# VideoFactory Desktop alpha.2 launcher repair

## What failed in alpha.1

The alpha.1 source archive contained application code, but its `package.json` did not declare the required runtime and development packages. `npm install` therefore could not install Electron, React, Vite, SQLite, FFmpeg helpers, Google APIs, or the test/build tools. The launcher also exited immediately when PowerShell or npm returned an error, so the useful message disappeared with the window.

## What alpha.2 changes

- Adds the complete npm dependency and development-dependency declarations.
- Pins a supported Electron runtime and current Electron/Vite tooling.
- Uses Electron’s bundled `node:sqlite` instead of an undeclared native SQLite add-on.
- Corrects Electron/Vite module output so the preload and main process paths resolve on Windows.
- Keeps the launcher window open after a failed start.
- Writes the full startup output to `VideoFactory-Last-Startup.log`.
- Adds preflight checks before dependency installation.
- Adds an installed-dependency doctor check before launch.
- Gives a clear error when Node.js is missing, unsupported, or the ZIP was not fully extracted.
- Adds equivalent logging and pause behavior to portable and installer build scripts.
- Fixes strict TypeScript issues found in diagnostics and credential settings code.
- Adds an in-app startup error dialog and a persistent `%APPDATA%` startup log.

## Replace the old copy

Use the full corrected alpha.2 folder rather than mixing files manually. If reusing the same folder, delete these first:

```text
node_modules\
package-lock.json
```

Then extract alpha.2 and run:

```text
RUN-ON-WINDOWS.cmd
```

The first launch installs dependencies and may take several minutes. If it fails, the terminal remains open and the same error is saved in:

```text
VideoFactory-Last-Startup.log
```
