# API and Electron compatibility status

Application code may import the framework using the Electron module name:

```js
const { app, BrowserWindow, ipcMain } = require('electron');
```

`require('atomjs')` remains available as a direct runtime import, but `electron` is the preferred application-facing API.

## Functional core

- `app.whenReady()`
- `app.isReady()`
- `app.quit()` / `app.exit()`
- `app.getName()` / `setName()` / `getVersion()`
- `app.getPath()` / `getAppPath()`
- `BrowserWindow`
- `BrowserWindow.loadFile()` / `loadURL()`
- repeated navigation events through `webContents.did-finish-load`
- `BrowserWindow.close()` / `destroy()` / `reload()`
- `BrowserWindow.setTitle()`
- `BrowserWindow.setMenu()` / `getMenu()` / `removeMenu()`
- `BrowserWindow.getAllWindows()` / `fromId()`
- `webContents.send()`
- `webContents.executeJavaScript()`
- `webContents.reload()` / `loadURL()` / `getURL()`
- `ipcMain.on()` / `handle()` / `handleOnce()`
- preload `ipcRenderer.send()` / `invoke()` / listeners
- preload `contextBridge.exposeInMainWorld()`
- `dialog.showOpenDialog()`
- `dialog.showSaveDialog()`
- `dialog.showMessageBox()`
- `shell.openExternal()` / `openPath()` / `showItemInFolder()`
- text clipboard
- `Menu` data model

## Module-resolution compatibility

- CommonJS `require('electron')`
- ESM `import('electron')`
- `electron/main`
- `electron/renderer`
- `electron/common`
- preload `require('electron')`
- `process.versions.electron`
- `process.type === 'browser'` in the main process
- automatic facade provisioning by `atom run dev`
- facade vendoring by `atom build`

This allows Electron-oriented dependencies such as MSMC to resolve `BrowserWindow` without publishing a separate AtomJS build.

## Compatibility surfaces

The following names are exported so packages can load and feature-detect them. Some are lightweight implementations and some are explicit stubs:

- `session`, cookies, and `webRequest`
- `protocol`
- `net`
- `screen`
- `nativeImage`
- `Notification`
- `globalShortcut`
- `powerSaveBlocker` / `powerMonitor`
- `systemPreferences`
- `safeStorage`
- `desktopCapturer`
- `crashReporter`
- `autoUpdater`
- `contentTracing`
- `netLog`
- `utilityProcess`
- `BrowserView`, `WebContentsView`, `BaseWindow`, and `View`
- `MessageChannelMain`

A compatibility export does not imply full Electron behavior. APIs that require Chromium internals or a native platform adapter either return a conservative result or throw a clear error.

## Partial behavior

- `show()` / `hide()` / `focus()` maintain compatibility state, but not every host can change native visibility after its GUI loop starts.
- `setSize()` / `setBounds()` currently update stored values after creation.
- DevTools are selected at window creation; runtime open/close control is incomplete.
- Native menu rendering, tray icons, global shortcuts, notification-center integration, and updater installation still need platform adapters.
- Node integration inside arbitrary renderer page scripts is not equivalent to Electron. Preload code can import Electron renderer APIs and should delegate privileged work through IPC.

## Compatibility boundary

AtomJS can impersonate Electron at the Node module and application-architecture level. It cannot reproduce Chromium-only APIs, Chrome extensions, Electron native ABI modules, or exact browser-engine behavior while using a system WebView and remaining a pure-JavaScript framework.
