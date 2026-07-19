# Building and distribution customization

## Local target

```bash
atom build windows
atom build macos
atom build linux
```

A local build must match the host operating system. `atom build all` dispatches the included GitHub Actions workflow and downloads the platform artifacts into `build/<target>`.

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
      "requestedExecutionLevel": "asInvoker"
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

The final executable uses the Windows GUI subsystem, includes the embedded application payload and is branded with the configured ICO and version metadata. NSIS is used for the installer when `makensis` is installed. The installer supports per-user or per-machine installation, custom graphics, text, language, shortcuts and install paths.

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
