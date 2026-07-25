'use strict';

const WM_NCLBUTTONDOWN = 0x00A1;
const HTCAPTION = 2;
const VK_LBUTTON = 0x01;
const SM_CXDOUBLECLK = 36;
const SM_CYDOUBLECLK = 37;
const { Worker } = require('node:worker_threads');

let singleton = null;
let warned = false;

class WindowsNativeDragApi {
  constructor(koffi) {
    if (!koffi || typeof koffi.load !== 'function') {
      throw new TypeError('A Koffi module is required.');
    }

    const user32 = koffi.load('user32.dll');
    const pointType = koffi.struct('ATOMJS_WIN32_POINT', { x: 'long', y: 'long' });
    this.releaseCapture = user32.func('__stdcall', 'ReleaseCapture', 'bool', []);
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
    // Windows uses this point as the anchor for the native move loop. Sending
    // asynchronously with PostMessageW can process the message after the cursor
    // has moved, which is what causes the visible jump on Windows 11.
    const cursor = {};
    const cursorPosition = this.getCursorPos(cursor) ? packScreenPoint(cursor.x, cursor.y) : 0n;

    // SendMessageW blocks until the user releases the mouse. Keep that wait in a
    // short-lived worker so the AtomJS/renderer event loop remains responsive.
    this.releaseCapture();
    const worker = new Worker(WINDOWS_DRAG_WORKER, {
      eval: true,
      workerData: {
        handle,
        message: WM_NCLBUTTONDOWN,
        hitTest: HTCAPTION,
        cursorPosition
      }
    });
    worker.unref();
    worker.once('error', () => {});
    worker.once('exit', () => worker.removeAllListeners());
    return true;
  }
}

const WINDOWS_DRAG_WORKER = String.raw`
  const { workerData } = require('node:worker_threads');
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const releaseCapture = user32.func('__stdcall', 'ReleaseCapture', 'bool', []);
    const sendMessageW = user32.func(
      '__stdcall',
      'SendMessageW',
      'intptr_t',
      ['void *', 'uint32_t', 'uintptr_t', 'intptr_t']
    );
    releaseCapture();
    sendMessageW(
      BigInt(workerData.handle),
      workerData.message,
      workerData.hitTest,
      BigInt(workerData.cursorPosition)
    );
  } catch {}
`;


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

module.exports = {
  WindowsNativeDragApi,
  getWindowsNativeDragApi,
  nativeWindowHandle,
  packScreenPoint,
  constants: {
    WM_NCLBUTTONDOWN,
    HTCAPTION,
    VK_LBUTTON,
    SM_CXDOUBLECLK,
    SM_CYDOUBLECLK
  },
  WINDOWS_DRAG_WORKER
};
