# Changelog

## 0.2.0-alpha.0

### Electron compatibility

- Added an AtomJS-backed package named `electron` for both CommonJS and ESM.
- Added `electron/main`, `electron/renderer`, and `electron/common` export paths.
- `atom run dev` provisions the lightweight Electron facade for transitive dependencies automatically.
- Packaged applications vendor the same facade, so dependencies do not need AtomJS-specific builds.
- Added Electron runtime markers such as `process.versions.electron` and `process.type`.
- Preload scripts can now use `require('electron')` directly.
- Added compatibility exports for frequently imported Electron modules.

### BrowserWindow and OAuth

- Added `BrowserWindow.setMenu()`, `getMenu()`, `removeMenu()`, and menu-bar compatibility methods.
- `webContents.did-finish-load` now fires after every completed navigation instead of only the initial document.
- The macOS WKWebView navigation delegate reports native navigation completion, including remote OAuth redirects where a page CSP may block the JavaScript bridge.
- Added compatibility tests that match the Electron calls used by MSMC.

## 0.1.1-alpha.0

### Fixed

- macOS development launches WKWebView through JavaScript for Automation.
- macOS no longer requires `webview-nodejs`, CMake, or a compiled Node addon for development runs.
- `BrowserWindow.loadFile()` and `loadURL()` suppress fire-and-forget unhandled rejections.
