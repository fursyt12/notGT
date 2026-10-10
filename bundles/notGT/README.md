# notGT — the `notGT` bundle

**English** · [Русский](README_RU.md)

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
- [REST API](#rest-api)
- [Bitfocus Companion](#bitfocus-companion)
- [OBS Studio](#obs-studio)
- [Persistence](#persistence)
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
`slide-left/right/up/down`, `scale`, `wipe-left/right`, plus `durationMs`) and its own
playback configuration, `playback` (used when a placement has none of its own). For
`kind: "layers"` the transitions are applied to the animation's wrapper; `kind: "code"`
has **none at all**: the code itself animates the entrance and the exit (`onShow` /
`onHide`) and the system does not touch the wrapper — see
[“Transitions”](#transitions-entrance-and-exit).

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

### Service state

- The `activeTitle` Replicant — the “program”: what is shown now, on which out, with which
  label and overrides. This is what survives a restart.
- The `runtime` Replicant — derived: `playing` (`{outId: [itemId, ...]}`), `triggers` and
  `revision`. Recomputed on the server and not persisted.
- The `selection` Replicant — the chosen element of every list variable
  (`{"guests": 1}`). Persisted; included in `GET /api/state`.

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

- the dashboard — `http://localhost:9090/dashboard/`
- add the graphics to OBS:
  `http://localhost:9090/bundles/notGT/graphics/out.html?out=main`

Building the bundle (if you changed `src/`):

```bash
cd bundles/notGT && npm install && npm run build && cd ../..
```

For the Docker deployment see `docker-compose.yml` and `.env.example` in the repository root.

---

## Dashboard: panels

The dashboard is at `http://<host>/dashboard/`. The bundle's panel files are served from
`/bundles/notGT/dashboard/<file>`.

The tabs at the top are the bundle's three panels, each taking the whole screen
(`fullbleed`). Each has its own job, and settings are not repeated between them:

| Panel             | What it is for                                               |
| ----------------- | ------------------------------------------------------------ |
| **Control**       | on air: show, hide, change the data                           |
| **Titles & Outs** | setup: outs, the animation library, what sits on which out    |
| **Editor**        | look: the out's canvas, layers, code, position and crop       |

In every panel red means one thing: **this is on air right now**. Deleting and other rare
actions live in the `⋯` menu at the end of a row.

The dashboard's **language** — English or Russian — is switched with the `EN` / `RU`
button in the top-right corner of any panel; the choice is shared by all three and
remembered in the browser. By default the browser's language is used, and `?lang=ru` or
`?lang=en` in a panel's address sets it for that one page. The translation lives in
`src/dashboard/locales/ru.json` (English phrase → Russian). To add a language, copy that
file, translate the values and add the language to `LANGS` and `DICTS` in
`src/dashboard/i18n.tsx`; a phrase without a translation is a type error, so
`npm run typecheck` checks completeness. The labels below are the English ones.

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
  current” = merge, “Replace all” = replace).

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
- **`Play`** and **`Go on air`** act on the selected placement: the same one-shot and the
  same “On air” switch Control has (the button turns into **`Take off air`**). Unsaved
  edits are saved first. For an animation that is not on this out, the manual show is
  used.
- **`Save`** writes the edits to layers and the template; while something is unsaved,
  “Unsaved” is shown next to it. Placements apply at once, without saving: a drag must
  never be lost.

**On the left** are three lists: **“On the out”** (placements: order, play, remove; a red
dot means on air), **“Layers”** of the active animation (order, hide, lock, delete;
double-click to rename) and the **“Library”** of all animations (place, duplicate, delete;
“+” for a new one). A row's actions appear on hover and on the selected row.

**The canvas**

- **What is on air is visible on the canvas.** Everything on air on this out is drawn
  under the canvas by the out page itself — the same one OBS has open — so entrances,
  holds and exits play here exactly as they go out: press `Play` or turn the switch on
  (here, in Control or through the API) and the animation plays on the canvas. A placement
  that is on air has a red frame with an “On air” tag. While the active animation has
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
- The **magnets** measure a placement by its **visible part**: a cropped animation sticks
  to lines with the edge and centre of its window, not of the hidden template box, and
  that same window is offered to other animations as a target. The magnets also work
  while resizing: a placement's corner handle sticks with the window's right and bottom
  edges and its centre to the same lines, and a layer sticks with the edges being dragged
  to the edges and centre of the template box and to its sibling layers.
- **Layers** inside an animation are selected with a click, dragged and resized on the
  canvas; the empty part of the box, its frame and the handle in its top-left corner move
  the whole placement.

**On the right is the inspector**, with a tab for each thing being edited:

- **“Layer”** — the selected layer's properties: position and size, text and variable,
  font, stroke and shadow, the source of an image or a video. The tab opens by itself when
  a layer is selected.
- **“Placement”** — the animation on this out: `x`/`y`/scale and “Fit out width”
  (`scale = out.width / template.width`), the size of the crop window and “Clear”,
  playback (“Timed” / “Until switched off”, “Hold”, “As long as the video”), “Starts from
  the API and Companion” (`enabled`).
- **“Animation”** — the template itself: name, box size, kind, entrance and exit
  transitions and default playback. For a code animation, instead of transitions it shows
  what the code animates itself and how long its exit takes: that is read from
  `onHide(fn, ms)` and written to `code.exitMs` for you.

A **code animation** (`kind: "code"`) is edited in the **dock under the canvas**: tabs for
HTML / CSS / JavaScript, a “Reference” for the runtime, and a preview of the animation on
its own with a “Replay” button (plays the entrance again). The live preview is also drawn
right on the canvas, where the placement is (or in the centre, if the template is not on
this out yet). The arrow on the right folds the dock away.

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
| `allowUnauthenticatedApi`  | boolean | `false`      | Explicitly allow an open API and silence the warning. Ignored when `apiToken` is set.           |
| `hideApiState`             | boolean | `false`      | Drop `templates`/`outs` from the `GET /api/state` response (for frequent polling from Companion). |
| `defaultOutId`             | string  | `"main"`     | The `id` of the out created on first run.                                                       |
| `language`                 | string  | `""`         | Language of the example library and sample data on first run: `en` or `ru`. Empty = the server process's locale, else English. |

The config is read once, when the bundle starts — **restart NodeCG after editing it**
(in Docker: `docker compose restart notgt`).

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
  "outs": [{ "id": "main", "name": "Main", "width": 1920, "height": 1080, "url": "…" }],
  "templates": [{ "id": "lower_third", "name": "Lower third", "kind": "layers" }]
}
```

- `activeTemplateId`, `activeVisible`, `activeOutId` — “flat” copies of the fields of
  `active`, so that a JSON path can be given directly in Companion.
- `playing` — which placements are actually playing now, per out.
- `revision` — a monotonic counter: it changes on any change, a cheap way to tell that
  “something changed”.
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
            "style": { "fontFamily": "Inter", "fontSize": 64, "color": "#ffffff" },
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

# one-shot of a specific placement
curl -sS -X POST http://<host>/api/outs/interview/items/item_ab12cd34ef56/trigger \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"holdMs":6000}'

# stop everything on an out
curl -sS -X POST http://<host>/api/outs/interview/stop \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

---

## Bitfocus Companion

There is no dedicated Companion module in the package — the stock HTTP module is used.
It covers 95 % of the job: show a title, hide it, light a button by state.

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

### Looking ahead: a dedicated module

If push instead of polling is needed later, the right way is a separate Companion module
on `@companion-module/base` that connects to NodeCG over **Socket.IO** and subscribes to
the Replicants directly. That gives:

- state updates without polling (the server sends the changes itself);
- dynamic dropdowns of templates and outs in actions (instead of typing ids by hand);
- ready-made variables/feedbacks with proper names.

This is not implemented yet; the HTTP scheme above is the recommended way.

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
- **Uploaded assets** (the `media` category) — kept in `assets/` (in Docker, the
  `notgt-assets` volume).

### Does not survive a restart

- **Derived playback state** (`runtime`: `playing`, `revision`) — recomputed on the server
  from scratch.
- **Running timers** — a `setTimeout` lives only in the process, so a single trigger “in
  flight” is lost. `held`, however, is state of the placement and is persisted: the
  scheduler brings the animations that were switched on back up automatically on start.

In a Docker deployment `db`, `assets` and `logs` are volumes declared in
`docker-compose.yml`; they survive `docker compose down` and an image rebuild. Delete a
volume and the show's configuration is gone.

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
wrapper. For a code animation that is rarely what you want: its own letter-by-letter
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
file. The file example is `graphics/animations/example-file-animation.html`; for the
built-in example templates, whose code lives inside them, see
[“Ready-made examples”](#ready-made-examples).

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
  font-family: Inter, system-ui, sans-serif;
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

The examples are a ready-made graphics package in one style: dark plates, a single red
accent, white type and a slanted cut on the edge. **All of them are in the library from
the first run**, under the stable ids in the table below, so they can be shown right
away — from Control or through the API (`POST /api/titles/example-poll/show`). On an
existing installation the missing examples and sample values for their variables are
added once, by a schema migration, and the built-in code examples that nobody edited are
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
| Countdown                | `example-countdown`     | code       | counting from `Date.now()`, three states, a ring of time left |
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
| Countdown                    | `example-countdown`      | a countdown: counting from `Date.now()`, three states, a remaining-time ring on `conic-gradient`  |
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
  -d '{"data":{"countdown":{"title":"On air in","target":"2027-01-01T00:00:00+03:00"}}}'
```

Every variable of every example is optional — without them it shows a meaningful demo (a
countdown from +10 minutes, Moscow, clear sky and so on). So the examples can be tried
before you set any data up.

The clock and the weather are better **held** on screen than played for a set time: add
the template to an out as a placement with `held: true` (in the Control panel that is the
“On air” switch).

Separately from the examples there is the **animations from files** mechanism (see
above) — `graphics/animations/example-file-animation.html` demonstrates it.

#### `example-countdown` — countdown

| Variable            | Default       | Meaning                                                           |
| ------------------- | ------------- | ----------------------------------------------------------------- |
| `countdown.title`   | `Starts in`   | the caption above the digits                                      |
| `countdown.target`  | now + 10 min  | the target: ISO 8601 (`2027-01-01T00:00:00+03:00`) or Unix time in ms |
| `countdown.from`    | the moment it is shown | the start of the count, for the ring (ISO 8601)          |
| `countdown.urgent`  | `10`          | how many seconds before zero the “panic” turns on                 |
| `countdown.accent`  | `#ff3b30`     | accent colour                                                     |

What to look at in the code: the remainder is always computed from `Date.now()`, so the
count neither slips nor accumulates drift; the ring is a single `conic-gradient` eased by
a CSS transition on `@property --p`, while the JS only sets a number. The ring shows how
much time is **left** (full at the start, empty at zero). A changing digit triggers a CSS
“toss” animation through a class.

#### `example-clock` — network clock

| Variable            | Default           | Meaning                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| `clock.title`       | the zone's city   | the caption (`Moscow`)                                       |
| `clock.timeZone`    | `Europe/Moscow`   | IANA time zone                                               |
| `clock.api`         | built-in list     | your own source URL; by default timeapi.io → worldtimeapi.org |
| `clock.syncMinutes` | `15`              | resync period                                                |
| `clock.accent`      | `#ff3b30`         | accent colour                                                |

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
| `weather.accent`         | `#ff3b30`         | accent colour                                       |

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
(`--build-arg INSTALL_FFMPEG=false` if you do not need it). Without ffmpeg, uploading
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
`NOTGT_BASE`, the path to Chromium with `CHROME_PATH`).

```bash
cd bundles/notGT
npm run test:e2e
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

What `scripts/e2e-panels.mjs` checks (dashboard): all three panels mount in standalone
mode in English and in Russian with no console errors; the editor has its Konva canvas;
moving, resizing and cropping a placement snap to the right lines; and the “On air” switch
puts a placement on air and keeps it there.

Screenshots are saved to `bundles/notGT/.e2e/` (the directory is in `.gitignore`).
