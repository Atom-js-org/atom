# AtomJS architecture

## Goal

Keep the application-facing shape close to Electron while replacing the bundled Chromium renderer with the operating system WebView.

```text
Application main.js (Node.js)
        │
        ├── app / BrowserWindow / ipcMain
        │
        ├── authenticated HTTP + WebSocket bridge
        │                 │
        │                 └── renderer IPC and static application files
        │
        └── one window-host process per BrowserWindow
                          │
                          └── system WebView
                              Windows: WebView2
                              macOS: WebKit / WKWebView
                              Linux: WebKitGTK
```

## Why a window-host process

Native GUI event loops must not block the application's Node.js main process. AtomJS therefore gives every BrowserWindow a small host process while preserving responsive Node.js timers, filesystem callbacks and IPC. On macOS that host is JavaScript for Automation controlling AppKit and WKWebView; Windows and Linux currently use the `webview-nodejs` adapter.

## Main process

The main script is ordinary Node.js. It can use `node:fs`, databases, servers, npm modules and operating-system commands. Privileged work should stay here.

## Renderer and preload

A system WebView is a browser environment, not a Node.js environment. AtomJS injects a restricted preload-compatible runtime that implements:

- `require('electron')`, `require('electron/renderer')`, `require('atomjs')`, and `require('atom')` inside preload scripts
- `contextBridge.exposeInMainWorld()`
- `ipcRenderer.send()`
- `ipcRenderer.invoke()`
- renderer channel listeners

Arbitrary Node.js `require()` calls are intentionally unavailable in the renderer and preload. Use IPC to delegate them to the main process.

## File loading

`BrowserWindow.loadFile()` serves the page from an authenticated local HTTP server instead of `file://`. This avoids common module/CORS problems with modern frontend builds while restricting files to the selected content root.

## IPC security

Every application run creates a random 256-bit bridge token and listens only on `127.0.0.1`. A window ID and token are required for WebSocket upgrades. This is suitable for a prototype, but a production release should additionally validate navigation origins, rotate per-window tokens and define explicit IPC permissions.

## Electron compatibility boundary

AtomJS can closely match lifecycle and IPC names, but cannot promise binary or behavioral compatibility with Chromium-specific APIs. Unsupported APIs must fail clearly rather than silently claim success.
