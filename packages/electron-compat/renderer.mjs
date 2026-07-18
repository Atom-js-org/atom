const bridge = globalThis.__ATOMJS_INTERNAL__;
if (!bridge) {
  throw new Error('electron/renderer is only available inside an AtomJS WebView preload context.');
}

export const ipcRenderer = bridge.ipcRenderer;
export const contextBridge = bridge.contextBridge;
export const webFrame = bridge.webFrame || {};
export default { ipcRenderer, contextBridge, webFrame };
