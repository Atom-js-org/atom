'use strict';

const WM_NCLBUTTONDOWN = 0x00A1;
const HTCAPTION = 2;
const HTLEFT = 10;
const HTRIGHT = 11;
const HTTOP = 12;
const HTTOPLEFT = 13;
const HTTOPRIGHT = 14;
const HTBOTTOM = 15;
const HTBOTTOMLEFT = 16;
const HTBOTTOMRIGHT = 17;
const VK_LBUTTON = 0x01;
const SM_CXDOUBLECLK = 36;
const SM_CYDOUBLECLK = 37;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DEFAULT = 0;
const DWMWCP_ROUND = 2;

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
    return this.startWindowInteraction(nativeWindow, HTCAPTION);
  }

  startWindowResize(nativeWindow, hitTest) {
    if (!RESIZE_HIT_TESTS.has(Number(hitTest))) return false;
    return this.startWindowInteraction(nativeWindow, Number(hitTest));
  }

  startWindowInteraction(nativeWindow, hitTest) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n || !this.isLeftButtonDown()) return false;

    // Capture the click location before handing the window to DefWindowProc.
    // This is the stable Windows 10/11 path used by the known-good .4 build.
    // PostMessageW keeps the UI thread out of the modal move loop while Windows
    // still owns pointer movement, snapping and DPI transitions.
    const cursor = {};
    const cursorPosition = this.getCursorPos(cursor) ? packScreenPoint(cursor.x, cursor.y) : 0n;

    this.releaseCapture();
    return Boolean(this.postMessageW(handle, WM_NCLBUTTONDOWN, hitTest, cursorPosition));
  }
}

const RESIZE_HIT_TESTS = new Set([
  HTLEFT,
  HTRIGHT,
  HTTOP,
  HTTOPLEFT,
  HTTOPRIGHT,
  HTBOTTOM,
  HTBOTTOMLEFT,
  HTBOTTOMRIGHT
]);

class WindowsNativeShapeApi {
  constructor(koffi) {
    if (!koffi || typeof koffi.load !== 'function') {
      throw new TypeError('A Koffi module is required.');
    }

    const dwmapi = koffi.load('dwmapi.dll');
    this.dwmSetWindowAttribute = dwmapi.func(
      '__stdcall',
      'DwmSetWindowAttribute',
      'int',
      ['void *', 'uint32_t', 'uint32_t *', 'uint32_t']
    );
  }

  setRoundedCorners(nativeWindow, radius) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n) return false;
    if (Number(radius) <= 0) return this.clearRoundedCorners(nativeWindow);

    // DWM owns the non-client frame and adjusts it during live resize,
    // maximization, DPI changes and fullscreen transitions. SetWindowRgn does
    // not, which is why a manual region caused white seams and broken resizing.
    try {
      return Number(this.dwmSetWindowAttribute(
        handle,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        [DWMWCP_ROUND],
        4
      )) === 0;
    } catch {
      return false;
    }
  }

  clearRoundedCorners(nativeWindow) {
    const handle = nativeWindowHandle(nativeWindow);
    if (handle === 0n) return false;
    try {
      return Number(this.dwmSetWindowAttribute(
        handle,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        [DWMWCP_DEFAULT],
        4
      )) === 0;
    } catch {
      return false;
    }
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

module.exports = {
  WindowsNativeDragApi,
  WindowsNativeShapeApi,
  getWindowsNativeDragApi,
  getWindowsNativeShapeApi,
  nativeWindowHandle,
  packScreenPoint,
  constants: {
    WM_NCLBUTTONDOWN,
    HTCAPTION,
    HTLEFT,
    HTRIGHT,
    HTTOP,
    HTTOPLEFT,
    HTTOPRIGHT,
    HTBOTTOM,
    HTBOTTOMLEFT,
    HTBOTTOMRIGHT,
    VK_LBUTTON,
    SM_CXDOUBLECLK,
    SM_CYDOUBLECLK,
    DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_DEFAULT,
    DWMWCP_ROUND
  }
};
