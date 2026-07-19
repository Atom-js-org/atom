import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const EVENT_PREFIX = '__ATOMJS_EVENT__';
const configPath = process.argv[2];
if (!configPath) {
  console.error('AtomJS window host expected a configuration file');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('Unable to read AtomJS window configuration:', error);
  process.exit(1);
} finally {
  fs.rmSync(configPath, { force: true });
}

if (process.platform === 'darwin') {
  console.error('AtomJS macOS windows must use the shared native Cocoa host, not the legacy Node window host.');
  process.exit(1);
}

let Webview;
let SizeHint;
try {
  ({ Webview, SizeHint } = await import('webview-nodejs'));
} catch (error) {
  console.error('\nAtomJS could not load the system WebView binding.');
  console.error('Windows and Linux currently require the webview-nodejs package.');
  console.error('Run `atom doctor`, install the platform prerequisites, then install dependencies again.');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}

function emit(event) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

function configureWindowsWindow(options) {
  const parentProcessId = Number(options.parentProcessId || 0);
  const modal = Boolean(options.modal && parentProcessId > 0);
  const env = {
    ...process.env,
    ATOMJS_CHILD_PID: String(process.pid),
    ATOMJS_PARENT_PID: String(parentProcessId || 0),
    ATOMJS_MODAL: modal ? '1' : '0',
    ATOMJS_FRAME: options.frame === false ? '0' : '1',
    ATOMJS_RESIZABLE: options.resizable === false ? '0' : '1',
    ATOMJS_MINIMIZABLE: options.minimizable === false ? '0' : '1',
    ATOMJS_MAXIMIZABLE: options.maximizable === false ? '0' : '1',
    ATOMJS_CLOSABLE: options.closable === false ? '0' : '1',
    ATOMJS_ALWAYS_ON_TOP: options.alwaysOnTop ? '1' : '0',
    ATOMJS_FOCUSABLE: options.focusable === false ? '0' : '1',
    ATOMJS_SKIP_TASKBAR: options.skipTaskbar ? '1' : '0',
    ATOMJS_TRANSPARENT: options.transparent ? '1' : '0',
    ATOMJS_OPACITY: String(normalizeOpacity(options.opacity)),
    ATOMJS_CENTER: options.center === false ? '0' : '1',
    ATOMJS_SHOW: options.show === false ? '0' : '1',
    ATOMJS_X: Number.isFinite(Number(options.x)) ? String(Math.round(Number(options.x))) : '',
    ATOMJS_Y: Number.isFinite(Number(options.y)) ? String(Math.round(Number(options.y))) : ''
  };

  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', WINDOWS_WINDOW_SETUP
  ], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    console.warn(`[AtomJS] Could not configure the native Windows window: ${result.error.message}`);
  } else if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    if (detail) console.warn(`[AtomJS] Could not configure every native Windows option: ${detail}`);
  }

  return modal ? { parentProcessId } : null;
}

function releaseWindowsModal(ownership) {
  if (!ownership || !ownership.parentProcessId) return;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', WINDOWS_MODAL_RELEASE
  ], {
    env: {
      ...process.env,
      ATOMJS_PARENT_PID: String(ownership.parentProcessId)
    },
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    console.warn(`[AtomJS] Could not restore the parent Windows window: ${result.error.message}`);
  }
}

function normalizeOpacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

const WINDOWS_INTEROP = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AtomJSNativeWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetParent(IntPtr hWnd);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
  private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);

  [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
  private static extern IntPtr GetWindowLongPtr32(IntPtr hWnd, int index);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
  private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);

  [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
  private static extern IntPtr SetWindowLongPtr32(IntPtr hWnd, int index, IntPtr value);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint attachThreadId, uint attachToThreadId, bool attach);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern IntPtr SetActiveWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  public static extern bool EnableWindow(IntPtr hWnd, bool enabled);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);

  [DllImport("user32.dll")]
  public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool revert);

  [DllImport("user32.dll")]
  public static extern bool DeleteMenu(IntPtr menu, uint position, uint flags);

  [DllImport("user32.dll")]
  public static extern bool DrawMenuBar(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static IntPtr GetWindowLongPtr(IntPtr hWnd, int index) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index) : GetWindowLongPtr32(hWnd, index);
  }

  public static IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value) {
    return IntPtr.Size == 8 ? SetWindowLongPtr64(hWnd, index, value) : SetWindowLongPtr32(hWnd, index, value);
  }

  public static IntPtr FindWindowForProcess(uint expectedProcessId) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((window, state) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId == expectedProcessId && GetParent(window) == IntPtr.Zero) {
        result = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

function Find-AtomWindow([uint32] $ProcessId) {
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $window = [AtomJSNativeWindow]::FindWindowForProcess($ProcessId)
    if ($window -ne [IntPtr]::Zero) { return $window }
    Start-Sleep -Milliseconds 40
  }
  return [IntPtr]::Zero
}
`;

const WINDOWS_WINDOW_SETUP = WINDOWS_INTEROP + String.raw`
$child = Find-AtomWindow ([uint32]$env:ATOMJS_CHILD_PID)
if ($child -eq [IntPtr]::Zero) { throw 'The AtomJS WebView window handle was not found.' }

$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$GWLP_HWNDPARENT = -8
$WS_CAPTION = 0x00C00000L
$WS_THICKFRAME = 0x00040000L
$WS_MINIMIZEBOX = 0x00020000L
$WS_MAXIMIZEBOX = 0x00010000L
$WS_EX_TOOLWINDOW = 0x00000080L
$WS_EX_APPWINDOW = 0x00040000L
$WS_EX_LAYERED = 0x00080000L
$WS_EX_NOACTIVATE = 0x08000000L
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW = 0x0040
$SC_CLOSE = 0xF060
$MF_BYCOMMAND = 0x0000
$LWA_ALPHA = 0x00000002

$style = [AtomJSNativeWindow]::GetWindowLongPtr($child, $GWL_STYLE).ToInt64()
if ($env:ATOMJS_FRAME -eq '0') { $style = $style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME)) }
if ($env:ATOMJS_RESIZABLE -eq '0') { $style = $style -band (-bnot $WS_THICKFRAME) }
if ($env:ATOMJS_MINIMIZABLE -eq '0') { $style = $style -band (-bnot $WS_MINIMIZEBOX) }
if ($env:ATOMJS_MAXIMIZABLE -eq '0') { $style = $style -band (-bnot $WS_MAXIMIZEBOX) }
[void][AtomJSNativeWindow]::SetWindowLongPtr($child, $GWL_STYLE, [IntPtr]$style)

$extendedStyle = [AtomJSNativeWindow]::GetWindowLongPtr($child, $GWL_EXSTYLE).ToInt64()
if ($env:ATOMJS_SKIP_TASKBAR -eq '1') {
  $extendedStyle = ($extendedStyle -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
}
if ($env:ATOMJS_FOCUSABLE -eq '0') {
  $extendedStyle = $extendedStyle -bor $WS_EX_NOACTIVATE
} else {
  $extendedStyle = $extendedStyle -band (-bnot $WS_EX_NOACTIVATE)
}
$opacity = [Math]::Max(0.0, [Math]::Min(1.0, [double]$env:ATOMJS_OPACITY))
if ($env:ATOMJS_TRANSPARENT -eq '1' -or $opacity -lt 1.0) {
  $extendedStyle = $extendedStyle -bor $WS_EX_LAYERED
}
[void][AtomJSNativeWindow]::SetWindowLongPtr($child, $GWL_EXSTYLE, [IntPtr]$extendedStyle)

if ($env:ATOMJS_CLOSABLE -eq '0') {
  $menu = [AtomJSNativeWindow]::GetSystemMenu($child, $false)
  if ($menu -ne [IntPtr]::Zero) {
    [void][AtomJSNativeWindow]::DeleteMenu($menu, $SC_CLOSE, $MF_BYCOMMAND)
    [void][AtomJSNativeWindow]::DrawMenuBar($child)
  }
}

$alpha = [byte][Math]::Round($opacity * 255.0)
if ($env:ATOMJS_TRANSPARENT -eq '1' -or $opacity -lt 1.0) {
  [void][AtomJSNativeWindow]::SetLayeredWindowAttributes($child, 0, $alpha, $LWA_ALPHA)
}

$parent = [IntPtr]::Zero
if ([uint32]$env:ATOMJS_PARENT_PID -gt 0) {
  $parent = Find-AtomWindow ([uint32]$env:ATOMJS_PARENT_PID)
  if ($parent -ne [IntPtr]::Zero) {
    [void][AtomJSNativeWindow]::SetWindowLongPtr($child, $GWLP_HWNDPARENT, $parent)
    if ($env:ATOMJS_MODAL -eq '1') { [void][AtomJSNativeWindow]::EnableWindow($parent, $false) }
  }
}

$rect = New-Object AtomJSNativeWindow+RECT
[void][AtomJSNativeWindow]::GetWindowRect($child, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$x = $rect.Left
$y = $rect.Top
if ($env:ATOMJS_CENTER -eq '1' -and $parent -ne [IntPtr]::Zero) {
  $parentRect = New-Object AtomJSNativeWindow+RECT
  [void][AtomJSNativeWindow]::GetWindowRect($parent, [ref]$parentRect)
  $x = $parentRect.Left + [Math]::Max(0, (($parentRect.Right - $parentRect.Left) - $width) / 2)
  $y = $parentRect.Top + [Math]::Max(0, (($parentRect.Bottom - $parentRect.Top) - $height) / 2)
} elseif ($env:ATOMJS_CENTER -eq '1') {
  $x = [Math]::Max(0, ([AtomJSNativeWindow]::GetSystemMetrics(0) - $width) / 2)
  $y = [Math]::Max(0, ([AtomJSNativeWindow]::GetSystemMetrics(1) - $height) / 2)
}
if ($env:ATOMJS_X -ne '') { $x = [int]$env:ATOMJS_X }
if ($env:ATOMJS_Y -ne '') { $y = [int]$env:ATOMJS_Y }

$insertAfter = if ($env:ATOMJS_ALWAYS_ON_TOP -eq '1') { [IntPtr](-1) } else { [IntPtr]::Zero }
$positionFlags = $SWP_FRAMECHANGED
if ($env:ATOMJS_SHOW -ne '0') { $positionFlags = $positionFlags -bor $SWP_SHOWWINDOW }
[void][AtomJSNativeWindow]::SetWindowPos($child, $insertAfter, [int]$x, [int]$y, $width, $height, $positionFlags)
if ($env:ATOMJS_SHOW -eq '0') {
  [void][AtomJSNativeWindow]::ShowWindow($child, 0)
} else {
  [void][AtomJSNativeWindow]::ShowWindow($child, 5)
  [void][AtomJSNativeWindow]::BringWindowToTop($child)
}
if ($env:ATOMJS_SHOW -ne '0' -and $env:ATOMJS_FOCUSABLE -ne '0') {
  # WebView windows live in helper processes. Temporarily attach the setup
  # thread to the foreground and WebView UI threads so Windows accepts the
  # activation request instead of leaving OAuth/login windows behind the app.
  $foreground = [AtomJSNativeWindow]::GetForegroundWindow()
  [uint32]$foregroundProcess = 0
  [uint32]$childProcess = 0
  $foregroundThread = if ($foreground -ne [IntPtr]::Zero) {
    [AtomJSNativeWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
  } else { 0 }
  $childThread = [AtomJSNativeWindow]::GetWindowThreadProcessId($child, [ref]$childProcess)
  $currentThread = [AtomJSNativeWindow]::GetCurrentThreadId()
  $attachedForeground = $false
  $attachedChild = $false

  try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
      $attachedForeground = [AtomJSNativeWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    if ($childThread -ne 0 -and $childThread -ne $currentThread) {
      $attachedChild = [AtomJSNativeWindow]::AttachThreadInput($currentThread, $childThread, $true)
    }
    [void][AtomJSNativeWindow]::BringWindowToTop($child)
    [void][AtomJSNativeWindow]::SetActiveWindow($child)
    [void][AtomJSNativeWindow]::SetForegroundWindow($child)
    [void][AtomJSNativeWindow]::SetFocus($child)
  } finally {
    if ($attachedChild) {
      [void][AtomJSNativeWindow]::AttachThreadInput($currentThread, $childThread, $false)
    }
    if ($attachedForeground) {
      [void][AtomJSNativeWindow]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
  }
}
`;

const WINDOWS_MODAL_RELEASE = WINDOWS_INTEROP + String.raw`
$parent = Find-AtomWindow ([uint32]$env:ATOMJS_PARENT_PID)
if ($parent -ne [IntPtr]::Zero) {
  [void][AtomJSNativeWindow]::EnableWindow($parent, $true)
  [void][AtomJSNativeWindow]::ShowWindow($parent, 5)
  [void][AtomJSNativeWindow]::BringWindowToTop($parent)
  [void][AtomJSNativeWindow]::SetForegroundWindow($parent)
}
`;

async function main() {
  let view = null;
  let windowsOwnership = null;
  try {
    view = new Webview(Boolean(config.debug));
    view.title(String(config.title || 'AtomJS App'));

    const width = Number(config.width || 800);
    const height = Number(config.height || 600);
    view.size(
      width,
      height,
      config.resizable === false ? SizeHint.Fixed : SizeHint.None
    );

    if (Number(config.minWidth) > 0 || Number(config.minHeight) > 0) {
      view.size(
        Number(config.minWidth) > 0 ? Number(config.minWidth) : width,
        Number(config.minHeight) > 0 ? Number(config.minHeight) : height,
        SizeHint.Min
      );
    }
    if (Number(config.maxWidth) > 0 || Number(config.maxHeight) > 0) {
      view.size(
        Number(config.maxWidth) > 0 ? Number(config.maxWidth) : width,
        Number(config.maxHeight) > 0 ? Number(config.maxHeight) : height,
        SizeHint.Max
      );
    }

    view.init(String(config.bridgeScript || ''));
    view.navigate(String(config.url));

    if (process.platform === 'win32') {
      windowsOwnership = configureWindowsWindow(config);
    }

    emit({ type: 'created', windowId: Number(config.windowId || 0), pid: process.pid });
    view.show();
  } catch (error) {
    console.error('AtomJS native window failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (process.platform === 'win32') releaseWindowsModal(windowsOwnership);
  }
}

await main();
