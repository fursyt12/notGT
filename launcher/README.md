# notGT Launcher

A small, **dependency-free** (Node builtins only) local control panel for the notGT
(NodeCG) server. It lets a Windows user pick a network interface and a port, start the
server, and open the GUI — in the spirit of the Bitfocus Companion launcher.

It has two faces. On Windows the user sees **a window**: `notGT Launcher.exe`
([`win/notGT-launcher.c`](win/notGT-launcher.c), described in
[docs/windows-build.md](../docs/windows-build.md#the-native-launcher)) starts this
script hidden with `--no-open` and drives it through the control API below. On macOS
the window is `notGT Launcher.app` ([`mac/notGT-launcher.m`](mac/notGT-launcher.m),
described in [docs/macos-build.md](../docs/macos-build.md)): it starts the script the
same way and shows its page in a web view of its own. Run by
itself — `notGT.cmd`, or `node launcher/index.mjs` on any system — the script serves
the same controls as **a page** (`ui.html`) and opens it in the browser.

No `package.json`, no `node_modules`: run it with a bare `node`.

```sh
node launcher/index.mjs [--app <dir>] [--control-port <n>] [--no-open] [--host <ip>] [--port <n>]
```

| flag                  | default                    | meaning                                                                      |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `--app <dir>`         | repo root (`launcher/..`)  | NodeCG runtime root (`index.js`, `cfg/`, `bundles/`, …)                      |
| `--control-port <n>`  | `0`                        | port for the launcher's own UI; `0` = ephemeral. Always bound to `127.0.0.1` |
| `--no-open`           | off                        | do not open the launcher window (used by tests)                              |
| `--host <ip>`         | `0.0.0.0` (all interfaces) | initial «Интерфейс» selection                                                |
| `--port <n>`          | `9090`                     | initial «Порт» selection                                                     |
| `--ready-timeout <s>` | `120`                      | how long to wait for the server to answer                                    |

On startup it prints exactly one line to stdout:

```
notGT launcher on http://127.0.0.1:<port>
```

The last chosen host/port — and the language — is remembered in
`launcher/launcher-config.json` (write failures are ignored) and pre-selected on the next
run. Explicit CLI flags win over the saved values. `--settings <file>` keeps it somewhere
else, which is what the tests do so as not to rewrite yours.

## Languages

The launcher speaks **Russian and English**; both faces have an RU / EN switch. Until
someone uses it the language is the system's (`--lang ru|en` pins it). The choice is one
setting for the window, the page and everything the launcher says: `GET /api/state`
carries `lang`, and `POST /api/lang` `{ "lang": "en" }` changes it — including the status
text already on screen, which is kept in both languages and only becomes one when it is
sent. In the source a text is written in both, side by side: `tr(ru, en)` / `T(ru, en)`
in `index.mjs`, `tx(ru, en)` and `data-en="…"` in `ui.html`, `T(L"…", L"…")` in the
window's C. A third language would turn those pairs into tables.

## How the server is started

NodeCG reads `host`/`port` only from `<appDir>/cfg/nodecg.json`; there are no CLI flags for
them. So `POST /api/start`:

1. reads `cfg/nodecg.json` (tolerating missing/invalid JSON),
2. merges `{ host, port }` into it, preserving every other key, and writes it back
   pretty-printed,
3. checks that `host:port` is free (clear error on `EADDRINUSE`, no spawn),
4. spawns `process.execPath` with `["index.js"]`, `cwd: appDir`, capturing
   stdout+stderr into a 400-line ring buffer,
5. probes **both** the chosen address and `127.0.0.1` every 400 ms for up to 120 s (any
   HTTP response counts) and flips the status to `running` — or to `error` with the log
   tail when neither answers.

## Why the chosen interface can be silent (and what the launcher does about it)

Binding a single network card is what makes Windows Firewall drop **even same-machine**
connections to that address: the browser sits on a blank page and the readiness probe never
passes. That looks exactly like "the server did not start", so the launcher tells the two
cases apart:

- **chosen address answers** → `running`, no warning.
- **`127.0.0.1` answers, the chosen address does not (after 8 s)** → `running` **plus** a
  `warning`. The launcher does not sit out the whole timeout, `guiUrl` falls back to
  `127.0.0.1` so «Открыть GUI» always works, and the UI offers a one-click fix.
- **nothing answers** → `error` with a diagnosis and the log tail.

`POST /api/firewall/allow` adds an inbound allow rule (`profile=any`, TCP, that exact port)
— first unelevated, then through a UAC prompt, then it _verifies_ with
`netsh ... show rule` rather than trusting an exit code. Rule names are space-free
(`notGT-NodeCG-TCP-9090`) because `netsh` re-parses its raw command line. On non-Windows
platforms the endpoint answers with an explanation instead of failing.

`GET /api/diagnostics` re-probes both addresses and returns an actionable `verdict` list,
including a warning when a **system proxy** is enabled and the chosen address is not in
`ProxyOverride` — loopback is normally on the browser bypass list, which is the other
classic reason for "everything except 127.0.0.1 hangs".

## ffmpeg

The server needs ffmpeg to convert `.mp4`/`.mov` uploads. `GET /api/state` carries
`ffmpeg`: `{ installed, source: "launcher" | "system" | "", version, canInstall,
installing, progress, failed, text }`. While there is none — neither in `ffmpeg/` next
to `launcher/` nor on `PATH` — both faces offer **Install ffmpeg**; `POST
/api/ffmpeg/install` downloads the newest LGPL shared win64 build from BtbN/FFmpeg-Builds,
checks its SHA-256 against the release's `checksums.sha256`, unpacks `bin/` (without
ffplay) with a small zip reader of its own, and writes `ffmpeg/notgt-ffmpeg.json`. The
server is always started with `NOTGT_FFMPEG_DIR=<that folder>` and puts it first on
`PATH` for each conversion, so no restart is needed. The install is offered on Windows
only; elsewhere ffmpeg comes from the system. `NOTGT_FFMPEG_DIR` moves the folder, and
`NOTGT_FFMPEG_URL` (+ `NOTGT_FFMPEG_SHA256`) installs from another zip on any system —
that is what the tests use.

## Sign-in («Вход по паролю»)

The sign-in is on unless `cfg/nodecg.json` switches it off. With no `login` block there —
the state of a fresh install — the users are the ones kept in the dashboard's Team tab,
starting with `admin` / `admin`; the card says so, and says it for as long as
`db/notGT-team.json` still marks that account as having the default password.

An administrator set in the launcher is NodeCG's own local login, which lives in the
`login` block of the same `cfg/nodecg.json`. `POST /api/login` merges that block in,
preserving every other key: it generates a `sessionSecret` on first use and stores the
password as `sha256:<HMAC keyed with sessionSecret>` — never as text. `GET /api/state`
reports `login: { enabled, source, username, defaultPassword }` and nothing more — `source`
is `team` (no block), `launcher` (an administrator set here) or `off`. `POST
/api/login/disable` writes `login.enabled: false`; `POST /api/login/default` removes the
block, which is how a switched-off sign-in is turned back on without naming an
administrator. NodeCG reads its config at boot,
so a change applies after «Остановить» → «Запустить»; the response says so while the
server is running.

All three endpoints insist on `Content-Type: application/json`. The control API has no
password of its own, and a page of another origin can post a form to `127.0.0.1` without
asking — but not a JSON request.

`POST /api/stop` kills the child **tree** — `taskkill /PID <pid> /T /F` on Windows,
`SIGTERM` then `SIGKILL` after a grace period elsewhere. The child is always stopped when
the launcher exits (`SIGINT`, `SIGTERM`, `exit`).

## Outliving the window

Closing the Windows window does not stop the server. The window starts this script with
`--background` and, when it closes, sends `POST /api/quit` `{ "stop": false }`: with a
server running the script **stays** to look after it; with none it exits. `{ "stop": true }`
stops the server first. While it runs the script keeps a note of how to reach it —
`launcher/launcher-runtime.json`, `{ pid, port }` (`--runtime <file>` puts it elsewhere) —
and the next window reads the note, asks that launcher for its state and attaches to it
instead of starting another: that is how a server left running shows up as running.
In `--background` a script with no server and no window asking for the state for 20 s
ends by itself. Run by hand (the page), none of this applies: it lives until it is
killed, and takes the server with it.

## Two different HTTP APIs — do not confuse them

The launcher has its own control API, and NodeCG serves the **notGT titles API**. Only the
first one is loopback-only:

|                            | launcher control API                                            | notGT titles API                                                                         |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| base URL                   | `http://127.0.0.1:<control-port>` (ephemeral, printed on start) | `http://<адрес>:<port>/api` (порт NodeCG, по умолчанию 9090)                             |
| reachable from the network | **no, by design**                                               | **yes** — everywhere NodeCG listens (`0.0.0.0` unless you chose «Только этот компьютер») |
| what it is for             | start/stop NodeCG, firewall rules (UAC), logs, diagnostics      | titles, data, templates, outs, animations — Bitfocus Companion, OBS, your own module     |
| docs                       | this section                                                    | [`bundles/notGT/README.md`](../bundles/notGT/README.md#bitfocus-companion)               |

The launcher API is deliberately bound to `127.0.0.1`: it spawns and kills processes and can
raise an elevated `netsh` prompt, so exposing it would hand remote code execution to anyone
on the LAN. The titles API is the integration surface — it lives on the NodeCG port, works
over the LAN, sends permissive CORS headers (`Access-Control-Allow-Origin: *`) and answers
`OPTIONS` with `204`, so a Companion connection, a browser page or a native module can all
talk to it. Verify from another machine with:

```bash
curl -sS http://<адрес>:9090/api/health           # {"ok":true,...} — no token needed
curl -sS http://<адрес>:9090/api/state            # full public state
curl -sS -X POST http://<адрес>:9090/api/titles/lower-third/toggle
```

If the address does not answer from another machine, that is the Windows firewall — see the
section above («Разрешить порт»).

## Launcher HTTP API (127.0.0.1 only, JSON)

| method | path                   | notes                                                                              |
| ------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/`                    | the launcher UI (`ui.html`)                                                        |
| `GET`  | `/api/state`           | full state: version, appDir, interfaces, status, guiUrl, warning, reach, firewall  |
| `POST` | `/api/start`           | body `{ host, port }`; `409` while running, `400` on bad port, `409` if port busy  |
| `POST` | `/api/stop`            | safe no-op `200` when already stopped                                              |
| `POST` | `/api/open`            | optional body `{ url }` (defaults to the _usable_ GUI url)                         |
| `GET`  | `/api/logs?since=<n>`  | `{ lines, next }` for incremental log appends                                      |
| `POST` | `/api/reach`           | re-probes both addresses; returns `{ reach, warning }`                             |
| `GET`  | `/api/diagnostics`     | fresh probe + `verdict[]`, firewall rule state, Windows proxy settings             |
| `POST` | `/api/firewall/allow`  | body `{ port? }`; adds the inbound rule (UAC), then re-probes                      |
| `POST` | `/api/firewall/remove` | body `{ port? }`; deletes the rule                                                 |
| `POST` | `/api/ffmpeg/install`  | downloads ffmpeg into `ffmpeg/` in the background (`202`); progress in `ffmpeg`    |
| `POST` | `/api/login`           | body `{ username, password }`; switches the dashboard sign-in on for that operator |
| `POST` | `/api/login/disable`   | switches the sign-in off; the stored operator is kept                              |
| `POST` | `/api/login/default`   | removes the `login` block: sign-in on, users kept in the dashboard's Team tab      |
| `POST` | `/api/lang`            | body `{ lang }` — `ru` or `en`; answers with the state, in that language           |
| `POST` | `/api/quit`            | body `{ stop? }`; the window is closing — see "Outliving the window"               |

`status` ∈ `stopped | starting | running | stopping | error`.
`guiUrl` is `http://<openHost>:<port>/dashboard/`, where `0.0.0.0` is dialled as `127.0.0.1`;
`networkUrl` is the same address built from the chosen interface and `loopbackUrl` is the
`127.0.0.1` one, so the UI can always offer both.

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
node scripts/e2e-launcher.mjs          # 39 checks: state/API/logs/GUI/cfg/bind + firewall surface
node scripts/e2e-launcher-blocked.mjs  # 11 checks: server up, chosen address silently dropped
```

`e2e-launcher.mjs` boots the launcher on an ephemeral control port, starts a real NodeCG
instance on a free port, asserts the state/API/logs/GUI contract, the `cfg/nodecg.json`
merge, the readiness diagnosis and firewall endpoints, the 409 on a double start, the
occupied-port error, the port being freed after stop, and that `0.0.0.0` is written as the
bind host while a real address is advertised. It backs up and restores the developer's
`cfg/nodecg.json` in a `finally` block.

`e2e-launcher-blocked.mjs` reproduces the reported bug — the server is up but the chosen
address is unreachable (on Linux with a private network namespace, a dummy card and
`iptables -j DROP`; it skips elsewhere) — and asserts that the launcher still reports
`running`, explains the cause, keeps `guiUrl` on loopback and clears the warning on stop.
