'use strict';

const bridge = globalThis.__ATOMJS_INTERNAL__;
if (!bridge) {
  throw new Error("electron/renderer is only available inside an AtomJS WebView preload context.");
}

exports.ipcRenderer = bridge.ipcRenderer;
exports.contextBridge = bridge.contextBridge;
exports.webFrame = bridge.webFrame || {};
exports.default = exports;
