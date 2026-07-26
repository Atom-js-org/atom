'use strict';

const WM_NCLBUTTONDOWN = 0x00A1;
const HTCAPTION = 2;
const VK_LBUTTON = 0x01;
const SM_CXDOUBLECLK = 36;
const SM_CYDOUBLECLK = 37;

let singleton = null;
let shapeSingleton = null;
let warned = false;

class WindowsNativeDragApi {
  constructor(koffi) {
    if (!koffi || typeof koffi.load !== 'function') {
      throw new TypeError('A Koffi module is required.');
    }

    const user32 = koffi.load('user32.dll');
    const pointType = koffi.struct('ATOMJS_WIN32_POINT', { x: 'long', y: 'long' });
    this.releaseCapture = user32.func('__stdcall', 'ReleaseCapture', 'bool', []);
    this.postMessageW = user32.func(
      '__stdcall',
      'PostMessageW',
      'bool',
      ['void *', 'uint32_t', 'uintptr_t', 'intptr_t']
    );
    this.getAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16_t', ['int']);
    this.getCursorPos = user32.func('__stdcall', 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(pointType))]);
    this.getDoubleClickTime = user32.func('__stdcall', 'GetDoubleClickTime', 'uint32_t', []);
    this.getSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
  }

  isLeftButtonDown() {
    return (Number(this.getAsyncKeyState(VK_LBUTTON)) & 0x8000) !== 0;
  }

  doubleClickSettings() {
    return {
      time: positiveInteger(this.getDoubleClickTime(), 500),
      width: positiveInteger(this.getSystemMetrics(SM_CXDOUBLECLK), 4),
      height: positiveInteger(this.getSystemMetrics(SM_CYDOUBLECLK), 4)
    };
  }

  startWindowDrag(nativeWindow) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n || !this.isLeftButtonDown()) return false;

    // Capture the click location before handing the window to DefWindowProc.
    // This is the stable Windows 10/11 path used by the known-good .4 build.
    // PostMessageW keeps the UI thread out of the modal move loop while Windows
    // still owns pointer movement, snapping and DPI transitions.
    const cursor = {};
    const cursorPosition = this.getCursorPos(cursor) ? packScreenPoint(cursor.x, cursor.y) : 0n;

    this.releaseCapture();
    return Boolean(this.postMessageW(handle, WM_NCLBUTTONDOWN, HTCAPTION, cursorPosition));
  }
}

class WindowsNativeShapeApi {
  constructor(koffi) {
    if (!koffi || typeof koffi.load !== 'function') {
      throw new TypeError('A Koffi module is required.');
    }

    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    this.createRoundRectRgn = gdi32.func(
      '__stdcall',
      'CreateRoundRectRgn',
      'void *',
      ['int', 'int', 'int', 'int', 'int', 'int']
    );
    this.setWindowRgn = user32.func(
      '__stdcall',
      'SetWindowRgn',
      'int',
      ['void *', 'void *', 'bool']
    );
    this.deleteObject = gdi32.func('__stdcall', 'DeleteObject', 'bool', ['void *']);
  }

  setRoundedCorners(nativeWindow, radius) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n) return false;

    const size = nativeWindowSize(nativeWindow);
    if (!size || size.width < 2 || size.height < 2) return false;

    const clampedRadius = Math.max(0, Math.min(
      Math.round(Number(radius) || 0),
      Math.floor(Math.min(size.width, size.height) / 2)
    ));
    if (clampedRadius === 0) return false;

    const region = this.createRoundRectRgn(
      0,
      0,
      size.width + 1,
      size.height + 1,
      clampedRadius * 2,
      clampedRadius * 2
    );
    if (!region) return false;

    const applied = Number(this.setWindowRgn(handle, region, true)) !== 0;
    if (!applied) {
      try { this.deleteObject(region); } catch {}
    }
    return applied;
  }

  clearRoundedCorners(nativeWindow) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n) return false;
    // Passing NULL removes the HRGN owned by the window. Maximized and
    // fullscreen windows must be rectangular or DWM can expose a bright
    // backdrop through the clipped corners.
    try { return Number(this.setWindowRgn(handle, null, true)) !== 0; } catch { return false; }
  }
}

function packScreenPoint(x, y) {
  const xWord = BigInt.asUintN(16, BigInt(Math.trunc(Number(x) || 0)));
  const yWord = BigInt.asUintN(16, BigInt(Math.trunc(Number(y) || 0)));
  return BigInt.asIntN(32, xWord | (yWord << 16n));
}

function nativeWindowHandle(nativeWindow) {
  if (!nativeWindow) return 0n;

  let value = 0n;
  try {
    if (typeof nativeWindow.getNativeHandleAnyThread === 'function') {
      value = nativeWindow.getNativeHandleAnyThread();
    } else if (typeof nativeWindow.getNativeHandle === 'function') {
      value = nativeWindow.getNativeHandle();
    }
  } catch {
    return 0n;
  }

  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function getWindowsNativeDragApi() {
  if (process.platform !== 'win32') return null;
  if (singleton) return singleton;

  try {
    singleton = new WindowsNativeDragApi(require('koffi'));
    return singleton;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn([
        '[AtomJS] Native Windows window dragging could not be initialized.',
        'Run npm install so the prebuilt koffi Windows package is present.',
        error && error.message ? error.message : String(error)
      ].join('\n'));
    }
    return null;
  }
}

function getWindowsNativeShapeApi() {
  if (process.platform !== 'win32') return null;
  if (shapeSingleton) return shapeSingleton;

  try {
    shapeSingleton = new WindowsNativeShapeApi(require('koffi'));
    return shapeSingleton;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn([
        '[AtomJS] Native Windows rounded-window support could not be initialized.',
        error && error.message ? error.message : String(error)
      ].join('\n'));
    }
    return null;
  }
}

function nativeWindowSize(nativeWindow) {
  try {
    const size = nativeWindow.getOuterSize(false);
    const width = Math.round(Number(size && size.width));
    const height = Math.round(Number(size && size.height));
    if (width > 0 && height > 0) return { width, height };
  } catch {}
  return null;
}

module.exports = {
  WindowsNativeDragApi,
  WindowsNativeShapeApi,
  getWindowsNativeDragApi,
  getWindowsNativeShapeApi,
  nativeWindowHandle,
  nativeWindowSize,
  packScreenPoint,
  constants: {
    WM_NCLBUTTONDOWN,
    HTCAPTION,
    VK_LBUTTON,
    SM_CXDOUBLECLK,
    SM_CYDOUBLECLK
  }
};
