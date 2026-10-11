/**
 * Example — a kinetic lower third.
 *
 * The showcase for what a code animation can do that layers cannot: the name is
 * split into letters that rise one after another, and the title animates its
 * own way out and tells notGT how long that takes.
 */
import { defaultPlayback, defaultTransition } from "../types";
import type { GalleryExample } from "./gallery";

const html = String.raw`<div class="kt" id="kt">
	<div class="kt__chip" id="chip"><span id="role"></span></div>
	<div class="kt__name" id="name"></div>
	<div class="kt__rule" id="rule"></div>
</div>`;

const css = String.raw`/*
 * KINETIC LOWER THIRD
 *
 * What to look at:
 *   - the name line is a mask (overflow: hidden) and every letter is its own
 *     inline-block, so letters can rise into view one after another;
 *   - the entrance lives in onShow, the text in onData: fixing a typo while
 *     the title is on air does not replay the entrance;
 *   - the exit is declared once, as the second argument of onHide.
 *
 * Variables (all optional):
 *   speaker.name    the big line
 *   speaker.role    the chip above it
 *   speaker.accent  colour of the chip (#ff5a8c)
 */
.kt {
	position: absolute;
	left: 0;
	bottom: 0;
	color: #f5ecda;
	font-family: Montserrat, "Segoe UI", Roboto, Arial, sans-serif;
}

/* The slanted cut on the trailing edge is a clip-path, so the chip can also be
   wiped in and out by animating that same path. */
.kt__chip {
	display: inline-block;
	padding: 11px 44px 11px 20px;
	background: linear-gradient(135deg, var(--accent, #ff5a8c), var(--accent-deep, #ff5a8c));
	clip-path: polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%);
	color: #0c2b25;
	font-size: 27px;
	font-weight: 700;
	letter-spacing: 0.1em;
	text-transform: uppercase;
	white-space: nowrap;
}

/* The mask. The padding leaves room inside it for the text shadow and for the
   first letter, which the tight letter-spacing pushes past the left edge. */
.kt__name {
	overflow: hidden;
	margin: 6px 0 0 -8px;
	padding: 0 32px 10px 8px;
	font-size: 112px;
	font-weight: 800;
	line-height: 1.06;
	letter-spacing: -0.025em;
	white-space: nowrap;
	text-shadow: 0 6px 28px rgba(3, 14, 11, 0.55);
}

.kt__rule {
	width: 100%;
	height: 4px;
	background: linear-gradient(90deg, #f5ecda 0, #f5ecda 30%, rgba(245, 236, 218, 0) 100%);
	transform-origin: left center;
}

.ch {
	display: inline-block;
	will-change: transform;
}`;

const js = String.raw`const $ = (id) => document.getElementById(id);
const OUT = "cubic-bezier(.16,1,.3,1)"; // decelerates into place
const IN = "cubic-bezier(.7,0,.84,0)"; // accelerates away
const STEP = 28; // ms between two letters

const SHOWN = "polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)";
const WIPED = "polygon(0 0, 0 0, 0 100%, 0 100%)";

// One <span> per letter. A space would collapse inside an inline-block, so it
// becomes a non-breaking one.
function split(el, text) {
  el.textContent = "";
  return [...text].map((ch) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.textContent = ch === " " ? " " : ch;
    el.appendChild(span);
    return span;
  });
}

let letters = [];

// Data only lays the text out. The entrance belongs to onShow, so a change made
// while the title is on air updates the letters without replaying it.
onData(() => {
  letters = split($("name"), vars("speaker.name", "__NAME__"));
  $("role").textContent = vars("speaker.role", "__ROLE__");
  const accent = vars("speaker.accent");
  if (accent) {
    $("kt").style.setProperty("--accent", accent);
    $("kt").style.setProperty("--accent-deep", accent);
  }
});

onShow(() => {
  $("chip").animate([{ clipPath: WIPED }, { clipPath: SHOWN }], {
    duration: 520,
    easing: OUT,
    fill: "backwards",
  });
  letters.forEach((el, i) =>
    el.animate([{ transform: "translateY(112%)" }, { transform: "translateY(0)" }], {
      duration: 760,
      delay: 160 + i * STEP,
      easing: OUT,
      fill: "backwards",
    }),
  );
  $("rule").animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
    duration: 900,
    delay: 260,
    easing: OUT,
    fill: "backwards",
  });
});

// The exit takes EXIT ms, and this is the one place that number lives. notGT
// reads it from the second argument of onHide and starts the exit that much
// before the hold runs out, so the title is gone exactly on time.
const EXIT = 480;

onHide(() => {
  letters.forEach((el, i) =>
    el.animate([{ transform: "translateY(0)" }, { transform: "translateY(-112%)" }], {
      duration: 300,
      delay: Math.min(i * 7, 140),
      easing: IN,
      fill: "forwards",
    }),
  );
  $("rule").animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], {
    duration: 320,
    easing: IN,
    fill: "forwards",
  });
  $("chip").animate([{ clipPath: SHOWN }, { clipPath: WIPED }], {
    duration: 300,
    delay: 160,
    easing: IN,
    fill: "forwards",
  });
  setTimeout(hideDone, EXIT);
}, EXIT);`;

export const kineticExample: GalleryExample = {
	id: "example-kinetic",
	kind: "code",
	name: { en: "Kinetic lower third", ru: "Кинетический титр" },
	summary: {
		en: "Letters rise one by one, and the title animates its own exit. The reference for onShow and onHide.",
		ru: "Буквы поднимаются по одной, а уход титр анимирует сам. Образец для onShow и onHide.",
	},
	place: { x: 5, y: 66 },
	template: (lang) => ({
		kind: "code",
		width: 1500,
		height: 250,
		layers: [],
		code: {
			html,
			css,
			js: js
				.replace("__NAME__", lang === "ru" ? "Имя Фамилия" : "First Last")
				.replace("__ROLE__", lang === "ru" ? "Должность" : "Role"),
			exitMs: 480,
		},
		inTransition: defaultTransition(),
		outTransition: defaultTransition(),
		playback: { ...defaultPlayback(), mode: "once", holdMs: 7000 },
	}),
	data: (lang) => ({
		speaker:
			lang === "ru"
				? { name: "Иван Петров", role: "Ведущий" }
				: { name: "John Carter", role: "Host" },
	}),
};
