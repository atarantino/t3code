# Copilot import desktop test build

The fork supports a separate macOS app for local Copilot import testing. Versions ending in
`-copilot-import-nightly.YYYYMMDD.N` select a distinct app name, bundle ID, T3 home, and Electron
profile. The test build does not register official T3 URL handlers or use an automatic update feed.

From the fork checkout, with Node 24, dependencies, Rust, and Apple command-line build tools installed:

```sh
npx vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version 0.0.34-copilot-import-nightly.20261008.1
```

The DMG contains **T3 Code Copilot Import (Nightly).app** with the server and web client bundled.
It runs without a separate development server or browser pairing flow. Use the command palette's
**Import all GitHub Copilot sessions…** action to import that Mac's local CLI history.

Default data locations:

- T3 data: `~/.t3-copilot-import/userdata`
- Electron profile: `~/Library/Application Support/t3code-copilot-import`
- Import source: `~/.copilot/session-state` (or the server's `COPILOT_HOME`)

An explicit `T3CODE_HOME` still overrides the default. Do not point a test build at a live official
installation's data directory. Builds are unsigned and unnotarized unless signing is explicitly
configured. Install newer test DMGs manually; the fork app does not auto-update.
