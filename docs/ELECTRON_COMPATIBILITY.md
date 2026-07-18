# Electron compatibility facade

AtomJS includes a lightweight npm package whose package name is exactly `electron`. It exports AtomJS-backed implementations instead of downloading the Electron binary or Chromium.

## Why this exists

Many npm libraries do not accept a framework object from the application. They load Electron internally:

```js
const { BrowserWindow } = require('electron');
```

or:

```js
const { BrowserWindow } = await import('electron');
```

Without a package named `electron`, those libraries fail before AtomJS has an opportunity to provide an adapter. The facade solves module resolution at the source.

## Development runs

Before starting the main process, `atom run dev` makes sure the project has an AtomJS-marked `node_modules/electron` facade. It never downloads Chromium.

If an unrelated or real Electron package already occupies that path, AtomJS stops rather than deleting it silently. Remove the conflicting package before running AtomJS.

## Packaged applications

`atom build` vendors both the AtomJS runtime and the Electron facade. The staged production `package.json` points to local copies:

```json
{
  "dependencies": {
    "atomjs": "file:vendor/atomjs",
    "electron": "file:vendor/electron-compat"
  }
}
```

This keeps transitive `require('electron')` calls working in the final application.

## Renderer and preload

AtomJS preload scripts can use:

```js
const { contextBridge, ipcRenderer } = require('electron');
```

The system WebView is not a Node.js process. Therefore arbitrary Node modules are not synchronously available inside page JavaScript. Use the main process and IPC for filesystem, process, database, and operating-system work.

## MSMC compatibility

MSMC's Electron GUI path creates a `BrowserWindow`, calls `setMenu(null)`, loads an OAuth URL, reads `webContents.getURL()`, and listens for repeated `did-finish-load` events. AtomJS 0.2 implements those calls and reports macOS WKWebView navigations natively so redirects still arrive even when the remote page blocks the JavaScript bridge through Content Security Policy.

## What “Electron-compatible” means

- Same module name for existing dependencies.
- Same Main / Preload / Renderer project structure.
- Same core API names where the system-WebView architecture can support them.
- Explicit, testable failures for unsupported behavior.

It does not mean that Chromium, V8 embedder APIs, Chrome extensions, Electron's native module ABI, or every Electron API are secretly present.
