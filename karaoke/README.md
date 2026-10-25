# notGT Karaoke

A small Windows program that puts the lyrics of what Spotify plays into notGT, line by
line, for the **Karaoke** example of the library (`example-karaoke`). It reads the playing
track and its position from Windows, finds synced lyrics on the internet and sends the line
being sung to notGT over the [WebSocket API](../bundles/notGT/README.md#bitfocus-companion).

It is the [launcher](../launcher/README.md)'s sibling: a Win32 program in C with the same
look, which links only what Windows ships — no runtime to install. Unlike the launcher it
stands on its own: it can run on the computer where Spotify plays while notGT runs on
another one.

## Using it

1. Start `notGT Karaoke.exe` (it is in the Windows package, next to `notGT Launcher.exe`).
2. Type notGT's address — `localhost:9090`, `192.168.1.20:9090` or a whole `ws://` URL —
   and, if the server asks for one, a WebSocket key (the keys are in the dashboard, Team
   tab), then press **Connect**. The pill says whether notGT let it in.
3. Play a track in Spotify. The window shows the track, the line being sung and where the
   lyrics come from.
4. In notGT, switch the **Karaoke** example on in Control (it is a "stays up" animation).

Closing the window hides it: the program goes on in the notification area. Its menu has
the same controls and **Quit**; Quit tells the title that nothing plays any more.

## When the lyrics are out of sync

A song often has several timings in the sources — LRCLIB alone keeps a few versions of a
song and many copies of the usual one. They are all kept as **variants**: the best one is
shown, and **Previous / Next** switch to the others. "Best" is, in this order: word timing;
a timing that agrees (within 0.35 s) with most of the copies found — an outlier is usually
another version of the song, seconds off; then Musixmatch, LRCLIB, NetEase; then the number
of copies. The journal lists the variants with the shift of each against the one shown.

**Earlier / Later** move this track's text by 100 ms. Both choices are remembered for the
track. **Search again** asks the sources once more, past the cache.

## Sources

| Source     | What it is                                                                      |
| ---------- | ------------------------------------------------------------------------------- |
| LRCLIB     | `lrclib.net`, an open database of synced lyrics                                  |
| NetEase    | `music.163.com`, a large catalogue                                               |
| Musixmatch | the lyrics Spotify itself shows; only with a token of your own account (**Musixmatch…**) |

Musixmatch no longer hands out anonymous tokens (it answers with a token of zeros, and
every search with it returns the same demo song), so without a token of your own it is not
asked. A text in another script than the track's (a transliteration, a translation) is not
taken; a song in two languages is.

## Where its files are

| File                                    | What it holds                                                    |
| --------------------------------------- | ---------------------------------------------------------------- |
| `%APPDATA%\notGT\karaoke.json`           | the address, the language, and the keys — encrypted for this Windows user (DPAPI) |
| `%LOCALAPPDATA%\notGT\karaoke\*.json`    | per track: its variants, the one chosen, its own shift          |

## What it sends

One `setData` frame (`mode: "merge"`) whenever the line changes, playback stops or starts,
or the position drifts by more than 0.35 s; all values are strings:

| Variable                       | Meaning                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `karaoke.artist`, `.title`     | the track                                                            |
| `karaoke.prev`, `.cur`, `.next`, `.next2` | the lines around the one being sung                       |
| `karaoke.pos`                  | ms into the current line when the frame was sent                     |
| `karaoke.dur`                  | ms until the next line                                               |
| `karaoke.sing`                 | ms the line is actually sung (the rest of `dur` is a pause)          |
| `karaoke.wt`                   | `start:end,…` per word, ms into the line; empty without word timing  |
| `karaoke.playing`              | `1` while it plays                                                   |
| `karaoke.seq`                  | a new value with every frame                                         |

Anything that writes the same variables drives the title as well.

## Sources and build

| File (in `win/`)                   | What it is                                                     |
| ---------------------------------- | -------------------------------------------------------------- |
| `notGT-karaoke.c`                  | the windows, the tray, the settings, the engine and the WebSocket |
| `smtc.h`                           | what Spotify plays, from Windows' media controls (WinRT from C) |
| `lyrics.h`                         | the sources, LRC, the variants and their ranking, the cache   |
| `net.h`                            | HTTPS and the WebSocket through WinHTTP                        |
| `notGT-karaoke.rc`, `.manifest`    | the launcher's icon and logo, the version, DPI awareness       |
| `test/post.c`                      | closes, quits or asks about the window, for the test           |

`scripts/build-windows.mjs` builds it into the package. By hand:

```sh
cd karaoke/win
x86_64-w64-mingw32-windres notGT-karaoke.rc -O coff -o karaoke-res.o
x86_64-w64-mingw32-gcc -O2 -municode -mwindows -o "notGT Karaoke.exe" \
  notGT-karaoke.c karaoke-res.o -lwinhttp -lgdiplus -lole32 -lshell32 -lgdi32 -lcomctl32 -lcrypt32
```

The media controls need Windows 10 1809 or later; the rest runs on Windows 8 and later.

## Tests

```sh
node scripts/e2e-karaoke.mjs
```

cross-compiles the program and runs it under wine in a virtual display against a stand-in
for notGT's WebSocket API: the demo song's frames, the variants and the shift from a
remembered track, the key, hiding and quitting. It needs mingw-w64, wine, Xvfb and xdotool
and skips itself without them; it does not reach the internet.

For development the program takes `--simulate` (a built-in demo song instead of Spotify),
`--fake "Artist|Title|seconds|from"` (play that track), `--settings <file>`,
`--cache <dir>`, `--log-file <file>`, `--command <n|p|+|-|0|r>@<seconds>` (press a button),
`--snapshot <dir>` (save pictures of the windows and exit) and `--hidden` (start in the
notification area).
