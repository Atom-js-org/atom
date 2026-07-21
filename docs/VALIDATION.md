# Validation record

Validated for 0.5.3-alpha.1:

- Node.js API and packaging tests cover Electron facade resolution, IPC, repeated OAuth navigation, parent/modal windows and customization options.
- Windows source checks cover GUI-subsystem output, PE signature handling, the prebuilt in-process host, native owner assignment and foreground activation.
- Windows packaging checks cover executable metadata, ICO resources and customizable NSIS generation.
- macOS source checks cover shared AppKit lifecycle, sheets/child windows, title-bar options, app identity, icon handling and code signing.
- macOS packaging keeps signing and DMG generation on local temporary storage before copying artifacts to external volumes.
- Linux packaging emits a standalone binary, portable tarball, AppDir, `.deb`, optional `.rpm` and optional AppImage.
- Generated projects include default PNG/ICO assets and a cross-platform customization configuration.
- CommonJS and ESM `electron` aliases resolve to AtomJS.

Native GUI behavior is finally verified on the corresponding operating system because Windows WebView2, macOS AppKit and Linux WebKitGTK are not available in one CI container.
