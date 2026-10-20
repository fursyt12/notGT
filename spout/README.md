# notGT Spout

**English** · [Русский](README_RU.md)

notGT's **Spout** library: an out shared as a Spout 2 sender on Windows. It is not a
program of its own — the notGT sender in [`../ndi`](../ndi/README.md) renders the out
pages, as it does for NDI, and hands their frames to this library; the launcher starts
that sender with the server.

Resolume, TouchDesigner, OBS with the Spout2 plugin and many other programs on Windows
also take **Spout**: a texture shared on the GPU between programs on one computer. In
**Titles & Outs**, the **Spout** switch sits under the NDI one; switched on, the sender on
that computer lists the out as a Spout sender — `notGT <out>` unless named otherwise in
its settings, with its frame rate (60 fps unless set) and whether it keeps its
transparency.

```
notGT out page ─ Chromium (GPU) ─► D3D11 texture ─► Resolume · TouchDesigner · OBS
```

- **On the GPU, as it is.** With the GPU, Chromium's frame stays a texture: one draw on
  the GPU copies it into the texture Spout receivers open, with its alpha premultiplied as
  Chromium draws it and as Resolume and TouchDesigner take it (or opaque, over black). No copy through memory, no
  compression, nothing on the network. On the CPU, only the rectangle that changed is
  uploaded.
- **At the out's size**, always: on one GPU a smaller picture saves next to nothing.
- **Only on Windows, on the computer that receives it.** Spout does not leave the
  computer. The notGT launcher starts the sender together with the server, so with the
  Windows package there is nothing to do; elsewhere start the sender on the Windows
  machine as for NDI. A sender on Linux or macOS does not ask for Spout outs at all.
- **No NDI needed.** The Spout outs work without the NDI runtime; they need this
  library's addon (`native/`, in the Windows package).
- **Spout cannot count receivers**, so a Spout out is painted at its rate all the time —
  but only when something moves: a still title costs nothing.
- An out can go out over NDI and Spout at once. Each is then drawn by a process of its
  own (the page is drawn twice), so switch on only what is received.

It follows the Spout SDK's protocol (Spout 2.007): the sender is in Spout's list of
senders, has its info and its access mutex, and counts its frames — receivers that ask
for new frames only get them. Two Spout senders cannot have one name: the second says so
under the out.

## What is here

| Path             | What is there                                                         |
| ---------------- | --------------------------------------------------------------------- |
| `native/core/`   | the Spout protocol and the D3D11 sender (Rust, `notgt-spout-core`)     |
| `native/node/`   | the Node-API addon, `native/notgt-spout-native.win32-x64.node`         |
| `src/native.mjs` | loads the addon                                                       |
| `src/sink.mjs`   | one out's frames into one sender: Chromium's textures, or bitmaps     |
| `index.mjs`      | what the sender imports                                               |

```bash
npm run build:native     # on Windows, with Rust: builds the addon
```

## Tests

```bash
cd native && cargo test --release -p notgt-spout-core    # on Windows
```

On Linux they run under wine (which draws, but cannot share textures between
devices; that part is left to Windows):

```bash
cd native && cargo build --release --target x86_64-pc-windows-gnu -p notgt-spout-core --tests
WINEPREFIX=/tmp/wine-spout WINE_D3D_CONFIG=renderer=gl xvfb-run -a wine \
  target/x86_64-pc-windows-gnu/release/deps/sender-*.exe --test-threads=1
```
