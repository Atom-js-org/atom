# @atom-js-org/runtime

The AtomJS runtime provides an Electron-style main-process API powered by operating-system WebViews.

```js
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const main = new BrowserWindow({ width: 1000, height: 700 });
  const auth = new BrowserWindow({ parent: main, modal: true, width: 520, height: 720 });
  auth.loadURL('https://example.com/login');
});
```

Supported window options include parent/modal relationships, frame and resize controls, always-on-top, opacity, transparency, min/max sizes, taskbar behavior, macOS title-bar styles and traffic-light positioning.

AtomJS does not install or execute Electron and does not bundle a private Chromium copy. Windows uses WebView2, macOS uses WKWebView, and Linux uses WebKitGTK.

Most applications should install the Electron-compatible alias:

```bash
npm install electron@npm:@atom-js-org/electron@alpha
```

Project: https://github.com/Atom-js-org/atom
