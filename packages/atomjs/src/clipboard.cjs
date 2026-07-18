'use strict';

const { execFileSync, spawnSync } = require('node:child_process');

function writeText(text) {
  const value = String(text);
  if (process.platform === 'win32') {
    const script = `Set-Clipboard -Value ${psQuote(value)}`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script]);
    return;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('pbcopy', [], { input: value, encoding: 'utf8' });
    if (result.error) throw result.error;
    return;
  }
  let result = spawnSync('wl-copy', [], { input: value, encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    result = spawnSync('xclip', ['-selection', 'clipboard'], { input: value, encoding: 'utf8' });
  }
  if (result.error) throw new Error('Install wl-clipboard or xclip to use clipboard.writeText on Linux');
}

function readText() {
  if (process.platform === 'win32') {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).replace(/\r?\n$/, '');
  }
  if (process.platform === 'darwin') {
    return execFileSync('pbpaste', [], { encoding: 'utf8' });
  }
  try {
    return execFileSync('wl-paste', ['--no-newline'], { encoding: 'utf8' });
  } catch {
    try {
      return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
    } catch {
      throw new Error('Install wl-clipboard or xclip to use clipboard.readText on Linux');
    }
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = { writeText, readText };
