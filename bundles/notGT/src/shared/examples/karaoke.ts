/**
 * Example — karaoke.
 *
 * The line being sung, filled left to right as it is sung, with the next line
 * under it. The `karaoke.*` variables come from notGT Karaoke (`karaoke/` in
 * the repository), which follows the track playing in Spotify; any program
 * that writes the same variables drives it as well.
 */
import { defaultPlayback, defaultTransition } from "../types";
import type { GalleryExample } from "./gallery";

const html = String.raw`<section class="karaoke is-empty" id="karaoke">
	<div class="karaoke__head">
		<span class="karaoke__tag" id="tag"></span>
		<span class="karaoke__track" id="track"></span>
	</div>
	<div class="karaoke__plate">
		<p class="karaoke__line" id="line"></p>
		<div class="karaoke__wait" id="wait"><i></i><i></i><i></i></div>
		<p class="karaoke__next" id="next"></p>
	</div>
</section>`;

const css = String.raw`/*
 * KARAOKE
 *
 * What to look at:
 *   - the position comes with every line (karaoke.pos: ms into it when it was
 *     sent), and the title counts on by itself until the next frame, so the
 *     fill runs smoothly between frames and stops when playback pauses;
 *   - every word is a gradient clipped to its letters, moved by one custom
 *     property (--p, 0..1). With word timing each word fills in its own time;
 *     without it the line fills at the speed it is sung (karaoke.sing);
 *   - before the first line and in a solo, three dots go out one by one as
 *     the next line comes closer.
 *
 * Variables:
 *   karaoke.artist / .title      the track
 *   karaoke.cur / .next / .next2 the line being sung and the ones after it
 *   karaoke.pos                  ms into the current line when it was sent
 *   karaoke.dur / .sing          ms until the next line / that this one is sung
 *   karaoke.wt                   "start:end,..." per word, ms in the line (empty without word timing)
 *   karaoke.playing / .seq       "1" while it plays / a new value with every frame
 */
.karaoke {
	position: absolute;
	right: 0;
	bottom: 0;
	left: 0;
	color: #f5ecda;
	font-family: Montserrat, "Segoe UI", Roboto, Arial, sans-serif;
	transition: opacity 0.4s ease;
}

/* Nothing plays, or the song is over: the title waits out of sight. */
.karaoke.is-empty {
	opacity: 0;
}

.karaoke__head {
	display: flex;
}

.karaoke__tag {
	padding: 9px 34px 9px 18px;
	background: linear-gradient(135deg, #ff6c98, #ff5a8c);
	clip-path: polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%);
	color: #0c2b25;
	font-size: 20px;
	font-weight: 700;
	letter-spacing: 0.14em;
	text-transform: uppercase;
}

.karaoke__track {
	max-width: 1100px;
	margin-left: -10px;
	padding: 9px 40px 9px 28px;
	overflow: hidden;
	background: rgba(8, 32, 25, 0.94);
	clip-path: polygon(18px 0, 100% 0, calc(100% - 18px) 100%, 0 100%);
	color: #a9b8a8;
	font-size: 20px;
	font-weight: 600;
	letter-spacing: 0.02em;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.karaoke__plate {
	position: relative;
	padding: 26px 96px 30px 44px;
	background: linear-gradient(180deg, rgba(18, 54, 48, 0.97), rgba(10, 37, 31, 0.97));
	/* the slanted cut every plate has, on the trailing edge */
	clip-path: polygon(0 0, 100% 0, calc(100% - 46px) 100%, 0 100%);
}

.karaoke__plate::before {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 10px;
	background: linear-gradient(180deg, #ff6c98, #ff5a8c);
}

.karaoke__line {
	display: -webkit-box;
	min-height: 1.14em;
	margin: 0;
	overflow: hidden;
	font-size: 56px;
	font-weight: 800;
	line-height: 1.14;
	letter-spacing: -0.012em;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

/* One word: sung (Signal) up to --p of its width, still to sing (cream) after. */
.w {
	--p: 0;
	background: linear-gradient(90deg, #ff5a8c calc(var(--p) * 100%), #f5ecda calc(var(--p) * 100%));
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}

/* The line that comes after a pause is shown, not yet sung. */
.karaoke.is-waiting .w {
	opacity: 0.55;
}

.karaoke.is-paused .karaoke__line {
	opacity: 0.7;
}

.karaoke__next {
	min-height: 1.2em;
	margin: 14px 0 0;
	overflow: hidden;
	color: #6f8a7e;
	font-size: 30px;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.karaoke__wait {
	display: none;
	gap: 14px;
	margin: 18px 0 2px;
}

.karaoke.is-counting .karaoke__wait {
	display: flex;
}

.karaoke__wait i {
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: #2c5a4f;
	transition: background 0.25s ease;
}

.karaoke__wait i.is-on {
	background: #ffd23f;
}

.is-new {
	animation: rise 0.34s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes rise {
	from {
		opacity: 0;
		transform: translateY(18px);
	}
	to {
		opacity: 1;
		transform: none;
	}
}`;

const js = String.raw`const $ = (id) => document.getElementById(id);
const root = $("karaoke");
const dots = Array.from($("wait").children);

$("tag").textContent = "__TAG__";

let seq = null; // the frame the timing below comes from
let base = 0; // ms into the line when that frame was sent
let at = 0; // when it arrived (performance.now)
let playing = false;
let sing = 0; // ms the line is sung
let dur = 0; // ms until the next line
let shown = null; // the line on screen, and whether it was shown waiting
let waiting = false; // between lines: the next one is shown, not sung
let words = []; // { el, from, to }: ms in the line (word timing) or letters (without)
let timed = false; // the words carry their own time
let letters = 0;

function now() {
  return playing ? base + (performance.now() - at) : base;
}

// The line as one span per word, so that each word can be filled on its own.
function build(text, timing, entrance) {
  const line = $("line");
  const parts = text.split(/\s+/).filter(Boolean);
  const times = timing ? timing.split(",").map((pair) => pair.split(":").map(Number)) : [];
  timed = times.length === parts.length && times.every((pair) => pair.length === 2 && pair.every(isFinite));
  line.textContent = "";
  letters = 0;
  words = parts.map((word, i) => {
    const el = document.createElement("span");
    el.className = "w";
    el.textContent = word;
    if (i) line.appendChild(document.createTextNode(" "));
    line.appendChild(el);
    const entry = timed
      ? { el, from: times[i][0], to: times[i][1] }
      : { el, from: letters, to: letters + word.length };
    letters += word.length;
    return entry;
  });
  if (!entrance) return;
  line.classList.remove("is-new");
  void line.offsetWidth; // restart the entrance
  line.classList.add("is-new");
}

onData(() => {
  const frame = vars("karaoke.seq");
  if (frame === seq) return; // another variable changed
  const before = shown === null ? 0 : now();
  seq = frame;
  base = Number(vars("karaoke.pos")) || 0;
  at = performance.now();
  playing = vars("karaoke.playing") === "1";
  dur = Number(vars("karaoke.dur")) || 0;
  sing = Number(vars("karaoke.sing")) || dur;

  const artist = vars("karaoke.artist");
  const title = vars("karaoke.title");
  const cur = vars("karaoke.cur");
  const next = vars("karaoke.next");
  waiting = !cur && Boolean(next);
  $("track").textContent = [artist, title].filter(Boolean).join(" — ");
  root.classList.toggle("is-empty", (!artist && !title) || (!cur && !next));
  root.classList.toggle("is-waiting", waiting);
  root.classList.toggle("is-counting", waiting && dur >= 2500);
  root.classList.toggle("is-paused", !playing);

  // A new line: other text, the same words sung again (the position went back),
  // or the line waited for that now begins (it stays, and gets its timing).
  const text = waiting ? next : cur;
  const key = (waiting ? "wait:" : "sing:") + text;
  if (key !== shown || base + 300 < before) {
    const begins = shown === "wait:" + text && !waiting;
    shown = key;
    build(text, waiting ? "" : vars("karaoke.wt"), !begins);
    $("next").textContent = waiting ? vars("karaoke.next2") : next;
  }
});

function fill() {
  const t = now();
  if (waiting) {
    // the dots go out one by one over the pause
    const left = Math.max(0, dur - t);
    dots.forEach((dot, i) => dot.classList.toggle("is-on", left > (dur * i) / dots.length));
    for (const word of words) word.el.style.setProperty("--p", "0");
  } else {
    const sung = timed ? t : Math.min(1, t / Math.max(1, sing)) * letters;
    for (const word of words) {
      const p = Math.max(0, Math.min(1, (sung - word.from) / Math.max(1, word.to - word.from)));
      const value = p.toFixed(3);
      if (word.el.style.getPropertyValue("--p") !== value) word.el.style.setProperty("--p", value);
    }
  }
  requestAnimationFrame(fill);
}
requestAnimationFrame(fill);

onShow(() => {
  root.animate(
    [{ opacity: 0, transform: "translateX(-48px)" }, { opacity: 1, transform: "none" }],
    { duration: 620, easing: "cubic-bezier(.16,1,.3,1)" },
  );
});

const EXIT = 350;

onHide(() => {
  root.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-40px)" }],
    { duration: EXIT, easing: "ease-in", fill: "forwards" },
  );
}, EXIT);`;

export const karaokeExample: GalleryExample = {
	id: "example-karaoke",
	kind: "code",
	name: { en: "Karaoke", ru: "Караоке" },
	summary: {
		en: "The line being sung fills left to right, the next one waits under it. Driven by notGT Karaoke from Spotify.",
		ru: "Строка заливается слева направо, пока её поют, следующая ждёт под ней. Ведёт notGT Караоке из Spotify.",
	},
	place: { x: 6, y: 68 },
	template: (lang) => ({
		kind: "code",
		width: 1680,
		height: 300,
		layers: [],
		code: {
			html,
			css,
			js: js.replace("__TAG__", lang === "ru" ? "Караоке" : "Karaoke"),
			exitMs: 350,
		},
		inTransition: defaultTransition(),
		outTransition: defaultTransition(),
		// Karaoke stays up for the whole song: it is switched on, not played.
		playback: { ...defaultPlayback(), mode: "loop" },
	}),
	data: (lang) => ({
		karaoke: {
			artist: "notGT",
			title: lang === "ru" ? "Караоке" : "Karaoke",
			prev: "",
			cur: lang === "ru" ? "Строки меняются по таймкодам" : "Lines change on their timecodes",
			next: lang === "ru" ? "А заливка идёт слева направо" : "And the fill runs left to right",
			next2: "",
			pos: "0",
			dur: "3500",
			sing: "3000",
			wt: "",
			playing: "1",
			seq: "1",
		},
	}),
};
