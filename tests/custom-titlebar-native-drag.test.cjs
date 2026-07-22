'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('custom title bars publish layout regions instead of relaying pointer movement', () => {
  const bridge = source('packages/atomjs/src/bridge-script.cjs');

  assert.match(bridge, /command: 'set-window-drag-regions'/);
  assert.match(bridge, /new MutationObserver\(scheduleWindowDragRegionUpdate\)/);
  assert.match(bridge, /getBoundingClientRect\(\)/);
  assert.doesNotMatch(bridge, /document\.addEventListener\('mousedown',[\s\S]*start-window-drag/);
  assert.doesNotMatch(bridge, /pointermove[\s\S]*set-bounds/);
});


test('Windows custom title bars use the native Win32 move loop', () => {
  const host = source('packages/atomjs/src/windows-native-host.cjs');
  const nativeDrag = source('packages/atomjs/src/windows-native-drag.cjs');

  assert.match(host, /_startNativeWindowDrag/);
  assert.match(nativeDrag, /ReleaseCapture/);
  assert.match(nativeDrag, /PostMessageW/);
  assert.match(nativeDrag, /WM_NCLBUTTONDOWN/);
  assert.doesNotMatch(host, /_continueWindowDrag|setPosition\([\s\S]*offsetX/);
});

test('macOS custom title bars use the original AppKit mouse event', () => {
  const host = source('packages/atomjs/src/runtime/macos-native-host.m');

  assert.match(host, /@interface AtomJSDraggableContentView : NSView/);
  assert.match(host, /- \(NSView \*\)hitTest:\(NSPoint\)point/);
  assert.match(host, /performWindowDragWithEvent:event/);
  assert.doesNotMatch(host, /mouseEventWithType:NSEventTypeLeftMouseDown/);
  assert.match(host, /if \(!AtomJSBoolean\(region\[@"draggable"\], NO\)\) return NO;/);
});

test('macOS BrowserWindow bounds use a top-left virtual desktop coordinate system', () => {
  const host = source('packages/atomjs/src/runtime/macos-native-host.m');
  const browserWindow = source('packages/atomjs/src/browser-window.cjs');

  assert.match(host, /static NSRect AtomJSVirtualDesktopFrame\(void\)/);
  assert.match(host, /NSMaxY\(virtualDesktop\) - atomY - height/);
  assert.match(host, /NSMaxY\(virtualDesktop\) - NSMaxY\(frame\)/);
  assert.match(host, /@"type": @"bounds-changed"/);
  assert.match(browserWindow, /event\.type === 'bounds-changed'/);
});

