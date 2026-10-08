# GitHub Copilot

T3 Code connects directly to the official GitHub Copilot CLI through its ACP server. It does not
route Copilot through OpenCode.

## Install

Install the CLI globally:

```bash
npm install -g @github/copilot
```

Then authenticate:

```bash
copilot login
```

Keep the provider's Binary path set to `copilot` unless the executable is installed elsewhere.

## Token Authentication

The Copilot CLI also accepts authentication from environment variables. Add one of these to the
Copilot provider instance in Settings:

```text
COPILOT_GITHUB_TOKEN
GH_TOKEN
GITHUB_TOKEN
```

Mark tokens as sensitive. The CLI decides credential precedence and can also use a stored
`copilot login` or GitHub CLI (`gh auth`) session. T3 Code forwards the provider environment,
including `COPILOT_HOME`, without interpreting credentials.

## Import CLI conversations

To import everything at once, open the command palette and choose **Import all GitHub Copilot
sessions…**. T3 groups the conversations by their original repository root, or working folder
when no repository root is recorded. It reuses matching projects and creates missing projects.
You do not need to add a project first. The final notification reports imported sessions,
previously imported sessions, and any failures, with details you can expand.

Folders must still exist on the connected machine. Sessions with missing folders or no usable
folder metadata are reported as failures, and the remaining sessions continue importing. You can
retry the batch safely; sessions already imported are skipped. Individual import lets you choose
a different existing project for a session whose original folder is no longer available.

Open a project in the web or desktop app, open the command palette, and choose
**Import GitHub Copilot session…**. Select a session to import its text messages and recorded tool
calls into a T3 Code thread. Sessions from the project's workspace appear first.

The list reads the connected environment's Copilot CLI history from `~/.copilot/session-state`,
or from `COPILOT_HOME` when set in the T3 server's environment. When connected to a remote server,
the sessions come from that server's machine. Sessions without a readable transcript or messages
do not appear. VS Code Copilot Chat history is not supported by this importer.

An import is a snapshot: it leaves the original session untouched, and importing it again opens
the existing T3 thread without copying newer messages. A session marked **in use** may still be
changing; wait until it finishes if you want the complete transcript.

Your next message starts a new provider conversation with the imported history supplied as
context. It does not resume the original CLI process or restore its files, attachments, or
checkpoints. You can change the thread's provider and model before continuing. Imported threads
can be archived or deleted like other T3 threads. Mobile can read and continue these threads;
the import picker is available in web and desktop.

## Early Access

GitHub currently describes ACP support as a public preview. T3 Code labels the provider Early
Access because CLI behavior may change while that preview evolves.
