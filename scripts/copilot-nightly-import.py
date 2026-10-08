#!/usr/bin/env python3
"""One-time Copilot CLI history import for official T3 Code Nightly.

No dependencies. Run without --apply to preview. Writes only while T3 is stopped.
Uses Nightly's legacy transcript migration; never starts a replacement server.
"""
import argparse
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid

SUPPORTED_VERSION = "0.0.46-nightly.20261008.2833"
HELPER_REVISION = "20261008.2"
EPOCH = "1970-01-01T00:00:00.000Z"
SESSION_ID = re.compile(r"^[0-9a-fA-F-]{8,64}$")
DEFAULT_MODEL = {"instanceId": "codex", "model": "gpt-6-astra"}


def iso(value, fallback=EPOCH):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return fallback
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, TypeError, OverflowError):
        return fallback


def workspace_metadata(path):
    """Copilot writes flat YAML scalars; ignore complex YAML values."""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        value = value.strip()
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                continue
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1].replace("''", "'")
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        if isinstance(value, str) and value not in ("", "null", "~", "|", ">"):
            result[key] = value
    return result


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def text_value(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def parse_session(directory):
    for lock in directory.glob("inuse.*.lock"):
        match = re.fullmatch(r"inuse\.(\d+)\.lock", lock.name)
        if match and alive(int(match[1])):
            raise ValueError("Copilot session is still in use; finish it and retry")
    transcript = directory / "events.jsonl"
    before = transcript.stat()
    metadata = workspace_metadata(directory / "workspace.yaml")
    context, messages, requests, pending = {}, [], {}, {}
    first_user = None
    malformed = 0
    timestamp = EPOCH
    started = None
    conversational = 0

    def append(role, text, at):
        # Nightly orders legacy messages by timestamp and then message id.
        # Clamp out-of-order/broken timestamps to preserve the transcript order.
        ordered_at = max(iso(at, timestamp), messages[-1][2] if messages else EPOCH)
        messages.append((role, text, ordered_at))

    def tool_record(call_id, data, at, interrupted=False):
        tool = pending.pop(call_id, None) or requests.get(call_id)
        if not tool:
            return
        error = data.get("error")
        result = data.get("result")
        status = "interrupted" if interrupted else "failed" if error or data.get("success") is False else "completed"
        output = error.get("message") if isinstance(error, dict) else result.get("content") if isinstance(result, dict) else None
        # Preserve tool details as quoted transcript text; never execute them.
        details = [f"[Imported Copilot tool: {tool['name']} — {status}]"]
        if tool.get("input") is not None:
            details.append("Input:\n" + text_value(tool["input"]))
        if output is not None:
            details.append("Output:\n" + text_value(output))
        append("assistant", "\n\n".join(details), at)

    with transcript.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            if not isinstance(event, dict):
                malformed += 1
                continue
            timestamp = iso(event.get("timestamp"), timestamp)
            started = started or timestamp
            data = event.get("data")
            data = data if isinstance(data, dict) else {}
            kind = event.get("type")
            if kind in ("session.start", "session.resume"):
                for key, value in (data.get("context") or {}).items() if isinstance(data.get("context"), dict) else []:
                    if isinstance(value, str) and value.strip():
                        context[key] = value
            elif kind in ("user.message", "assistant.message"):
                content = data.get("content")
                if isinstance(content, str) and content.strip():
                    role = "user" if kind == "user.message" else "assistant"
                    append(role, content, timestamp)
                    conversational += 1
                    if role == "user" and first_user is None:
                        first_user = content
                tool_requests = data.get("toolRequests")
                for request in tool_requests if isinstance(tool_requests, list) else []:
                    if isinstance(request, dict) and isinstance(request.get("toolCallId"), str):
                        requests[request["toolCallId"]] = {"name": request.get("name", "unknown"), "input": request.get("arguments")}
            elif kind == "tool.execution_start" and isinstance(data.get("toolCallId"), str):
                call_id = data["toolCallId"]
                request = requests.get(call_id, {})
                pending[call_id] = {"name": data.get("toolName", request.get("name", "unknown")), "input": data.get("arguments", request.get("input"))}
            elif kind == "tool.execution_complete" and isinstance(data.get("toolCallId"), str):
                tool_record(data["toolCallId"], data, timestamp)
    for call_id in list(pending):
        tool_record(call_id, {}, timestamp, interrupted=True)
    after = transcript.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("Copilot transcript changed during the scan; retry when idle")
    if not conversational:
        raise ValueError("No readable user or assistant messages")
    folder = context.get("gitRoot") or metadata.get("git_root") or context.get("cwd") or metadata.get("cwd")
    if not folder or not Path(folder).is_absolute():
        raise ValueError("No original absolute workspace folder recorded")
    folder = Path(folder).resolve()
    if not folder.is_dir():
        raise ValueError(f"Original folder no longer exists: {folder}")
    title = " ".join((metadata.get("name") or first_user or "Copilot session").split())[:120]
    return {"id": directory.name, "thread_id": "copilot-import-" + directory.name, "folder": str(folder),
            "title": title, "branch": context.get("branch"), "created": iso(metadata.get("created_at"), started or EPOCH),
            "updated": max(timestamp, messages[-1][2]), "messages": messages, "malformed": malformed}


class SnapshotConnection(sqlite3.Connection):
    """Own the private snapshot for exactly as long as its connection is open."""
    snapshot_directory = None

    def close(self):
        try:
            super().close()
        finally:
            if self.snapshot_directory is not None:
                self.snapshot_directory.cleanup()
                self.snapshot_directory = None


def database_file_state(database):
    paths = [database, Path(str(database) + "-wal"), Path(str(database) + "-journal")]
    result = {}
    for path in paths:
        if path.exists():
            stat = path.stat()
            result[path] = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    return result


def offline_readonly_snapshot(database):
    # Apple's SQLite may reject mode=ro on a closed WAL database without its
    # sidecars. Never work around that by opening the user's source read-write,
    # or immutable=1 (which would silently ignore committed WAL contents).
    assert_stopped(database)
    directory = tempfile.TemporaryDirectory(prefix="t3-copilot-read-")
    connection = None
    try:
        before = database_file_state(database)
        snapshot = Path(directory.name) / database.name
        for source in before:
            target = Path(directory.name) / source.name
            shutil.copyfile(source, target)
            target.chmod(0o600)
        assert_stopped(database)
        if before != database_file_state(database):
            raise ValueError("Nightly's database changed while copying it. Keep Nightly closed and retry.")
        # The disposable copy may create/recover WAL sidecars. Source bytes stay
        # untouched. SQL writes are disabled before handing the connection out.
        connection = sqlite3.connect(snapshot, factory=SnapshotConnection)
        connection.snapshot_directory = directory
        connection.execute("PRAGMA schema_version").fetchone()
        connection.execute("PRAGMA query_only=ON")
        return connection
    except BaseException:
        if connection is not None:
            connection.close()
        directory.cleanup()
        raise


def connect_readonly(database):
    with database.open("rb") as stream:
        header = stream.read(20)
    missing_sidecars = any(not Path(str(database) + suffix).exists() for suffix in ("-wal", "-shm"))
    if header[:16] == b"SQLite format 3\0" and header[18:20] == b"\x02\x02" and missing_sidecars:
        # Standard SQLite may create source sidecars even in mode=ro; Apple
        # SQLite can fail instead. A closed-file snapshot handles both cases.
        return offline_readonly_snapshot(database)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        # Opening is lazy: force the read here so fallback also covers failures
        # that would otherwise first surface in validate_database().
        connection.execute("PRAGMA schema_version").fetchone()
        return connection
    except sqlite3.OperationalError as error:
        connection.close()
        if "unable to open database file" not in str(error).lower():
            raise
        return offline_readonly_snapshot(database)
    except BaseException:
        connection.close()
        raise


def validate_database(connection):
    migrations = connection.execute("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id").fetchall()
    if len(migrations) != 60 or migrations[-1] != (60, "ThreadSnapshotWindowIndexes"):
        raise ValueError("Database migrations do not match the supported Nightly. No import performed.")
    for table, expected in EXPECTED_COLUMNS.items():
        actual = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
        if actual != expected:
            raise ValueError(f"Unexpected {table} schema. No import performed.")
    if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
        raise ValueError("Database integrity check failed. No import performed.")


def existing_thread_ids(connection):
    return {row[0] for row in connection.execute("SELECT thread_id FROM projection_threads UNION SELECT thread_id FROM orchestration_v2_projection_threads")}


def scan(copilot_home, existing):
    root = copilot_home / "session-state"
    if not root.is_dir():
        raise ValueError(f"No Copilot CLI session history found at {root}")
    sessions, skipped, failures = [], 0, []
    for directory in sorted(root.iterdir()):
        if directory.is_symlink() or not directory.is_dir() or not SESSION_ID.fullmatch(directory.name):
            continue
        if "copilot-import-" + directory.name in existing:
            skipped += 1
            continue
        try:
            sessions.append(parse_session(directory))
        except (OSError, ValueError) as error:
            failures.append((directory.name, str(error)))
    return sessions, skipped, failures


def assert_stopped(database):
    runtime = database.parent / "server-runtime.json"
    if runtime.exists():
        state = json.loads(runtime.read_text())
        if isinstance(state.get("pid"), int) and state["pid"] > 0 and alive(state["pid"]):
            raise ValueError("T3's local server is running. Quit Nightly and stop its background server, then retry.")
    lsof = shutil.which("lsof") or "/usr/sbin/lsof"
    files = [str(p) for p in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")) if p.exists()]
    result = subprocess.run([lsof, "-t", *files], capture_output=True, text=True, timeout=15)
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise ValueError("Could not verify that the database is closed. Quit Nightly and try again.")
    if result.stdout.strip():
        raise ValueError("T3's database is still open. Quit Nightly and stop its background server, then retry.")


def backup_database(database, home):
    directory = home / "copilot-import-backups" / (dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, mode=0o700)
    backup = directory / database.name
    descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    with closing(connect_readonly(database)) as source, closing(sqlite3.connect(backup)) as target:
        source.backup(target)
        if target.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise ValueError("Backup verification failed; import stopped")
    return backup


def app_command(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    version = info.get("CFBundleShortVersionString")
    if version != SUPPORTED_VERSION:
        raise ValueError(f"Supported Nightly: {SUPPORTED_VERSION}; installed: {version}. No import performed.")
    if info.get("CFBundleIdentifier") != "com.t3tools.t3code":
        raise ValueError("Select the official T3 Code Nightly app, not the custom importer app")
    return [str(app / "Contents/MacOS" / info["CFBundleExecutable"]),
            str(app / "Contents/Resources/app.asar/apps/server/dist/bin.mjs")]


def cli_environment(home):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("T3", "VITE_"))}
    env.update(ELECTRON_RUN_AS_NODE="1", T3CODE_HOME=str(home))
    return env


def project_map(connection):
    return {str(Path(row[1]).resolve()): (row[0], row[2]) for row in connection.execute(
        "SELECT project_id, workspace_root, default_model_selection_json FROM projection_projects WHERE deleted_at IS NULL")}


def insert_sessions(connection, sessions, projects):
    imported = 0
    existing = existing_thread_ids(connection)
    for session in sessions:
        if session["thread_id"] in existing:
            continue
        project_id, model = projects[session["folder"]]
        model = model or json.dumps(DEFAULT_MODEL)
        connection.execute("""INSERT INTO projection_threads
            (thread_id, project_id, title, branch, created_at, updated_at, runtime_mode, interaction_mode, model_selection_json)
            VALUES (?, ?, ?, ?, ?, ?, 'approval-required', 'default', ?)""",
            (session["thread_id"], project_id, session["title"], session["branch"], session["created"], session["updated"], model))
        connection.executemany("""INSERT INTO projection_thread_messages
            (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json)
            VALUES (?, ?, ?, ?, 0, ?, ?, '[]')""", [
                (f"{session['thread_id']}:{index:09d}", session["thread_id"], role, text, at, at)
                for index, (role, text, at) in enumerate(session["messages"])])
        imported += 1
    return imported


def apply_import(database, home, sessions, command):
    assert_stopped(database)
    backup = backup_database(database, home)
    print(f"Verified backup: {backup}", flush=True)
    # Use the installed official CLI for project events; only legacy history is
    # staged directly. Nightly itself turns it into durable v2 events on startup.
    failed_folders = {}
    with closing(connect_readonly(database)) as connection:
        projects = project_map(connection)
    for folder in sorted({session["folder"] for session in sessions}):
        assert_stopped(database)
        if folder not in projects:
            try:
                result = subprocess.run(command + ["project", "add", "--base-dir", str(home), folder],
                                        env=cli_environment(home), capture_output=True, text=True, timeout=120)
                if result.returncode:
                    failed_folders[folder] = "Official CLI could not create the project: " + result.stderr[-1500:]
            except subprocess.TimeoutExpired:
                failed_folders[folder] = "Official CLI timed out creating the project"
    sessions = [session for session in sessions if session["folder"] not in failed_folders]
    assert_stopped(database)
    connection = sqlite3.connect(database, timeout=1)
    try:
        connection.execute("BEGIN IMMEDIATE")
        validate_database(connection)
        imported = insert_sessions(connection, sessions, project_map(connection))
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
    return imported, backup, failed_folders


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up and import with Nightly fully stopped")
    parser.add_argument("--home", type=Path, default=Path.home() / ".t3", help="Official Nightly's T3 home (default ~/.t3)")
    parser.add_argument("--copilot-home", type=Path, default=Path(os.environ.get("COPILOT_HOME") or str(Path.home() / ".copilot")))
    parser.add_argument("--app", type=Path, default=Path("/Applications/T3 Code (Nightly).app"))
    args = parser.parse_args(argv)
    home = args.home.expanduser().resolve()
    database = home / "userdata/statev2.sqlite"
    command = app_command(args.app.expanduser().resolve())
    if not database.is_file():
        raise ValueError(f"No Nightly database at {database}. Open official Nightly once first, or pass --home.")
    print(f"Helper revision: {HELPER_REVISION}\nTarget: official T3 Code Nightly {SUPPORTED_VERSION}\nData: {database}", flush=True)
    with closing(connect_readonly(database)) as connection:
        validate_database(connection)
        sessions, skipped, failures = scan(args.copilot_home.expanduser().resolve(), existing_thread_ids(connection))
    print(f"Ready: {len(sessions)} conversations in {len({s['folder'] for s in sessions})} folders; already imported: {skipped}; skipped: {len(failures)}")
    for folder in sorted({s["folder"] for s in sessions}):
        print(f"  {sum(s['folder'] == folder for s in sessions)} conversations: {folder}")
    for session_id, error in failures:
        print(f"Skipped {session_id}: {error}")
    malformed = sum(s["malformed"] for s in sessions)
    if malformed:
        print(f"Warning: ignored {malformed} malformed transcript lines; readable messages will be imported.")
    if args.apply and sessions:
        imported, _, failed_folders = apply_import(database, home, sessions, command)
        for folder, error in failed_folders.items():
            print(f"Skipped folder {folder}: {error}")
        failures.extend(failed_folders.items())
        print(f"Imported {imported} conversations. Reopen official Nightly to read them.")
        print("Tool records are preserved as text. Select your preferred provider/model before continuing a chat.")
    elif not args.apply:
        print("Preview only. Quit Nightly, then rerun with --apply to import.")
    else:
        print("No new conversations to import.")
    return 1 if failures else 0


EXPECTED_COLUMNS = {
  "projection_threads": [
    "thread_id",
    "project_id",
    "title",
    "branch",
    "worktree_path",
    "latest_turn_id",
    "created_at",
    "updated_at",
    "deleted_at",
    "runtime_mode",
    "interaction_mode",
    "model_selection_json",
    "archived_at",
    "latest_user_message_at",
    "pending_approval_count",
    "pending_user_input_count",
    "has_actionable_proposed_plan",
    "settled_override",
    "settled_at",
    "snoozed_until",
    "snoozed_at",
    "title_regeneration_request_id",
    "title_regeneration_started_at",
    "pinned_at",
    "pin_order_key",
    "linked_pull_request_json",
    "unsettled_at",
    "branch_pull_request_json",
    "active_order_key",
    "title_state_json",
    "auto_settle_disabled_at"
  ],
  "projection_thread_messages": [
    "message_id",
    "thread_id",
    "turn_id",
    "role",
    "text",
    "is_streaming",
    "created_at",
    "updated_at",
    "attachments_json",
    "context_json"
  ]
}

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(f"Import stopped: {error}", file=sys.stderr)
        sys.exit(1)
