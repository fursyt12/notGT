# notGT NDI sender

**English** · [Русский](README_RU.md)

Resolume Arena, vMix, TriCaster and a good many other programs take NDI and not a web
page. The sender turns notGT's outs into NDI sources: each out with NDI switched on
becomes one source on the network, at the out's size or smaller, **with its
transparency** — a lower third arrives in Resolume as a layer, not on a black box.

It is a small separate program. It can run on the notGT server itself or on any other
machine on the network — a Raspberry Pi will do — and it finds out from the server what
to send.

```
notGT server ──GET /api/ndi──► sender ──NDI──► Resolume · vMix · OBS (DistroAV) · …
             ◄──status───────
```

## How it stays light

The out page is drawn by Chromium (in Electron) off screen, with no window and no
display, and every painted frame goes straight to the NDI library. The sender does as
little as it can:

- **Nothing moves, nothing is drawn.** Chromium only paints when something on the page
  changes, so a title that is standing still, or an empty out, sends nothing — just one
  repeat a second, so receivers do not take the source for gone.
- **Nobody watches, nothing is sent.** Until a receiver connects the page paints at most
  once a second and no frame is converted or sent. The page keeps running all the same,
  so whatever is on air is there the moment Resolume connects.
- **Only what changed is touched.** Chromium paints premultiplied alpha and NDI wants it
  straight; the conversion is done only inside the rectangle that changed — a lower third
  sliding in costs its own box, not the two million pixels around it.
- **NDI works on its own threads.** Frames are handed over without waiting; compression
  and sending run inside the NDI library while the next frame is being drawn.
- **No GPU needed.** Rendering is on the CPU by default, which is the quicker way for
  offscreen pages on most machines and the Pi. `--gpu` is there for the rest.

Measured on an x86-64 desktop (Linux, a 1920×1080 page with something moving all the
time, sent at 30 fps to one receiver): the sender took about a quarter of one CPU core,
of which the sender's own work was about 0.5% — the rest is NDI compressing the picture.
With nobody receiving, or nothing moving, it is next to nothing.

So what decides the cost is **the size and the frame rate of the picture**, and both are
set per out in the dashboard. Half the size is a quarter of the work.

## What you need

- **Node.js 22.12 or newer.** `npm install` fetches Electron for this machine.
- **The NDI 6 runtime.** The sender does not bring the NDI library with it — it comes
  from NDI:
  - **Windows** — the NDI runtime ([ndi.link/NDIRedistV6](https://ndi.link/NDIRedistV6))
    or NDI Tools. It sets `NDI_RUNTIME_DIR_V6`, which is where the sender looks.
  - **macOS** — the NDI runtime ([ndi.link/NDIRedistV6Apple](https://ndi.link/NDIRedistV6Apple));
    the library ends up in `/usr/local/lib`.
  - **Linux, Raspberry Pi** — the NDI SDK for Linux
    ([ndi.video/for-developers/ndi-sdk](https://ndi.video/for-developers/ndi-sdk/)); copy
    the library of your machine to `/usr/local/lib` (see [Raspberry Pi](#raspberry-pi)).
  - Anywhere — `NDI_LIB=/path/to/libndi.so.6` names the file outright.

## Starting it

1. In **Titles & Outs**, switch **NDI** on for an out. The line next to the switch sums
   up how it goes out; click it for the **NDI settings**:

   | Setting      | Choices                                                                                                                   |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
   | Source name  | what receivers list, as `<computer> (name)`; `notGT <out>` unless given                                                   |
   | Picture size | the out's own, ¾, ⅔, ½ or ⅓ of it — 1920×1080, 1440×810, 1280×720, 960×540, 640×360                                       |
   | Frame rate   | 23.976 · 24 · 25 · 29.97 · 30 · 50 · 59.94 · 60 fps; the broadcast rates go out as n/1001                                 |
   | NDI groups   | which NDI groups see the source, comma separated; empty = NDI's default (`public`)                                        |
   | Transparency | on: with alpha. Off: opaque, over black — about a tenth less work for the sender, and no alpha for the receiver to decode |

   Settings can be made before NDI is switched on.

2. Below the outs, **NDI senders** shows the command to start a sender, with the address
   of this server and — when the sign-in is on — the senders' key. Copy it and run it in
   this folder:

   ```bash
   cd ndi
   npm install            # once
   npm start -- --server http://192.168.1.10:9090 --token ndi_…
   ```

3. In Resolume (or vMix, or OBS with DistroAV) the out appears as
   `<computer> (notGT Main)`. Under the out, the dashboard now says where it is sent from,
   how many receivers watch it and at how many frames a second.

Changing the size, the frame rate or the name in the dashboard restarts that source by
itself; switching NDI off removes it. The sender keeps the sources up while the server
is away and catches up when it is back.

### The key

With the sign-in on (the default), the sender presents **the senders' key**: it opens
`/api/ndi` and nothing else, so a Pi in the corner of the stage cannot drive the show.
An administrator sees it in the command above and can replace it from the `⋯` menu of
**NDI senders** — senders with the old key stop at once. With the sign-in off the API
needs no key, unless `apiToken` is set — then `--token` is the `apiToken`.

### Flags

| Flag              | Default                 | Meaning                                                                  |
| ----------------- | ----------------------- | ------------------------------------------------------------------------ |
| `--server <url>`  | `http://127.0.0.1:9090` | the notGT server (also `NOTGT_SERVER`)                                   |
| `--token <key>`   | —                       | the senders' key or the `apiToken` (also `NOTGT_TOKEN`)                  |
| `--id <name>`     | the host name           | how this sender is named in the dashboard                                |
| `--poll <ms>`     | `2000`                  | how often it asks the server what to send                                |
| `--gpu`           | off                     | render on the GPU instead of the CPU                                     |
| `--url <page>`    | —                       | send this one page instead of asking a server (any page, not just notGT) |
| `--name <source>` | `notGT`                 | with `--url`: the NDI name                                               |
| `--size <WxH>`    | `1920x1080`             | with `--url`: the size the page lays out at                              |
| `--scale <k>`     | `1`                     | with `--url`: draw it smaller, `0.5` = half                              |
| `--fps <n>`       | `30`                    | with `--url`: frames a second                                            |
| `--groups <list>` | —                       | with `--url`: NDI groups                                                 |
| `--opaque`        | off                     | with `--url`: no transparency, over black                                |

`NOTGT_NDI_DEBUG=1` makes it say, every two seconds, what each source sends and what that
costs.

## Docker

On a Linux machine running notGT with Docker Compose — a Raspberry Pi included — the
sender comes with it. Two lines in `.env` next to `docker-compose.yml`:

```bash
COMPOSE_PROFILES=ndi
NDI_ACCEPT_LICENSE=yes
```

```bash
docker compose up --build -d
```

Then switch NDI on for an out in **Titles & Outs**; it shows up in Resolume as
`<this machine> (notGT Main)`. Nothing else to set up:

- **The NDI library** is downloaded from NDI while the image is built — only with
  `NDI_ACCEPT_LICENSE=yes`, which accepts the
  [NDI SDK License Agreement](https://ndi.video/for-developers/ndi-sdk/). Without it the
  build stops and says so. The image keeps a copy of the licence in
  `/usr/local/share/ndi/`.
- **The key** is handed over by the server: it writes the senders' key into a volume the
  two containers share, and the sender reads it from there — again when it is replaced in
  the dashboard.
- **The network**: the sender runs on the host's network (`network_mode: host`). It has
  to — NDI finds sources with mDNS and receivers connect straight to the sender, and
  neither crosses Docker's bridge. It reaches the server on the published port
  (`NOTGT_PORT`).
- **The architecture** is the machine's own: x86-64, arm64 and 32-bit ARM each get their
  Electron and their NDI library.

`NOTGT_NDI_ID` in `.env` names the sender in the dashboard (the host name by default).
`docker compose logs -f ndi` shows what it sends; `docker compose exec ndi node
scripts/probe.mjs --source "notGT Main"` checks the source from inside.

**Docker Desktop (macOS, Windows)** has no real host network for containers, so NDI from
a container does not reach the LAN there. Run the sender natively instead
([Starting it](#starting-it)) — the server can stay in Docker.

## Raspberry Pi

A Raspberry Pi 4 or 5 with the 64-bit Raspberry Pi OS — Lite (no desktop) is enough: on a
Linux with no display the sender renders with none.

1. **Node.js 22** — from [nodejs.org](https://nodejs.org/en/download) or NodeSource.
2. **The NDI library.** Download the NDI SDK for Linux, unpack it and copy the Pi's
   library:

   ```bash
   tar xzf Install_NDI_SDK_v6_Linux.tar.gz
   sh Install_NDI_SDK_v6_Linux.sh          # shows the licence; type y
   sudo cp -P "NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi/"libndi.so* /usr/local/lib/
   sudo ldconfig
   ```

   (`arm-rpi4-linux-gnueabihf` is the folder for a 32-bit system.)

3. **What Chromium needs**, on Lite:

   ```bash
   sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 \
     libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
     libpango-1.0-0 libcairo2
   ```

4. **The sender** — this folder, then `npm install`.
5. **Start it with the system** — `/etc/systemd/system/notgt-ndi.service`:

   ```ini
   [Unit]
   Description=notGT NDI sender
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=pi
   WorkingDirectory=/home/pi/notGT/ndi
   ExecStart=/usr/bin/npm start -- --server http://192.168.1.10:9090 --token ndi_…
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now notgt-ndi`, and `journalctl -u notgt-ndi -f` to watch it.

On a Pi, give the out a smaller NDI picture — **1280×720** or **960×540** — and 25 or 30
fps; keep 1920×1080 for a desktop. Use wired Ethernet: NDI is a lot of data, and Wi-Fi
drops frames. The sender has been built and measured on x86-64 Linux; Electron, koffi
and the NDI library all ship ARM builds for the Pi, but this README does not yet carry
numbers measured on one.

## Checking it without Resolume

`npm run probe` looks at NDI from the receiving end:

```bash
npm run probe                                   # the sources on the network
npm run probe -- --source "notGT Main"          # receive one for 5 s: size, fps, alpha
npm run probe -- --source "notGT Main" --save frame.pam --pixel 960,540
```

`--save` writes the last frame as a PAM image with its alpha (GIMP and ImageMagick open
it). `--ips 10.0.0.5` reaches a machine that mDNS does not.

## When something is off

- **“The NDI library was not found”** — install the NDI runtime (see above) or set
  `NDI_LIB`. The message lists every place it looked.
- **The source is not seen in Resolume** — NDI finds sources with mDNS (UDP 5353) and
  sends over TCP from port 5960 up; let both through the firewall of both machines. On
  networks without mDNS, NDI Access Manager or a Discovery Server tell receivers where
  to look.
- **The sender says the server refused the key** — the key was replaced, or this is the
  `apiToken` of another server. Copy the command again from **NDI senders**.
- **“No NDI sender has picked it up yet”** — no sender reports to this server: it is not
  running, or it follows another address. Its own output says which.
- **Chromium does not start on Linux** (`The SUID sandbox helper binary was found, but
is not configured correctly`) — `npm start` turns Chromium's sandbox off by itself
  where it cannot work (as root, in a container); elsewhere add `--no-sandbox`, or
  `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 …`.

## Tests

```bash
npm test                                        # frame conversion, the sync with the server
NOTGT_BASE=http://127.0.0.1:9090 node ../bundles/notGT/scripts/e2e-ndi.mjs   # the server's side
```

The fixture page `test/fixtures/page.html` has pixels whose values are known (opaque
red, white at half alpha) and something that moves: send it with `--url` and look at it
with the probe.

---

NDI® is a registered trademark of Vizrt NDI AB. notGT is not made or endorsed by NDI;
the sender only uses the NDI library, which is NDI's and comes under its own licence.
