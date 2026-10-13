# macOS packaging

notGT ships for macOS the same way it does for Windows: a **portable folder/zip** with a
bundled Node.js runtime, the NodeCG server, the built `notGT` bundle and a launcher with a
window of its own. Nothing has to be installed on the target Mac.

- Packager: [`scripts/build-macos.mjs`](../scripts/build-macos.mjs); `app/` is assembled
  by [`scripts/build-windows.mjs --app-only`](../scripts/build-windows.mjs), so the two
  packages cannot drift apart
- The launcher's window: [`launcher/mac/notGT-launcher.m`](../launcher/mac/notGT-launcher.m)
- CI: the `macos-package` job of
  [`.github/workflows/release.yml`](../.github/workflows/release.yml)

The release process — the version commit, the tag, what CI publishes — is the one
described in [windows-build.md](windows-build.md); a tag publishes both packages as one
release.

## Package layout

```
notGT-macos-arm64/
  notGT Launcher.app      the launcher's window
  notGT.command           fallback: the same controls as a page in the browser
  launcher/
    index.mjs             what the window drives: NodeCG supervisor (spawns app/index.js)
    ui.html
  node/                   official macOS Node runtime: node and its licence
  app/                    NodeCG runtime root, as in the Windows package
    cfg/  db/  assets/  logs/
  README.txt
```

The application is deliberately **not** self-contained: the server writes its settings,
its database and the uploaded media under `app/`, and a program's own bundle is no place
for data. So the application stays in its folder, next to what it starts, exactly like
`notGT Launcher.exe` does.

`arm64` is Apple silicon (M1 and newer), macOS 11 or later. There is no Intel package:
the one part of `app/` that belongs to a system is the native database driver, which is
that of the machine that builds, and the release is built on an Apple silicon runner.
`--arch x64` on an Intel Mac builds one.

## How the package is built

```sh
node scripts/build-macos.mjs --node-version 22.14.0      # on a Mac
```

1. **`app/`** — `build-windows.mjs --app-only` (the builds, the production dependencies
   in a throwaway staging directory, the server bundled into one file).
2. **Node** — `node-v<version>-darwin-<arch>.tar.gz` from nodejs.org, its SHA-256 checked
   against `SHASUMS256.txt`; only `bin/node` and the licence are kept.
3. **The window** — `launcher/mac/notGT-launcher.m` compiled with the system `clang`
   (`xcrun clang`, the Xcode command line tools) for both architectures, put into
   `notGT Launcher.app` with `launcher/mac/Info.plist` and the icon, and signed ad hoc.
4. **`notGT.command`**, **`README.txt`**, and the zip, written with `ditto` so that the
   application keeps its executable bits and its signature.

| flag             | default        | meaning                                                                          |
| ---------------- | -------------- | -------------------------------------------------------------------------------- |
| `--node-version` | `22.14.0`      | the Node runtime to bundle                                                       |
| `--out <dir>`    | `dist`         | where the package and the zip go                                                 |
| `--arch <arch>`  | this machine's | `arm64` or `x64`: which package to build; it only runs when built on that machine |
| `--skip-build`   | off            | reuse the existing build output                                                  |
| `--no-zip`       | off            | leave the folder, write no archive                                               |
| `--smoke`        | off            | start the packaged server, then the launcher's window                            |

`--smoke` starts the packaged server with the packaged Node and looks at what it serves,
as on Windows. Then it starts the window itself with `--snapshot`: the program has to
come up, start its Node process, show the launcher's page and save a picture of it
(`dist/macos-launcher.png`, which CI keeps as the `macos-launcher-preview` artifact).

On Linux the script still lays the package out — without the window, and with a warning
that the driver in `app/` is not a Mac's. That is a check of the layout, not a package.

## The launcher's window

The program is a face, as on Windows: everything it does is done by
`launcher/index.mjs`, which it starts with `--no-open --background` and whose page it
shows in a web view. That page is the one `notGT.command` opens in a browser, so the two
cannot differ. A link that leads anywhere else opens in the browser.

- **Closing the window does not stop the server.** The program sends
  `POST /api/quit` `{ "stop": false }`; a launcher with a running server stays, and the
  next window finds it through `launcher/launcher-runtime.json` and attaches to it.
- **It knows where it really is.** macOS starts a downloaded application that still
  carries the quarantine mark from a read-only copy elsewhere ("translocation"), where
  there is no `node/` next to it. The program asks the system for the original location
  and uses that folder.
- **It clears the quarantine mark from its folder.** By then the user has allowed the
  program to run; without this the system refuses to load the unsigned database driver
  into Node, and the server would fail to start with a message about a file nobody has
  heard of.

## Not signed

The application is signed ad hoc, not with an Apple developer certificate, and it is not
notarized. On the first start macOS says it cannot verify it; the user allows it in
System Settings → Privacy & Security → “Open Anyway”, or clears the mark in Terminal:

```sh
xattr -dr com.apple.quarantine ~/Downloads/notGT-macos-arm64
```

Signing and notarizing it needs a paid Apple Developer account; with one, the two steps
go after the `codesign` call in `buildLauncherApp()`.

## The icon

`launcher/mac/assets/notgt.icns` is committed. After the logo changed,
`node launcher/mac/make-assets.mjs` draws it again from `media/brand/notgt-mark.svg`
(needs `rsvg-convert`).
