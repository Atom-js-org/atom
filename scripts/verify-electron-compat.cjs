'use strict';

const assert = require('node:assert/strict');

(async () => {
  const commonjs = require('electron');
  const esm = await import('electron');

  assert.equal(typeof commonjs.BrowserWindow, 'function');
  assert.equal(esm.BrowserWindow, commonjs.BrowserWindow);
  assert.match(process.versions.electron, /atomjs/);

  const window = new commonjs.BrowserWindow({ show: false });
  window.setMenu(null);
  assert.equal(window.getMenu(), null);

  let loads = 0;
  window.webContents.on('did-finish-load', () => loads++);
  window._markRendererReady({ href: 'https://example.test/login' });
  window._markRendererReady({ href: 'https://example.test/callback?code=ok' });
  assert.equal(loads, 2);
  assert.equal(window.webContents.getURL(), 'https://example.test/callback?code=ok');

  window.destroy();
  console.log('AtomJS Electron compatibility check passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
