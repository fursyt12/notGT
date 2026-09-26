# notGT Launcher

A small, **dependency-free** (Node builtins only) local control panel for the notGT
(NodeCG) server. It lets a Windows user pick a network interface and a port, start the
server, and open the GUI — in the spirit of the Bitfocus Companion launcher.

No `package.json`, no `node_modules`: run it with a bare `node`.

```sh
node launcher/index.mjs [--app <dir>] [--control-port <n>] [--no-open] [--host <ip>] [--port <n>]
```

| flag                 | default                                   | meaning                                                                      |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `--app <dir>`        | repo root (`launcher/..`)                 | NodeCG runtime root (`index.js`, `cfg/`, `bundles/`, …)                      |
| `--control-port <n>` | `0`                                       | port for the launcher's own UI; `0` = ephemeral. Always bound to `127.0.0.1` |
| `--no-open`          | off                                       | do not open the launcher window (used by tests)                              |
| `--host <ip>`        | first non-internal IPv4, else `127.0.0.1` | initial «Интерфейс» selection                                                |
| `--port <n>`         | `9090`                                    | initial «Порт» selection                                                     |

On startup it prints exactly one line to stdout:

```
notGT launcher on http://127.0.0.1:<port>
```

The last chosen host/port is remembered in `launcher/launcher-config.json` (write failures
are ignored) and pre-selected on the next run. Explicit CLI flags win over the saved values.

## How the server is started

NodeCG reads `host`/`port` only from `<appDir>/cfg/nodecg.json`; there are no CLI flags for
them. So `POST /api/start`:

1. reads `cfg/nodecg.json` (tolerating missing/invalid JSON),
2. merges `{ host, port }` into it, preserving every other key, and writes it back
   pretty-printed,
3. checks that `host:port` is free (clear error on `EADDRINUSE`, no spawn),
4. spawns `process.execPath` with `["index.js"]`, `cwd: appDir`, capturing
   stdout+stderr into a 400-line ring buffer,
5. polls `http://<openHost>:<port>/` for up to 30 s (any HTTP response counts) and flips
   the status to `running`, or to `error` with the log tail.

`POST /api/stop` kills the child **tree** — `taskkill /PID <pid> /T /F` on Windows,
`SIGTERM` then `SIGKILL` after a grace period elsewhere. The child is always stopped when
the launcher exits (`SIGINT`, `SIGTERM`, `exit`).

## HTTP API (127.0.0.1 only, JSON)

| method | path                  | notes                                                                             |
| ------ | --------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/`                   | the launcher UI (`ui.html`)                                                       |
| `GET`  | `/api/state`          | full state: version, appDir, interfaces, status, guiUrl, logs, …                  |
| `POST` | `/api/start`          | body `{ host, port }`; `409` while running, `400` on bad port, `409` if port busy |
| `POST` | `/api/stop`           | safe no-op `200` when already stopped                                             |
| `POST` | `/api/open`           | optional body `{ url }` (defaults to `guiUrl`)                                    |
| `GET`  | `/api/logs?since=<n>` | `{ lines, next }` for incremental log appends                                     |

`status` ∈ `stopped | starting | running | stopping | error`.
`guiUrl` is `http://<openHost>:<port>/dashboard/`, where `0.0.0.0` is dialled as `127.0.0.1`.

## Packaging layout (fixed contract)

```
notGT-win-x64/
  notGT Launcher.exe      native bootstrap; runs node\node.exe launcher\index.mjs --app <dir>\app
  launcher/index.mjs
  launcher/ui.html
  node/node.exe
  app/                    NodeCG runtime root
  README.txt
```

## Tests

```sh
node scripts/e2e-launcher.mjs
```

Boots the launcher on an ephemeral control port, starts a real NodeCG instance on a free
port, asserts the state/API/logs/GUI contract, the `cfg/nodecg.json` merge, the 409 on a
double start, the occupied-port error and the port being freed after stop. It backs up and
restores the developer's `cfg/nodecg.json` in a `finally` block.
