/**
 * Example — a timer card.
 *
 * Shows one of the timers of the Control panel: its name, its digits, a chip
 * that says whether it runs, and a bar of the time gone. The reference for
 * reading a timer from code — `timer(key)` / `timer(key, field)` — and for
 * a title that follows any timer through a variable.
 */
import { defaultPlayback, defaultTransition } from "../types";
import type { GalleryExample } from "./gallery";

/** The timer the card shows unless `timerCard.timer` names another one. */
export const TIMER_EXAMPLE_KEY = "segment";

const html = String.raw`<div class="tc" id="card" data-state="paused">
	<div class="tc__head">
		<span class="tc__label" id="label"></span>
		<span class="tc__chip" id="chip"></span>
	</div>
	<div class="tc__digits"><span id="digits">--:--</span></div>
	<div class="tc__bar"><span id="fill"></span></div>
</div>`;

const css = String.raw`/*
 * TIMER CARD
 *
 * What to look at:
 *   - the digits come from timer("…") in onData, which runs on every tick of
 *     the timer: no setInterval, no clock of the animation's own;
 *   - font-variant-numeric: tabular-nums keeps 1 as wide as 0, so the digits
 *     do not shake as they count;
 *   - the bar moves once a second and a linear transition fills in between.
 *
 * Variables:
 *   timerCard.timer   key of the timer to show (segment) — the timers are made,
 *                     started and paused in the Control panel
 */
.tc {
	--accent: #ff5a8c;
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	justify-content: center;
	padding: 18px 48px 22px 34px;
	background: linear-gradient(180deg, #123630, #0a251f);
	clip-path: polygon(0 0, 100% 0, calc(100% - 36px) 100%, 0 100%);
	color: #f5ecda;
	font-family: Montserrat, "Segoe UI", Roboto, Arial, sans-serif;
}

/* The accent edge on the left. */
.tc::before {
	content: "";
	position: absolute;
	inset: 0 auto 0 0;
	width: 10px;
	background: var(--accent);
}

.tc__head {
	display: flex;
	align-items: center;
	gap: 14px;
}

.tc__label {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	font-size: 24px;
	font-weight: 700;
	letter-spacing: 0.12em;
	text-overflow: ellipsis;
	text-transform: uppercase;
	white-space: nowrap;
}

.tc__chip {
	padding: 3px 12px;
	border-radius: 4px;
	background: rgba(245, 236, 218, 0.14);
	font-size: 18px;
	font-weight: 700;
	letter-spacing: 0.1em;
}

.tc[data-state="live"] .tc__chip {
	background: #ffd23f;
	color: #0c2b25;
}

.tc[data-state="done"] .tc__chip,
.tc[data-state="over"] .tc__chip {
	background: var(--accent);
	color: #0c2b25;
}

/* A mask, so the digits can rise into it. */
.tc__digits {
	overflow: hidden;
	margin-top: 2px;
	font-family: Handjet, Montserrat, sans-serif;
	font-size: 120px;
	font-weight: 700;
	line-height: 1;
	font-variant-numeric: tabular-nums;
	letter-spacing: 0.02em;
}

.tc__digits span {
	display: inline-block;
}

.tc[data-state="over"] .tc__digits,
.tc[data-state="done"] .tc__digits {
	color: var(--accent);
}

.tc__bar {
	height: 6px;
	margin-top: 10px;
	border-radius: 3px;
	background: rgba(245, 236, 218, 0.16);
	overflow: hidden;
}

.tc__bar span {
	display: block;
	height: 100%;
	background: var(--accent);
	transform-origin: left center;
	transform: scaleX(0);
	transition: transform 1s linear;
}`;

const js = String.raw`const $ = (id) => document.getElementById(id);
const OUT = "cubic-bezier(.16,1,.3,1)"; // decelerates into place
const IN = "cubic-bezier(.7,0,.84,0)"; // accelerates away
const SHOWN = "polygon(0 0, 100% 0, calc(100% - 36px) 100%, 0 100%)";
const WIPED = "polygon(0 0, 0 0, 0 100%, 0 100%)";
const STATES = { live: "__LIVE__", paused: "__PAUSED__", done: "__DONE__", over: "__OVER__" };

// Which timer: a variable, so one card can follow any timer of the Control panel.
const key = () => vars("timerCard.timer", "__KEY__");

// Runs now, on every change of the variables and on every tick of the timer.
// Only data here: the entrance belongs to onShow.
onData(() => {
  const k = key();
  const flag = (field) => timer(k, field) === "true";
  const state = flag("overtime") ? "over" : flag("done") ? "done" : flag("running") ? "live" : "paused";
  $("digits").textContent = timer(k) || "--:--";
  $("label").textContent = timer(k, "name") || k;
  $("chip").textContent = STATES[state];
  $("card").dataset.state = state;
  $("fill").style.transform = "scaleX(" + (Number(timer(k, "progress")) || 0) + ")";
});

onShow(() => {
  $("card").animate([{ clipPath: WIPED }, { clipPath: SHOWN }], {
    duration: 560,
    easing: OUT,
    fill: "backwards",
  });
  $("digits").firstElementChild?.animate(
    [{ transform: "translateY(105%)" }, { transform: "translateY(0)" }],
    { duration: 620, delay: 140, easing: OUT, fill: "backwards" },
  );
});

const EXIT = 420;

onHide(() => {
  $("digits").firstElementChild?.animate(
    [{ transform: "translateY(0)" }, { transform: "translateY(-105%)" }],
    { duration: 260, easing: IN, fill: "forwards" },
  );
  $("card").animate([{ clipPath: SHOWN }, { clipPath: WIPED }], {
    duration: 300,
    delay: 120,
    easing: IN,
    fill: "forwards",
  });
  setTimeout(hideDone, EXIT);
}, EXIT);`;

const LABELS = {
	en: { live: "LIVE", paused: "PAUSED", done: "TIME", over: "OVERTIME" },
	ru: { live: "ИДЁТ", paused: "ПАУЗА", done: "ВРЕМЯ", over: "ОВЕРТАЙМ" },
} as const;

export const timerExample: GalleryExample = {
	id: "example-timer",
	kind: "code",
	name: { en: "Timer card", ru: "Таймер" },
	summary: {
		en: "A timer of the Control panel on air: its name, its digits and a bar of the time gone. The reference for timer() in code.",
		ru: "Таймер из панели Control в эфире: название, цифры и полоса прошедшего времени. Образец для timer() в коде.",
	},
	place: { x: 62, y: 5 },
	template: (lang) => {
		const labels = LABELS[lang];
		return {
			kind: "code",
			width: 640,
			height: 230,
			layers: [],
			code: {
				html,
				css,
				js: js
					.replace("__LIVE__", labels.live)
					.replace("__PAUSED__", labels.paused)
					.replace("__DONE__", labels.done)
					.replace("__OVER__", labels.over)
					.replace("__KEY__", TIMER_EXAMPLE_KEY),
				exitMs: 420,
			},
			inTransition: defaultTransition(),
			outTransition: defaultTransition(),
			// A clock stays up until it is switched off.
			playback: { ...defaultPlayback(), mode: "loop" },
		};
	},
	data: () => ({ timerCard: { timer: TIMER_EXAMPLE_KEY } }),
	timers: (lang) => [
		{
			key: TIMER_EXAMPLE_KEY,
			name: lang === "ru" ? "Блок" : "Segment",
			mode: "down",
			durationMs: 5 * 60_000,
			overtime: true,
		},
	],
};
