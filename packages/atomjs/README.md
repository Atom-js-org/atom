# @atom-js-org/runtime

The lightweight AtomJS runtime. It uses Node.js for the main process and the operating system WebView for rendering.

AtomJS does not install or execute the Electron runtime and does not bundle a private Chromium copy. On Windows, the system WebView is Microsoft Edge WebView2; on macOS it is WKWebView; on Linux it is WebKitGTK through the current native binding.

Most applications should import the Electron-compatible alias instead:

```bash
npm install electron@npm:@atom-js-org/electron@alpha
```

```js
const { app, BrowserWindow, ipcMain } = require('electron');
```

Project: https://github.com/Atom-js-org/atom
