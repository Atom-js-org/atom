# API and Electron compatibility status

Application code may use the Electron module name:

```js
const { app, BrowserWindow, ipcMain } = require('electron');
```

## BrowserWindow

Core lifecycle, loading, IPC and navigation APIs are implemented. AtomJS also maps a growing set of constructor options to native windows:

```js
const mainWindow = new BrowserWindow({
  width: 1100,
  height: 760,
  minWidth: 720,
  minHeight: 520,
  title: 'My App',
  backgroundColor: '#10131a',
  frame: true,
  resizable: true,
  alwaysOnTop: false,
  opacity: 1,
  transparent: false,
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 16 },
  webPreferences: { preload }
});
```

Supported window relationships:

```js
const authWindow = new BrowserWindow({
  parent: mainWindow,
  modal: true,
  width: 520,
  height: 720,
  show: true
});
```

On Windows, owned/modal windows are assigned a native owner, the parent is disabled for a modal window, and the new window is explicitly activated. On macOS, modal windows are displayed as sheets and non-modal child windows stay above their parent. A modal window without an explicit parent uses the currently focused AtomJS window.

Implemented methods include:

- `loadFile()` / `loadURL()`
- `show()` / `hide()` / `focus()`
- `close()` / `destroy()` / `reload()`
- `setTitle()` / `getTitle()`
- `getParentWindow()` / `getChildWindows()`
- `setAlwaysOnTop()` / `isAlwaysOnTop()`
- `setOpacity()` / `getOpacity()`
- `setResizable()` / `isResizable()`
- fullscreen, maximize, minimize, restore, size and bounds methods
- `getAllWindows()` / `fromId()` / `getFocusedWindow()`

Some after-creation native mutations are currently complete on the shared macOS host but remain creation-time options on the Windows/Linux adapter. The constructor options are the reliable cross-platform customization surface for this alpha.

## Functional core

- application lifecycle and paths
- `BrowserWindow` and repeated navigation events
- `webContents.send()`, `executeJavaScript()`, reload and URL state
- `ipcMain` and preload `ipcRenderer`
- `contextBridge.exposeInMainWorld()`
- open, save and message dialogs
- shell, clipboard and menu data model

## Module-resolution compatibility

- CommonJS `require('electron')`
- ESM `import('electron')`
- `electron/main`, `electron/renderer`, `electron/common`
- preload `require('electron')`
- `process.versions.electron`
- automatic facade provisioning in development and vendoring in builds

## Compatibility boundary

AtomJS can match the Electron main/preload architecture and many window APIs while using system WebViews. Chromium-only APIs, Chrome extensions, Electron native ABI modules and exact browser-engine behavior are outside that boundary and must remain explicit rather than silently pretending to work.

## Native custom title-bar dragging

Frameless and hidden-title-bar windows can use Electron-compatible drag regions without sending a stream of `setBounds()` calls from JavaScript. AtomJS detects `-webkit-app-region: drag` in the renderer and asks AppKit to perform one native window drag operation.

```css
.titlebar {
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar button,
.titlebar input {
  -webkit-app-region: no-drag;
}
```

For WebKit versions that do not expose the Electron CSS property through computed styles, add the AtomJS fallback attribute to the same element:

```html
<header class="titlebar" data-atom-drag-region>
  <button data-atom-no-drag>Close</button>
</header>
```

Interactive controls are treated as non-draggable by default. Main-process code can also begin the same native operation with `window.startDrag()` while the primary mouse button is held. Do not implement custom title-bar movement by calling `setBounds()` for every `mousemove` or `pointermove`; that crosses the renderer, Node.js, and native-host boundaries for every frame and causes visible lag.
