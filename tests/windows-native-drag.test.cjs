'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WindowsNativeDragApi,
  WindowsNativeShapeApi,
  nativeWindowHandle,
  packScreenPoint,
  constants
} = require('../packages/atomjs/src/windows-native-drag.cjs');
const { isSystemDoubleClick, parseColor } = require('../packages/atomjs/src/windows-native-host.cjs');

function fakeKoffi(overrides = {}) {
  const calls = [];
  const functions = {
    ReleaseCapture: () => { calls.push(['ReleaseCapture']); return true; },
    PostMessageW: () => { calls.push(['PostMessageW']); return true; },
    GetAsyncKeyState: () => 0x8000,
    GetCursorPos: (point) => { point.x = -120; point.y = 85; return true; },
    GetDoubleClickTime: () => 500,
    GetSystemMetrics: (index) => index === constants.SM_CXDOUBLECLK ? 8 : 10,
    ...overrides
  };
  return {
    calls,
    module: {
      struct() { return Symbol('POINT'); },
      pointer(type) { return { pointer: type }; },
      out(type) { return { out: type }; },
      load(name) {
        assert.equal(name, 'user32.dll');
        return {
          func(_convention, name) {
            assert.equal(typeof functions[name], 'function', `unexpected native function ${name}`);
            return functions[name];
          }
        };
      }
    }
  };
}

function fakeDwmKoffi() {
  const calls = [];
  return {
    calls,
    module: {
      load(name) {
        assert.equal(name, 'dwmapi.dll');
        return {
          func(_convention, name) {
            assert.equal(name, 'DwmSetWindowAttribute');
            return (...args) => { calls.push(args); return 0; };
          }
        };
      }
    }
  };
}

test('Windows drag starts the native Windows move loop without blocking Node', () => {
  const fake = fakeKoffi();
  const api = new WindowsNativeDragApi(fake.module);
  const win = { getNativeHandleAnyThread: () => 0x1234n };

  assert.equal(api.startWindowDrag(win), true);
  assert.deepEqual(fake.calls, [['ReleaseCapture'], ['PostMessageW']]);
});

test('Windows drag does not enter move mode after the left button was released', () => {
  const fake = fakeKoffi({ GetAsyncKeyState: () => 0 });
  const api = new WindowsNativeDragApi(fake.module);

  assert.equal(api.startWindowDrag({ getNativeHandleAnyThread: () => 5n }), false);
  assert.deepEqual(fake.calls, []);
});

test('Win32 screen coordinates preserve negative multi-monitor positions', () => {
  const packed = packScreenPoint(-120, -45);
  assert.equal(Number(BigInt.asIntN(16, packed)), -120);
  assert.equal(Number(BigInt.asIntN(16, packed >> 16n)), -45);
});

test('Windows native handles remain pointer-sized BigInts', () => {
  assert.equal(nativeWindowHandle({ getNativeHandleAnyThread: () => 0x1_0000_0001n }), 0x1_0000_0001n);
  assert.equal(nativeWindowHandle({ getNativeHandle: () => 42 }), 42n);
  assert.equal(nativeWindowHandle(null), 0n);
});

test('Windows 11 uses DWM corner preferences instead of clipping the window region', () => {
  const fake = fakeDwmKoffi();
  const api = new WindowsNativeShapeApi(fake.module);
  const win = { getNativeHandleAnyThread: () => 0x1234n };

  assert.equal(api.setRoundedCorners(win, 18), true);
  assert.equal(api.clearRoundedCorners(win), true);
  assert.deepEqual(fake.calls, [
    [0x1234n, constants.DWMWA_WINDOW_CORNER_PREFERENCE, [constants.DWMWCP_ROUND], 4],
    [0x1234n, constants.DWMWA_WINDOW_CORNER_PREFERENCE, [constants.DWMWCP_DEFAULT], 4]
  ]);
});

test('Windows title-bar double click follows system time and rectangle settings', () => {
  const record = { lastDragClick: null };
  const settings = { time: 500, width: 8, height: 10 };

  assert.equal(isSystemDoubleClick(record, { x: 100, y: 50 }, settings), false);
  record.lastDragClick.time = Date.now() - 100;
  assert.equal(isSystemDoubleClick(record, { x: 103, y: 54 }, settings), true);

  record.lastDragClick = { time: Date.now() - 100, x: 100, y: 50 };
  assert.equal(isSystemDoubleClick(record, { x: 106, y: 50 }, settings), false);
});

test('Windows transparent WebView backgrounds do not paint an opaque white rectangle', () => {
  assert.deepEqual(parseColor('#ffffff', true), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColor('#123456', false), { r: 18, g: 52, b: 86, a: 255 });
  assert.deepEqual(parseColor('#12345678', true), { r: 18, g: 52, b: 86, a: 120 });
});
