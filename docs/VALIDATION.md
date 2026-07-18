# Validation record

Validated for 0.3.0-alpha.0 with Node.js 22 and 24:

- thirteen Node.js tests pass
- CommonJS `require('electron')` and ESM `import('electron')` return AtomJS `BrowserWindow`
- the macOS runtime contains a Cocoa/WKWebView host and no JXA window host
- `BrowserWindow` uses one shared macOS host for all windows
- native macOS window commands cover create, close, navigation, title, visibility, focus, bounds, minimize, maximize, restore and fullscreen
- macOS open/save/message dialogs are handled by Cocoa rather than `osascript`
- the macOS builder embeds the application payload as a SEA asset
- the macOS bundle contains no visible `Resources/app` source directory or separate `Resources/runtime/node`
- the build compiles the host with `xcrun clang`, ad-hoc signs nested executables, and performs strict deep signature verification
- static file serving and WebSocket `ipcMain.handle()` invocation are exercised
- `atom init` project generation and Electron-facade provisioning are exercised

GitHub Actions performs the actual macOS compile-and-package smoke build because Cocoa and WebKit frameworks are unavailable in the Linux development container. Windows and Linux keep the alpha adapter architecture and require dedicated native-host work before receiving the same packaging model.
