# @atom-js-org/electron

Electron-compatible imports for AtomJS. This package does **not** contain the Electron runtime and does not bundle Chromium.

Install it under the local package name `electron`:

```bash
npm install electron@npm:@atom-js-org/electron@alpha
npm install --save-dev @atom-js-org/cli@alpha
```

Existing code can continue to use:

```js
const { app, BrowserWindow } = require('electron');
```

Project: https://github.com/Atom-js-org/atom
