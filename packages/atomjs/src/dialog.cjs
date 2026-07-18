'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const app = require('./app.cjs');
const { getNativeHost } = require('./native-host.cjs');

const execFileAsync = promisify(execFile);

async function showOpenDialog(browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(browserWindowOrOptions, maybeOptions);

  if (process.platform === 'darwin') {
    return macOSRequest('dialog-open', options);
  }

  try {
    const filePaths = await openDialogForPlatform(options);
    return { canceled: filePaths.length === 0, filePaths };
  } catch (error) {
    if (isCancellation(error)) return { canceled: true, filePaths: [] };
    throw error;
  }
}

async function showSaveDialog(browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(browserWindowOrOptions, maybeOptions);

  if (process.platform === 'darwin') {
    const result = await macOSRequest('dialog-save', options);
    return {
      canceled: Boolean(result.canceled),
      filePath: result.filePath || undefined
    };
  }

  try {
    const filePath = await saveDialogForPlatform(options);
    return { canceled: !filePath, filePath: filePath || undefined };
  } catch (error) {
    if (isCancellation(error)) return { canceled: true, filePath: undefined };
    throw error;
  }
}

async function showMessageBox(browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(browserWindowOrOptions, maybeOptions);
  const title = options.title || 'AtomJS';
  const message = options.message || '';

  if (process.platform === 'darwin') {
    return macOSRequest('dialog-message', { ...options, title, message });
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName PresentationFramework',
      `[System.Windows.MessageBox]::Show(${psQuote(message)}, ${psQuote(title)}) | Out-Null`
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  } else {
    await execFileAsync('zenity', ['--info', `--title=${title}`, `--text=${message}`]);
  }

  return { response: 0, checkboxChecked: false };
}

async function macOSRequest(command, options) {
  const host = getNativeHost(app.getName());
  return host.request({ command, options });
}

async function openDialogForPlatform(options) {
  const multiple = Array.isArray(options.properties) && options.properties.includes('multiSelections');

  if (process.platform === 'win32') {
    const filter = toWindowsFilter(options.filters);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Multiselect = $${multiple ? 'true' : 'false'}`,
      options.defaultPath ? `$d.InitialDirectory = ${psQuote(options.defaultPath)}` : '',
      filter ? `$d.Filter = ${psQuote(filter)}` : '',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }'
    ].filter(Boolean).join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' });
    return splitLines(stdout);
  }

  const args = ['--file-selection'];
  if (options.title) args.push(`--title=${options.title}`);
  if (options.defaultPath) args.push(`--filename=${options.defaultPath}`);
  if (multiple) args.push('--multiple', '--separator=\n');
  const { stdout } = await execFileAsync('zenity', args, { encoding: 'utf8' });
  return splitLines(stdout);
}

async function saveDialogForPlatform(options) {
  if (process.platform === 'win32') {
    const filter = toWindowsFilter(options.filters);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.SaveFileDialog',
      options.defaultPath ? `$d.FileName = ${psQuote(options.defaultPath)}` : '',
      filter ? `$d.Filter = ${psQuote(filter)}` : '',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }'
    ].filter(Boolean).join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' });
    return stdout.trim();
  }

  const args = ['--file-selection', '--save', '--confirm-overwrite'];
  if (options.title) args.push(`--title=${options.title}`);
  if (options.defaultPath) args.push(`--filename=${options.defaultPath}`);
  const { stdout } = await execFileAsync('zenity', args, { encoding: 'utf8' });
  return stdout.trim();
}

function normalizeOptions(first, second) {
  if (second && typeof second === 'object') return second;
  if (first && typeof first === 'object' && !('webContents' in first)) return first;
  return {};
}

function toWindowsFilter(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  return filters.map((filter) => {
    const extensions = (filter.extensions || ['*']).map((ext) => ext === '*' ? '*.*' : `*.${ext}`).join(';');
    return `${filter.name || 'Files'}|${extensions}`;
  }).join('|');
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isCancellation(error) {
  return error && (error.code === 1 || error.code === 'ENOENT' || /cancel/i.test(error.stderr || ''));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = { showOpenDialog, showSaveDialog, showMessageBox };
