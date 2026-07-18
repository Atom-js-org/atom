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
        └── native window host
              ├── macOS: one Cocoa process owns every WKWebView window
              ├── Windows: WebView2 adapter
              └── Linux: WebKitGTK adapter
```

## One application, multiple windows

A desktop application must not become a collection of unrelated helper applications. On macOS, AtomJS starts one shared Cocoa host for the whole Node.js main process. Every `BrowserWindow` is created inside that host and uses the same application menu, Dock identity, activation state, and event loop.

The macOS host is a small Objective-C program compiled with the installed Apple SDK. It does not use `osascript`, JXA, Electron, Chromium, or Rust. Node.js remains the main process and sends JSON commands to the host over pipes.

Windows and Linux still use the current WebView adapter while their shared-host implementations are developed.

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

## Packaged application payload

On macOS, production code and production dependencies are compressed into an AtomJS payload and embedded in the Node.js Single Executable Application. The `.app` bundle no longer exposes a `Resources/app` source tree or a second `Resources/runtime/node` executable. On first launch, the signed executable materializes its payload into a versioned application-data cache and starts the project main script from there.

## IPC security

Every application run creates a random 256-bit bridge token and listens only on `127.0.0.1`. A window ID and token are required for WebSocket upgrades. A production release should additionally validate navigation origins, rotate per-window tokens and define explicit IPC permissions.

## Electron compatibility boundary

AtomJS can closely match lifecycle and IPC names, but cannot promise binary or behavioral compatibility with Chromium-specific APIs. Unsupported APIs must fail clearly rather than silently claim success.
