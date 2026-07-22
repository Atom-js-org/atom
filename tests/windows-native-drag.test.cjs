'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WindowsNativeDragApi,
  nativeWindowHandle,
  packScreenPoint,
  constants
} = require('../packages/atomjs/src/windows-native-drag.cjs');
const { isSystemDoubleClick } = require('../packages/atomjs/src/windows-native-host.cjs');

function fakeKoffi(overrides = {}) {
  const calls = [];
  const functions = {
    ReleaseCapture: () => { calls.push(['ReleaseCapture']); return true; },
    PostMessageW: (...args) => { calls.push(['PostMessageW', ...args]); return true; },
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

test('Windows drag hands the HWND to the native Windows move loop', () => {
  const fake = fakeKoffi();
  const api = new WindowsNativeDragApi(fake.module);
  const win = { getNativeHandleAnyThread: () => 0x1234n };

  assert.equal(api.startWindowDrag(win), true);
  assert.deepEqual(fake.calls, [
    ['ReleaseCapture'],
    ['PostMessageW', 0x1234n, constants.WM_NCLBUTTONDOWN, constants.HTCAPTION, packScreenPoint(-120, 85)]
  ]);
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

test('Windows title-bar double click follows system time and rectangle settings', () => {
  const record = { lastDragClick: null };
  const settings = { time: 500, width: 8, height: 10 };

  assert.equal(isSystemDoubleClick(record, { x: 100, y: 50 }, settings), false);
  record.lastDragClick.time = Date.now() - 100;
  assert.equal(isSystemDoubleClick(record, { x: 103, y: 54 }, settings), true);

  record.lastDragClick = { time: Date.now() - 100, x: 100, y: 50 };
  assert.equal(isSystemDoubleClick(record, { x: 106, y: 50 }, settings), false);
});
