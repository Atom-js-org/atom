# Building

## Local target

```bash
atom build windows
atom build macos
atom build linux
```

Platform packages:

- Windows: unpacked application, ZIP, NSIS script, and an EXE installer when `makensis` is available.
- macOS: a native `.app`, ZIP, and DMG when `hdiutil` is available.
- Linux: tar.gz, AppDir, and AppImage when `appimagetool` is available.

### macOS layout

```text
build/macos/
├── <Product Name>.app/
│   └── Contents/
│       ├── Info.plist
│       ├── MacOS/
│       │   ├── <Product Name>
│       │   └── AtomJSWindowHost
│       └── Resources/
│           └── ATOMJS-CREDIT.txt
├── <Product Name>-macos.zip
├── <Product Name>.dmg
└── manifest.json
```

The product executable is a Mach-O Node.js SEA binary with the application payload embedded as an asset. `AtomJSWindowHost` is a small Cocoa/WKWebView executable compiled for the target Mac. One host owns every window. The build does not contain `Resources/app`, a loose project source directory, `osascript`, or a separate Node runtime file.

The alpha builder ad-hoc signs and verifies the complete bundle. Public distribution still requires the developer's Apple Developer ID certificate and notarization.

### Windows and Linux

Windows and Linux currently retain the existing unpacked runtime layout while the shared native-host and embedded-payload work is ported to WebView2 and WebKitGTK. They still do not bundle Electron or a private Chromium runtime.

## All operating systems from any host

```bash
atom build all
```

Native installers, platform WebViews, native Node addons, signing and macOS packaging cannot be reliably produced for every target on one arbitrary local OS. AtomJS dispatches the included `atom-build.yml` workflow to GitHub-hosted Windows, macOS and Linux runners, waits for completion, then downloads artifacts into `build/<os>`.

Requirements:

1. Commit `.github/workflows/atom-build.yml`.
2. Install GitHub CLI (`gh`).
3. Run `gh auth login`.
4. Push the project to GitHub.

## Signing

The alpha builder creates unsigned or ad-hoc signed output. Production distribution requires developer-owned certificates:

- Windows Authenticode certificate
- Apple Developer ID signing and notarization
- optional Linux package/repository signing
