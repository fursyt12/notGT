# Windows packaging & releases

notGT ships as a **portable Windows folder/zip**: a bundled Node.js runtime, the
NodeCG server, the built `notGT` bundle and a small launcher. Nothing has to be
installed on the target machine. This document describes how the package is
assembled and how a release is cut.

- Packager: [`scripts/build-windows.mjs`](../scripts/build-windows.mjs)
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
  node/                   official Windows Node runtime (node.exe, npm, …)
  app/                    NodeCG runtime root
    index.js
    package.json          (nodecgRoot: true → monorepo layout)
    node_modules/         production-only, symlinks dereferenced
    workspaces/<pkg>/dist built NodeCG workspaces
    bundles/notGT/        built bundle (extension/index.js, dashboard/, graphics/)
    cfg/  db/  assets/  logs/
  README.txt
```

`dist/notGT-win-x64.zip` contains the folder above with `notGT-win-x64/` as the
single top-level entry.

## How the package is built

`node scripts/build-windows.mjs` performs, in order:

1. **Builds** (unless `--skip-build`): `npm run build` at the repo root and
   `npm ci && npm run build` inside `bundles/notGT` (the bundle has its own
   lockfile and is *not* an npm workspace).
2. **Production dependencies** — mirrored from the `Dockerfile`: the manifests
   and the built `workspaces/*` are copied to a throwaway staging directory in
   the OS temp dir, where `npm ci --omit=dev` runs. The developer's own root
   `node_modules` is **never** touched. `PUPPETEER_SKIP_DOWNLOAD=true` avoids
   fetching Chromium.
3. **`app/` assembly** — `index.js`, `package.json`, `workspaces/*/dist`,
   the built `bundles/notGT` (without its `node_modules`/`.e2e`) and the
   production `node_modules`. Workspace symlinks are dereferenced while
   copying, so the zip contains only regular files and extracts correctly on
   Windows without symlink privileges.
   Empty `cfg/`, `db/`, `assets/`, `logs/` are created. The repo's
   `cfg/nodecg.json`, `db/*` and `assets/*` are deliberately **not** copied
   (secrets / local state); `cfg/README.txt` is shipped instead, and a real
   `bundles/notGT/cfg/notGT.json` (contains `apiToken`) is skipped.
4. **Node runtime** — downloads
   `https://nodejs.org/dist/v<version>/node-v<version>-win-x64.zip`, verifies
   its SHA-256 against the matching `SHASUMS256.txt` (hard failure on mismatch),
   caches the zip under `<out>/.cache/` and extracts it into `node/`
   (`tar -xf` on Windows, `unzip` on Linux — GNU tar cannot read zip).
5. **Native launcher** — compiles `notGT Launcher.exe` with
   `x86_64-w64-mingw32-gcc -O2 -municode -mwindows`. If mingw-w64 is missing
   (typical on `windows-latest`) the `.exe` is skipped with a warning and
   `notGT.cmd` is the entry point — it is fully functional on its own and only
   differs by showing a console window.
6. **`README.txt`**, `notGT.cmd`, then the **zip** (unless `--no-zip`) and a
   summary of paths and sizes.

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

| Flag | Default | Meaning |
| --- | --- | --- |
| `--node-version <x.y.z>` | `22.14.0` | Windows Node runtime version |
| `--out <dir>` | `dist` | Output root (`notGT-win-x64/`, the zip and `.cache/` live here) |
| `--skip-build` | off | Reuse existing root/bundle build output |
| `--no-zip` | off | Assemble the folder only |

> Run the packaging **on Windows** for a shippable build: `npm ci --omit=dev`
> installs platform-specific native modules (e.g. `better-sqlite3`), so a build
> produced on Linux carries Linux binaries. Linux builds are for verifying the
> layout, UI and tooling.
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

## Releasing via GitHub Actions

`.github/workflows/release.yml` runs on `windows-latest`:

1. `actions/checkout`, `actions/setup-node` (Node 22, npm cache for both
   lockfiles);
2. `npm ci` (root, with `PUPPETEER_SKIP_DOWNLOAD=true`) and `npm run build`;
3. `npm ci` + `npm run build` in `bundles/notGT`;
4. `node scripts/build-windows.mjs --node-version 22.14.0`;
5. uploads `dist/notGT-win-x64.zip` as the `notGT-win-x64` workflow artifact;
6. creates or updates the GitHub Release for the tag and attaches the zip
   (`gh release view` → `gh release create` / `gh release upload --clobber`),
   with a release body listing the contents and the OBS Browser Source URL.

Trigger a release by pushing a version tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

A manual run (`workflow_dispatch`) builds and uploads the artifact; fill in the
optional `tag` input to also publish a release. Re-running a job for an existing
tag is safe: the asset is uploaded with `--clobber`.

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
