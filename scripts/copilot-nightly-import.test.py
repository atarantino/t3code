"""Focused importer checks: python3 scripts/copilot-nightly-import.test.py"""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("importer", Path(__file__).with_name("copilot-nightly-import.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
SCHEMA = Path(__file__).parent / "fixtures/copilot-nightly-20261008-schema.sql"


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / "Original project"
        self.folder.mkdir()
        self.source = self.root / "copilot"
        self.session = self.source / "session-state/11111111-1111-4111-8111-111111111111"
        self.session.mkdir(parents=True)
        self.db = self.root / "userdata/statev2.sqlite"
        self.db.parent.mkdir()
        with closing(sqlite3.connect(self.db)) as connection:
            connection.executescript(SCHEMA.read_text())
            connection.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Existing project',?,'[]',?,?)", (str(self.folder), importer.EPOCH, importer.EPOCH))
            connection.commit()

    def events(self, extra=None):
        events = [
            {"type": "session.start", "timestamp": "2026-10-01T01:00:00Z", "data": {"context": {"cwd": str(self.folder), "gitRoot": str(self.folder), "branch": "feature"}}},
            {"type": "user.message", "timestamp": "2026-10-01T01:00:01Z", "data": {"content": "Question"}},
            {"type": "assistant.message", "timestamp": "2026-10-01T01:00:02Z", "data": {"content": "Answer"}},
        ] + (extra or [])
        (self.session / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events))

    def test_transcript_metadata_and_damaged_lines(self):
        self.events()
        with (self.session / "events.jsonl").open("a") as stream:
            stream.write('\n{"truncated":')
        (self.session / "workspace.yaml").write_text('name: "Conversation title"\n')
        result = importer.parse_session(self.session)
        self.assertEqual(result["title"], "Conversation title")
        self.assertEqual(result["folder"], str(self.folder))
        self.assertEqual(result["branch"], "feature")
        self.assertEqual(result["malformed"], 1)
        self.assertEqual([m[:2] for m in result["messages"]], [("user", "Question"), ("assistant", "Answer")])

    def test_tool_input_output_and_interrupted_tools_are_preserved(self):
        self.events([
            {"type": "tool.execution_start", "data": {"toolCallId": "tool1", "toolName": "bash", "arguments": {"command": "echo hello"}}},
            {"type": "tool.execution_complete", "data": {"toolCallId": "tool1", "success": True, "result": {"content": "hello"}}},
            {"type": "tool.execution_start", "data": {"toolCallId": "tool2", "toolName": "view", "arguments": {"path": "file.txt"}}},
        ])
        text = "\n".join(m[1] for m in importer.parse_session(self.session)["messages"])
        self.assertIn("bash — completed", text)
        self.assertIn("echo hello", text)
        self.assertIn("Output:\nhello", text)
        self.assertIn("view — interrupted", text)

    def test_invalid_and_backwards_dates_keep_message_order(self):
        self.events([
            {"type": "assistant.message", "timestamp": "broken", "data": {"content": "Third"}},
            {"type": "user.message", "timestamp": "2025-01-01T00:00:00Z", "data": {"content": "Fourth"}},
        ])
        dates = [m[2] for m in importer.parse_session(self.session)["messages"]]
        self.assertEqual(dates, sorted(dates))
        self.assertTrue(all(d.startswith("2026-") for d in dates))

    def test_scan_skips_missing_folders_and_active_sessions(self):
        self.events()
        self.folder.rmdir()
        sessions, _, failures = importer.scan(self.source, set())
        self.assertEqual(sessions, [])
        self.assertIn("no longer exists", failures[0][1])
        self.folder.mkdir()
        (self.session / f"inuse.{os.getpid()}.lock").touch()
        self.assertIn("in use", importer.scan(self.source, set())[2][0][1])

    def test_reimport_skips_even_if_source_folder_is_gone(self):
        self.events()
        self.folder.rmdir()
        self.assertEqual(importer.scan(self.source, {"copilot-import-" + self.session.name}), ([], 1, []))

    def test_known_schema_and_newer_migration_rejected(self):
        with closing(sqlite3.connect(self.db)) as connection:
            importer.validate_database(connection)
            connection.execute("INSERT INTO effect_sql_migrations(migration_id,name) VALUES (61,'Future')")
            with self.assertRaisesRegex(ValueError, "migrations"):
                importer.validate_database(connection)

    def test_backup_is_complete_private_and_source_unchanged(self):
        before = self.db.read_bytes()
        backup = importer.backup_database(self.db, self.root)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute("SELECT title FROM projection_projects").fetchone()[0], "Existing project")

    def test_insert_reuses_project_preserves_dates_and_is_idempotent(self):
        self.events()
        session = importer.parse_session(self.session)
        with closing(sqlite3.connect(self.db)) as connection:
            projects = importer.project_map(connection)
            self.assertEqual(importer.insert_sessions(connection, [session], projects), 1)
            self.assertEqual(importer.insert_sessions(connection, [session], projects), 0)
            rows = connection.execute("SELECT role,text,created_at FROM projection_thread_messages ORDER BY message_id").fetchall()
            self.assertEqual(rows, session["messages"])
            self.assertEqual(connection.execute("SELECT project_id,runtime_mode FROM projection_threads").fetchone(), ("project", "approval-required"))

    def test_transaction_rolls_back_whole_history_on_failure(self):
        self.events()
        session = importer.parse_session(self.session)
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute("CREATE TRIGGER fail_message BEFORE INSERT ON projection_thread_messages BEGIN SELECT RAISE(ABORT,'test failure'); END")
            connection.commit()
            with self.assertRaises(sqlite3.IntegrityError), connection:
                importer.insert_sessions(connection, [session], importer.project_map(connection))
            self.assertEqual(connection.execute("SELECT count(*) FROM projection_threads").fetchone()[0], 0)

    def test_running_server_is_rejected(self):
        (self.db.parent / "server-runtime.json").write_text(json.dumps({"pid": os.getpid()}))
        with self.assertRaisesRegex(ValueError, "server is running"):
            importer.assert_stopped(self.db)

    def test_open_database_is_rejected_even_without_runtime_file(self):
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute("SELECT * FROM projection_projects").fetchall()
            with self.assertRaisesRegex(ValueError, "still open"):
                importer.assert_stopped(self.db)

    def test_failed_project_does_not_prevent_other_imports(self):
        self.events()
        good = importer.parse_session(self.session)
        bad = dict(good, id="22222222", thread_id="copilot-import-22222222", folder=str(self.root / "Other folder"))
        with patch.object(importer, "assert_stopped"), patch.object(importer.subprocess, "run") as run:
            run.return_value.returncode = 1
            run.return_value.stderr = "Project unavailable"
            imported, backup, failures = importer.apply_import(self.db, self.root, [good, bad], ["test-cli"])
        self.assertEqual(imported, 1)
        self.assertTrue(backup.is_file())
        self.assertIn(bad["folder"], failures)
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute("SELECT thread_id FROM projection_threads").fetchall(), [(good["thread_id"],)])

    def test_preview_never_writes(self):
        self.events()
        before = self.db.read_bytes()
        with patch.object(importer, "app_command", return_value=["never-run"]):
            self.assertEqual(importer.main(["--home", str(self.root), "--copilot-home", str(self.source)]), 0)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse((self.root / "copilot-import-backups").exists())


if __name__ == "__main__":
    unittest.main()
