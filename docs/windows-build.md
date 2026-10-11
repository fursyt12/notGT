# Windows packaging & releases

notGT ships as a **portable Windows folder/zip**: a bundled Node.js runtime, the
NodeCG server, the built `notGT` bundle and a small launcher. Nothing has to be
installed on the target machine. This document describes how the package is
assembled and how a release is cut.

- Packager: [`scripts/build-windows.mjs`](../scripts/build-windows.mjs), with what goes
  into `app/` in [`scripts/windows-app.mjs`](../scripts/windows-app.mjs)
- Native bootstrap: [`launcher/win/notGT-launcher.c`](../launcher/win/notGT-launcher.c)
- CI: [`.github/workflows/release.yml`](../.github/workflows/release.yml)

## Package layout

```
notGT-win-x64/
  notGT Launcher.exe      native bootstrap (mingw-w64; absent if not available)
  notGT.cmd               fallback bootstrap, always present
  launcher/
    index.mjs             launcher UI + NodeCG supervisor (spawns app/index.js)
    ui.html
  node/                   official Windows Node runtime: node.exe and its licence
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
5. **Native launcher** — compiles `notGT Launcher.exe` with
   `x86_64-w64-mingw32-gcc -O2 -municode -mwindows`. If mingw-w64 is missing
   (typical on `windows-latest`) the `.exe` is skipped with a warning and
   `notGT.cmd` is the entry point — it is fully functional on its own and only
   differs by showing a console window.
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

`notGT Launcher.exe` is a GUI-subsystem Win32 program (no console window). It:

1. finds its own directory with `GetModuleFileNameW`,
2. builds `"<dir>\node\node.exe" "<dir>\launcher\index.mjs" --app "<dir>\app"`,
3. starts it with `CreateProcessW` + `CREATE_NO_WINDOW` and exits immediately
   (the launcher keeps running as the application),
4. shows a Russian `MessageBoxW` naming the missing path if `node\node.exe`,
   `launcher\index.mjs` or `app\` is absent.

`launcher/index.mjs` then serves the control page on `127.0.0.1`, and when the
user presses «Запустить» it writes `host`/`port` into `<appDir>/cfg/nodecg.json`
and spawns `node index.js` with `cwd = app`. The packager itself never starts
NodeCG.

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

Единственный автоматический CI в этом форке — Windows-сборка
(`.github/workflows/release.yml`, имя workflow `Windows`). Апстримные проверки
NodeCG (`ci.yaml`: lint, типы, тесты, контейнер) переведены на ручной запуск и
сами не срабатывают: в notGT они не нужны, а `release-please` вдобавок требует
разрешения репозитория на создание pull request'ов.

| Событие       | Что происходит                                                         |
| ------------- | ---------------------------------------------------------------------- |
| push в `main` | собирается Windows-пакет и кладётся в артефакты (релиз не публикуется) |
| тег `v*`      | то же плюс публикация/обновление GitHub Release                        |
| ручной запуск | как push; если заполнить `tag` — ещё и релиз                           |

Шаги на `windows-latest`:

1. `actions/checkout`, `actions/setup-node` (Node 22, npm cache for both
   lockfiles);
2. `npm ci` (root, with `PUPPETEER_SKIP_DOWNLOAD=true`) and `npm run build`;
3. `npm ci` + `npm run build` in `bundles/notGT`;
4. `node scripts/build-windows.mjs --node-version 22.14.0 --smoke` — the
   package is started with its own `node.exe` before it is zipped;
5. uploads `dist/notGT-win-x64.zip` as the `notGT-win-x64` workflow artifact;
6. creates or updates the GitHub Release for the tag and attaches the zip
   (`gh release view` → `gh release create` / `gh release upload --clobber`),
   with a release body listing the contents and the OBS Browser Source URL.

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
ls -R /tmp/notgt-win/notGT-win-x64 | head
unzip -l /tmp/notgt-win/notGT-win-x64.zip | head          # notGT-win-x64/ is top-level
```

The OBS Browser Source URL for the shipped `main` out is:

```
http://<host>:<port>/bundles/notGT/graphics/out.html?out=main
```
