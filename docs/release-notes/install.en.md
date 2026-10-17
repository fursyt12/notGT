### Downloads

Portable builds: there is no need to install Node.js — it is already inside.

- **Windows (x64)** — `notGT-win-x64.zip`
- **macOS (Apple silicon, M1 and later)** — `notGT-macos-arm64.zip`

### notGT for Windows (x64)

A portable build: unpack the whole ZIP archive into a folder of its own and
run `notGT Launcher.exe` (or `notGT.cmd` if the `.exe` was not built).
There is no need to install Node.js — it is already inside.

#### What is inside

- `notGT Launcher.exe` — the launcher: a window to pick the network interface and the port, start and stop the server, set the sign-in, open the firewall and read the log; in Russian or English;
- `notGT.cmd` — a fallback start through `node\node.exe`: the same controls as a page in the browser;
- `launcher/` — what the launcher's window drives;
- `node/` — the official Node.js for Windows;
- `ndi/` — the NDI sender: outs with NDI switched on show up in OBS, Resolume and other programs (needs the NDI Runtime or NDI Tools);
- `app/` — the NodeCG server and the built `notGT` bundle (`app/bundles/notGT`), with `cfg/`, `db/`, `assets/`, `logs/`.

#### Getting started

1. Unpack the archive into a folder of its own.
2. Run `notGT Launcher.exe`.
3. Pick the network interface and the port, press “Start”, then “Open dashboard”.
4. The dashboard asks for a name and a password. On a new server it is `admin` / `admin` — sign in and change the password in the Team tab straight away. The other users, their groups and the keys for Bitfocus Companion are added there too.

Closing the launcher does not stop the server: it keeps running, and the
next time the launcher is started it shows the server that is running. To
stop the server, press “Stop”.

#### If the dashboard does not open on another device

The server listens on every interface, and the chosen address goes into
the links. If the page “never loads”, it is almost always Windows Firewall:
it does not let incoming connections reach `node.exe`. In the launcher open
“Network and firewall…” and press “Allow the port” (administrator rights
are needed) — the rule is made for the chosen port in every network
profile. “Check” shows which addresses really answer.

#### OBS Browser Source

The address is copied in the dashboard with “Link for OBS” — every out has
its own, with that out's key in it:

```
http://<chosen-interface>:<port>/bundles/notGT/graphics/out.html?out=main&key=out_…
```

Size 1920x1080, switch on “Transparent background”. When updating from a
version without the sign-in, copy the links into OBS again: the old ones,
without a key, show the sign-in page.

#### .mp4 and .mov videos

To upload `.mp4` and `.mov` into a video layer, the server needs ffmpeg —
it converts them. It is not in the package: while there is none, the
launcher's window has an “Install ffmpeg” button. One press downloads ffmpeg
(about 75 MB), checks it and puts it into an `ffmpeg` folder next to the
launcher; the server picks it up without a restart. Ready `.webm` files
upload without ffmpeg.

#### Data

Settings and media live in `app\cfg`, `app\db` and `app\assets`. To update,
unpack the new version into a new folder and move these folders over — the
uploaded files and the database are kept.

### notGT for macOS (Apple silicon)

For Macs with Apple processors (M1 and later), macOS 11 and later. Unpack
the whole ZIP archive and run `notGT Launcher` from the unpacked folder. Do
not move the program out of the folder: `node`, `launcher` and `app` are
next to it.

#### First start

The build is not signed with an Apple developer certificate, so on the
first start macOS says it cannot check it. Either of two ways:

- “System Settings” → “Privacy & Security” → “Open Anyway” at the bottom
  (it appears after the first attempt to start);
- or in Terminal, with your own folder:

  ```
  xattr -dr com.apple.quarantine ~/Downloads/notGT-macos-arm64
  ```

Once allowed, the program takes the quarantine mark off its own folder:
otherwise macOS would not let the server load the database driver.

#### What is inside

- `notGT Launcher.app` — the launcher: a window to pick the interface and the port, start and stop the server, set the sign-in and read the log; in Russian or English;
- `notGT.command` — a fallback start without the window: the same controls as a page in the browser;
- `launcher/`, `node/`, `app/` — the same as in the Windows build.

Closing the window does not stop the server; to stop it, press “Stop”.
The data lives in `app/cfg`, `app/db` and `app/assets`.
