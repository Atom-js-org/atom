'use strict';

const atom = require('@atom-js-org/runtime');

installElectronProcessMarkers();

function rendererOnlyApi(name) {
  const fail = () => {
    throw new Error(`${name} is a renderer-process Electron API. Use it from an AtomJS preload script.`);
  };
  return new Proxy({}, {
    get(_target, property) {
      if (property === Symbol.toStringTag) return name;
      if (property === 'then') return undefined;
      return fail;
    }
  });
}

function installElectronProcessMarkers() {
  defineIfMissing(process.versions, 'atomjs', atom.app && atom.app.getVersion ? atom.app.getVersion() : '0.2.0');
  // Presence of process.versions.electron is used by many Electron-oriented
  // packages as a runtime capability check. This is an AtomJS compatibility
  // version, not the version of the real Electron runtime.
  defineIfMissing(process.versions, 'electron', '0.2.0-atomjs.0');
  defineIfMissing(process, 'type', 'browser');
  defineIfMissing(process, 'defaultApp', true);
  defineIfMissing(process, 'resourcesPath', process.cwd());
}

function defineIfMissing(target, key, value) {
  if (target[key] !== undefined) return;
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: false,
      value
    });
  } catch {}
}

exports.app = atom.app;
exports.BaseWindow = atom.BaseWindow;
exports.BrowserWindow = atom.BrowserWindow;
exports.BrowserView = atom.BrowserView;
exports.WebContentsView = atom.WebContentsView;
exports.View = atom.View;
exports.ImageView = atom.ImageView;
exports.Menu = atom.Menu;
exports.MenuItem = atom.MenuItem;
exports.Tray = atom.Tray;
exports.Notification = atom.Notification;
exports.TouchBar = atom.TouchBar;
exports.MessageChannelMain = atom.MessageChannelMain;
exports.MessagePortMain = atom.MessagePortMain;
exports.ipcMain = atom.ipcMain;
exports.ipcRenderer = rendererOnlyApi('ipcRenderer');
exports.contextBridge = rendererOnlyApi('contextBridge');
exports.webFrame = rendererOnlyApi('webFrame');
exports.dialog = atom.dialog;
exports.shell = atom.shell;
exports.clipboard = atom.clipboard;
exports.nativeTheme = atom.nativeTheme;
exports.nativeImage = atom.nativeImage;
exports.session = atom.session;
exports.protocol = atom.protocol;
exports.net = atom.net;
exports.screen = atom.screen;
exports.webContents = atom.webContents;
exports.globalShortcut = atom.globalShortcut;
exports.powerSaveBlocker = atom.powerSaveBlocker;
exports.powerMonitor = atom.powerMonitor;
exports.systemPreferences = atom.systemPreferences;
exports.safeStorage = atom.safeStorage;
exports.desktopCapturer = atom.desktopCapturer;
exports.crashReporter = atom.crashReporter;
exports.autoUpdater = atom.autoUpdater;
exports.contentTracing = atom.contentTracing;
exports.netLog = atom.netLog;
exports.utilityProcess = atom.utilityProcess;
exports.pushNotifications = atom.pushNotifications;
exports.inAppPurchase = atom.inAppPurchase;
exports.parentPort = atom.parentPort;
exports.default = exports;
