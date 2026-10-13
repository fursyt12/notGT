#!/usr/bin/env node
/**
 * notGT — a layer's own entrance and exit, end to end.
 *
 *   1. On the out page: a layer with a delayed entrance is kept away until its
 *      delay is over, a layer without one is there at once, and on the way out
 *      the slot stays until the last layer has left.
 *   2. In the Editor: the "Animation" tab draws the whole animation as a
 *      timeline, a bar is dragged to set a delay, and what is set there is what
 *      gets saved.
 *   3. In full screen the "Layer" and "Crop" tools come along onto the desk.
 *
 * Usage (server must already be running on 127.0.0.1:9090):
 *   node scripts/e2e-motion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", ".e2e");
const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const CHROME =
	process.env.CHROME_PATH ??
	["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		(p) => fs.existsSync(p),
	);

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

async function api(method, url, body) {
	const response = await fetch(`${BASE}${url}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!response.ok) {
		throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
	}
	return json;
}

const FIXTURE = "e2e-motion";

/** Three bars: one plain, one that comes in late, one that leaves late. */
const TEMPLATE = {
	id: FIXTURE,
	name: "E2E motion",
	kind: "layers",
	width: 1920,
	height: 1080,
	layers: [
		{
			id: "m_plain",
			name: "Plain",
			type: "shape",
			shape: "rect",
			x: 10,
			y: 10,
			width: 20,
			height: 10,
			style: { fill: "#ffffff", opacity: 1, rotation: 0 },
			z: 1,
		},
		{
			id: "m_late",
			name: "Late",
			type: "shape",
			shape: "rect",
			x: 10,
			y: 30,
			width: 20,
			height: 10,
			style: { fill: "#ff5a8c", opacity: 0.8, rotation: 10 },
			inTransition: { type: "fade", durationMs: 300, delayMs: 600, easing: "linear" },
			outTransition: { type: "fade", durationMs: 200, easing: "linear" },
			z: 2,
		},
		{
			id: "m_slide",
			name: "Slide",
			type: "shape",
			shape: "rect",
			x: 10,
			y: 50,
			width: 20,
			height: 10,
			style: { fill: "#ffd23f", opacity: 1, rotation: 0 },
			inTransition: { type: "slide-left", durationMs: 300, easing: "linear" },
			outTransition: { type: "slide-right", durationMs: 300, delayMs: 500, easing: "linear" },
			z: 3,
		},
	],
	inTransition: { type: "none", durationMs: 0 },
	outTransition: { type: "none", durationMs: 0 },
	playback: { mode: "once", intervalMs: 10000, holdMs: 60000, autoStart: false },
};

async function removeFixtures() {
	await fetch(`${BASE}/api/outs/${FIXTURE}`, { method: "DELETE" });
	await fetch(`${BASE}/api/templates/${FIXTURE}`, { method: "DELETE" });
}

async function main() {
	if (!CHROME) throw new Error("No Chromium binary found; set CHROME_PATH");
	fs.mkdirSync(outDir, { recursive: true });

	await removeFixtures();
	await api("POST", "/api/templates", TEMPLATE);
	await api("POST", "/api/outs", { id: FIXTURE, name: "E2E Motion", width: 1920, height: 1080 });
	const created = await api("POST", `/api/outs/${FIXTURE}/items`, { templateId: FIXTURE });
	const itemId = created.item.id;
	const setHeld = (held) => api("PATCH", `/api/outs/${FIXTURE}/items/${itemId}`, { held });
	const readTemplate = async () => {
		const answer = await api("GET", `/api/templates/${FIXTURE}`);
		return answer.template ?? answer;
	};

	// What the API was given is what it keeps: the delays are part of the model.
	const stored = await readTemplate();
	const storedLate = stored.layers?.find((layer) => layer.id === "m_late");
	check(
		"the API keeps a layer's own transitions and their delays",
		storedLate?.inTransition?.delayMs === 600 && storedLate?.outTransition?.type === "fade",
		JSON.stringify(storedLate?.inTransition),
	);

	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--force-color-profile=srgb",
		],
	});

	const errors = [];
	const watch = (page) => {
		page.on("pageerror", (error) => errors.push(String(error)));
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
	};

	try {
		// ------------------------------------------------- 1. the out page
		const out = await browser.newPage();
		await out.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
		watch(out);
		await out.goto(`${BASE}/bundles/notGT/graphics/out.html?out=${FIXTURE}&debug=1`, {
			waitUntil: "networkidle2",
			timeout: 30_000,
		});
		await out.waitForFunction(
			(id) => document.getElementById("notgt-debug")?.textContent?.includes(`out: ${id}`),
			{ timeout: 15_000 },
			FIXTURE,
		);

		// Every frame: where each layer is and how much of it shows.
		await out.evaluate(() => {
			window.__samples = [];
			const read = (id) => {
				const el = document.querySelector(`.notgt-layer[data-layer-id="${id}"]`);
				if (!el) return null;
				const style = getComputedStyle(el);
				return {
					opacity: Number(style.opacity),
					x: Math.round(el.getBoundingClientRect().x),
					transform: style.transform,
				};
			};
			const tick = () => {
				window.__samples.push({
					t: performance.now(),
					plain: read("m_plain"),
					late: read("m_late"),
					slide: read("m_slide"),
				});
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		const samples = () => out.evaluate(() => window.__samples);
		const now = () => out.evaluate(() => performance.now());

		await setHeld(true);
		await sleep(1500);
		const shown = (await samples()).filter((sample) => sample.late !== null);
		const t0 = shown[0]?.t ?? 0;
		const during = (list, from, to) =>
			list.filter((sample) => sample.t - t0 >= from && sample.t - t0 <= to);
		const last = shown[shown.length - 1];

		check(
			"a layer without an entrance of its own is there at once",
			shown[0]?.plain?.opacity === 1,
			JSON.stringify(shown[0]?.plain),
		);
		const waiting = during(shown, 0, 480);
		check(
			"a delayed layer is kept away until its delay is over",
			waiting.length > 5 && waiting.every((sample) => sample.late.opacity < 0.02),
			`${waiting.length} frames, max ${Math.max(...waiting.map((sample) => sample.late.opacity))}`,
		);
		const fading = during(shown, 640, 880).map((sample) => sample.late.opacity);
		check(
			"…and then plays its own entrance",
			fading.some((opacity) => opacity > 0.05 && opacity < 0.75),
			fading.map((opacity) => opacity.toFixed(2)).join(" "),
		);
		check(
			"when the entrance is over the layer is exactly as it was styled",
			Math.abs((last?.late?.opacity ?? 0) - 0.8) < 0.01 &&
				last?.late?.transform !== "none" &&
				last?.slide?.opacity === 1 &&
				last?.slide?.x === 192,
			JSON.stringify({ late: last?.late, slide: last?.slide }),
		);
		const sliding = during(shown, 0, 200);
		check(
			"another layer runs its own entrance in the meantime",
			sliding.some((sample) => sample.slide.x < 180 && sample.slide.opacity < 1),
			sliding.map((sample) => sample.slide.x).join(" "),
		);
		await out.screenshot({ path: path.join(outDir, "motion-on-air.png") });

		// The way out: one layer leaves at once, the other waits half a second,
		// and the slot stays for as long as the later one needs.
		const hideAt = (await now()) - t0;
		await setHeld(false);
		await sleep(1500);
		const all = await samples();
		const leaving = all.filter((sample) => sample.t - t0 >= hideAt);
		const after = (from, to) =>
			leaving.filter(
				(sample) => sample.t - t0 - hideAt >= from && sample.t - t0 - hideAt <= to,
			);
		const early = after(320, 440);
		check(
			"on the way out a layer plays its own exit",
			early.length > 3 && early.every((sample) => sample.late && sample.late.opacity < 0.05),
			early.map((sample) => sample.late?.opacity.toFixed(2)).join(" "),
		);
		check(
			"a layer with a delayed exit stays put until then",
			early.every((sample) => sample.slide && sample.slide.opacity > 0.95 && sample.slide.x === 192),
			early.map((sample) => `${sample.slide?.x}/${sample.slide?.opacity}`).join(" "),
		);
		const late = after(600, 780);
		check(
			"…and then leaves",
			late.some((sample) => sample.slide && sample.slide.x > 200),
			late.map((sample) => sample.slide?.x).join(" "),
		);
		const gone = leaving.find((sample) => sample.slide === null);
		const goneAfter = gone ? Math.round(gone.t - t0 - hideAt) : -1;
		check(
			"the slot is dropped when the last exit is over, not before",
			goneAfter >= 780 && goneAfter <= 1250,
			`${goneAfter} ms after the hide`,
		);
		await out.close();

		// --------------------------------------------------- 2. the editor
		const page = await browser.newPage();
		await page.setViewport({ width: 1600, height: 950 });
		watch(page);
		await page.goto(`${BASE}/bundles/notGT/dashboard/editor.html?standalone=1&lang=en`, {
			waitUntil: "networkidle2",
			timeout: 30_000,
		});
		await page.waitForSelector("select.ed-out-select", { timeout: 15_000 });
		await page.select("select.ed-out-select", FIXTURE);
		await sleep(900);

		const clickTab = (name) =>
			page.evaluate((label) => {
				const tab = [...document.querySelectorAll(".ed-tabs--fill .ed-tab")].find(
					(button) => button.textContent?.trim() === label,
				);
				tab?.click();
				return Boolean(tab);
			}, name);
		await clickTab("Animation");
		await sleep(300);

		const timeline = () =>
			page.evaluate(() => {
				const bar = (row, phase) => {
					const el = document.querySelector(
						`[data-motion-row="${row}"] [data-motion-bar="${phase}"]`,
					);
					if (!el) return null;
					return {
						left: el.style.left,
						width: el.style.width,
						ghost: el.classList.contains("is-ghost"),
					};
				};
				const rows = [...document.querySelectorAll("[data-motion-row]")].map(
					(row) => row.dataset.motionRow,
				);
				const total = (phase) =>
					document.querySelector(`[data-motion-total="${phase}"]`)?.textContent?.trim();
				return {
					rows,
					totalIn: total("in"),
					totalOut: total("out"),
					lateIn: bar("m_late", "in"),
					slideOut: bar("m_slide", "out"),
					plainIn: bar("m_plain", "in"),
					warning: Boolean(document.querySelector("[data-motion-warning]")),
					hatched: document.querySelectorAll(".ed-tl__gone").length,
				};
			});

		const drawn = await timeline();
		check(
			"editor: the Animation tab has a row for the whole animation and one per layer",
			JSON.stringify(drawn.rows) === JSON.stringify(["whole", "m_slide", "m_late", "m_plain"]),
			JSON.stringify(drawn.rows),
		);
		// The scale is 1.5 s: the longer phase is 0.9 s, with room left to drag.
		check(
			"editor: a bar starts at its delay and is as long as its duration",
			drawn.lateIn?.left === "40%" &&
				drawn.lateIn?.width === "20%" &&
				drawn.slideOut?.left.startsWith("33.3") &&
				drawn.slideOut?.width === "20%",
			JSON.stringify({ lateIn: drawn.lateIn, slideOut: drawn.slideOut }),
		);
		check(
			"editor: the timeline says how long the entrance and the exit take",
			drawn.totalIn === "0.9 s" && drawn.totalOut === "0.8 s",
			`${drawn.totalIn} / ${drawn.totalOut}`,
		);
		check(
			"editor: a layer with no transition of its own is drawn as following the animation",
			drawn.plainIn?.ghost === true && drawn.lateIn?.ghost === false,
			JSON.stringify(drawn.plainIn),
		);

		/** Centre of a bar (or of its right edge) and the width of its zone. */
		const grip = (row, phase, edge = false) =>
			page.evaluate(
				(row, phase, edge) => {
					const bar = document.querySelector(
						`[data-motion-row="${row}"] [data-motion-bar="${phase}"]`,
					);
					const target = edge ? bar.querySelector("[data-motion-edge]") : bar;
					const rect = target.getBoundingClientRect();
					return {
						x: edge ? rect.right - 2 : rect.left + Math.min(3, rect.width / 2),
						y: rect.top + rect.height / 2,
						zone: bar.parentElement.getBoundingClientRect().width,
					};
				},
				row,
				phase,
				edge,
			);
		const dragBar = async (row, phase, share, edge = false) => {
			const at = await grip(row, phase, edge);
			await page.mouse.move(at.x, at.y);
			await page.mouse.down();
			await page.mouse.move(at.x + at.zone * share, at.y, { steps: 8 });
			await page.mouse.up();
			await sleep(250);
		};
		/** The fields under the timeline: which row they are for, and their values. */
		const fields = (phase) =>
			page.evaluate((phase) => {
				const edit = document.querySelector("[data-motion-edit]");
				const box = edit?.querySelector(`[data-motion-fields="${phase}"]`);
				const numbers = [...(box?.querySelectorAll('input[type="number"]') ?? [])].map(
					(input) => Number(input.value),
				);
				return {
					row: edit?.dataset.motionEdit,
					type: box?.querySelector("select")?.value,
					delay: numbers[0],
					duration: numbers[1],
				};
			}, phase);

		// A fifth of the 1.5 s scale is 300 ms.
		await dragBar("m_plain", "in", 0.2);
		const dragged = await fields("in");
		check(
			"editor: dragging a layer's bar gives the layer a delay of its own",
			dragged.row === "m_plain" &&
				dragged.type === "fade" &&
				Math.abs(dragged.delay - 300) <= 10 &&
				dragged.duration === 350,
			JSON.stringify(dragged),
		);
		check(
			"editor: the change is an unsaved edit of the animation",
			await page.evaluate(() => Boolean(document.querySelector(".ed-chip.is-dirty"))),
		);

		await dragBar("m_late", "in", -0.1, true);
		const shortened = await fields("in");
		check(
			"editor: dragging the right edge of a bar changes its length",
			shortened.row === "m_late" && shortened.duration === 150 && shortened.delay === 600,
			JSON.stringify(shortened),
		);

		// The arrow keys move the bar that has the focus, and nothing else: on
		// the rest of the page they nudge the placement.
		const placementBefore = (await api("GET", `/api/outs/${FIXTURE}`)).out?.items?.[0];
		await page.focus('[data-motion-row="m_late"] [data-motion-bar="out"]');
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
		await sleep(250);
		const nudged = await fields("out");
		const placementAfter = (await api("GET", `/api/outs/${FIXTURE}`)).out?.items?.[0];
		check(
			"editor: the arrow keys move the focused bar in 10 ms steps",
			nudged.row === "m_late" && nudged.delay === 30,
			JSON.stringify(nudged),
		);
		check(
			"editor: …and leave the placement where it was",
			placementBefore?.x === placementAfter?.x && placementBefore?.y === placementAfter?.y,
			JSON.stringify({ before: placementBefore?.x, after: placementAfter?.x }),
		);

		// The whole animation gets a fade of its own on the way out: the layer
		// that leaves after it is not seen, and the timeline says so.
		await page.click('[data-motion-row="whole"] .ed-tl__name');
		await sleep(150);
		await page.select('[data-motion-edit="whole"] [data-motion-fields="out"] select', "fade");
		await sleep(250);
		const warned = await timeline();
		const wholeOut = await fields("out");
		check(
			"editor: a transition picked after “No transition” gets a length",
			wholeOut.row === "whole" && wholeOut.type === "fade" && wholeOut.duration === 350,
			JSON.stringify(wholeOut),
		);
		check(
			"editor: an exit that outlasts the whole animation is pointed out",
			warned.warning === true && warned.hatched === 1,
			JSON.stringify({ warning: warned.warning, hatched: warned.hatched }),
		);
		await page.screenshot({ path: path.join(outDir, "editor-motion.png") });
		{
			const side = await page.$(".ed-side--right");
			await side?.screenshot({ path: path.join(outDir, "editor-motion-side.png") });
		}

		// A layer gives its transition up again.
		await page.click('[data-motion-row="m_slide"] .ed-tl__name');
		await sleep(150);
		await page.select('[data-motion-edit="m_slide"] [data-motion-fields="out"] select', "with-whole");
		await sleep(250);
		const released = await timeline();
		check(
			"editor: “With the whole animation” takes a layer's own transition away",
			released.slideOut?.ghost === true && released.warning === false,
			JSON.stringify(released.slideOut),
		);

		// Saved as set.
		await page.evaluate(() => {
			[...document.querySelectorAll(".ed-toolbar button")]
				.find((button) => button.textContent?.trim() === "Save")
				?.click();
		});
		await sleep(600);
		const saved = await readTemplate();
		const layer = (id) => saved.layers.find((candidate) => candidate.id === id);
		check(
			"editor: Save stores every layer's transitions and delays",
			Math.abs((layer("m_plain").inTransition?.delayMs ?? -1) - 300) <= 10 &&
				layer("m_plain").inTransition?.type === "fade" &&
				layer("m_late").inTransition?.durationMs === 150 &&
				layer("m_late").outTransition?.delayMs === 30 &&
				!layer("m_slide").outTransition &&
				layer("m_slide").inTransition?.type === "slide-left" &&
				saved.outTransition?.type === "fade" &&
				saved.outTransition?.durationMs === 350,
			JSON.stringify({
				plain: layer("m_plain").inTransition,
				late: [layer("m_late").inTransition, layer("m_late").outTransition],
				slide: layer("m_slide").outTransition ?? null,
				whole: saved.outTransition,
			}),
		);

		// The same fields, on the layer itself.
		await page.evaluate(() => {
			const row = [...document.querySelectorAll(".ed-side .ed-list-item")].find(
				(item) => item.querySelector(".ed-inline-name")?.textContent?.trim() === "Late",
			);
			row?.click();
		});
		await sleep(300);
		await page.evaluate(() => {
			[...document.querySelectorAll(".ed-side--right .ed-section__head")]
				.find((head) => head.textContent?.trim() === "Entrance and exit")
				?.click();
		});
		await sleep(250);
		const onLayer = await page.evaluate(() => {
			const box = document.querySelector('.ed-side--right [data-motion-fields="in"]');
			const numbers = [...(box?.querySelectorAll('input[type="number"]') ?? [])].map((input) =>
				Number(input.value),
			);
			return { type: box?.querySelector("select")?.value, delay: numbers[0], duration: numbers[1] };
		});
		check(
			"editor: the Layer tab has the layer's own entrance and exit",
			onLayer.type === "fade" && onLayer.delay === 600 && onLayer.duration === 150,
			JSON.stringify(onLayer),
		);
		await page.screenshot({ path: path.join(outDir, "editor-motion-layer.png") });

		// ---------------------------------------- 3. tools in full screen
		const tools = () =>
			page.evaluate(() => {
				const desk = document.querySelector(".ed-center");
				const strip = desk?.querySelector("[data-desk-tools]");
				const reachable = (el) => {
					if (!el) return false;
					const rect = el.getBoundingClientRect();
					const hit = document.elementFromPoint(
						rect.left + rect.width / 2,
						rect.top + rect.height / 2,
					);
					return hit === el || el.contains(hit);
				};
				const crop = document.querySelectorAll("[data-crop-toggle]");
				const layer = document.querySelectorAll('button[aria-label="Add layer"][aria-haspopup="menu"]');
				return {
					native: document.fullscreenElement === desk,
					filled: Boolean(desk?.classList.contains("is-filled")),
					strip: Boolean(strip),
					cropCount: crop.length,
					cropOnDesk: Boolean(strip?.querySelector("[data-crop-toggle]")),
					cropReachable: reachable(crop[0]),
					cropActive: Boolean(crop[0]?.classList.contains("is-active")),
					cropHint: Boolean(strip?.querySelector("[data-crop-hint]")),
					// The layer list of the left bar has an "add" of its own.
					layerOnDesk: Boolean(strip?.querySelector('button[aria-label="Add layer"]')),
					layerReachable: reachable(strip?.querySelector('button[aria-label="Add layer"]')),
					layerButtons: layer.length,
					menuOnDesk: Boolean(desk?.querySelector(".menu__list")),
					menuReachable: reachable(desk?.querySelector(".menu__list .menu__item")),
				};
			});
		const layerCount = () =>
			page.evaluate(() => {
				const group = [...document.querySelectorAll(".ed-side .ed-group")].find(
					(section) => section.querySelector("h3")?.textContent?.trim() === "Layers",
				);
				return group?.querySelectorAll(".ed-list-item").length ?? -1;
			});

		const windowed = await tools();
		check(
			"editor: out of full screen the tools are in the toolbar only",
			!windowed.strip && windowed.cropCount === 1,
			JSON.stringify(windowed),
		);
		const layersBefore = await layerCount();

		await page.click("[data-desk-toggle]");
		await sleep(700);
		const full = await tools();
		check(
			"editor: in full screen the desk has the Layer and Crop tools",
			(full.native || full.filled) &&
				full.strip &&
				full.cropOnDesk &&
				full.layerOnDesk &&
				full.cropCount === 1,
			JSON.stringify(full),
		);
		check(
			"editor: both tools can be reached there",
			full.cropReachable && full.layerReachable,
			JSON.stringify({ crop: full.cropReachable, layer: full.layerReachable }),
		);

		await page.click('[data-desk-tools] button[aria-label="Add layer"]');
		await sleep(250);
		const menu = await tools();
		check(
			"editor: the layer menu opens on the full-screen desk",
			menu.menuOnDesk && menu.menuReachable,
			JSON.stringify({ onDesk: menu.menuOnDesk, reachable: menu.menuReachable }),
		);
		await page.screenshot({ path: path.join(outDir, "editor-desk-full-tools.png") });
		await page.evaluate(() => {
			[...document.querySelectorAll(".ed-center .menu__item")]
				.find((item) => item.textContent?.trim() === "Shape")
				?.click();
		});
		await sleep(400);

		await page.click("[data-desk-tools] [data-crop-toggle]");
		await sleep(300);
		const cropping = await tools();
		check(
			"editor: the crop tool turns on in full screen, with its hint and its Done",
			cropping.cropActive && cropping.cropHint && (cropping.native || cropping.filled),
			JSON.stringify(cropping),
		);
		await page.screenshot({ path: path.join(outDir, "editor-desk-full-crop.png") });
		await page.click("[data-desk-tools] [data-crop-toggle]");
		await sleep(200);

		await page.click("[data-desk-toggle]");
		await sleep(700);
		const back = await tools();
		const layersAfter = await layerCount();
		check(
			"editor: leaving full screen puts the tools back in the toolbar",
			!back.native && !back.filled && !back.strip && back.cropCount === 1,
			JSON.stringify(back),
		);
		check(
			"editor: the layer added in full screen is in the animation",
			layersBefore === 3 && layersAfter === 4,
			`${layersBefore} -> ${layersAfter}`,
		);
		await page.close();

		// Where a page may not have the browser's full screen, the desk fills
		// the panel instead, and Escape leaves it. With the crop tool on, the
		// first Escape belongs to the tool.
		const framed = await browser.newPage();
		await framed.setViewport({ width: 1600, height: 950 });
		watch(framed);
		await framed.evaluateOnNewDocument(() => {
			Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
		});
		await framed.goto(`${BASE}/bundles/notGT/dashboard/editor.html?standalone=1&lang=en`, {
			waitUntil: "networkidle2",
			timeout: 30_000,
		});
		await framed.waitForSelector("select.ed-out-select", { timeout: 15_000 });
		await framed.select("select.ed-out-select", FIXTURE);
		await sleep(900);
		const filledState = () =>
			framed.evaluate(() => ({
				filled: Boolean(document.querySelector(".ed-center")?.classList.contains("is-filled")),
				crop: Boolean(document.querySelector("[data-crop-toggle]")?.classList.contains("is-active")),
				onDesk: Boolean(document.querySelector("[data-desk-tools] [data-crop-toggle]")),
			}));
		await framed.click("[data-desk-toggle]");
		await sleep(400);
		await framed.click("[data-desk-tools] [data-crop-toggle]");
		await sleep(300);
		const filledCrop = await filledState();
		await framed.keyboard.press("Escape");
		await sleep(300);
		const afterFirst = await filledState();
		await framed.keyboard.press("Escape");
		await sleep(300);
		const afterSecond = await filledState();
		check(
			"editor: a desk that fills the panel has the tools too",
			filledCrop.filled && filledCrop.onDesk && filledCrop.crop,
			JSON.stringify(filledCrop),
		);
		check(
			"editor: Escape leaves the crop tool first and full screen second",
			afterFirst.filled && !afterFirst.crop && !afterSecond.filled,
			JSON.stringify({ afterFirst, afterSecond }),
		);
		await framed.close();

		check("no page/console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
	} finally {
		await browser.close();
		await removeFixtures();
	}

	console.log(
		`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`,
	);
	console.log(`screenshots: ${outDir}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("E2E ERROR:", error);
	process.exit(2);
});
