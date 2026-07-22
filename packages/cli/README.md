# AtomJS CLI

Run and package AtomJS applications:

```bash
atom run dev
atom run build
atom build windows
atom build macos
atom build linux
atom build current --local
```

`atom.config.json` controls artifact names, Windows EXE/NSIS branding, macOS app/DMG metadata and Linux AppImage/DEB/RPM output. New projects include default PNG and ICO assets that can be replaced directly. Builds are local-first and do not require GitHub Actions; run the target build on the matching operating system.

Project: https://github.com/Atom-js-org/atom
