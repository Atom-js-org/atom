'use strict';

const app = require('./app.cjs');
const { BrowserWindow } = require('./browser-window.cjs');
const ipcMain = require('./ipc-main.cjs');
const dialog = require('./dialog.cjs');
const shell = require('./shell.cjs');
const clipboard = require('./clipboard.cjs');
const { Menu, MenuItem, Tray } = require('./menu.cjs');
const electronApis = require('./electron-apis.cjs');

const nativeTheme = {
  get shouldUseDarkColors() {
    return process.env.ATOM_THEME === 'dark';
  },
  themeSource: 'system'
};

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  MenuItem,
  Tray,
  nativeTheme,
  ...electronApis
};
