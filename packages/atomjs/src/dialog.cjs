'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function showOpenDialog(_browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(_browserWindowOrOptions, maybeOptions);
  try {
    const filePaths = await openDialogForPlatform(options);
    return { canceled: filePaths.length === 0, filePaths };
  } catch (error) {
    if (isCancellation(error)) return { canceled: true, filePaths: [] };
    throw error;
  }
}

async function showSaveDialog(_browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(_browserWindowOrOptions, maybeOptions);
  try {
    const filePath = await saveDialogForPlatform(options);
    return { canceled: !filePath, filePath: filePath || undefined };
  } catch (error) {
    if (isCancellation(error)) return { canceled: true, filePath: undefined };
    throw error;
  }
}

async function showMessageBox(_browserWindowOrOptions, maybeOptions) {
  const options = normalizeOptions(_browserWindowOrOptions, maybeOptions);
  const title = options.title || 'AtomJS';
  const message = options.message || '';

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName PresentationFramework',
      `[System.Windows.MessageBox]::Show(${psQuote(message)}, ${psQuote(title)}) | Out-Null`
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  } else if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', `display dialog ${appleQuote(message)} with title ${appleQuote(title)} buttons {"OK"} default button "OK"`]);
  } else {
    await execFileAsync('zenity', ['--info', `--title=${title}`, `--text=${message}`]);
  }

  return { response: 0, checkboxChecked: false };
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

  if (process.platform === 'darwin') {
    const prompt = options.title || 'Choose a file';
    const script = multiple
      ? `set chosenFiles to choose file with prompt ${appleQuote(prompt)} with multiple selections allowed\nset output to ""\nrepeat with f in chosenFiles\nset output to output & POSIX path of f & linefeed\nend repeat\nreturn output`
      : `POSIX path of (choose file with prompt ${appleQuote(prompt)})`;
    const { stdout } = await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' });
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

  if (process.platform === 'darwin') {
    const defaultName = options.defaultPath ? String(options.defaultPath).split(/[\\/]/).pop() : 'Untitled';
    const script = `POSIX path of (choose file name with prompt ${appleQuote(options.title || 'Save file')} default name ${appleQuote(defaultName)})`;
    const { stdout } = await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' });
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

function appleQuote(value) {
  return JSON.stringify(String(value));
}

module.exports = { showOpenDialog, showSaveDialog, showMessageBox };
