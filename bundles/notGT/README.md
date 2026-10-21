# notGT — the `notGT` bundle

**English** · [Русский](README_RU.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../media/brand/notgt-logo-on-dark.svg">
  <img src="../../media/brand/notgt-logo.svg" alt="notGT" width="260">
</picture>

**notGT** is a web titling and broadcast-animation system that runs as a NodeCG bundle.
It gives you several independent outputs (outs), each opened in OBS as a Browser Source
by its own URL; a set of animations, either assembled from primitives (text, image, gif,
shape) or written by hand in HTML/CSS/JS; and a REST API through which the dashboard,
Bitfocus Companion and any external integration drive all of it.

The server side (the extension) is the single source of truth: it keeps the state in
Replicants, owns the playback timers and exposes `GET /api/state`. The graphics pages only
draw what they are sent, so the state in the API always matches what is on screen.

---

## Contents

- [Mental model](#mental-model)
- [Quick start](#quick-start)
- [Dashboard: panels](#dashboard-panels)
- [Bundle configuration](#bundle-configuration)
- [Sign-in (login)](#sign-in-login)
- [Team: users, groups and keys](#team-users-groups-and-keys)
- [REST API](#rest-api)
- [WebSocket API](#websocket-api)
- [Bitfocus Companion](#bitfocus-companion)
- [OBS Studio](#obs-studio)
- [NDI](#ndi)
- [Persistence](#persistence)
- [Project files (.ngt)](#project-files-ngt)
- [Writing a code animation](#writing-a-code-animation)
  - [Transitions: entrance and exit](#transitions-entrance-and-exit)
  - [Ready-made examples](#ready-made-examples)
  - [Data from the internet](#data-from-the-internet)
  - [Generating titles with AI](#generating-titles-with-ai)
- [Troubleshooting](#troubleshooting)

---

## Mental model

Four entities and one rule.

### Outs

An **out** is one render target = one OBS Browser Source = one URL:

```
http://<host>/bundles/notGT/graphics/out.html?out=<outId>
```

An out has an `id`, a `name`, a design size `width`/`height` (1920×1080 by default) and a
list of placements. Outs are fully independent: several Browser Sources with different
`?out=` values work at the same time, and each draws only what is addressed to it. The out
with the id `main` is created on first run (see the `defaultOutId` key).

### Animations / templates

A **template** is one whole animation. There are two kinds (`kind`):

- **`layers`** — drawn from primitives: `text`, `image`, `gif`, `shape` (`rect`/`ellipse`).
  Each layer is positioned in percent of the template's design box (`x`, `y`, `width`,
  `height`), has a style (font, size, colour, stroke, shadow, opacity, rotation), a `z`
  for stacking order, and either a `binding` (a path to a variable) or `text` with
  `{{...}}` substitutions. For an `image`/`gif` layer, `src` is an absolute URL,
  `/assets/<bundle>/<file>` or a path relative to the bundle.
- **`code`** — your own HTML/CSS/JS (`code.html`, `code.css`, `code.js`), executed in a
  sandboxed iframe. The contract is described in
  [“Writing a code animation”](#writing-a-code-animation).

A template has an entrance and an exit (`inTransition` / `outTransition`: `none`, `fade`,
`slide-left/right/up/down`, `scale`, `wipe-left/right`, plus `durationMs` and an optional
`delayMs`) and its own playback configuration, `playback` (used when a placement has none
of its own). For `kind: "layers"` the transitions are applied to the animation's wrapper;
`kind: "code"` has **none at all**: the code itself animates the entrance and the exit
(`onShow` / `onHide`) and the system does not touch the wrapper — see
[“Transitions”](#transitions-entrance-and-exit).

**Every layer can have an entrance and an exit of its own**: the same two fields,
`inTransition` / `outTransition`, on the layer. They play on the layer itself, together
with the template's on the whole picture, and each waits its own `delayMs` first — so a
plate can wipe in, the name slide up 200 ms later and the role fade in after that. All
the clocks of a phase start together: when the animation is shown for an entrance, when
it is taken off for an exit. `none` with a delay is a cut at that moment. A layer without
these fields simply comes and goes with the animation, and on the way out the animation
stays up until its last layer has left.

### Placements (items)

A **placement** is a template put on a particular out. It has its own coordinates `x`/`y`
(in percent of the out's stage), `scale`, `enabled`, `held`, `order` and its **own**
`playback`, which overrides the template's:

- `mode: "once"` — plays only on an explicit trigger (`trigger`, `show` or a command from
  Companion): entrance → stays for `holdMs` → exit. This is the one-shot title;
- `mode: "loop"` — “on air while it is switched on”: the **“On air”** switch (the same
  `held`) turns it on and off, it has no length of its own, and whatever repeats is done
  by the animation inside itself. `holdMs`, `intervalMs` and `autoStart` do not apply;
- `holdMode: "video"` — the on-air time (for `once`) is taken **from the template's own
  video layer** rather than from `holdMs`: the title stays exactly as long as the clip
  plays. The length is measured on the server with `ffprobe`
  (`GET /api/media/probe?templateId=<id>`) and cached by file and mtime; if it cannot be
  measured (no video layer, `{{...}}` in `src`, an external URL, no ffprobe), `holdMs` is
  used as the fallback. The default is `fixed`.

Separately from `playback` there is `held` — “show it and keep it”. While it is on (the
**“On air”** switch in the Control panel), the placement stays on air and is not taken
off by `holdMs` or by the `once`/`loop` schedule; switch it off and it is hidden. `held`
wins over `enabled`.

One more field of a placement is `crop`: a window `{x, y, width, height}` **in template
pixels** that decides which part of the animation is visible. Everything outside the
window is cut off (on the out it is `overflow: hidden` around content shifted inwards),
while the animation itself stays where it is and at its own scale: a crop removes what is
not needed, it does not shrink the title. Without `crop` the whole template box is
visible. It is set with the mouse in the editor (the **“Crop”** button) or through the API.

Its sibling is `bounds`, the same kind of window but for the animation's **box itself**:
the area the animation is rendered in, made bigger or smaller with **“Scale Bounds”**.
Its edges may go past the template box on any side (`x`/`y` below zero, `width`/`height`
beyond the template's), so a box grown to the right shows what the animation draws there.
The animation keeps its size and its place, only the box changes, and everything outside
the box is clipped. A placement has either `crop` or `bounds`: each tool writes its own
and clears the other, and if an API client sends both, `bounds` wins. A code animation
draws inside its iframe, which keeps the template's size, so growing its box past the
template only adds empty space.

The same template can be placed on several outs, or several times on one out — these are
different placements with different `id`s.

### Variables (data)

A global store of values (the `titleData` Replicant), addressed by paths:
`speaker.name`, `panel.items[0].title`. In a template a path is substituted as
`{{speaker.name}}`, with a fallback as `{{speaker.name ?? Guest}}`. A path is an English
identifier; a value is anything (string, number, bool, nested object).

**List variables.** A value can be an array; the variable then behaves as a “pick one”
collection:

```json
{ "guests": [ { "name": "Anna", "role": "Expert" },
              { "name": "Peter", "role": "Guest" } ] }
```

Which element is the current one is kept in the `selection` Replicant (`{ "guests": 1 }`).
A binding that passes through an array resolves against the chosen element:
`{{guests.name}}` → `Peter`, `{{guests.role}}` → `Guest`. A path may end on the array
itself — `{{guests}}` returns the chosen object. An explicit index always wins:
`{{guests[0].name}}` → `Anna`. If nothing is chosen, element `0` is used.

In the **Control** panel a list is shown as a table: a row per element, and the mark on
the left picks the row that goes on air. A row can be added (**`+ Row`**), edited in
place, and moved, duplicated or deleted through the `⋯` menu. Changing the chosen row
changes the picture on air at once — without reloading the Browser Source (verified by a
test, ~10 ms).

A scalar variable can be turned into a list: the variable's `⋯` menu → “Turn into a list”.

The active show also has a **per-show override**: `data` in the body of
`POST /api/titles/:id/show` is laid over the global store without changing it. This is
handy when names come from outside and have no place in the global variables.

### Timers

A **timer** is a countdown or a stopwatch that the operator starts, pauses and nudges in
the **Control** panel (or from Companion, REST or the WebSocket), and that any number of
titles show at once. Each timer is a group of variables under `timer.<key>`:

| Variable                   | Example    | What it is                                                         |
| -------------------------- | ---------- | ------------------------------------------------------------------ |
| `timer.match.text`         | `04:59`    | The value in the timer's format.                                   |
| `timer.match.hh` `mm` `ss` | `00` `04` `59` | Hours, minutes within the hour, seconds within the minute.     |
| `timer.match.t`            | `3`        | Tenths of a second.                                                |
| `timer.match.sign`         | `-`        | `-` past zero (overtime), empty otherwise.                         |
| `timer.match.totalSeconds` | `299`      | The shown value in whole seconds; negative in overtime.           |
| `timer.match.progress`     | `0.0033`   | 0 → 1 over the duration.                                           |
| `timer.match.running` `done` `overtime` | `true` | Whether it runs, has reached its end, is past zero. |
| `timer.match.name`         | `Match`    | The timer's name.                                                  |

- **In a layers title** — `{{timer.match.text}}` in any text, or a text layer whose
  variable is `timer.match.text`. **Editor → Layer → Timer** adds such a layer in one go
  (and makes a timer if there is none yet): a timer as a title of its own.
- **In a code title** — `timer("match")` → `"04:59"`, `timer("match", "ss")` → `"59"`;
  `<span data-bind="timer.match.text">` ticks by itself, and `onData` runs as the timer
  ticks. An animation whose code does not mention `timer` is not sent the ticks, so its
  `onData` does not run every second for nothing.
- **Counts** `down` from its duration to zero (then stops, or goes on with a minus when
  “Past zero, keep counting” is on) or `up` from zero (stopping at its limit, if it has
  one). **Format**: `auto` (`04:59`, `1:04:59`), `hh:mm:ss`, `mm:ss` (minutes past 59 keep
  counting), `ss`, `mm:ss.t`.
- **Shared with** — the groups of the [team](#team-users-groups-and-keys) whose members see
  the timer in the Control panel and whose WebSocket keys may drive it; none = everyone.
  A member's new timer is shared with their own groups, and they can share it with another
  group too. The titles read every timer, whoever it is shared with.

The server keeps a timer as *when it was started and how much it had counted before*, on
its own clock, never as a ticking number: every out and panel works out the value itself,
so all of them show the same second without a frame per tick, an out on another machine
included. A countdown that reaches zero is stopped by the server at that moment.

### Service state

- The `activeTitle` Replicant — the “program”: what is shown now, on which out, with which
  label and overrides. This is what survives a restart.
- The `runtime` Replicant — derived: `playing` (`{outId: [itemId, ...]}`), `triggers` and
  `revision`. Recomputed on the server and not persisted.
- The `selection` Replicant — the chosen element of every list variable
  (`{"guests": 1}`). Persisted; included in `GET /api/state`.
- The `timers` Replicant — the [timers](#timers). Persisted; listed (without their
  ticking value) in `GET /api/state`.

---

## Quick start

```bash
# 1. (optional) enable the API token
cp bundles/notGT/cfg/notGT.example.json \
   bundles/notGT/cfg/notGT.json
$EDITOR bundles/notGT/cfg/notGT.json

# 2. start NodeCG from the repository root
node index.js
```

Then:

- the dashboard — `http://localhost:9090/dashboard/`. Sign in as `admin` / `admin` and
  change the password in the **Team** tab (see [Sign-in](#sign-in-login));
- add the graphics to OBS: copy the out's address with “Link for OBS” — it looks like
  `http://localhost:9090/bundles/notGT/graphics/out.html?out=main&key=out_…`

Building the bundle (if you changed `src/`):

```bash
cd bundles/notGT && npm install && npm run build && cd ../..
```

For the Docker deployment see `docker-compose.yml` and `.env.example` in the repository root.

---

## Dashboard: panels

The dashboard is at `http://<host>/dashboard/`. The bundle's panel files are served from
`/bundles/notGT/dashboard/<file>`.

The tabs at the top are the bundle's four panels, each taking the whole screen
(`fullbleed`). Each has its own job, and settings are not repeated between them:

| Panel             | What it is for                                               |
| ----------------- | ------------------------------------------------------------ |
| **Control**       | on air: show, hide, change the data                           |
| **Titles & Outs** | setup: outs, the animation library, what sits on which out    |
| **Editor**        | look: the out's canvas, layers, code, position and crop       |
| **Team**          | people: users, groups, whose outs are whose, the keys         |

In every panel yellow — the brand's Lemon — means one thing: **this is on air right now**. Deleting and other rare
actions live in the `⋯` menu at the end of a row.

The dashboard's **language** — English or Russian — is switched with the `EN` / `RU`
button in the top-right corner of any panel; the choice is shared by all three and
remembered in the browser. By default the browser's language is used, and `?lang=ru` or
`?lang=en` in a panel's address sets it for that one page. The translation lives in
`src/dashboard/locales/ru.json` (English phrase → Russian). To add a language, copy that
file, translate the values and add the language to `LANGS` and `DICTS` in
`src/dashboard/i18n.tsx`; a phrase without a translation is a type error, so
`npm run typecheck` checks completeness. The labels below are the English ones.

The dashboard's **theme** is switched with the sun / moon button next to it: **Dark**
(Cream on Studio, the default), **Light** (Studio on Cream, the brandbook's own page) or
**As in the system**. The choice is shared by the three panels and the shell around them
and remembered in the browser; `?theme=light` or `?theme=dark` in a panel's address sets
it for that one page. The colours of both themes are the tokens at the top of
`dashboard/ui.css`. Signal and Amber are too pale to read as text on Cream, and Lemon
nearly vanishes on it, so in the light theme accents are fills and edges, accent-coloured
text is a shade mixed towards Studio, and whatever is on air keeps its Lemon inside a
Studio edge. The Editor's stage stays dark in both themes: a title is drawn for video.
The theme never touches what goes on air.

### Control (`control.html`)

The operator's “here and now” panel. It does not change any layout — only what is on air
and the data.

- The **on-air bar** at the top says what is showing on all outs and holds the
  **“Take everything off air”** button: it clears every out at once — turns off the
  “On air” switches, stops what is playing and hides the animation shown by hand.
- **Outs** — a block per out, a row per placement. A row has two actions:
  - **`Play`** — a one-shot: entrance → `holdMs` → exit. The button only exists for timed
    placements (`once`) while they are not being held;
  - the **“On air”** switch — “show it and keep it” (the `held` flag): on, and the
    placement stays on air for as long as needed and is not removed by `holdMs`; off, and
    it is hidden. It does not depend on `once`/`loop` and wins over `enabled`. For a
    placement that stays up it is the only control.

  The caption under the name (`5 s`, `until switched off`) opens the “how long it stays on
  air” setting: **“Timed”** (`mode: "once"`) — the `Play` button shows the placement for
  “Hold” seconds; **“Until switched off”** (`mode: "loop"`) — no button, only the switch.
  “As long as the video” (`holdMode: "video"`) is offered only when the animation has a
  video layer. Nothing loops by itself: `loop` in the data is the historical name of the
  “until switched off” mode.
  **“Link for OBS”** in the block's header copies the Browser Source address.
- **“Show an animation without placing it”** (folded) — the manual “program”, the same one
  the REST API and Companion drive: pick an animation and an out, then `Show` /
  `Play once` / `Hide`. The “Custom data for this show” checkbox opens a field for
  per-show overrides in JSON — they apply to one show and do not change the variables.
- **Data** — the variables, grouped by the first segment of their path (`speaker` →
  `name`, `role`). A value is edited right in its row and goes on air as you type. A list
  variable is shown as a table: the mark on the left picks the row that goes into
  `{{...}}`. **`+ Variable`** adds a value by path, **`JSON`** is bulk input (“Add to
  current” = merge, “Replace all” = replace). **`Excel`** connects a workbook — see below.
  A list's `⋯` menu has “Add a column”, which gives every row a new field.

#### Excel as a data source

An `.xlsx` workbook can be the source of list variables. **Every sheet is a list**: the
first filled row names the columns, every row under it is a row of the list. The sheet
gives the variable its name (`Guests` → `{{Guests.Name}}`), spaces becoming `_`; a sheet
still called `Sheet1` takes the file's name instead. Field names are the column headers
as written, so what you see in the spreadsheet is what you bind.

There are two ways to connect a workbook, chosen in **`Excel`** on the Data panel:

- **Load a file** — the file comes from your machine: pick it in the form, or simply
  **drop the `.xlsx` anywhere on the Data panel**. The server keeps a working copy.
  “Download the workbook” in the workbook's `⋯` menu gives the copy back, with your edits
  in it. Loading a file of the same name again replaces the copy.
- **Track a file on the server** — you give the path of a workbook on the machine notGT
  runs on (`/data/titles.xlsx`, `C:\Titles\guests.xlsx`). The file stays where it is and
  is read again whenever it is saved there — the list follows by itself, usually within a
  second or two. In Docker the path is a path inside the container: mount the folder
  first (there is a commented-out example in `docker-compose.yml`).

In both modes the list is an ordinary list in Data — the row mark, the cells, `+ Row`,
moving and deleting rows all work — and **an edit is written into the workbook**: a
changed value goes into its cell, a new row under the last one, a new column after the
last one, and a removed row or column is emptied. Only cells whose value changed are
touched, so formats, column widths, formulas and the other sheets stay as they were.
The same holds for a change made through the REST API.

What to know before pointing it at a workbook that matters:

- **A tracked file is the master.** When it is saved on disk, it replaces the list, an
  unsaved edit in Data included.
- **A workbook open in Excel cannot be written.** Excel locks the file; the workbook's
  line in Data says so, and the edit is written the next time you change a value after
  closing it. Reading keeps working.
- **Overwriting a formula.** A cell with a formula shows its calculated value; editing
  that value in Data replaces the formula with the value.
- **Keep it a table.** notGT rewrites the file with a spreadsheet library. Values,
  formulas, formats and widths survive that; charts, pivot tables and macros are not
  guaranteed to. Use a plain workbook for titles, and only `.xlsx` is read.
- **Connecting never overwrites silently.** If a sheet would replace a variable that
  already exists, you are asked first.
- **Tracking uses the server's rights.** Whoever can open the dashboard can have the
  server read and rewrite an `.xlsx` at any path it can reach. Only `.xlsx` paths are
  accepted; keep the dashboard behind a login or on a trusted network, as for the API.
- “Disconnect” lets go of the workbook and leaves its lists as ordinary variables;
  deleting a list lets go of its sheet. The file itself is never deleted, except the
  working copy of a loaded one.

### Titles & Outs (`titles.html`)

The make-up of the show: which outs exist, which animations, and what sits on which out.

- **Outs** (left) — each has a name and a stage size (edited in place), the address for
  the Browser Source with a “Copy” button, and its list of placements. A placement has its
  order (the arrows appear on hover) and a `⋯` menu: play once, **replace the animation**
  (position and settings stay), turn API start off (`enabled`), remove from the out.
  **`+ Add animation`** puts an animation from the library on this out.
- **Animations** (right) — the library: name (edited in place), kind (`layers` / `code`),
  the variables the animation reads, the **“Place”** button and a `⋯` menu (duplicate,
  delete). **`+ New animation`** creates an animation from layers or from code, or adds a
  ready-made one — **“From an example”** opens the [gallery](#ready-made-examples).
- **Project** (next to “New animation”, for an administrator) — **“Save project”** gives
  one `.ngt` file with every animation, out and variable and the media they use; **“Open
  project…”** puts such a file in place of all of that. See
  [Project files (.ngt)](#project-files-ngt).

Under an out's address sits its **NDI** switch, with the source name, the picture size
and the frame rate — see [NDI](#ndi).

A placement's position, scale and crop are set on the canvas in Editor, and its mode and
duration there or in Control: they are left out of this panel on purpose.

### Editor (`editor.html`)

The editor of the **selected out**. The canvas is the out's stage
(`out.width × out.height`): it shows everything placed on this out exactly as OBS will
draw it.

**The toolbar**

- **`Out`** switches the out being edited; the link icon next to it copies its address for
  OBS.
- **`+ Layer`** — text, a shape, an image, a GIF or a video into the active animation. If
  none is selected (or a code animation is), a new animation the size of the out is
  created, placed on it and made active.
- **`Crop`** turns on the crop tool for the active placement (see below).
- **`Scale Bounds`** turns on the tool that resizes the active placement's box (see below).
- The **full-screen** button next to it gives the whole screen to the desk — the canvas
  and its status bar, without the bars around it. The same button sits at the end of the
  status bar, so it is there in full screen too; `Esc` also leaves. Where the browser does
  not allow a page full screen, the desk fills the panel instead. In full screen
  **`+ Layer`**, **`Crop`** and **`Scale Bounds`** come along: they move into a strip above
  the canvas, so a layer can be added and a placement cropped without leaving it.
- **`Play`** and **`Go on air`** act on the selected placement: the same one-shot and the
  same “On air” switch Control has (the button turns into **`Take off air`**). Unsaved
  edits are saved first. For an animation that is not on this out, the manual show is
  used.
- **`Save`** writes the edits to layers and the template; while something is unsaved,
  “Unsaved” is shown next to it. Placements apply at once, without saving: a drag must
  never be lost.

**On the left** are three lists: **“On the out”** (placements: order, play, remove; a yellow
dot means on air), **“Layers”** of the active animation (order, hide, lock, delete;
double-click to rename) and the **“Library”** of all animations (place, duplicate, delete;
“+” for a new one). A row's actions appear on hover and on the selected row.

**The canvas**

- **What is on air is visible on the canvas.** Everything on air on this out is drawn
  under the canvas by the out page itself — the same one OBS has open — so entrances,
  holds and exits play here exactly as they go out: press `Play` or turn the switch on
  (here, in Control or through the API) and the animation plays on the canvas. A placement
  that is on air has a yellow frame with an “On air” tag. While the active animation has
  unsaved edits or a selected layer, the canvas shows the draft and the on-air picture
  under it is faded: what is on air is the saved version.
- A **placement** is edited with the mouse: drag the active animation's frame (changes
  `x`/`y` in % of the stage), drag the corner handle to scale it (`scale`). The animation
  follows the cursor **immediately**, live code preview included: position and scale are
  written once, when the mouse button is released, and until then the canvas shows the
  result to come and spells it out in the status bar below. Animations that are not
  selected are dimmed and become active on a click.
- **Crop**: a frame with eight handles (corners and edge midpoints) sets the **visible
  part** of the animation. Everything outside the frame is hidden — on the canvas and on
  air; the animation itself neither moves nor scales, so a crop removes what is not needed
  rather than resizing. The frame can be dragged as a whole, the handles along its edges;
  the magnets pull it to the edges and centre of the template box, to the out's lines
  (edges, the 5 % safe area, the centre) and to the visible windows of other animations.
  `Esc` or “Done” turns the tool off. The crop is stored in the placement (`crop` in the
  `outs` of that out) and visible through `GET /api/outs`.
- **Scale Bounds**: a frame with the same eight handles sets the **box the animation is
  rendered in**. Pulling a handle moves only that edge, inwards or outwards, past the
  template box too. The animation does not stretch, move or scale; what falls outside the
  new box is hidden. Only the new box is drawn, not the template box's old corners.
  Dragging inside the frame moves the placement, and the edges stick to the out's lines
  and to other animations. “Reset” goes back to the template box; `Esc` or “Done” turns
  the tool off. It is stored as `bounds` in the placement.
- The **magnets** measure a placement by its **visible part**: a cropped animation sticks
  to lines with the edge and centre of its window, not of the hidden template box, and
  that same window is offered to other animations as a target. The magnets also work
  while resizing: a placement's corner handle sticks with the window's right and bottom
  edges and its centre to the same lines, and a layer sticks with the edges being dragged
  to the edges and centre of the template box and to its sibling layers.
- **Layers** inside an animation are selected with a click, dragged and resized on the
  canvas; the empty part of the box, its frame and the handle in its top-left corner move
  the whole placement.

**The bars are resizable.** Drag the inner edge of the left bar, of the right bar or the
top edge of the code dock to give the desk more or less room; the arrow keys move a
focused edge, and a double click gives the bar its own size back. The sizes are
remembered in the browser.

**On the right is the inspector**, with a tab for each thing being edited:

- **“Layer”** — the selected layer's properties: position and size, text and variable,
  font, stroke and shadow, the source of an image or a video, and “Entrance and exit” —
  the layer's own transitions with their delays. The tab opens by itself when a layer is
  selected.
- **“Placement”** — the animation on this out: `x`/`y`/scale and “Fit out width”
  (`scale = out.width / template.width`), the size of the crop window and of the scaled
  bounds, each with “Clear”,
  playback (“Timed” / “Until switched off”, “Hold”, “As long as the video”), “Starts from
  the API and Companion” (`enabled`).
- **“Animation”** — the template itself: name, box size, kind, “Entrance and exit” and
  default playback. For a code animation, instead of transitions it shows what the code
  animates itself and how long its exit takes: that is read from `onHide(fn, ms)` and
  written to `code.exitMs` for you.

**“Entrance and exit” is a timeline of the whole animation.** There is a row for the
animation as a whole and one for each layer; the entrance is the left half of a row and
the exit the right half, and a bar starts at its delay and is as long as its duration.
Both halves count from zero — the entrance from the moment of the show, the exit from the
moment the animation is taken off — and the totals above them say how long each takes.

- **Drag a bar** to set when it starts, and **its right edge** to set how long it takes;
  with the focus on a bar the arrow keys move it by 10 ms (`Shift` — by 100 ms).
- A layer with no transition of its own is drawn as a dashed outline of the animation's:
  it comes and goes with the whole picture. Dragging that outline gives the layer a
  transition of its own.
- **Click a row** to get its numbers under the timeline: the transition, the delay, the
  duration and the easing, for the entrance and for the exit. “With the whole animation”
  takes a layer's own transition away again.
- The exit of the whole animation takes the picture away, so what a layer does after it
  is not seen: that part of the bar is hatched, and a note says what to change.

`Play` shows the result on the canvas, exactly as it goes on air.

A **code animation** (`kind: "code"`) is edited in the **dock under the canvas**: tabs for
HTML / CSS / JavaScript, a “Reference” for the runtime, and a preview of the animation on
its own with a “Replay” button (plays the entrance again). The live preview is also drawn
right on the canvas, where the placement is (or in the centre, if the template is not on
this out yet). The arrow on the right folds the dock away.

### Team (`team.html`)

For an administrator: the groups with their outs and WebSocket keys, the users, and the
OBS link of every out. Described in [Team](#team-users-groups-and-keys). Everyone else
sees which groups they are in.

---

## Bundle configuration

NodeCG reads the bundle's config from `bundles/notGT/cfg/notGT.json`; the schema is
`bundles/notGT/configschema.json`. **There is no active `notGT.json` in the repository** —
copy the example first:

```bash
cp bundles/notGT/cfg/notGT.example.json \
   bundles/notGT/cfg/notGT.json
```

| Key                        | Type    | Default      | Purpose                                                                                        |
| -------------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `apiToken`                 | string  | `""`         | Shared secret for `/api`. An empty string means the API is open.                                |
| `wsToken`                  | string  | `""`         | The key of the [WebSocket API](#websocket-api) — what goes into the Companion module. Empty = `apiToken` is the WebSocket's key too. |
| `allowUnauthenticatedApi`  | boolean | `false`      | Explicitly allow an open API and silence the warning. Ignored when `apiToken` is set.           |
| `hideApiState`             | boolean | `false`      | Drop `templates`/`outs` from the `GET /api/state` response (for frequent polling from Companion). |
| `defaultOutId`             | string  | `"main"`     | The `id` of the out created on first run.                                                       |
| `language`                 | string  | `""`         | Language of the example library and sample data on first run: `en` or `ru`. Empty = the server process's locale, else English. |

The config is read once, when the bundle starts — **restart NodeCG after editing it**
(in Docker: `docker compose restart notgt`). A `notGT.json` in the `cfg/` folder of the
installation itself (next to `nodecg.json`) is read too, and wins when both exist.

---

## Sign-in (login)

The dashboard asks for a username and a password. **A new server lets `admin` / `admin`
in** — the sign-in page says so — and the first thing to do is to give that administrator
a real password: the **Team** tab shows a warning with a “Change the password” button
until it is done. Until then, anyone who can reach the port knows the way in.

Everyone else is added in the Team tab too; see
[Team](#team-users-groups-and-keys). What is set where the server is started is only
this:

| To…                                    | from the launcher                                                    | in Docker (`.env`)                                    |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| keep the default and change the password in the dashboard | nothing to do                                     | nothing to do                                         |
| name the administrator yourself        | the “Вход по паролю” card: a name, a password, “Задать администратора здесь” | `NOTGT_LOGIN_USER=…` and `NOTGT_LOGIN_PASSWORD=…` |
| switch the sign-in off                 | “Отключить” on the same card                                         | `NOTGT_LOGIN=off`                                     |

Each of these applies after the server is restarted. An administrator named this way
replaces the default one: an `admin` account whose password nobody changed is removed.
Such an administrator's password is changed where it was set, not in the Team tab. The
launcher does not write the password down — it stores an HMAC of it.

With the sign-in **off** the dashboard opens for everyone who can reach the port, the OBS
links need no key and the API is open unless `apiToken` is set. That suits a closed show
LAN and nothing else.

The launcher and the variables are shorthand for the `login` block of `cfg/nodecg.json`,
NodeCG's own config, which can also be written by hand and wins over the variables:

```json
{
  "login": {
    "enabled": true,
    "sessionSecret": "a-long-random-string",
    "local": {
      "enabled": true,
      "allowedUsers": [{ "username": "operator", "password": "s3cret" }]
    }
  }
}
```

Every entry of `allowedUsers` is an administrator. A password can be written as
`sha256:<hex>` instead of plain text, where `<hex>` is the HMAC-SHA256 of the password
keyed with `sessionSecret` (that is what the launcher writes). `"enabled": false` switches
the sign-in off; no `login` block at all is the default described above.

What the sign-in means for the rest:

- **The dashboard** sends a stranger to the sign-in page; “Sign Out” is in the header.
- **OBS.** A Browser Source cannot sign in, so its address carries a key:
  `…/out.html?out=main&key=out_…`. The key belongs to the **out**, not to whoever copies
  the link: every operator sees the same address, it does not change when people sign in
  or out, and it opens that one out and nothing else. The “Link for OBS” buttons copy the
  address with the key in it. Without the key the source shows the sign-in page instead
  of the titles — so **after updating from a version without the sign-in, copy the links
  into OBS again**.
- **The REST API** is no longer open, `apiToken` or not: a request needs the token or the
  session of a signed-in operator. `GET /api/health` stays open.
- **The WebSocket API** takes the token or the username and password in its `login` frame.

The sign-in keeps strangers on the same network out of the control room; it does not
encrypt anything. Over plain `http://` the password travels as text, so on a network you
do not trust put TLS in front (the Traefik block of `docker-compose.yml`).

---

## Team: users, groups and keys

For a show with several people — a VJ, streamer 1, streamer 2 — who each work with their
own outs. It is managed in the **Team** tab of the dashboard, by an administrator.

- A **group** (“VJ”, “Streamer 1”) is a set of outs: tick the outs it works with. An out
  can be in several groups.
- A **user** has a name, a password and the groups they are in. A member sees the outs of
  their groups in Control, Titles & Outs and Editor, and no others. An **administrator**
  sees every out, makes and deletes outs, and manages the team. There is always at least
  one: the last administrator can be neither deleted nor made a member.
- An **out** has one **OBS link**, with a key of its own (`…&key=out_…`). The link is the
  same for everyone, belongs to no user, and opens that out's page only — its socket
  reads the show and cannot change it. “New link” in the Team tab replaces the key: the
  old address stops working at once.
- A group has **WebSocket keys** (`ws_…`), as many as it needs — one per Companion, say.
  A group's key sees and drives the outs of that group and no others (see
  [Signing in](#signing-in)). Revoking a key disconnects whatever uses it.

Changes apply at once, without a restart: a user removed from the team is signed out, a
key that was revoked is disconnected, an out added to a group shows up for its members
and its keys.

Two things to know:

- **What a member is kept from is what the dashboard shows them.** The outs of other
  groups are hidden from a member's panels, and the keys — an out's, a group's — are
  enforced by the server. But a signed-in member's browser talks to NodeCG the way an
  administrator's does, so this separates a team that works together; it is not a wall
  between people who should not trust each other. The animations and the variables are
  shared by everyone.
- **With the sign-in switched off there are no users**: whoever opens the dashboard is an
  administrator and the OBS links need no key. Groups and their WebSocket keys work all
  the same — and once any group has a key, the WebSocket stops being open.

The team is kept in `db/notGT-team.json`, next to NodeCG's database (the `notgt-db`
volume in Docker): back it up with the rest. Passwords are stored as scrypt hashes; the
keys are stored as they are, since they have to be shown again.

---

## REST API

The bundle mounts the same router at two paths:

- `http://<host>/api` — short, convenient for Companion;
- `http://<host>/bundles/notGT/api` — the version with the bundle prefix (useful behind a
  reverse proxy that strips the path).

The examples below use the short `/api`; swap the prefix if you need the other one.

### Authentication

- If `apiToken` **is set**, every request to `/api/*` must carry the token in one of these
  ways:
  - `Authorization: Bearer <token>`
  - `X-API-Token: <token>`
  - `?token=<token>`
- `GET /api/health` is **always open** — so uptime probes need no secret.
- If `apiToken` is **empty**, the API is open; a warning is logged on start. The
  `allowUnauthenticatedApi: true` flag silences that warning. The safe reading: an empty
  token is acceptable only when the server is unreachable from untrusted networks or sits
  behind Basic Auth at the Traefik level.
- With the [sign-in](#sign-in-login) switched on, the session of a signed-in operator is
  let in as well — and with an empty `apiToken` it is the only way in, the API is not
  open any more. For scripts and Companion set an `apiToken`.
- The REST API is all or nothing: `apiToken` reaches every out. The keys that reach a
  [group's](#team-users-groups-and-keys) outs only are WebSocket keys.
- A request with no token or a wrong one gets `401 {"error":"unauthorized", ...}`.
- CORS is open (`Access-Control-Allow-Origin: *`), so the API can be polled straight from
  a browser.

In all the examples below `$NOTGT_TOKEN` is the value of `apiToken`, and
`-H "Authorization: Bearer …"` can be replaced with `-H "X-API-Token: …"` or `?token=…`.

### Endpoints

| Method               | Path                                        | Purpose                                                                                        |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`                | `/api/health`                               | Liveness check. Always open.                                                                    |
| `GET`                | `/api/state`                                | Aggregated state of the program (see below).                                                    |
| `GET`                | `/api/data`                                 | The whole set of variables.                                                                     |
| `GET`                | `/api/data?path=speaker.name`               | One value by path.                                                                              |
| `POST`               | `/api/data`                                 | Write variables. `?mode=merge` (default) or `?mode=replace`.                                    |
| `GET`                | `/api/data?path=guests&raw=1`               | As above, but return the node as stored (the array), without resolving the chosen element.      |
| `DELETE`             | `/api/data/:path`                           | Delete the value at a path.                                                                     |
| `GET`                | `/api/media/probe?templateId=<id>`          | Length of a template's video layer (`{durationMs}` or `null`) — for `holdMode: "video"`.        |
| `GET`                | `/api/selection`                            | The chosen element of list variables: `{"guests": 1}`.                                          |
| `POST`               | `/api/selection`                            | Choose an element: `{"path": "guests", "index": 1}` (or a whole map, `{"guests": 1}`).          |
| `DELETE`             | `/api/selection/:path`                      | Reset the choice (element `0` is used again).                                                   |
| `GET`                | `/api/templates`                            | List the animations.                                                                            |
| `POST`               | `/api/templates`                            | Create an animation.                                                                            |
| `GET` `PUT` `PATCH`  | `/api/templates/:id`                        | Read / update an animation (`PATCH` is a partial update).                                       |
| `DELETE`             | `/api/templates/:id`                        | Delete an animation.                                                                            |
| `POST`               | `/api/titles/:templateId/show`              | Show an animation.                                                                              |
| `POST`               | `/api/titles/:templateId/toggle`            | Show / hide (toggle).                                                                           |
| `POST`               | `/api/titles/:templateId/trigger`           | Play once (one-shot).                                                                           |
| `POST`               | `/api/titles/hide`                          | Hide the title.                                                                                 |
| `POST`               | `/api/titles/reset`                         | Reset the “program” completely: the active title, overrides and visibility; playback on the outs stops. |
| `GET`                | `/api/outs`                                 | List the outs.                                                                                  |
| `POST`               | `/api/outs`                                 | Create an out.                                                                                  |
| `GET` `PUT` `PATCH`  | `/api/outs/:id`                             | Read / update an out.                                                                           |
| `DELETE`             | `/api/outs/:id`                             | Delete an out.                                                                                  |
| `GET`                | `/api/outs/:id/url`                         | The URL for an OBS Browser Source.                                                              |
| `POST`               | `/api/outs/:outId/stop`                     | Stop playback on an out.                                                                        |
| `POST`               | `/api/outs/:outId/items`                    | Add a placement to an out (`{templateId, ...}`).                                                |
| `PUT` `PATCH`        | `/api/outs/:outId/items/:itemId`            | Update a placement.                                                                             |
| `DELETE`             | `/api/outs/:outId/items/:itemId`            | Delete a placement.                                                                             |
| `POST`               | `/api/outs/:outId/items/:itemId/trigger`    | One-shot of a specific placement (optional `{holdMs}`).                                         |
| `GET`                | `/api/timers`                               | The timers, each with what it shows now (`vars`) and the server's time.                        |
| `POST`               | `/api/timers`                               | Make a timer: `{name, key?, mode?: "down"\|"up", duration?: "5:00", overtime?, format?, groups?}`. |
| `GET` `PUT` `PATCH`  | `/api/timers/:timer`                        | Read / change a timer (by id or key). A running timer keeps running.                           |
| `DELETE`             | `/api/timers/:timer`                        | Delete a timer.                                                                                 |
| `POST`               | `/api/timers/:timer/:command`               | `start` · `pause` · `toggle` · `reset` · `restart` · `set {value: "1:30"}` · `adjust {delta: 10}` (seconds, or `"-1:00"`). |
| `GET`                | `/api/ndi`                                  | The outs with NDI switched on, as the NDI sender takes them (see [NDI](#ndi)). Also with the senders' key. |
| `POST`               | `/api/ndi/status`                           | A sender's report: `{id, host, platform, version, ndi, outs: [{id, state, connections, fps, …}]}`. Also with the senders' key. |

### `GET /api/state`

```json
{
  "active": {
    "templateId": "lower_third",
    "visible": true,
    "outId": "main",
    "data": {},
    "label": "Alice",
    "updatedAt": 1735000000000
  },
  "activeTemplateId": "lower_third",
  "activeVisible": true,
  "activeOutId": "main",
  "playing": { "main": ["item_ab12cd34ef56"] },
  "revision": 42,
  "outs": [
    {
      "id": "main",
      "name": "Main",
      "width": 1920,
      "height": 1080,
      "url": "…",
      "items": [
        {
          "id": "item_ab12cd34ef56",
          "templateId": "lower_third",
          "enabled": true,
          "held": true,
          "mode": "once"
        }
      ]
    }
  ],
  "templates": [{ "id": "lower_third", "name": "Lower third", "kind": "layers" }]
}
```

- `activeTemplateId`, `activeVisible`, `activeOutId` — “flat” copies of the fields of
  `active`, so that a JSON path can be given directly in Companion.
- `playing` — which placements are actually playing now, per out.
- `revision` — a monotonic counter: it changes on any change, a cheap way to tell that
  “something changed”.
- `outs[].items` — the placements of an out, in short: `held` is the “On air” switch,
  `mode` is `once` or `loop`. Whether one is on air right now is in `playing`.
- `outs` and `templates` are **absent** when `hideApiState: true`.

### Examples

Liveness check (no token needed):

```bash
curl -sS http://<host>/api/health
```

State of the program:

```bash
curl -sS http://<host>/api/state \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

Variables: all of them, by path, and writing.

```bash
curl -sS http://<host>/api/data -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS 'http://<host>/api/data?path=speaker.name' \
  -H "Authorization: Bearer $NOTGT_TOKEN"

# merge (default): updates only the keys that were sent
curl -sS -X POST 'http://<host>/api/data?mode=merge' \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speaker":{"name":"Alice","role":"Host"}}'

# replace: replaces the whole set of variables with the object sent
curl -sS -X POST 'http://<host>/api/data?mode=replace' \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"data":{"speaker":{"name":"Alice"}}}'

curl -sS -X DELETE 'http://<host>/api/data/speaker.name' \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

> The body of `POST /api/data` is either the data object itself or a `{"data": {…}}`
> wrapper; both work.

Showing a title (a form for Companion and for external systems):

```bash
# the whole body is taken as the variable override…
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speaker":{"name":"Alice"}}'

# …or the override sits in `data`, with out/label next to it
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"out":"main","label":"Alice","data":{"speaker":{"name":"Alice"}}}'

# the same through query parameters
curl -sS -X POST 'http://<host>/api/titles/lower_third/show?out=main&label=Alice' \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

Toggle, one-shot trigger and hide:

```bash
curl -sS -X POST http://<host>/api/titles/lower_third/toggle \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main"}'

# trigger: plays once. If the animation is placed on the out, the placement plays;
# otherwise it is shown for holdMs and hides by itself.
curl -sS -X POST http://<host>/api/titles/lower_third/trigger \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main","holdMs":5000}'

# hide: stop playback on a particular out…
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main"}'

# …or on all of them at once
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# templateId narrows the hide to one title, out to one out
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main","templateId":"lower_third"}'
```

> `POST /api/titles/hide` accepts `{out?, templateId?}`. The active title is hidden only
> if it matches the filters sent. If `templateId` is not sent, playback is also stopped on
> the given out (or on all of them, if `out` is not sent).

Animations (templates):

```bash
curl -sS -X POST http://<host>/api/templates \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "id": "lower_third",
        "name": "Lower third",
        "kind": "layers",
        "width": 1920,
        "height": 1080,
        "layers": [
          {
            "id": "name",
            "type": "text",
            "x": 6, "y": 78, "width": 60,
            "binding": "speaker.name",
            "style": { "fontFamily": "Montserrat", "fontSize": 64, "color": "#ffffff" },
            "inTransition": { "type": "slide-up", "durationMs": 300, "delayMs": 200 },
            "z": 1
          }
        ],
        "inTransition": { "type": "slide-left", "durationMs": 350 },
        "outTransition": { "type": "fade", "durationMs": 250 },
        "playback": { "mode": "once", "holdMs": 8000 }
      }'

curl -sS http://<host>/api/templates/lower_third -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS -X PATCH http://<host>/api/templates/lower_third \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"playback":{"mode":"once"}}'

curl -sS -X DELETE http://<host>/api/templates/lower_third \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

`POST /api/templates` requires `name` (else `400`); `id` may be omitted — it is derived
from `name`. For `POST /api/outs` a duplicate `id` gives `409`.

Outs and placements:

```bash
curl -sS http://<host>/api/outs -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS -X POST http://<host>/api/outs \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"interview","name":"Interview","width":1920,"height":1080}'

# the URL for OBS
curl -sS http://<host>/api/outs/interview/url -H "Authorization: Bearer $NOTGT_TOKEN"

# put an animation on an out
curl -sS -X POST http://<host>/api/outs/interview/items \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "templateId": "lower_third",
        "x": 0, "y": 0, "scale": 1,
        "playback": { "mode": "once", "holdMs": 8000 }
      }'

# put a title that stays up on air and leave it there (taken off with held: false)
curl -sS -X POST http://<host>/api/outs/interview/items \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"templateId":"ticker","x":0,"y":0,"playback":{"mode":"loop"},"held":true}'

# crop a placement: show only the 960x540 window from (480,270), in template
# pixels. Template pixels, not the out's; the animation neither moves nor scales.
curl -sS -X PATCH http://<host>/api/outs/interview/items/<itemId> \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"crop":{"x":480,"y":270,"width":960,"height":540}}'

# remove the crop — the whole box is visible again
curl -sS -X PATCH http://<host>/api/outs/interview/items/<itemId> \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"crop":null}'

# grow a placement's box 192 px past the template box on every side (a 1920x1080
# template); the animation keeps its size, only the area it is shown in grows
curl -sS -X PATCH http://<host>/api/outs/interview/items/<itemId> \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"bounds":{"x":-192,"y":-192,"width":2304,"height":1464}}'

# one-shot of a specific placement
curl -sS -X POST http://<host>/api/outs/interview/items/item_ab12cd34ef56/trigger \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"holdMs":6000}'

# stop everything on an out
curl -sS -X POST http://<host>/api/outs/interview/stop \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

---

## WebSocket API

The live counterpart of the REST API: the same verbs, and the state is **pushed** when it
changes instead of being polled. This is what a Companion module connects to.

- Address: `ws://<host>/api/ws` (or `ws://<host>/bundles/notGT/api/ws`); `wss://` behind
  TLS.
- A plain WebSocket, **not** Socket.IO. Every frame is a JSON object with a `type`.
- Every frame the client sends is answered by exactly one `reply` frame that carries the
  same `id`.

### The conversation

```
server → {"type":"hello","protocol":1,"bundle":"notGT","version":"0.15.7",
          "authRequired":true,"authenticated":false,"login":["token","password"]}
client → {"type":"login","id":1,"token":"<wsToken>"}
server → {"type":"reply","id":1,"command":"login","ok":true,"result":{"user":null}}
server → {"type":"state","state":{ …the object of GET /api/state… }}
client → {"type":"show","id":2,"templateId":"lower_third","out":"main"}
server → {"type":"reply","id":2,"command":"show","ok":true,"result":{"active":{…}}}
server → {"type":"state","state":{ … "activeVisible":true … }}
```

`state` comes by itself: once after signing in and then on every change, whoever made it
— this socket, the dashboard or a REST request. It is always the whole object, with
`outs` and `templates` (the `hideApiState` flag is about polling and does not apply).

A command that failed is answered with `ok: false`:

```json
{ "type": "reply", "id": 2, "command": "show", "ok": false,
  "error": { "code": "not_found", "message": "Unknown template: nope" } }
```

`error.code` is one of `bad_request`, `not_found`, `forbidden` (an out this key does not
reach), `unknown_command`, `unauthorized`, `internal`. A frame that is not a JSON object gets `{"type":"error","code":"bad_request"}`
and the connection stays open.

### Signing in

There are two kinds of key:

- **`wsToken`** in the bundle config (`bundles/notGT/cfg/notGT.json`), next to `apiToken`
  — the key that reaches **every out**. When it is set, the WebSocket takes it and
  **not** `apiToken`; when it is empty, `apiToken` is the WebSocket's key as well. It does
  not open the REST API.
- **A group's key** (`ws_…`), made in the [Team](#team-users-groups-and-keys) tab — it
  reaches **the outs of that group only**. This is the one to give a Companion that
  belongs to the VJ or to a streamer.

A username and a password work too, with the reach of that user: every out for an
administrator, the outs of their groups for a member.

`hello.authRequired` says whether the server asks to sign in, and `hello.login` what it
accepts: `token` (a key exists), `password` (the [sign-in](#sign-in-login) is on), or
both. The reply to `login` — and `hello` itself, when the key came with the handshake —
says how far the connection reaches:

```json
{ "type": "reply", "command": "login", "ok": true,
  "result": { "user": null, "group": "VJ", "outs": ["main", "stage"] } }
```

`outs` is `"all"` for the key of everything. A connection that does not reach every out:

- gets `state` with **its outs only** — `outs`, `playing`, and a title shown by hand on
  somebody else's out is not reported as `active`;
- is answered `forbidden` when a command names an out outside its reach;
- must name the `out` in `show`, `toggle` and `trigger` — unless it reaches exactly one,
  which is then taken for granted (so a one-out group never has to);
- `hide`, `stop` and `reset` without `out` apply to **its** outs, not to the whole show;
- the variables (`setData`, `select`, …) are shared by the whole team and stay open to it.

When the team is edited, the connection follows: an out added to the group arrives in the
next `state`, a revoked key is closed with 4401.

- **In the handshake**, the way a token goes to REST: `ws://<host>/api/ws?token=<key>`, or
  the `Authorization: Bearer <key>` / `X-API-Token` header. `hello.authenticated` is then
  already `true`.
- **With a frame**: `{"type":"login","token":"…"}` or
  `{"type":"login","username":"…","password":"…"}`.

Anything else before signing in, a wrong token or password, or no `login` frame within
10 seconds closes the connection with code **4401**. On an open server (`authRequired:
false`) a `login` frame is simply answered with `ok: true`, so a client does not need two
code paths.

### Commands

`out` is the id of an out; where it is optional, leaving it out means “every out”.

| `type`           | Parameters                                          | What it does                                                                                             |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `show`           | `templateId`, `out?`, `data?`, `label?`             | Shows a title (as `POST /api/titles/:id/show`).                                                           |
| `hide`           | `out?`, `templateId?`                               | Hides the title.                                                                                          |
| `toggle`         | `templateId`, `out?`, `data?`, `label?`             | Shows it, or hides it if it is the one on air.                                                            |
| `trigger`        | `templateId`, `out?`, `holdMs?`, `data?`, `label?`  | Plays once: the placements of that template, or a timed show when it is placed nowhere.                   |
| `trigger`        | `out`, `itemId`, `holdMs?`                          | Plays one particular placement once.                                                                      |
| `hold`           | `out`, `itemId`, `held?`                            | The “On air” switch of a placement. Without `held` it flips.                                              |
| `stop`           | `out?`                                              | Takes everything off an out.                                                                              |
| `reset`          | —                                                   | Clears the program state and stops playback on every out.                                                 |
| `setData`        | `data`, `mode?` (`merge` \| `replace`)              | Writes variables.                                                                                         |
| `deleteData`     | `path`                                              | Deletes a variable.                                                                                       |
| `select`         | `path`, `index`                                     | Chooses the element of a list variable.                                                                   |
| `select`         | `path`, `delta`, `wrap?`                            | Steps from the current element: `1` is “next”, `-1` “previous”; wraps around unless `wrap` is `false`.   |
| `clearSelection` | `path`                                              | Back to element `0`.                                                                                      |
| `timer`          | `action`, `timer`, …                                | Drives a timer: `action` is a command of `POST /api/timers/:timer/:command`, or `create` · `update` · `remove`; the rest as there. Only the timers shared with the client's groups (or everyone). |
| `getTimers`      | —                                                   | The timers within reach, with what they show now.                                                        |
| `getState`       | —                                                   | The state, in the reply.                                                                                  |
| `getData`        | `path?`, `raw?`                                     | The variables, or one value.                                                                              |
| `subscribe`      | `topics`                                            | `state` (on by default), `data` — the variable store, pushed as `{"type":"data","data":{…}}` — and `timers`: `{"type":"timers","timers":[{key, text, ss, running, …}]}` each time what a timer shows changes (a Companion button that counts). |
| `unsubscribe`    | `topics`                                            | Stops a push.                                                                                             |
| `ping`           | —                                                   | Answers; for a client that wants its own keep-alive.                                                      |

The server pings every 30 seconds at the protocol level (a WebSocket library answers by
itself) and drops a connection that stopped answering.

### Trying it

```bash
npx wscat -c "ws://<host>/api/ws?token=$NOTGT_WS_TOKEN"
> {"type":"toggle","id":1,"templateId":"lower_third","out":"main"}
```

---

## Bitfocus Companion

There is no dedicated Companion module in the package yet. Until there is one, the stock
HTTP module covers 95 % of the job — show a title, hide it, light a button by state — and
is described first. A module of its own connects to the
[WebSocket API](#websocket-api); see [the end of this section](#a-dedicated-module).

### Connecting

In Companion create a connection of the HTTP-request kind (for example **Generic HTTP
Requests**) and set the base address:

```
http://<host>
```

and add a header with the token (if `apiToken` is set):

```
X-API-Token: <token>
```

or

```
Authorization: Bearer <token>
```

To check the link: `GET /api/health` must answer `{"ok":true,...}` — this path is always
open and needs no token.

### Actions

**Show a title:**

- Method: `POST`
- URL / path: `/api/titles/<templateId>/show`
- Body (JSON, optional): `{"out":"main"}` or `{"out":"main","label":"Alice"}`
- Content-Type: `application/json`

For example, for the `lower_third` template:

```
POST /api/titles/lower_third/show   {"out":"main"}
```

**Hide the title:**

```
POST /api/titles/hide   {}
```

or on a particular out:

```
POST /api/titles/hide   {"out":"main"}
```

`toggle` and `trigger` are available the same way:

```
POST /api/titles/<templateId>/toggle    {"out":"main"}
POST /api/titles/<templateId>/trigger   {"out":"main","holdMs":5000}
```

`trigger` plays once; if the animation is placed on the out, the placement plays,
otherwise it is shown for `holdMs` and hides by itself.

The curl equivalent (handy to check before setting Companion up):

```bash
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "X-API-Token: $NOTGT_TOKEN" -H 'Content-Type: application/json' -d '{"out":"main"}'
```

### HTTP feedback (lighting a button)

Companion can poll a URL and pull a value out by JSON path — that is what a “the button
is lit when…” feedback hangs on.

- URL: `http://<host>/api/state`
- Header: `X-API-Token: <token>`
- Method: `GET`
- Poll interval: **500 ms** (recommended)
- JSON path — the string you type into the feedback's field:

| JSON path              | Example value                | What it means                                                      |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `activeVisible`        | `true` / `false`             | Whether any title is shown right now.                               |
| `activeTemplateId`     | `"lower_third"` / `null`     | The `id` of the current template (or `null` if nothing is shown).   |
| `activeOutId`          | `"main"` / `null`            | Which out it is shown on (`null` = all of them).                    |
| `revision`             | `42`                         | The change counter — good for “blink on any change”.                |
| `playing.main[0]`      | `"item_ab12cd34ef56"`        | The first placement playing on the out `main` (the key may be absent). |

Typical button setups:

- **Show / Hide** — two buttons with the `show` and `hide` actions, both lit from
  `activeVisible` (or from `activeTemplateId`, if there are many buttons, each for its own
  template).
- **Trigger** — a button with a single `trigger` action, lit from `playing.main[0]`
  (the value is non-empty while the placement plays).

Notes:

- Every feedback is a separate HTTP request on every poll. At 500 ms that is fine, but
  with many buttons turn on `hideApiState: true` in the bundle config: the `outs` and
  `templates` arrays leave the response, and every path in the table above keeps working.
- `outId` is a slug (`[a-z0-9-]`), so `playing.main[0]` is valid; an `outId` never
  contains a dot, by design.
- 500 ms is a compromise between a responsive button and load. For “display” buttons that
  do not need an instant reaction 1000–2000 ms will do; below 250 ms there is no point,
  the state is recomputed on the server anyway.

### A dedicated module

A module on `@companion-module/base` talks to the [WebSocket API](#websocket-api) and
needs no polling at all:

- **Config fields**: host, port, and either a key — a group's from the Team tab, or
  `wsToken` for the whole show — or a username and a password; `hello.login` tells which
  of them the server accepts.
- **Feedbacks and variables** come from the `state` frame, which arrives on every change:
  `activeVisible` / `activeTemplateId` for “this title is on air”, `playing[out]` and
  `outs[].items[].held` for placements, `selection` for the chosen element of a list.
- **Dropdowns** for actions are filled from `state.templates` and `state.outs` (with their
  `items`), so nobody types ids by hand.
- **Actions** are the commands of the table above: `show`, `hide`, `toggle`, `trigger`,
  `hold`, `select` with `delta: 1` for “next guest”, `setData` for a text field.

The core of such a module:

```js
import WebSocket from "ws";

const ws = new WebSocket(`ws://${config.host}:${config.port}/api/ws`);
ws.on("message", (raw) => {
	const frame = JSON.parse(raw);
	if (frame.type === "hello" && frame.authRequired) {
		ws.send(JSON.stringify({ type: "login", token: config.key })); // a group's key, or wsToken
	} else if (frame.type === "state") {
		this.state = frame.state; // then checkFeedbacks() and setVariableValues()
	}
});
ws.on("close", (code) => {
	// 4401 = wrong credentials: report it and do not hammer; anything else: reconnect.
});

// An action:
ws.send(JSON.stringify({ type: "toggle", templateId: "lower_third", out: "main" }));
```

---

## OBS Studio

1. **Sources → Add → Browser**.
2. **URL**:

   ```
   http://<host>/bundles/notGT/graphics/out.html?out=main
   ```

3. **Width / Height** — the stage size of this out (`1920` × `1080` by default). Keep them
   equal to the `width`/`height` in the “Titles & Outs” panel, or the scale will drift.
4. **Shutdown source when not visible** — **off**. Otherwise the browser source is
   unloaded, loses its connection and shows a stale state when the scene comes back.
5. **Background** — nothing to set: the page is transparent (`html, body` have a
   transparent background) and OBS takes it as it is.
6. Refresh the source **once** after creating it — from then on it looks after itself.

### Diagnostic overlay

Add the `debug` flag to the URL:

```
http://<host>/bundles/notGT/graphics/out.html?out=main&debug=1
```

The overlay in the corner of the page shows `out`, `revision`, the list of playing
placements and the list of active slots. It updates once a second even when idle, so it
is better not kept on air — turn it on for debugging only.

### Several outs

Several Browser Sources with different `?out=` values work at the same time and
independently:

```
http://<host>/bundles/notGT/graphics/out.html?out=main
http://<host>/bundles/notGT/graphics/out.html?out=interview
```

### What not to do

**Do not reload the Browser Source when the data changes.** Variables, the playing list
and template edits reach the page by themselves (through Replicants and Socket.IO). A
reload only breaks the connection and replays the entrance; with `{{...}}` in a code
template it also rebuilds the iframe. If it seems “not to update”, look at the `&debug=1`
overlay and at `GET /api/state` first.

---

## NDI

An out can also go out as an **NDI source** — for Resolume Arena, vMix, TriCaster and
the rest of what takes NDI and not a web page. The pictures are made by the NDI sender
in [`ndi/`](../../ndi/README.md), a separate program that runs on this machine or on
another one (a Raspberry Pi will do); the bundle keeps the settings and shows what the
senders report.

- **Per out** (Titles & Outs, under the address): the **NDI** switch, and next to it a
  line that sums up how the out goes out. A click on it opens the **NDI settings**: the
  source name (`notGT <out>` unless given), the picture size — the out's own, ¾, ⅔, ½ or
  ⅓ of it — the frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94 or 60), the NDI groups
  and the transparency (off: opaque, over black — lighter to send and to receive). Under
  it, what the senders say: sent from where, to how many receivers, at how many frames a
  second, or what went wrong. Stored in the out as
  `ndi: { enabled, name?, fps?, scale?, alpha?, groups? }`, so `PATCH /api/outs/:id`
  sets it too.
- **NDI senders** (below the outs, once one out has NDI or a sender reports): the senders
  that report, and for an administrator the command that starts one, with this server's
  address and the senders' key.
- **The senders' key** — made on first use while the sign-in is on. It opens
  `GET /api/ndi` and `POST /api/ndi/status` and nothing else; an administrator replaces
  it from the `⋯` menu of NDI senders. With the sign-in off the API takes `apiToken`, or
  nothing.

```bash
# switch NDI on for an out, at 1280×720 and 25 fps
curl -X PATCH http://localhost:9090/api/outs/main -H 'content-type: application/json' \
     -d '{"ndi": {"enabled": true, "scale": 0.6667, "fps": 25}}'
# what a sender is told to send
curl http://localhost:9090/api/ndi
```

A sender that stops reporting drops out of the dashboard after ten seconds.

With Docker Compose the sender can run next to the server (the `ndi` profile, see
[ndi/README.md](../../ndi/README.md#docker)). The server then keeps the senders' key in
the file `NOTGT_NDI_KEY_FILE` names — `docker-compose.yml` sets it — for the sender to
read: the key while the sign-in is on, the `apiToken` without it, empty when the API is
open.

## Persistence

NodeCG keeps the Replicants in `db/` (in Docker, in the `notgt-db` volume). What that
means in practice.

### Survives a restart

- **Animations (templates)** — a Replicant, including layers, transitions and playback.
- **Outs** — including every placement with its coordinates, scale and playback.
- **Variables (titleData)** — every value entered in the Control panel or through the API.
- **The last state of the program (activeTitle)** — what was shown, on which out, with
  which label and overrides.
- **Service metadata (meta)** — for example, the fact of first-run initialization.
- **Timers** — a running timer keeps counting through a restart: it is kept as the moment
  it was started.
- **Uploaded assets** (the `media` category) — kept in `assets/` (in Docker, the
  `notgt-assets` volume).

### Does not survive a restart

- **Derived playback state** (`runtime`: `playing`, `revision`) — recomputed on the server
  from scratch.
- **Playback timeouts** — a `setTimeout` lives only in the process, so a single trigger “in
  flight” is lost. `held`, however, is state of the placement and is persisted: the
  scheduler brings the animations that were switched on back up automatically on start.

In a Docker deployment `db`, `assets` and `logs` are volumes declared in
`docker-compose.yml`; they survive `docker compose down` and an image rebuild. Delete a
volume and the show's configuration is gone.

---

## Project files (.ngt)

A `.ngt` file is the whole show in one file: to keep a copy, to take the show to another
server, or to go back to how it was before a rehearsal. **Titles & Outs → Project** saves
and opens it; only an administrator has the menu.

What is in it:

- every animation, with its layers or code, transitions and playback;
- every out, with its placements, size and NDI/Spout settings;
- every variable, and the row chosen in each list;
- the media files the animations and the variables point at — files of the media folder
  (`/assets/notGT/media/…`), uploaded videos included. A link elsewhere (`https://…`)
  stays a link.

Not in it: timers, connected workbooks, the team and its keys, NodeCG's own settings.

Opening a file:

- replaces every animation, out and variable on this server and takes everything off
  air. A placement that was switched on in the file comes back switched off;
- writes its media into the media folder. The same file already there is used as it is;
  a different file under a name that is taken is saved as `name-2.ext`, and the
  animations point at it;
- leaves alone the lists a connected workbook mirrors: they keep the workbook's rows, so
  opening a project never writes into a workbook;
- reads the whole file first: a damaged, cut-off or foreign file is refused and nothing
  changes.

Over HTTP it is the same two calls, with the dashboard's session (not the API token), for
an administrator:

| Method | Path                          | What                                                     |
| ------ | ----------------------------- | -------------------------------------------------------- |
| `GET`  | `/bundles/notGT/project/save` | the `.ngt` file of this server; `?name=` names the download |
| `POST` | `/bundles/notGT/project/open` | body: the bytes of a `.ngt` file                         |

### The format

Every integer is little-endian. The file starts with a header:

| Bytes | Field                                                  |
| ----- | ------------------------------------------------------ |
| 8     | magic `89 4E 47 54 0D 0A 1A 0A` (`\x89NGT\r\n\x1a\n`) |
| 4     | format version, `u32` — `1`                            |

and goes on with chunks:

| Bytes | Field                                   |
| ----- | --------------------------------------- |
| 4     | type, four ASCII letters                |
| 8     | length of the payload, `u64`            |
| n     | the payload                             |
| 4     | CRC-32 of the type and the payload      |

| Type   | Payload                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| `INFO` | deflated JSON: `{ app, version, schemaVersion, savedAt, titles, outs, variables, media }` |
| `TITL` | deflated JSON: the animations, `TitleTemplate[]`                                       |
| `OUTS` | deflated JSON: the outs, `Out[]`                                                       |
| `VARS` | deflated JSON: `{ data, selection }`                                                   |
| `MDIA` | one media file: `u16` length of its name, the name in UTF-8, then the file's bytes     |
| `DONE` | empty; the last chunk                                                                  |

“Deflated” is raw deflate (RFC 1951), without a zlib or gzip wrapper. A reader skips the
chunk types it does not know, so a later notGT can add one; a file of a newer format
version is refused. The code is `src/extension/ngt.ts`, the test
`scripts/e2e-project.mjs`.

---

## Writing a code animation

A `kind: "code"` template consists of three strings: `code.html`, `code.css`, `code.js`.
It runs in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`) that lives
inside the animation's slot.

### The runtime contract

Inside the iframe you have:

| Entity                     | What it is                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `root`                     | The animation's container — it is `document.body`.                                             |
| `data`                     | The whole set of variables (an object) as of the iframe's creation; updated on changes.        |
| `vars(path, fallback?)`    | Read one value by path. Returns a string; `fallback` is used when the value is empty.          |
| `onData(fn)`               | A subscription: `fn` is called at once with the current data, then on every change.            |
| `onShow(fn)`               | The animation was shown: play the entrance. See [“Transitions”](#transitions-entrance-and-exit). |
| `onHide(fn, ms?)`          | The animation is being hidden: play the exit; `ms` is how long the system will wait for it.    |
| `hideDone()`               | Say “the exit is over” without waiting out `ms`.                                               |
| `timer(key, field?)`       | A [timer](#timers): `timer("match")` → `"04:59"`, `timer("match", "ss")` → `"59"`. `onData` runs as it ticks. |
| `[data-bind="path"]`       | Text nodes with this attribute update automatically on every data change.                      |
| `{{path}}` in HTML and CSS | The value is substituted **once, on load** (not live).                                         |

The rules:

- `{{path}}` and `{{path ?? fallback}}` work **only in HTML and CSS**. There is no
  substitution in `code.js` — for live values use `vars()` / `onData()` / `[data-bind]`.
- `[data-bind="path"]` has no fallback: an empty variable wipes the text written in the
  HTML. If you need a fallback text, set it from JS:
  `el.textContent = vars("path", "fallback")`.
- `root` is `document.body`. In a file animation the shim is inserted into `<head>`, when
  there is no `<body>` yet, so `root` is a getter and becomes valid as the document is
  parsed; read it inside your own `<script>` at the end of `<body>`.
- Paths are dotted, with array indices: `speaker.name`, `panel.items[0].title`.
- The iframe is **rebuilt from scratch** when the template itself changes (edits to code,
  layers, sizes), not when the data changes: after a code edit `{{...}}` is recomputed and
  the entrance plays again. Data changes arrive through `postMessage` and `onData`,
  without a reload.
- `vars()` always returns a string. Objects are serialized to JSON, `null`/`undefined`
  give an empty string.

### Transitions: entrance and exit

For an animation built from layers the system does the entrance and the exit: the slot
is wrapped, and the template's `inTransition` / `outTransition` is applied to that
wrapper, while a layer's own `inTransition` / `outTransition` plays on the layer inside
it. For a code animation that is rarely what you want: its own letter-by-letter
animation and its own exit live inside the iframe.

To have the code do the transitions, register the phases:

```js
onShow(() => {
	// The title was shown (the “On air” switch, show, or a repeated trigger).
	// The entrance goes here, and everything that should live while the title is on air.
});

onHide(() => {
	// The title is being hidden. Play the exit.
}, 700); // 700 ms — how long the system waits for it to end
```

The rules:

- **The system does not animate a code animation at all.** `kind: "code"` has neither
  `inTransition` nor `outTransition`: if the code did not register `onShow`, the title
  appears instantly; if it did not register `onHide`, it disappears instantly. The phases
  are independent: you can take just the exit and leave the entrance alone.
- The second argument of `onHide(fn, ms)` is the **maximum** time the system keeps the
  slot alive after the hide starts. As soon as the exit has finished, call `hideDone()`
  and the slot is removed at once, without waiting out `ms`. If `ms` is not given, the
  system waits 600 ms; it will not wait longer than 10 seconds.
- **The iframe only lives while the title is on screen**: it is created on show and
  removed after the exit. So `onShow` is called once per show, not on every data change —
  the entrance does not replay when the operator edits the text.
- Register the phases at the top level of the script, not inside `setTimeout`/`await`: the
  system decides what the animation handles by which hooks have appeared by then.
- `onData(fn)` is still called at once and on every change. Keep the roles apart: data in
  `onData`, the entrance in `onShow`.

**Timing.** The length of the exit is stored in the template as `code.exitMs`. The
scheduler takes the placement off air that much before `holdMs` runs out, so that the
exit finishes exactly at the end of the hold: entrance + time on air + exit = `holdMs`.
This number has one source — the second argument of `onHide(fn, ms)`. Editor reads it
from the live preview (the runtime itself reports which phases the code animates), writes
it to `code.exitMs` and shows it on the “Animation” tab; you never type it a second time.
`exitMs` is only set by hand when a template is created through the API, bypassing the
editor.

For `once` the scheduler takes the placement off air `exitMs` before `holdMs` — entrance,
show and exit fit into the configured time. For `loop` there is nothing to schedule: the
exit starts when the operator turns “On air” off, and `exitMs` works as the waiting
budget (how long the system keeps the iframe if the code never called `hideDone()`).

A full example: a speaker card where the name and the role fly in letter by letter,
particles live while the title is on air, and everything rides back out on hide.

```js
const $ = (id) => document.getElementById(id);

// 1. Data: lay the text out without animating — the animation belongs to the show.
function apply() {
	$("name").textContent = vars("speaker.name", "Name");
	$("role").textContent = vars("speaker.role", "Role");
}
onData(apply);

// 2. Entrance: split the line into letters and fly each one in.
function flyIn(el, delay, step) {
	const text = el.dataset.text || el.textContent; // the text is taken once
	el.dataset.text = text;
	el.textContent = "";
	[...text].forEach((ch, i) => {
		const span = document.createElement("span");
		span.className = "ch";
		span.textContent = ch;
		el.appendChild(span);
		span.animate(
			[
				{ transform: "translateY(115%)", opacity: 0 },
				{ transform: "translateY(0)", opacity: 1 },
			],
			{
				duration: 650,
				delay: delay + i * step,
				easing: "cubic-bezier(.2,.9,.25,1)",
				fill: "backwards",
			},
		);
	});
}

let sparks = 0;
onShow(() => {
	flyIn($("name"), 0, 40);
	flyIn($("role"), 300, 14);
	sparks = setInterval(spawnSpark, 400); // your particle function; lives while the title is on air
});

// 3. Hide: the exit, and stopping the background. 400 ms is how long the system waits.
onHide(() => {
	clearInterval(sparks);
	root.querySelectorAll(".line .ch").forEach((el) =>
		el.animate(
			[
				{ transform: "translateY(0)", opacity: 1 },
				{ transform: "translateY(-115%)", opacity: 0 },
			],
			{ duration: 380, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" },
		),
	);
}, 400);
```

Note the separation: `onData(apply)` only updates the values, so editing the text in the
Control panel does not replay the entrance; `onShow` is the only place the entrance (and
the background) starts, `onHide` the only place everything stops.

### Animations from files (without the web editor)

An animation can be written as a file instead of in the Editor panel. Put an `.html` into
`bundles/notGT/graphics/animations/` — on start the extension registers every file as a
`kind: "code"` template with the id `file-<file-name>` and a `code.src` pointing at that
file. The folder ships empty; for the built-in example templates, whose code lives inside
them, see [“Ready-made examples”](#ready-made-examples). A file animation is an ordinary
page:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="notgt:name" content="Partner" />  <!-- the name in the library -->
    <style>
      .bug { position: absolute; right: 4%; bottom: 9%; font: 700 40px Montserrat, sans-serif; }
    </style>
  </head>
  <body>
    <div class="bug" data-bind="partner.name">{{partner.name ?? ACME}}</div>
    <script>
      onData(() => document.body.classList.toggle("has-partner", vars("partner.name", "") !== ""));
    </script>
  </body>
</html>
```

```bash
cp my-animation.html bundles/notGT/graphics/animations/
curl -X POST http://localhost:9090/api/animations/sync      # re-read the directory
curl http://localhost:9090/api/animations                   # what is registered
```

Rules for file animations:

- The runtime (`vars`, `data`, `onData`, `root`, `[data-bind]`) is injected automatically
  **before** your `<script>`s, so `onData(...)` can be called straight away.
- `{{path}}` / `{{path ?? fallback}}` are substituted in a file too — everywhere **except**
  inside `<script>` (JS is never rewritten; for live values in JS use `vars()` /
  `onData()`).
- Relative paths to images and fonts work: the page is built with a `<base>` pointing at
  the file's directory.
- Two fonts ship with the bundle and need no `@font-face`: **Montserrat** for text and
  **Handjet** for numerals and headlines (`font-family: Montserrat, sans-serif`). They are
  declared in every code animation, inline or file, and offered first in the layer
  inspector's font list. The files and their OFL licences are in `graphics/fonts/`.
- The file is re-read whenever the iframe is rebuilt, that is, when the animation is shown
  or after the template is edited. No NodeCG restart is needed after editing the file —
  showing the animation again (or refreshing the Browser Source in OBS) is enough.
- If you open such an animation in the Editor panel and type HTML into `code.html`, the
  inline code takes priority over the file (a “fork” of sorts). To go back to the file,
  clear `code.html`.

### Example

`code.html`:

```html
<div class="card">
  <div class="name" data-bind="speaker.name">—</div>
  <div class="role">{{speaker.role ?? Guest}}</div>
</div>
```

`code.css`:

```css
.card {
  position: absolute;
  left: 6%;
  bottom: 8%;
  padding: 24px 40px;
  background: {{panel.color ?? #1d2b3a}};
  border-radius: 12px;
  font-family: Montserrat, system-ui, sans-serif;
  color: #fff;
}
.name {
  font-size: 64px;
  font-weight: 700;
}
.role {
  font-size: 32px;
  opacity: 0.8;
}
```

`code.js`:

```js
const el = root.querySelector(".name");

onData((d) => {
  // a live value instead of {{...}}
  const role = vars("speaker.role", "Guest");
  root.querySelector(".role").textContent = role;
});

// the opening animation is a property of the iframe itself, but this works too:
el.animate([{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1 }], {
  duration: 350,
  easing: "ease-out",
});
```

`[data-bind="speaker.name"]` in the HTML is updated by the runtime, so the JS does not
need to touch it.

### Ready-made examples

The examples are a ready-made graphics package in the notGT brand style (the brandbook
and logos are in `media/brand/`): Studio-green plates, the Signal pink accent, cream
type, Lemon for LIVE, Handjet numerals and a slanted cut on the edge. **All of them are in the library from
the first run**, under the stable ids in the table below, so they can be shown right
away — from Control or through the API (`POST /api/titles/example-poll/show`). On an
existing installation the missing examples and sample values for their variables are
added once, by a schema migration, and the built-in examples that nobody edited are
brought up to their current look; an example the operator deleted does not come back, and
one they changed is left alone. The language of the names, captions and sample data is
set by the `language` key in the [bundle configuration](#bundle-configuration).

The same set opens as a **gallery**: “New animation” → “From an example” in Editor or in
Titles & Outs. From there an example is added as a copy in the dashboard's language — you
can take it apart, rework it, delete it and add it again; only the variables that do not
exist yet are added. In Editor the copy is placed on the selected out straight away, in a
sensible spot.

| Example                  | id                      | Built from | What it shows                                              |
| ------------------------ | ----------------------- | ---------- | ---------------------------------------------------------- |
| Lower third              | `lower-third`           | layers     | name and role on a plate — the base for your own animation  |
| Score bug                | `example-scorebug`      | layers     | text from variables; the score changes on air from Control  |
| Guest from a list        | `example-guest`         | layers     | a list variable: the row chosen in Control goes on air      |
| Topic card               | `example-topic`         | layers     | a full-frame title between segments                         |
| Logo bug with a live tag | `example-logo-bug`      | layers     | an image layer (inline SVG) and a text tag in a corner      |
| Kinetic lower third      | `example-kinetic`       | code       | letter-by-letter entrance, its own exit, `onShow` / `onHide` |
| Live poll                | `example-poll`          | code       | bars and percentages travel to new values as the data is edited |
| Ticker                   | `code-sample`           | code       | frame-by-frame motion, the shortest complete code animation |
| Timer card               | `example-timer`         | code       | a [timer](#timers) of the Control panel: `timer()` in `onData`, running / paused / overtime; ships with the `segment` timer (5:00) |
| Countdown                | `example-countdown`     | code       | a [timer](#timers) of the Control panel as days to seconds, a ring of time left, paused / final seconds / time up; ships with the `countdown` timer (10:00) |
| Network clock            | `example-clock`         | code       | time from an API, corrected against the local clock         |
| Weather from the internet | `example-external-data` | code      | external JSON, a loading skeleton, “stale data”             |

The plates of the layer examples are inline SVG images (the “Plate” layer): a shape layer
can only be a rectangle or an ellipse, while an SVG carries the slanted edge and the
gradient and needs no uploaded file. The team colours in “Score bug” are left as plain
shapes so that they can be recoloured in the inspector.

A code animation only receives the chosen row of a list, so the poll's options are four
named slots (`poll.a` … `poll.d`) rather than a list.

Three of the data examples have their code explained in detail — their HTML/CSS/JS, like
everyone else's, live right in the template, so the **Editor** panel shows the code and a
live preview:

| Template                     | id                       | What it teaches                                                                                  |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Countdown                    | `example-countdown`      | showing a [timer](#timers) instead of counting: `timer()` in `onData`, four states, a remaining-time ring on `conic-gradient` |
| Network clock                | `example-clock`          | time from an API: a correction against the local clock, hands turned by CSS, honest fallback to local time |
| Weather from the internet    | `example-external-data`  | external JSON: parsing the response, a loading skeleton, “stale data” instead of an empty screen  |

Showing an example:

```bash
curl -X POST http://localhost:9090/api/titles/example-countdown/show
curl -X POST http://localhost:9090/api/titles/hide
```

The examples' variables are best passed as a **per-show override**: they are laid over
the global store and do not get in the way of other titles.

```bash
curl -X POST http://localhost:9090/api/titles/example-countdown/show \
  -H 'content-type: application/json' \
  -d '{"data":{"countdown":{"title":"On air in"}}}'

# the countdown shows the `countdown` timer: set it and start it
curl -X POST http://localhost:9090/api/timers/countdown/set -H 'content-type: application/json' -d '{"value":"5:00"}'
curl -X POST http://localhost:9090/api/timers/countdown/start
```

Every variable of every example is optional — without them it shows a meaningful demo (the
countdown's own 10-minute timer, Moscow, clear sky and so on). So the examples can be tried
before you set any data up.

The clock and the weather are better **held** on screen than played for a set time: add
the template to an out as a placement with `held: true` (in the Control panel that is the
“On air” switch).

Separately from the examples there is the **animations from files** mechanism (see
above).

#### `example-countdown` — countdown

| Variable            | Default       | Meaning                                                           |
| ------------------- | ------------- | ----------------------------------------------------------------- |
| `countdown.timer`   | `countdown`   | the key of the [timer](#timers) it shows (Control panel → Timers) |
| `countdown.title`   | the timer's name | the caption above the digits                                   |
| `countdown.urgent`  | `10`          | how many seconds before zero the “panic” turns on                 |
| `countdown.accent`  | `#FF5A8C`     | accent colour                                                     |

The countdown does not count: it shows the `countdown` timer, which is started, paused,
reset and nudged in the Control panel (or from Companion), so every out shows the same
second and the operator can stop the clock. It comes with that timer (10:00, stops at
zero); point `countdown.timer` at another one to show that instead.

What to look at in the code: `timer(key, field)` is read in `onData`, which runs on every
tick of the timer — there is no `setInterval` or `requestAnimationFrame` of its own. The
ring is a single `conic-gradient` eased by a one-second CSS transition on
`@property --p`, while the JS only sets a number once a tick; it shows how much time is
**left** (`1 − progress`: full at the start, empty at zero). States: counting, paused,
final seconds, time is up, and “no such timer” when the key names none. A changing digit
triggers a CSS “toss” animation through a class.

#### `example-clock` — network clock

| Variable            | Default           | Meaning                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| `clock.title`       | the zone's city   | the caption (`Moscow`)                                       |
| `clock.timeZone`    | `Europe/Moscow`   | IANA time zone                                               |
| `clock.api`         | built-in list     | your own source URL; by default timeapi.io → worldtimeapi.org |
| `clock.syncMinutes` | `15`              | resync period                                                |
| `clock.accent`      | `#FF5A8C`         | accent colour                                                |

What to look at in the code: the time comes from the network, and a **correction** to the
local clock of the OBS machine is computed from the response; from then on the hands move
by themselves, because a CSS animation with a negative delay turns them
(`animation-delay: calc(var(--sec) * -1s)`), and the JS sets the numbers only once. If no
source answered, the clock falls back to local time and says so honestly with its
indicator (yellow instead of green) — the picture does not disappear.

#### `example-external-data` — data from the internet (weather)

| Variable                 | Default           | Meaning                                             |
| ------------------------ | ----------------- | --------------------------------------------------- |
| `weather.city`           | `Moscow`          | the caption                                         |
| `weather.latitude`       | `55.7558`         | latitude                                            |
| `weather.longitude`      | `37.6173`         | longitude                                           |
| `weather.units`          | `celsius`         | `celsius` or `fahrenheit`                           |
| `weather.refreshMinutes` | `10`              | refresh period                                      |
| `weather.api`            | open-meteo        | your own URL; supports `{lat}`, `{lon}`, `{units}`  |
| `weather.accent`         | `#FF5A8C`         | accent colour                                       |

What to look at in the code: the card's three states — a loading skeleton, data, and
“connection lost”. The last one matters most: on a network error the last known values
stay on screen, the card dims and is labelled “offline” instead of disappearing. The
weather icon is inline SVG; the animation (rays, drops, a gentle float) is CSS.

### Data from the internet

An animation lives in a sandboxed iframe, but `fetch` works from it. The rules that keep
it from breaking what is on air:

- **The source must send CORS** (`Access-Control-Allow-Origin`), or the browser will block
  the response. All the examples use open APIs without keys: timeapi.io, worldtimeapi.org,
  open-meteo.
- **Set a timeout** (`AbortController`) — otherwise a hung request keeps the loading
  indicator up for as long as it likes.
- **Never blank the graphics because of the network.** Keep the last good value and show
  it as stale. An empty screen on air is worse than yesterday's weather.
- **Do not poll more often than needed.** Weather every 10 minutes, time every 15; between
  syncs the clock should tick locally.
- **Do not put keys or tokens** into an animation's code: the animation file is visible to
  everyone with access to the dashboard. If an API needs a secret, fetch the data on the
  server (an extension module writes it into the variables) and let the animation read it
  through `vars()`.
- If a source returns a structure other than the expected one, throw an error and fall
  back — that way a broken response does not turn into `NaN` on screen.

### Generating titles with AI

The repository root holds two ready prompts: [`GENERATE_TITLES.md`](../../GENERATE_TITLES.md)
(English) and [`GENERATE_TITLES_RU.md`](../../GENERATE_TITLES_RU.md) (Russian). They are
not documentation but a **whole prompt**: paste the file into a chat with any LLM that
can produce code, fill in the “INPUTS” block at the end, and you get `html` / `css` /
`js` ready for a `kind: "code"` template.

The prompt describes the runtime contract, so the model does not invent its own:

- `code.html` is a fragment of markup inside `body`, with no `<html>`/`<head>` of its own;
- the background is transparent; backings and shadows belong to specific plates only;
- `{{...}}` only in HTML/CSS and only once, on load; live logic in JS goes through
  `vars()` / `onData()` / `data` / `[data-bind]`;
- layout in percent of the design box, without fixed `px`;
- no network, forms or `localStorage`;
- the title animates its own entrance and exit through `onShow` / `onHide` — the phase
  contract described in [“Transitions”](#transitions-entrance-and-exit);
- only `transform` and `opacity` are animated: on the Spout/NDI outputs (Electron
  offscreen) `clip-path`, `mask` and `filter` animations get dropped, so a wipe slides a
  child inside a static `overflow: hidden` wrapper;
- brand values go into CSS variables at the top of `code.css`;
- the answer contains three code blocks and a legend of variables, ready to be created in
  Control.

Where to paste the result: the **Editor** panel → **New animation** → **From code** → the
HTML / CSS / JavaScript tabs of the dock. If you would rather keep the animation as a
file, put the three parts into one `.html` in `graphics/animations/` (see
[“Animations from files”](#animations-from-files-without-the-web-editor)). As a sample
for the model it helps to give one of the built-in examples: `example-countdown`,
`example-clock`, `example-external-data` or `code-sample` (the ticker).

---

## Alpha video in overlays

**A `.mov` with alpha (ProRes 4444, HEVC+alpha, Animation) does not play in a Browser
Source at all** — Chromium handles neither ProRes nor alpha in H.264, so such a file will
not start whatever its size. It has to be converted.

Verified by rendering in Chromium (the same engine as the OBS Browser Source):

| Format | Alpha | Where to put it |
| --- | --- | --- |
| animated **WebP** | works | a `gif` or `image` layer (it is just an `<img>`) |
| **WebM VP9** + alpha | works | a `video` layer |
| **WebM VP8** + alpha | works | a `video` layer |
| ProRes 4444 `.mov` | **not decoded** | — |

### Drag and drop right in the editor

In the **Editor** panel, in the **“Video”** section of a video layer, a file can simply
be dropped (or picked with a click):

- `.webm`, `.webp`, `.gif`, `.png`, `.apng`, `.jpg`, `.svg` are published **as they are**;
- everything else (`.mov`, `.mp4`, `.mkv`, `.avi`, ProRes/HEVC with alpha) is converted by
  the server, with **two progress bars**: “Uploading” (the real upload progress) and
  “Converting” (the real ffmpeg progress). When it finishes, the layer's `src` is set
  automatically and all that is left is to press “Save”.

The result goes to **`<runtimeRoot>/assets/notGT/media/`** and is served as
`/assets/notGT/media/<file>`. In Docker that is the `assets` volume, so what you upload
**survives a container rebuild** (unlike `graphics/media/`, which ends up in the image).
The directory can be overridden with the `mediaDir` key in the bundle config. The upload
limit is 2 GB.

Next to the drop zone is the “Uploaded files” list (from
`GET /bundles/notGT/media/list`), to reuse a file or delete it. Images in that list are
tagged “image” and are **not put** into a video layer: a `<video>` cannot play them. Such
an image belongs in an **`Image`** or **`GIF`** layer — an `<img>` is rendered there, and
it plays animated WebP.

The converter turns short clips into WebP (lighter), but for a video layer into WebM (the
only video format with alpha that Chromium plays). So the same `.mov` gives different
files in a video layer and in an image layer, and that is fine.

**ffmpeg is needed on the server.** The Dockerfile installs it
(`--build-arg INSTALL_FFMPEG=false` if you do not need it). In the Windows package the
launcher installs it with one button, «Install ffmpeg», and the running server picks it up
without a restart (`NOTGT_FFMPEG_DIR`). Without ffmpeg, uploading
ready `.webm`/`.webp` files keeps working, and an attempt to convert returns a clear error
with a hint.

Endpoints (protected by the NodeCG session; they need no API token):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/bundles/notGT/media/upload?name=<name>&kind=video` | the body is the raw bytes of the file; the response is `{jobId}`. `kind=video` (what the editor's drop zone sends) makes the converter produce **WebM**: a `<video>` cannot play WebP, so a short clip that would become WebP in `auto` mode is encoded to WebM for a video layer |
| `GET` | `/bundles/notGT/media/jobs/:id` | state and progress of a job |
| `GET` | `/bundles/notGT/media/list` | the files already uploaded |
| `DELETE` | `/bundles/notGT/media/file/:name` | delete a file |

### The converter

```bash
cd bundles/notGT

# a short loop (<= 10 s) -> animated WebP, cropped to its content automatically
node scripts/convert-alpha.mjs ~/overlay.mov

# longer -> WebM VP9
node scripts/convert-alpha.mjs ~/overlay.mov --format webm

# scale down and compress harder
node scripts/convert-alpha.mjs ~/overlay.mov --format webm --max-width 960 --crf 34

# print the commands without running anything
node scripts/convert-alpha.mjs ~/overlay.mov --dry-run
```

What it does: reads the parameters with `ffprobe`, checks for alpha, finds the real box
of the content (`cropdetect`) and crops to it, scales and resamples the fps if asked,
picks the format by duration (`--threshold`, 10 s by default), then prints the size saved
and a ready `src` for the layer. The result goes to `graphics/media/` and is served as
`/bundles/notGT/graphics/media/<file>`.

Key options: `--format auto|webp|webm|webm-vp8`, `--out <dir>`, `--quality` (WebP),
`--crf` (VP8/VP9), `--bitrate` (VP8), `--fps`, `--scale w:h`, `--max-width`,
`--crop w:h:x:y`, `--no-crop`, `--dry-run`.

### If you want to do it by hand

```bash
# animated WebP (short loops)
ffmpeg -i in.mov -c:v libwebp_anim -pix_fmt yuva420p -q:v 80 -loop 0 -an out.webp

# WebM VP9 (longer). -auto-alt-ref 0 is required: without it libvpx
# refuses to encode transparency at all
ffmpeg -i in.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 \
  -b:v 0 -crf 30 -row-mt 1 -cpu-used 2 -an out.webm

# cropping to the content automatically is the biggest saving
CROP=$(ffmpeg -i in.mov -vf cropdetect=limit=0.1:round=2 -frames:v 90 -f null - 2>&1 \
       | grep -o 'crop=[0-9:]*' | tail -1)
```

### A trap when checking alpha

**Do not check a WebM's transparency with `ffprobe`/`ffmpeg`.** In WebM the alpha is a
separate auxiliary plane and ffmpeg's decoder does not show it — the file looks opaque
although Chromium/OBS play it with alpha correctly. Check it in OBS (or in Chromium).
WebP has no such problem, and the converter checks its alpha itself.

---

## Troubleshooting

**`401 {"error":"unauthorized"}`.** `apiToken` is set and the request comes without it.
Add `Authorization: Bearer <token>`, `X-API-Token: <token>` or `?token=<token>`. Check
that the token in the config has no stray spaces.

**A warning in the log that the API is open.** `apiToken` is empty. Set a token in
`bundles/notGT/cfg/notGT.json` and restart NodeCG — or close the API with Basic Auth at
the Traefik level (see `docker-compose.yml`).

**The graphics are empty.** Check in order: the out exists (the “Titles & Outs” panel) →
the URL has the right `?out=` → the placement has `enabled: true` → the animation is
actually shown or playing (in `GET /api/state` that is `activeVisible` / `playing`). Turn
on `&debug=1`.

**`No out matching "…"` in the page console.** The `?out=` in the URL names an id that
does not exist. Create an out with that id or fix the URL.

**Data does not appear on the graphics.** Do not reload the Browser Source: values arrive
through Replicants. Make sure the path in `{{...}}`/`binding`/`data-bind` matches the key
in `GET /api/data` (case and nesting matter).

**A config edit did not apply.** The config is read on start — restart NodeCG
(`docker compose restart notgt`).

**Companion does not light the button.** Check that the feedback polls `/api/state` (not
`/api/health`), that `X-API-Token` is given, and that the JSON path is written exactly as
in the table above (`activeVisible`, not `active.visible`). Make sure there is no Basic
Auth between Companion and the server answering `401`.

**Nothing was kept after the container was recreated.** Check that the volumes for
`/opt/nodecg/db` and `/opt/nodecg/assets` are in place in `docker-compose.yml`. Without
them every new container starts from a clean state.

**Logs.** The NodeCG panel or the process console; in Docker —

```bash
docker compose logs -f notgt
```

Or the files in `logs/` (in Docker, the `notgt-logs` volume).

---

## Verification (smoke tests)

The bundle has headless Puppeteer tests that check the acceptance criteria without OBS.
NodeCG must already be running on `127.0.0.1:9090` (the address is overridden with
`NOTGT_BASE`, the path to Chromium with `CHROME_PATH`). They come in two runs, because
one needs a server anyone can use and the other a server with a sign-in:

```bash
cd bundles/notGT

# the out page, the panels, Excel, media, the WebSocket API —
# against a server started with NOTGT_LOGIN=off
npm run test:e2e

# the team and the sign-in — against a server with the sign-in on
NOTGT_USER=admin NOTGT_PASSWORD=<the administrator's password> npm run test:e2e:team
```

What `scripts/e2e-out.mjs` checks (graphics):

- the page background is fully transparent (`rgba(0, 0, 0, 0)`),
- `POST /api/titles/<id>/show` puts a title up **in under 500 ms**,
- a layer's text matches the variable's value, `{{...}}` substitution included,
- `POST /api/data` changes the text on screen **without reloading the page** — the JS
  context and the DOM node itself are preserved (the “no flicker” check),
- a code animation renders in its own sandbox iframe and sees `vars()`/`data`,
- a `loop` placement stays on air while the “On air” switch is on (and does not go out by
  itself), and turning the switch off or deleting the placement takes it off air.

What `scripts/e2e-panels.mjs` checks (dashboard): all four panels mount in standalone
mode in English and in Russian with no console errors; the editor has its Konva canvas;
moving, resizing and cropping a placement snap to the right lines; and the “On air” switch
puts a placement on air and keeps it there.

What `scripts/e2e-team.mjs` checks (the team; needs a server with the sign-in on and an
administrator's `NOTGT_USER` / `NOTGT_PASSWORD`): an administrator makes groups, users and
keys and a member cannot; a member sees their groups' outs only; an out's key opens that
out's page, not another out and not the dashboard, and its socket cannot write; a group's
WebSocket key sees and drives that group's outs only; a revoked key and a removed user
lose access at once.

What `scripts/e2e-ws.mjs` checks (the WebSocket API): the handshake and the first
`state`, every verb and its reply, that a change made over REST is pushed to the socket,
and — on a server that asks to sign in — that a token and a username with a password are
let in while a stranger is closed with 4401. It needs no browser. For a protected server
give it the credentials:

```bash
NOTGT_TOKEN=<apiToken> node scripts/e2e-ws.mjs
NOTGT_TOKEN=<apiToken> NOTGT_WS_TOKEN=<wsToken> node scripts/e2e-ws.mjs
NOTGT_USER=operator NOTGT_PASSWORD=<password> node scripts/e2e-ws.mjs
```

Screenshots are saved to `bundles/notGT/.e2e/` (the directory is in `.gitignore`).
