# Changelog

## 0.5.2-alpha.0

- Added Electron-compatible `-webkit-app-region: drag` handling for custom title bars.
- Uses AppKit's native `performWindowDragWithEvent:` operation instead of repeated renderer-driven `setBounds()` calls.
- Added `data-atom-drag-region` and `data-atom-no-drag` fallbacks for system WebViews that do not expose the Electron CSS property.
- Added `BrowserWindow.startDrag()` for explicit main-process native dragging.

## 0.5.1-alpha.0

- Fixes macOS native-host compilation on SDKs where `WKWebView.drawsBackground` is not a public Objective-C property.
- Configures transparent WKWebView backgrounds through guarded runtime/KVC calls and the public under-page color when available.

## 0.5.0-alpha.0

- Brings Windows OAuth and secondary WebView windows to the foreground, with native owner/modal relationships when a parent is supplied.
- Expands `BrowserWindow` customization with parent, modal, always-on-top, opacity, transparency, frame, title-bar, traffic-light, taskbar and size-constraint options.
- Adds configurable Windows executable metadata and icons plus customizable NSIS branding, install scope, shortcuts, text and installation directory.
- Adds configurable macOS app icons, bundle metadata, signing identity, entitlements, hardened runtime, artifact names and DMG assets.
- Adds Linux standalone binaries, portable tarballs, AppDir, AppImage, Debian packages and RPM packages when `rpmbuild` is available.
- Generates starter projects with usable PNG/ICO icons and a documented cross-platform build configuration.

## 0.4.5-alpha.0

- Creates macOS DMG images entirely on the local temporary filesystem before copying them to the project output.
- Prevents `hdiutil: create failed - Operation not permitted` when projects are built from external, removable, network, or non-APFS volumes.
- Treats DMG creation as optional by default so a valid signed `.app` and ZIP are not discarded when `hdiutil` fails; set `ATOM_REQUIRE_DMG=1` to require a DMG.

## 0.4.4-alpha.0

- Build and sign macOS application bundles on local temporary storage before copying them to the project output.
- Remove AppleDouble (`._*`), `.DS_Store`, `__MACOSX`, and extended-attribute metadata before code signing.
- Archive macOS releases with `ditto --norsrc` to prevent resource-fork sidecars in ZIP files.
- Fix code-signing failures for projects stored on exFAT and other external volumes.

## 0.4.3-alpha.0

- Fixed macOS development windows by waiting for AppKit to finish launching before accepting native-host commands.
- Added acknowledged native window creation and native-host error reporting.
- Runs the macOS development host from an application bundle with the project name and icon instead of `AtomJSWindowHost` branding.
- Added a built-in AtomJS Dock icon when a project icon is not configured.
- Fixed `codesign` detection so macOS SEA executables and app bundles are actually re-signed after injection.
- Passes application identity and icon metadata to the native macOS host in development and packaged builds.

## 0.4.2-alpha.0

- Fixed Windows PE signature validation after SEA preparation.
- Added strict PE optional-header bounds checks before signature removal and GUI subsystem updates.
- Added a regression test that parses a synthetic PE32+ executable.
- Updated generated projects and build manifests to the current AtomJS release.

## 0.4.1-alpha.0

- Windows release executables now use the GUI subsystem, so launching a built app no longer opens a Command Prompt window.
- The build removes the inherited Node Authenticode signature before SEA injection to avoid corrupted-signature warnings.
- `atom doctor` now detects WebView2 using Microsoft's official runtime product ID and validates the `pv` version value.
- NSIS detection now checks standard installation locations, and generated installers register a proper uninstaller entry.

## 0.3.0-alpha.0

### Native macOS application host

- Replaced the per-window `osascript`/JXA process with one shared Cocoa and WKWebView host.
- Multiple `BrowserWindow` instances now belong to one macOS application process and Dock identity.
- Added native macOS show, hide, focus, title, bounds, minimize, maximize, restore, fullscreen, reload, and navigation commands.
- macOS builds compile and sign the native host with the system SDK and verify the resulting `.app` bundle.

### Native packaging

- macOS application code and production dependencies are compressed and embedded in the SEA executable instead of being shipped as a visible `Resources/app` source directory.
- Removed the separate `Resources/runtime/node` file from macOS bundles.
- `atom run build` now opens the generated `.app` bundle through Launch Services.
- Added CI assertions for the native host and embedded application payload.

## 0.2.0-alpha.0

### Electron compatibility

- Added an AtomJS-backed package named `electron` for both CommonJS and ESM.
- Added `electron/main`, `electron/renderer`, and `electron/common` export paths.
- `atom run dev` provisions the lightweight Electron facade for transitive dependencies automatically.
- Packaged applications vendor the same facade, so dependencies do not need AtomJS-specific builds.
- Added Electron runtime markers such as `process.versions.electron` and `process.type`.
- Preload scripts can now use `require('electron')` directly.
- Added compatibility exports for frequently imported Electron modules.

### BrowserWindow and OAuth

- Added `BrowserWindow.setMenu()`, `getMenu()`, `removeMenu()`, and menu-bar compatibility methods.
- `webContents.did-finish-load` now fires after every completed navigation instead of only the initial document.
- The macOS WKWebView navigation delegate reports native navigation completion, including remote OAuth redirects where a page CSP may block the JavaScript bridge.
- Added compatibility tests that match the Electron calls used by MSMC.

## 0.1.1-alpha.0

### Fixed

- macOS development launches WKWebView through JavaScript for Automation.
- macOS no longer requires `webview-nodejs`, CMake, or a compiled Node addon for development runs.
- `BrowserWindow.loadFile()` and `loadURL()` suppress fire-and-forget unhandled rejections.
