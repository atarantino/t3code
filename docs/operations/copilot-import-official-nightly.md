# Import Copilot CLI history into official Nightly

This one-time helper is for **official T3 Code Nightly
0.0.46-nightly.20261008.2833 on macOS**. After importing, keep using the official app
and its normal updates. The custom Copilot Import desktop app is not needed.

## On the Mac with your Copilot history

1. Have Python 3 available (`python3 --version`). Open official Nightly at least once
   so it has created its database. Finish any active Copilot CLI sessions.
2. Download `copilot-nightly-import.py` from the fork's
   [official Nightly importer release](https://github.com/atarantino/t3code/releases/tag/copilot-official-nightly-import-20261008.2)
   to Downloads.
3. Preview the import in Terminal:

   ```sh
   python3 ~/Downloads/copilot-nightly-import.py
   ```

4. Quit T3 Code Nightly completely, then run:

   ```sh
   python3 ~/Downloads/copilot-nightly-import.py --apply
   ```

5. Reopen **T3 Code (Nightly)**. Imported conversations appear under projects matching
   their original local folders. The first open may take a moment to finish importing
   the history. Select your preferred provider/model before continuing a conversation.

If the helper reports that the local server is still running, and you enabled T3's
background service, temporarily unload that service after quitting the app:

```sh
launchctl bootout --wait "gui/$(id -u)/com.t3tools.t3code.service"
```

Then retry `--apply`. After importing, reload the service and reopen Nightly:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist"
```

These commands apply only to the optional background service. If you run T3 from
Terminal instead, stop that process in its own terminal. Do not open Nightly during
import.

The helper prints the database it targets. Defaults are `~/.t3/userdata/statev2.sqlite`
and `~/.copilot/session-state`. Override these with `--home /path/to/t3-home` or
`--copilot-home /path/to/copilot-home`; `--app` selects an app installed elsewhere.
`COPILOT_HOME` is respected. The helper deliberately does not inherit `T3CODE_HOME`,
which may belong to a development checkout.

## macOS Python compatibility

Helper revision **20261008.2** fixes `Import stopped: unable to open database file`
with macOS's bundled Python/SQLite. Apple's SQLite may reject a read-only open of a
closed WAL database after its sidecar files have been removed. The helper now reads
a private temporary copy in that case, including any pending WAL data, after checking
that T3 is stopped. It does not open the source database read-write for previews or
backup reads. Both bundled Python 3.9 and Homebrew Python passed the regression tests.

If you downloaded the first revision, replace the script with the latest release and
rerun the same command. The helper prints its revision and target path on startup.

## What is imported

- All readable Copilot CLI conversations, grouped by recorded repository root or
  working folder. Existing projects are reused; missing projects are added through
  the installed official CLI.
- User and assistant messages, plus tool inputs/results rendered as transcript text.
  Messages keep their timestamps; invalid or backward timestamps are adjusted only
  as needed to preserve transcript order.
- Repeat runs skip conversations already imported, including archived/deleted ones.
  An import is a snapshot; repeat runs do not append newer source messages.
- Missing folders, active sessions, and unreadable transcripts are reported and
  skipped. Other conversations continue. A nonzero exit status indicates skipped
  sessions or an error; read the summary for any successful imports.

Original Copilot history is read only. This does not import VS Code Copilot Chat,
attachments, checkpoints, or a live Copilot process. The conversation's next turn
starts a new provider session with the imported history available as context.
Existing project model defaults are retained; otherwise imported threads initially
select Codex (`gpt-6-astra`). Change that in Nightly if desired.

## Backup and recovery

Before any write, the helper makes a verified SQLite backup under
`~/.t3/copilot-import-backups/<timestamp>/statev2.sqlite`, with private file permissions.
It rejects unsupported app versions/schemas and refuses to import while a server or
another process has the database open. Thread/message insertion is transactional.
If project creation succeeds but a later step fails, new empty projects can remain;
existing conversations are not overwritten.

To restore the entire pre-import database, first quit Nightly and stop its server.
Replace the example path below with the exact backup path printed by the helper:

```sh
sqlite3 "$HOME/.t3/userdata/statev2.sqlite" \
  ".restore '$HOME/.t3/copilot-import-backups/REPLACE-WITH-TIMESTAMP/statev2.sqlite'"
```

Restoring discards changes made after that backup. Keep the backup until you have
checked the imported conversations. Restoring is not required to retry an import.

## Implementation and validation

The helper stages ordinary legacy thread/message records, then lets the official
build's existing `LegacyV1ThreadImporter` materialize its own v2 events/projections on
startup. This avoids the fork-only `copilot_import` history marker. Project creation
uses the installed official CLI so project events remain durable. The helper does
not run a development server or alter the installed app.

Fifteen focused tests cover parsing, ordering, schema guards, backups, active-server
refusal, rollback, partial failures, and duplicate imports:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/copilot-nightly-import.test.py
```

Integration was checked using the official `0.0.46-nightly.20261008.2833` server with
an isolated temporary T3 home: bulk import into two projects, restart, and read both
conversations through the same HTTP snapshot API used by the desktop. Both user and
assistant messages appeared with their original dates and visible turn items. The
real local T3 database was not modified. Interactive desktop QA remains to be done.
