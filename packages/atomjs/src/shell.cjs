'use strict';

const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function openExternal(url) {
  const target = String(url);
  return new Promise((resolve, reject) => {
    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/d', '/s', '/c', 'start', '', target.replace(/&/g, '^&')];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [target];
    } else {
      command = 'xdg-open';
      args = [target];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function openPath(filePath) {
  return openExternal(pathToFileURL(String(filePath)).href).then(() => '');
}

function showItemInFolder(fullPath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', ['/select,', String(fullPath)], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  openPath(require('node:path').dirname(String(fullPath))).catch(() => {});
}

module.exports = { openExternal, openPath, showItemInFolder };
