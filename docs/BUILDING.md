# Building and distribution customization

## Local target

```bash
atom build windows
atom build macos
atom build macos --arch universal
atom build linux
```

A local build must match the host operating system. Windows builds no longer require CMake or Visual Studio Build Tools; the WebView binding is downloaded as a prebuilt platform package. AtomJS does not require GitHub Actions: run `atom build current --local` on each target operating system. Every build writes `packed-files.json` beside `manifest.json` so embedded scripts, styles and assets can be audited before release.

## Release script

From the repository root, after changing the version with `npm version`:

```bash
./build.sh
```

The script requires Node.js 24+, runs the test and package checks, verifies npm
authentication, refuses an already-published version, commits local changes,
pushes the current branch to `origin`, and publishes runtime, Electron
compatibility, and CLI packages in dependency order. Set `COMMIT_MESSAGE` or
`NPM_TAG` to customize the release metadata. It does not create a version
automatically.

On Windows, run it from Git Bash or WSL; native desktop artifacts still need
to be built on their target operating system.

## Configuration

Build output is controlled from `atom.config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/Atom-js-org/atom/main/atom.config.schema.json",
  "appId": "com.example.myapp",
  "productName": "My App",
  "main": "src/main.js",
  "icon": "assets/icon.png",
  "build": {
    "artifactName": "${productName}-${version}-${target}-${arch}",
    "windows": {
      "icon": "assets/icon.ico",
      "installerIcon": "assets/icon.ico",
      "headerImage": "assets/installer-header.bmp",
      "sidebarImage": "assets/installer-sidebar.bmp",
      "language": "English",
      "installMode": "user",
      "installDirectory": null,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "allowDirectorySelection": true,
      "runAfterFinish": true,
      "welcomeText": null,
      "finishText": null,
      "publisher": "Example Company",
      "requestedExecutionLevel": "asInvoker",
      "cornerRadius": 18,
      "store": {
        "enabled": false,
        "identityName": null,
        "publisher": null,
        "publisherDisplayName": null,
        "logo": "assets/icon.png",
        "square44Logo": "assets/store-44.png",
        "square150Logo": "assets/store-150.png",
        "upload": true
      }
    },
    "macos": {
      "icon": "assets/icon.png",
      "bundleName": "My App",
      "category": "public.app-category.utilities",
      "minimumSystemVersion": "12.0",
      "copyright": "Copyright © Example Company",
      "signingIdentity": "-",
      "entitlements": null,
      "hardenedRuntime": false,
      "dmg": {
        "enabled": true,
        "artifactName": "${productName}-${version}-${arch}-installer",
        "volumeName": "My App",
        "background": "assets/dmg-background.png"
      }
    },
    "linux": {
      "icon": "assets/icon.png",
      "binaryName": "my-app",
      "packageName": "my-app",
      "category": "Utility",
      "maintainer": "Example Company <dev@example.com>",
      "description": "My desktop application",
      "dependencies": ["libgtk-3-0", "libwebkit2gtk-4.1-0"],
      "rpmDependencies": ["gtk3", "webkit2gtk4.1"],
      "appImage": true,
      "deb": true,
      "rpm": true
    }
  }
}
```

Artifact templates support `${productName}`, `${version}`, `${target}`, `${arch}` and `${appId}`.

## Windows 11 and SmartScreen

The Windows executable is a real GUI PE file and does not need Administrator
rights. Windows 11 SmartScreen/Smart App Control can still block a newly built
or unsigned executable; that is a Windows trust decision, not a window-runtime
failure. For a distributable release, sign the application executable, its
embedded native `.dll`/`.node` binaries, and the NSIS installer as the last
build step:

```powershell
$env:ATOM_WINDOWS_SIGN = "1"
$env:ATOM_WINDOWS_CERTIFICATE = "C:\\keys\\my-app.pfx"
$env:ATOM_WINDOWS_CERTIFICATE_PASSWORD = "..."
$env:ATOM_WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"
atom build windows --local
```

`signtool.exe` must be installed from the Windows SDK, or its path can be set
with `ATOM_WINDOWS_SIGNTOOL`. For internal testing, Windows may still require
the user or administrator to explicitly trust an unsigned build. Signing is
not a mechanism to bypass enterprise security policy.

Windows uses the system WebView2 runtime, which is Chromium-based but avoids
shipping a second full Chromium copy with every AtomJS application. Production
windows keep DevTools disabled unless explicitly enabled. For custom frameless
windows, prefer an opaque `backgroundColor` with native `cornerRadius`; this
avoids the more expensive transparent WebView2 composition path while keeping
the native rounded clipping.

## Windows output

```text
build/windows/
├── portable/
│   ├── My App.exe
│   └── ATOMJS-CREDIT.txt
├── My App-<version>-windows-<arch>-portable.zip
├── My App-<version>-windows-<arch>-setup.exe
├── installer.nsi
└── manifest.json
```

The final executable uses the Windows GUI subsystem and keeps the AtomJS main process and native window host in one process, includes the embedded application payload and is branded with the configured ICO and version metadata. NSIS is used for the installer when `makensis` is installed. The installer supports per-user or per-machine installation, custom graphics, text, language, shortcuts and install paths.

Set `build.windows.store.enabled` to `true` to additionally generate an MSIX
package and an `.msixupload` archive. The Store values `identityName` and
`publisher` must come from Partner Center; they are not interchangeable with
the normal app ID or display publisher. The Windows SDK's `MakeAppx.exe` and a
real PNG Store logo are required. MSIX signing uses the same
`ATOM_WINDOWS_CERTIFICATE`/`signtool` settings as the EXE. The generated
`.msixupload` contains the MSIX package but no symbols; add an `.appxsym` when
crash symbols are desired.

Microsoft Store packaging is opt-in and does not change the normal portable
ZIP/NSIS outputs. The Store can also list an existing offline EXE/MSI
installer, but MSIX is the path that enables Store package features.

## macOS output

```text
build/macos/
├── My App.app/
│   └── Contents/
│       ├── Info.plist
│       ├── MacOS/
│       │   ├── My App
│       │   └── AtomJSWindowHost
│       └── Resources/
│           ├── AppIcon.icns
│           └── ATOMJS-CREDIT.txt
├── My App-<version>-macos-<arch>.zip
├── My App-<version>-macos-<arch>-installer.dmg
└── manifest.json
```

A PNG icon is converted to ICNS with the system `sips` and `iconutil` tools. An existing ICNS can be supplied directly. The bundle supports custom identifiers, names, categories, minimum macOS version, signing identity, entitlements and hardened runtime. DMG creation is optional unless `ATOM_REQUIRE_DMG=1` is set.

`atom build macos` produces an artifact for the current Node architecture. On
Apple Silicon, `atom build macos --arch universal` builds arm64 and x86_64
variants and combines the app executable and native window host with `lipo`.
The command needs a universal Node binary or both architecture-specific Node
executables; set `ATOMJS_ARM64_NODE` and `ATOMJS_X64_NODE` when they are not
available on `PATH`. The final `.app`, ZIP and DMG are universal and use the
same runtime/API on both architectures.

Windows and Linux do not have a macOS-style universal binary format. AtomJS
therefore emits architecture-specific artifacts for those targets; build once
on each target architecture when both are required.

## Linux output

```text
build/linux/
├── my-app
├── My App-<version>-linux-<arch>-portable.tar.gz
├── My App.AppDir/
├── My App-<version>-linux-<arch>.AppImage
├── My App-<version>-linux-<arch>.deb
├── My App-<version>-linux-<arch>.rpm
└── manifest.json
```

The standalone binary and tarball are always produced. The builder creates a Debian package without requiring `dpkg-deb`. It creates an RPM when `rpmbuild` is available and an AppImage when `appimagetool` is available. AppImage is the distro-neutral artifact; `.deb` and `.rpm` provide native package-manager integration.

## Signing

Ad-hoc signing is the default on macOS. Public distribution still requires developer-owned credentials:

- Windows Authenticode certificate and signing step.
- Apple Developer ID, hardened runtime, entitlements and notarization.
- Optional Linux repository/package signing.
