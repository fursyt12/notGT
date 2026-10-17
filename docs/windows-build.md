# Windows packaging & releases

notGT ships as a **portable Windows folder/zip**: a bundled Node.js runtime, the
NodeCG server, the built `notGT` bundle and a small launcher. Nothing has to be
installed on the target machine. This document describes how the package is
assembled and how a release is cut.

- Packager: [`scripts/build-windows.mjs`](../scripts/build-windows.mjs), with what goes
  into `app/` in [`scripts/windows-app.mjs`](../scripts/windows-app.mjs)
- The launcher's window: [`launcher/win/notGT-launcher.c`](../launcher/win/notGT-launcher.c)
- CI: [`.github/workflows/release.yml`](../.github/workflows/release.yml)

## Package layout

```
notGT-win-x64/
  notGT Launcher.exe      the launcher's window (mingw-w64; absent if not available)
  notGT.cmd               fallback bootstrap, always present
  launcher/
    index.mjs             what the window drives: NodeCG supervisor (spawns app/index.js)
    ui.html
  node/                   official Windows Node runtime: node.exe and its licence
  ndi/                    the NDI sender: its sources, koffi and Electron for Windows
  ffmpeg/                 not in the package: made by «Install ffmpeg» in the launcher
  app/                    NodeCG runtime root
    index.js              loads the bundled server
    package.json          (nodecgRoot: true → monorepo layout)
    workspaces/nodecg/    NodeCG as the server expects to find it:
      dist/server/bootstrap.js   the server and its dependencies, one file
      dist/server/templates/     dashboard and sign-in templates
      dist/client/               dashboard shell and client scripts
      schemas/  package.json
    node_modules/         only what cannot be bundled (see below)
    bundles/notGT/        built bundle (extension/index.js, dashboard/, graphics/)
    THIRD-PARTY-LICENSES.txt
    cfg/  db/  assets/  logs/
  README.txt
```

The package is a few hundred files, not tens of thousands. That is the point:
on Windows it is the number of files that makes unpacking slow and the first
start slower still, with the antivirus looking at each one.

`dist/notGT-win-x64.zip` contains the folder above with `notGT-win-x64/` as the
single top-level entry.

### The NDI sender

`ndi/` is the NDI sender of the repository, installed for Windows x64 at build
time (`npm ci --omit=dev --os=win32 --cpu=x64`, then Electron's own installer
with `ELECTRON_INSTALL_PLATFORM=win32`), so it builds the same on any host. It
is most of the package's size — Electron is a whole Chromium, about 330 MB
unpacked once Chromium's interface languages but English and Russian are
dropped. `--no-ndi` leaves it out.

The launcher starts it once the server answers — `node ndi\bin\notgt-ndi.mjs
--server http://127.0.0.1:<port> --token-file app\db\notGT-ndi.key` — and
stops it with the server; the server keeps the senders' key in that file
(`NOTGT_NDI_KEY_FILE`). Its lines go to the launcher's log with `[notgt-ndi]`
in front. It needs the NDI runtime, which is NDI's and not in the package:
NDI Tools or the NDI runtime installer. Without it the sender keeps running,
the dashboard says under each out with NDI on that the runtime is missing, and
it picks the runtime up as soon as it is installed — also from
`C:\Program Files\NDI\…` when the launcher was started before NDI Tools was
installed and does not see `NDI_RUNTIME_DIR_V6`. `--no-ndi` on the launcher
(or `NOTGT_NDI=off`) does not start it.

### ffmpeg

The server converts `.mp4`/`.mov` uploads with ffmpeg and measures clips with
ffprobe. The package does not carry them (they would double its download for
something not everyone uses); the launcher's window offers **Install ffmpeg**
while there is none — neither in `ffmpeg\` nor on `PATH`. One press downloads
the newest LGPL shared build for win64 from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (about 75 MB),
checks it against the release's `checksums.sha256`, and unpacks `bin\` (without
ffplay) and the licence into `ffmpeg\` next to `launcher\`. The server is
started with `NOTGT_FFMPEG_DIR` pointing there and looks at it on every
conversion, so a server that is already running uses the new ffmpeg at once.
LGPL is enough: the converter only needs VP9 (libvpx) and WebP (libwebp).

## How the package is built

`node scripts/build-windows.mjs` performs, in order:

1. **Builds** (unless `--skip-build`): `npm run build` at the repo root and
   `npm ci && npm run build` inside `bundles/notGT` (the bundle has its own
   lockfile and is _not_ an npm workspace).
2. **Production dependencies** — mirrored from the `Dockerfile`: the manifests
   and the built `workspaces/*` are copied to a throwaway staging directory in
   the OS temp dir, where `npm ci --omit=dev` runs. The developer's own root
   `node_modules` is **never** touched. `PUPPETEER_SKIP_DOWNLOAD=true` avoids
   fetching Chromium.
3. **`app/` assembly** — the server is **bundled into one file** with esbuild
   (`app/workspaces/nodecg/dist/server/bootstrap.js`), starting from the staged
   tree, so it contains exactly the production dependencies. Next to it go the
   files NodeCG reads from disk (templates, schemas, the client) and the built
   `bundles/notGT` without its sources, `node_modules`, source maps and tests.
   `app/node_modules` holds only:
   - packages with a **native addon** (`better-sqlite3`) and what they require
     at run time — an addon is found relative to its package, so it cannot be
     inside the bundle. They are detected, not listed;
   - `shelljs`, which loads its own files by a computed name;
   - the files the dashboard fetches from `/node_modules/…` (`soundjs`).

   What is kept is stripped of docs, type declarations, source maps and native
   build leftovers. The licences of everything inside the bundle are collected
   into `app/THIRD-PARTY-LICENSES.txt`.
   Empty `cfg/`, `db/`, `assets/`, `logs/` are created. The repo's
   `cfg/nodecg.json`, `db/*` and `assets/*` are deliberately **not** copied
   (secrets / local state); `cfg/README.txt` is shipped instead, and a real
   `bundles/notGT/cfg/notGT.json` (contains `apiToken`) is skipped.
4. **Node runtime** — downloads
   `https://nodejs.org/dist/v<version>/node-v<version>-win-x64.zip`, verifies
   its SHA-256 against the matching `SHASUMS256.txt` (hard failure on mismatch),
   caches the zip under `<out>/.cache/`, extracts it (`tar -xf` on Windows,
   `unzip` on Linux — GNU tar cannot read zip) and takes **only `node.exe`**
   and its licence into `node/`: nothing in the package runs npm or corepack.
5. **Native launcher** — compiles the resources (icon, logo, manifest, version) with
   `x86_64-w64-mingw32-windres` and `notGT Launcher.exe` with
   `x86_64-w64-mingw32-gcc -O2 -municode -mwindows`. If mingw-w64 is missing
   (typical on `windows-latest`) the `.exe` is skipped with a warning and
   `notGT.cmd` is the entry point — it is fully functional on its own, but shows a
   console window and opens the control page in the browser instead of a window of
   its own. `MINGW_GCC` / `MINGW_WINDRES` name another compiler.
6. **`README.txt`** and `notGT.cmd`.
7. **Smoke test** (with `--smoke`) — a copy of `app/` is started and checked:
   the dashboard shell, a notGT panel, the out page, the API, a file from
   `node_modules`, the socket.io client, a write to the variable store, and
   that the write is still there after a restart (which is the native database
   driver at work). On Windows it runs with the packaged `node.exe`.
8. The **zip** (unless `--no-zip`) and a summary of paths, sizes and file counts.

### What bundling changes

- **`transformBareModuleSpecifiers` is not available** in this package. NodeCG
  loads that deprecated feature's Babel at start-up; here it is replaced by a
  pass-through that logs a warning if a bundle asks for it. notGT does not.
- **A config file written in TypeScript is not read** (`cfg/nodecg.ts`): the
  compiler is left out. JSON, YAML and JavaScript configs work as before.
- A package that reads its own files by a path relative to itself needs an
  entry in `scripts/windows-app.mjs` (`SIDE_FILES`, or `UNBUNDLED` to keep it
  on disk whole). The smoke test and the end-to-end suites are how a new one
  is found; `NOTGT_DEBUG=1` prints what the bundle is made of.

The script is idempotent: it rebuilds `notGT-win-x64/` from scratch, reuses the
cached Node zip when its SHA-256 still matches, and overwrites the zip.

## Local build

Prerequisites: Node 22, npm, `zip`/`unzip` (Linux) or `tar` (Windows), and
optionally mingw-w64 for the native `.exe`.

```bash
# 1. Build the monorepo + bundle (once)
npm ci
npm run build
(cd bundles/notGT && npm ci && npm run build)

# 2. Package (builds nothing, reuses step 1)
node scripts/build-windows.mjs --skip-build --out dist

# Without --skip-build the script runs both builds itself:
node scripts/build-windows.mjs --node-version 22.14.0
```

Flags:

| Flag                     | Default   | Meaning                                                         |
| ------------------------ | --------- | --------------------------------------------------------------- |
| `--node-version <x.y.z>` | `22.14.0` | Windows Node runtime version                                    |
| `--out <dir>`            | `dist`    | Output root (`notGT-win-x64/`, the zip and `.cache/` live here) |
| `--skip-build`           | off       | Reuse existing root/bundle build output                         |
| `--no-zip`               | off       | Assemble the folder only                                        |
| `--smoke`                | off       | Start the packaged server and check that it works               |
| `--app-only`             | off       | Assemble `app/` only: no Node runtime, launcher or zip          |
| `--prod-root <dir>`      | —         | Use an installed production tree instead of a staging `npm ci`  |

> Run the packaging **on Windows** for a shippable build: `npm ci --omit=dev`
> installs platform-specific native modules (e.g. `better-sqlite3`), so a build
> produced on Linux carries Linux binaries. Linux builds are for verifying the
> layout, UI and tooling — and the bundled server itself:
> `--app-only --smoke` assembles `app/` and starts it with the local Node,
> which is the quickest way to check a change to the bundling on any OS.
>
> If the default npm cache (`~/.npm`) is not writable (sandboxed CI, read-only
> home), the script automatically falls back to `<out>/.cache/npm`.

## The native launcher

`notGT Launcher.exe` is the program the user double-clicks: a compact window in the
brand's colours, in the spirit of the Bitfocus Companion launcher. It is a
GUI-subsystem Win32 program in C (no console window, no runtime to install — it links
only what Windows ships), about 250 KB.

- **The main window**: the status, the network interface and the port, «Запустить» /
  «Остановить» / «Открыть панель», and the dashboard's address with «Копировать».
  **RU / EN** in the header switches the language — Russian and English, the system's
  until someone chooses; the names here are the Russian ones.
- **Three small windows** behind the links at the bottom: «Вход по паролю…» (name the
  administrator, or switch the sign-in off and on), «Сеть и брандмауэр…» (the firewall
  rule and the reachability check) and «Журнал сервера…».
- **The notification area**: an icon with «Открыть панель», «Показать лончер» and
  «Выйти». A second double click on the `.exe` brings the first window forward instead
  of starting another.

**Closing the launcher does not stop the server.** The close box and «Выйти» end the
window; a server that is running keeps running, and the next time the program is started
its window shows that server — running, with its address — and can stop it. To stop the
server, press «Остановить»; while it runs the tray menu also offers «Остановить сервер и
выйти» next to «Выйти — сервер продолжит работать».

The window is only a face. On start it

1. finds its own directory with `GetModuleFileNameW` and shows a Russian `MessageBoxW`
   naming the missing path if `node\node.exe`, `launcher\index.mjs` or `app\` is absent,
2. starts `"<dir>\node\node.exe" "<dir>\launcher\index.mjs" --app "<dir>\app" --no-open`
   hidden (`CREATE_NO_WINDOW`) with `--background`. That process is **not** tied to the
   window's life: it is what keeps looking after the server once the window is closed.
   It leaves a note of how to reach it (`launcher\launcher-runtime.json`), and step 2 is
   skipped when the note leads to a launcher that answers — the window attaches to it,
3. reads the one line that process prints — `notGT launcher on http://127.0.0.1:<port>` —
   and from then on talks to its control API over WinHTTP: `GET /api/state` once a
   second, and a request for every button.

So there is one implementation of "start NodeCG", "add a firewall rule" and the rest —
[`launcher/index.mjs`](../launcher/README.md) — shared with the browser page that
`notGT.cmd` (or `node launcher/index.mjs` on another system) opens. When the user
presses «Запустить» it writes `host`/`port` into `<appDir>/cfg/nodecg.json` and spawns
`node index.js` with `cwd = app`. The packager itself never starts NodeCG.

The sources are in `launcher/win/`:

| File                      | What it is                                                              |
| ------------------------- | ----------------------------------------------------------------------- |
| `notGT-launcher.c`        | the windows, their painting and what the buttons do                     |
| `backend.h`               | starting the Node process and the requests to it                        |
| `json.h`                  | a small JSON reader for the answers                                     |
| `notGT-launcher.rc`, `.manifest` | icon, logo, version, DPI awareness, themed controls              |
| `assets/`                 | `notgt.ico` and `logo.png`, made from `media/brand` by `make-assets.mjs` |
| `test/`                   | stand-ins used by `scripts/e2e-launcher-window.mjs`                     |

`scripts/e2e-launcher-window.mjs` cross-compiles the program and runs it under wine in a
virtual display against the real `launcher/index.mjs`: it checks that the windows are
drawn, that clicks and typed text reach the backend, and that quitting takes the Node
process down. It needs mingw-w64, wine, Xvfb and xdotool, and skips itself without them.
When the window closes it says so (`POST /api/quit`): with a server running the process
stays, otherwise it ends; a process that has neither a server nor a window asking for its
state for 20 seconds ends by itself, so a window that crashed leaves nothing behind.

Two switches exist for it and for development: `--control-url http://127.0.0.1:<port>`
attaches the window to a `launcher/index.mjs` that is already running, and
`--snapshot <dir>` saves a picture of every window as `.bmp` and exits.

## The chosen interface, and why it is not the bind address

The interface dropdown decides the **advertised** address (the links shown in
the launcher), not what NodeCG binds:

| choice                     | `cfg/nodecg.json` `host` | links                           |
| -------------------------- | ------------------------ | ------------------------------- |
| «Все интерфейсы (0.0.0.0)» | `0.0.0.0`                | 127.0.0.1 + the first real card |
| a concrete card (Wi-Fi, …) | `0.0.0.0` (or `::`)      | that card + 127.0.0.1           |
| «Только этот компьютер»    | `127.0.0.1`              | 127.0.0.1 only                  |

Binding a single card is what makes Windows Firewall drop **even same-machine**
connections to it, and it leaves no listener on `127.0.0.1` — so the launcher
could not tell "the server never started" from "the address is blocked", and the
browser showed an endless spinner. With the wildcard bind:

- `127.0.0.1` always proves the server is alive and gives the operator a URL
  that no firewall can block;
- the advertised address is probed separately, so a silent card is reported as
  `running` **with a warning** (after 8 s) instead of a 120 s timeout;
- «Разрешить порт» adds an inbound rule for that port on every network profile
  (UAC), and the launcher verifies it with `netsh ... show rule` instead of
  trusting an exit code.

Only the explicit «Только этот компьютер (127.0.0.1)» choice keeps the strict
loopback bind.

This applies to the **NodeCG port**, so the notGT titles API
(`http://<адрес>:<порт>/api/...`) is reachable from the LAN and is what Bitfocus
Companion, OBS or a custom module should talk to. The launcher's _own_ control
API (`http://127.0.0.1:<control-port>/api/...`) stays loopback-only on purpose:
it spawns processes and can raise an elevated `netsh` prompt. See
[`launcher/README.md`](../launcher/README.md#two-different-http-apis--do-not-confuse-them).

## CI и релиз через GitHub Actions

Единственный автоматический CI в этом форке — сборка пакетов для Windows и macOS
(`.github/workflows/release.yml`, имя workflow `Packages`). Апстримные проверки
NodeCG (`ci.yaml`: lint, типы, тесты, контейнер) переведены на ручной запуск и
сами не срабатывают: в notGT они не нужны, а `release-please` вдобавок требует
разрешения репозитория на создание pull request'ов.

| Событие       | Что происходит                                                         |
| ------------- | ---------------------------------------------------------------------- |
| push в `main` | собираются оба пакета и кладутся в артефакты (релиз не публикуется)   |
| тег `v*`      | то же плюс публикация/обновление GitHub Release с обоими пакетами      |
| ручной запуск | как push; если заполнить `tag` — ещё и релиз                           |

Шаги на `windows-latest`:

1. `actions/checkout`, `actions/setup-node` (Node 22, npm cache for both
   lockfiles);
2. `npm ci` (root, with `PUPPETEER_SKIP_DOWNLOAD=true`) and `npm run build`;
3. `npm ci` + `npm run build` in `bundles/notGT`;
4. `node scripts/build-windows.mjs --node-version 22.14.0 --smoke` — the
   package is started with its own `node.exe` before it is zipped;
5. uploads `dist/notGT-win-x64.zip` as the `notGT-win-x64` workflow artifact.

The macOS package is built by the `macos-package` job in the same way, on
`macos-latest` — see [macos-build.md](macos-build.md). For a tag, a third job,
`release`, waits for both, downloads the two artifacts and creates or updates
the GitHub Release with both zips attached (`gh release view` →
`gh release create` / `gh release upload --clobber`), with a release body
listing the contents and the OBS Browser Source URL. A release never goes out
with one of its packages missing.

Релиз запускается тегом:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Ручной запуск (`workflow_dispatch`) собирает и загружает артефакт; заполните
необязательный вход `tag`, чтобы ещё и опубликовать релиз. Перезапуск задачи для
существующего тега безопасен: файл загружается с `--clobber`.

## Verification recipe

```bash
node scripts/build-windows.mjs --skip-build --out /tmp/notgt-win
file "/tmp/notgt-win/notGT-win-x64/notGT Launcher.exe"   # PE32+ executable (GUI) x86-64
node scripts/e2e-launcher-window.mjs                      # the window itself, under wine
ls -R /tmp/notgt-win/notGT-win-x64 | head
unzip -l /tmp/notgt-win/notGT-win-x64.zip | head          # notGT-win-x64/ is top-level
```

The OBS Browser Source URL for the shipped `main` out is:

```
http://<host>:<port>/bundles/notGT/graphics/out.html?out=main&key=out_…
```

The key is the out's own and is copied with the address in the dashboard («Ссылка для
OBS»); with the sign-in switched off the address needs none.
