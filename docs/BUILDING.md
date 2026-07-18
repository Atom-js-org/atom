# Building

## Local target

```bash
atom build windows
atom build macos
atom build linux
```

When the target matches the current host, AtomJS creates:

```text
build/<os>/
├── unpacked/
│   ├── <Product executable>
│   ├── app/
│   └── ATOMJS-CREDIT.txt
├── manifest.json
└── platform packages
```

Platform packages:

- Windows: ZIP, NSIS script, and an EXE installer when `makensis` is available.
- macOS: `.app`, ZIP, and DMG when `hdiutil` is available.
- Linux: tar.gz, AppDir, and AppImage when `appimagetool` is available.

The launcher is produced with Node.js Single Executable Applications. Application files remain in the adjacent `app` directory. macOS uses the bundled JavaScript WKWebView host; Windows and Linux keep their native adapter beside the application so its `.node` addon can load normally.

## All operating systems from any host

```bash
atom build all
```

Native installers, platform WebViews, native Node addons, signing and macOS packaging cannot be reliably produced for every target on one arbitrary local OS. AtomJS solves this by dispatching the included `atom-build.yml` workflow to GitHub-hosted Windows, macOS and Linux runners, waiting for completion, then downloading artifacts into `build/<os>`.

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
