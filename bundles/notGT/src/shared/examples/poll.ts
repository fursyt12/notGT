/**
 * Example — a live poll.
 *
 * Numbers that change while the title is on air: the operator edits the votes
 * in Control and the bars and percentages travel to their new values.
 */
import { defaultPlayback, defaultTransition } from "../types";
import type { GalleryExample } from "./gallery";

const html = String.raw`<section class="poll" id="poll">
	<div class="poll__tag" id="tag"></div>
	<h1 class="poll__q" id="q"></h1>
	<ol class="poll__rows" id="rows"></ol>
	<p class="poll__total" id="total"></p>
</section>`;

const css = String.raw`/*
 * LIVE POLL
 *
 * What to look at:
 *   - onData redraws on every change, and the change itself is animated: the
 *     bar by a CSS transition on its width, the percentage by a short count;
 *   - the leading option is marked by a class, so its colour is plain CSS;
 *   - an option with an empty label is simply not drawn, so the same title
 *     serves two, three or four answers.
 *
 * Variables:
 *   poll.tag              the small tag above the question
 *   poll.question         the question
 *   poll.a.label / .votes first option; same for poll.b, poll.c, poll.d
 *
 * A code animation receives only the chosen row of a list variable, so the
 * options are four named slots here rather than a list.
 */
.poll {
	position: absolute;
	inset: 0 0 auto 0;
	padding: 0 44px 34px;
	background: linear-gradient(180deg, rgba(24, 33, 45, 0.97), rgba(10, 14, 20, 0.97));
	/* The same slanted cut the plates have, taken out of the top corner. */
	clip-path: polygon(0 0, calc(100% - 46px) 0, 100% 46px, 100% 100%, 0 100%);
	color: #fff;
	font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;
}

.poll__tag {
	display: inline-block;
	padding: 9px 34px 9px 16px;
	margin-left: -44px;
	background: linear-gradient(135deg, #ff5245, #dc2a20);
	clip-path: polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%);
	font-size: 20px;
	font-weight: 700;
	letter-spacing: 0.14em;
	text-transform: uppercase;
}

.poll__q {
	margin: 26px 0 30px;
	font-size: 42px;
	font-weight: 800;
	line-height: 1.12;
	letter-spacing: -0.015em;
}

.poll__rows {
	margin: 0;
	padding: 0;
	list-style: none;
}

.row {
	margin-bottom: 24px;
}

.row__head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	color: #c9d3de;
	font-size: 27px;
	font-weight: 600;
}

.row__pct {
	color: #fff;
	font-size: 34px;
	font-weight: 800;
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.02em;
}

.row__track {
	height: 8px;
	margin-top: 10px;
	background: rgba(255, 255, 255, 0.1);
}

.row__bar {
	width: 0;
	height: 100%;
	background: #7d8ea1;
	transition: width 0.9s cubic-bezier(0.16, 1, 0.3, 1);
}

.row.is-lead .row__head {
	color: #fff;
}

.row.is-lead .row__bar {
	background: linear-gradient(90deg, #ff5245, #ff3b30);
}

.poll__total {
	margin: 2px 0 0;
	color: #7d8ea1;
	font-size: 21px;
	letter-spacing: 0.02em;
}`;

const js = String.raw`const KEYS = ["a", "b", "c", "d"];
const $ = (id) => document.getElementById(id);

// The four rows exist from the start, in order; an unused one stays hidden.
const rows = KEYS.map((key) => {
  const li = document.createElement("li");
  li.className = "row";
  li.innerHTML =
    '<div class="row__head"><span class="row__label"></span><span class="row__pct">0%</span></div>' +
    '<div class="row__track"><div class="row__bar"></div></div>';
  $("rows").appendChild(li);
  return {
    key,
    li,
    label: li.querySelector(".row__label"),
    pct: li.querySelector(".row__pct"),
    bar: li.querySelector(".row__bar"),
    shown: 0, // the percentage currently written on screen
    target: 0, // the percentage the data asks for
  };
});

// Counts the number to its new value, so a change reads as a change.
function count(row, to) {
  const from = row.shown;
  const start = performance.now();
  row.shown = to;
  (function tick(now) {
    const t = Math.min(1, (now - start) / 900);
    const eased = 1 - Math.pow(1 - t, 3);
    row.pct.textContent = Math.round(from + (to - from) * eased) + "%";
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

function travel(row) {
  row.bar.style.width = row.target + "%";
  count(row, row.target);
}

let onAir = false;

onData(() => {
  $("tag").textContent = vars("poll.tag", "__TAG__");
  $("q").textContent = vars("poll.question", "__QUESTION__");

  const votes = rows.map((row) => Math.max(0, Number(vars("poll." + row.key + ".votes")) || 0));
  const labels = rows.map((row) => vars("poll." + row.key + ".label"));
  const total = votes.reduce((sum, value, i) => (labels[i] ? sum + value : sum), 0);
  const lead = Math.max.apply(null, votes.filter((_, i) => labels[i]).concat(0));

  rows.forEach((row, i) => {
    row.li.style.display = labels[i] ? "" : "none";
    row.label.textContent = labels[i];
    row.li.classList.toggle("is-lead", total > 0 && votes[i] === lead);
    row.target = total > 0 ? Math.round((votes[i] / total) * 100) : 0;
    if (onAir) travel(row);
  });

  $("total").textContent = "__TOTAL__".replace("{n}", total);
});

onShow(() => {
  onAir = true;
  $("poll").animate(
    [{ opacity: 0, transform: "translateX(48px)" }, { opacity: 1, transform: "none" }],
    { duration: 620, easing: "cubic-bezier(.16,1,.3,1)" },
  );
  // Every show starts the bars from zero; later changes travel from where they are.
  rows.forEach((row, i) => {
    row.bar.style.transition = "none";
    row.bar.style.width = "0%";
    row.shown = 0;
    row.pct.textContent = "0%";
    setTimeout(() => {
      row.bar.style.transition = "";
      travel(row);
    }, 260 + i * 110);
  });
});

const EXIT = 350;

onHide(() => {
  onAir = false;
  $("poll").animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(40px)" }],
    { duration: EXIT, easing: "ease-in", fill: "forwards" },
  );
}, EXIT);`;

export const pollExample: GalleryExample = {
	id: "example-poll",
	kind: "code",
	name: { en: "Live poll", ru: "Опрос в эфире" },
	summary: {
		en: "Bars and percentages that travel to new values as you edit the votes in Control.",
		ru: "Столбцы и проценты едут к новым значениям, пока вы меняете голоса в Control.",
	},
	place: { x: 58, y: 22 },
	template: (lang) => ({
		kind: "code",
		width: 720,
		height: 620,
		layers: [],
		code: {
			html,
			css,
			js: js
				.replace("__TAG__", lang === "ru" ? "Опрос" : "Poll")
				.replace("__QUESTION__", lang === "ru" ? "Вопрос опроса" : "Poll question")
				.replace("__TOTAL__", lang === "ru" ? "Голосов: {n}" : "{n} votes"),
			exitMs: 350,
		},
		inTransition: defaultTransition(),
		outTransition: defaultTransition(),
		// A poll stays up while people vote: it is switched on, not played.
		playback: { ...defaultPlayback(), mode: "loop" },
	}),
	data: (lang) => ({
		poll:
			lang === "ru"
				? {
						question: "Что показать первым?",
						a: { label: "Несколько out", votes: 42 },
						b: { label: "Титры на коде", votes: 67 },
						c: { label: "REST API", votes: 31 },
						d: { label: "", votes: 0 },
					}
				: {
						question: "What should we show first?",
						a: { label: "Multiple outs", votes: 42 },
						b: { label: "Code titles", votes: 67 },
						c: { label: "REST API", votes: 31 },
						d: { label: "", votes: 0 },
					},
	}),
};
