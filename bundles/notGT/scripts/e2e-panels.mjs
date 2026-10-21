#!/usr/bin/env node
/**
 * notGT dashboard panel smoke test.
 *
 * Loads every dashboard panel in NodeCG's `?standalone=1` mode (which injects
 * the NodeCG API + socket itself), asserts that the React app mounted, and
 * fails on any page/console error.
 *
 * Usage (server must already be running on 127.0.0.1:9090):
 *   node scripts/e2e-panels.mjs
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
	[
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
	].find((p) => fs.existsSync(p));

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
	);
	if (!ok) failures.push(name);
}

const PANELS = [
	{
		file: "control.html",
		expectText: ["Nothing is on air", "Data"],
		expectRu: ["В эфире ничего нет", "Данные"],
		heldToggle: true,
		excelData: true,
		listColumns: true,
		shot: "panel-control.png",
	},
	{
		file: "titles.html",
		expectText: ["Outs", "Animations"],
		expectRu: ["Анимации", "Новая анимация"],
		shot: "panel-titles.png",
	},
	{
		file: "editor.html",
		expectText: ["On the out", "Library"],
		expectRu: ["Библиотека", "Сохранить"],
		expectCanvas: true,
		clickPreview: true,
		outSwitch: true,
		dragAndCrop: true,
		layoutTools: true,
		shot: "panel-editor.png",
	},
	{
		file: "team.html",
		expectText: ["Team", "Groups"],
		expectRu: ["Команда", "Группы"],
		shot: "panel-team.png",
	},
];

async function main() {
	if (!CHROME) throw new Error("No Chromium binary found; set CHROME_PATH");
	fs.mkdirSync(outDir, { recursive: true });

	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
		],
	});

	try {
		for (const panel of PANELS) {
			const page = await browser.newPage();
			await page.setViewport({ width: 1600, height: 950 });
			const errors = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});

			await page.goto(
				// English is pinned: without `lang` a panel follows the browser's
				// language, which differs from machine to machine.
				`${BASE}/bundles/notGT/dashboard/${panel.file}?standalone=1&lang=en`,
				{ waitUntil: "networkidle2", timeout: 30_000 },
			);

			// React must mount something into the panel root.
			let mounted = false;
			for (let i = 0; i < 40; i++) {
				mounted = await page.evaluate(
					() =>
						(document.getElementById("notgt-root")?.childElementCount ?? 0) > 0,
				);
				if (mounted) break;
				await sleep(250);
			}
			check(`${panel.file}: React mounted`, mounted);
			await sleep(600);

			const bodyText = await page.evaluate(() => document.body.innerText ?? "");
			for (const needle of panel.expectText) {
				check(
					`${panel.file}: contains "${needle}"`,
					bodyText.includes(needle),
					bodyText.slice(0, 160).replace(/\n/g, " / "),
				);
			}

			if (panel.expectCanvas) {
				const canvases = await page.evaluate(
					() => document.querySelectorAll("canvas").length,
				);
				check(
					`${panel.file}: Konva canvas present`,
					canvases > 0,
					`${canvases} canvas`,
				);
			}

			const apiReady = await page.evaluate(
				() => typeof window.nodecg === "object" && window.nodecg !== null,
			);
			check(`${panel.file}: NodeCG API available`, apiReady);

			check(
				`${panel.file}: no page/console errors`,
				errors.length === 0,
				errors.slice(0, 3).join(" | "),
			);

			if (panel.expectRu) {
				// The same panel in Russian: `?lang=` picks the language for one
				// page view, without touching the saved choice.
				const ruPage = await browser.newPage();
				await ruPage.setViewport({ width: 1600, height: 950 });
				await ruPage.goto(
					`${BASE}/bundles/notGT/dashboard/${panel.file}?standalone=1&lang=ru`,
					{ waitUntil: "networkidle2", timeout: 30_000 },
				);
				await sleep(1200);
				const ruText = await ruPage.evaluate(
					() => document.body.innerText ?? "",
				);
				for (const needle of panel.expectRu) {
					check(
						`${panel.file}: in Russian contains "${needle}"`,
						ruText.includes(needle),
						ruText.slice(0, 120).replace(/\n/g, " / "),
					);
				}
				await ruPage.screenshot({
					path: path.join(outDir, panel.shot.replace(".png", "-ru.png")),
					fullPage: false,
				});
				await ruPage.close();
			}

			{
				// The light theme: `?theme=` picks it for one page view, and the
				// switch in the panel changes it and saves the choice.
				const themePage = await browser.newPage();
				await themePage.setViewport({ width: 1600, height: 950 });
				await themePage.goto(
					`${BASE}/bundles/notGT/dashboard/${panel.file}?standalone=1&lang=en&theme=light`,
					{ waitUntil: "networkidle2", timeout: 30_000 },
				);
				await sleep(800);
				const ground = () =>
					themePage.evaluate(() => ({
						theme: document.documentElement.dataset.theme,
						bg: getComputedStyle(document.body).backgroundColor,
						fg: getComputedStyle(document.body).color,
						saved: localStorage.getItem("notgt.theme"),
					}));
				const light = await ground();
				check(
					`${panel.file}: the light theme is Studio on Cream`,
					light.theme === "light" &&
						light.bg === "rgb(245, 236, 218)" &&
						light.fg === "rgb(12, 43, 37)",
					JSON.stringify(light),
				);
				await themePage.screenshot({
					path: path.join(outDir, panel.shot.replace(".png", "-light.png")),
					fullPage: false,
				});
				await themePage.click('button[aria-label="Interface theme"]');
				await sleep(200);
				await themePage.evaluate(() => {
					const item = [...document.querySelectorAll(".menu__item")].find(
						(node) => node.textContent?.trim() === "Dark",
					);
					item?.click();
				});
				await sleep(300);
				const dark = await ground();
				check(
					`${panel.file}: the theme switch turns it to Cream on Studio and saves the choice`,
					dark.theme === "dark" &&
						dark.bg === "rgb(12, 43, 37)" &&
						dark.fg === "rgb(245, 236, 218)" &&
						dark.saved === "dark",
					JSON.stringify(dark),
				);
				await themePage.evaluate(() => localStorage.removeItem("notgt.theme"));
				await themePage.close();
			}

			if (panel.clickPreview) {
				await fetch(`${BASE}/api/titles/hide`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				await sleep(300);

				const readState = async () =>
					await (await fetch(`${BASE}/api/state`)).json();
				const before = await readState();

				const clicked = await page.evaluate(() => {
					const target = [...document.querySelectorAll("button")].find(
						(button) => /^\s*play\s*$/i.test(button.textContent ?? ""),
					);
					if (!target) return false;
					target.click();
					return true;
				});
				check("editor.html: Preview button present", clicked);

				// Preview can legitimately take two paths: if the animation is placed
				// on the out, the scheduler plays that placement (runtime.revision
				// moves); otherwise it falls back to a timed manual show
				// (activeVisible becomes true). Accept either effect.
				let after = before;
				let reacted = false;
				for (let i = 0; i < 20 && !reacted; i++) {
					await sleep(150);
					after = await readState();
					reacted =
						Boolean(after.activeVisible) !== Boolean(before.activeVisible) ||
						(after.revision ?? 0) !== (before.revision ?? 0);
				}
				check(
					"editor.html: Preview reaches the extension (state changed)",
					reacted,
					`activeVisible ${before.activeVisible}->${after.activeVisible}, rev ${before.revision}->${after.revision}`,
				);
				await fetch(`${BASE}/api/titles/hide`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
			}

			if (panel.outSwitch) {
				// The canvas must BE the selected out: switching `Out:` has to change
				// what is drawn. This is the exact regression the operator reported.
				const fixture = "e2e-switch";
				await fetch(`${BASE}/api/outs/${fixture}`, { method: "DELETE" });
				await fetch(`${BASE}/api/outs`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: fixture,
						name: "E2E Switch",
						width: 1280,
						height: 720,
					}),
				});
				await fetch(`${BASE}/api/outs/${fixture}/items`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ templateId: "code-sample" }),
				});

				await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
				await page.waitForSelector("select.ed-out-select", { timeout: 15_000 });
				await sleep(800);

				const options = await page.$$eval(
					"select.ed-out-select option",
					(els) => els.map((el) => (el.textContent ?? "").trim()),
				);
				check(
					'editor.html: Out selector offers outs and no "все out\'ы"',
					options.length >= 2 && !options.some((o) => /все out/i.test(o)),
					JSON.stringify(options),
				);

				const readCanvas = () =>
					page.evaluate(() => {
						const canvas = document.querySelector("canvas");
						const data = canvas ? canvas.toDataURL() : "";
						let hash = 0;
						for (let i = 0; i < data.length; i++) {
							hash = (hash * 31 + data.charCodeAt(i)) | 0;
						}
						// The toolbar renders the label and the value in separate
						// elements, so collapse the whole text and slice from "Out:".
						const text = (document.body.innerText ?? "").replace(/\s+/g, " ");
						const at = text.indexOf("Out:");
						const status = at >= 0 ? text.slice(at, at + 140) : "";
						return { hash, status };
					});

				await page.select("select.ed-out-select", "main");
				await sleep(900);
				const beforeSwitch = await readCanvas();

				await page.select("select.ed-out-select", fixture);
				await sleep(900);
				const afterSwitch = await readCanvas();

				check(
					"editor.html: switching Out actually changes the canvas",
					beforeSwitch.hash !== afterSwitch.hash,
					`main=${beforeSwitch.hash} switch=${afterSwitch.hash}`,
				);
				check(
					"editor.html: canvas reports the newly selected out",
					/E2E Switch/.test(afterSwitch.status) &&
						afterSwitch.status !== beforeSwitch.status,
					`"${beforeSwitch.status}" -> "${afterSwitch.status}"`,
				);
				await page.screenshot({
					path: path.join(outDir, "editor-out-switch.png"),
					fullPage: false,
				});
				await fetch(`${BASE}/api/outs/${fixture}`, { method: "DELETE" });
			}

			if (panel.dragAndCrop) {
				// Dragging a placement must show where it goes *while* the mouse is
				// down — the live code preview is a DOM iframe under the canvas, so
				// it only follows if the drag publishes an offset instead of moving
				// a Konva node. The crop tool then has to write a real window onto
				// the placement, and the magnets have to measure that window rather
				// than the template box around it.
				//
				// The fixture lives on its own out: the seeded placements on `main`
				// would add their own snap lines and make the numbers unpredictable.
				const templateId = "e2e-drag-tpl";
				const fixtureOut = "e2e-drag-out";
				const box = { width: 800, height: 450 };
				const crop = { x: 400, y: 225, width: 400, height: 225 };
				const scale = 0.5;
				await fetch(`${BASE}/api/outs/${fixtureOut}`, { method: "DELETE" });
				await fetch(`${BASE}/api/templates/${templateId}`, {
					method: "DELETE",
				});
				await fetch(`${BASE}/api/templates`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: templateId,
						name: "E2E Drag",
						kind: "code",
						width: box.width,
						height: box.height,
						code: {
							html: "<div class='box'>drag me</div>",
							css: ".box{position:absolute;inset:0;background:#2b8cff;color:#fff;font:24px sans-serif}",
							js: "",
						},
					}),
				});
				await fetch(`${BASE}/api/outs`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: fixtureOut,
						name: "E2E Drag Out",
						width: 1920,
						height: 1080,
					}),
				});
				const created = await (
					await fetch(`${BASE}/api/outs/${fixtureOut}/items`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ templateId, x: 10, y: 10, scale, crop }),
					})
				).json();
				const itemId = created.item.id;

				// A reload is the cheapest way to see an out created a moment ago.
				await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
				await page.waitForSelector("select.ed-out-select", { timeout: 15_000 });
				await page.select("select.ed-out-select", fixtureOut);
				await sleep(900);

				const stage = await page.evaluate(() => {
					const el = document.querySelector(".konvajs-content");
					if (!el) return null;
					const r = el.getBoundingClientRect();
					return { x: r.x, y: r.y, w: r.width, h: r.height };
				});
				check(
					"editor.html: the canvas stage has a box",
					Boolean(stage && stage.w > 0),
				);

				const readItem = async () => {
					const outs = await (await fetch(`${BASE}/api/outs`)).json();
					const out = outs.outs.find((o) => o.id === fixtureOut);
					return out?.items.find((i) => i.id === itemId) ?? null;
				};
				/** Where the placement's *visible window* sits on the page, in page px. */
				const windowOnPage = async () => {
					const item = await readItem();
					const c = item?.bounds ?? item?.crop ?? {
						x: 0,
						y: 0,
						width: box.width,
						height: box.height,
					};
					const s = item?.scale ?? 1;
					const x = item?.x ?? 0;
					const y = item?.y ?? 0;
					return {
						left: stage.x + (x / 100 + (c.x * s) / 1920) * stage.w,
						top: stage.y + (y / 100 + (c.y * s) / 1080) * stage.h,
						right: stage.x + (x / 100 + ((c.x + c.width) * s) / 1920) * stage.w,
						bottom:
							stage.y + (y / 100 + ((c.y + c.height) * s) / 1080) * stage.h,
					};
				};

				const first = await windowOnPage();
				const centerX = (first.left + first.right) / 2;
				const centerY = (first.top + first.bottom) / 2;

				// Select it in the list rather than by clicking the canvas: the list
				// is what the operator uses, and the point under the cursor is not
				// always the placement's.
				const selected = await page.evaluate((name) => {
					const rows = [...document.querySelectorAll(".ed-list-item")];
					const row = rows.find(
						(el) =>
							(el.querySelector(".ed-list-item__name")?.textContent ?? "") ===
							name,
					);
					if (!row) return false;
					row.click();
					return true;
				}, "E2E Drag");
				check(
					"editor.html: the placement can be selected in the list",
					selected,
				);
				await sleep(400);
				const cropEnabled = await page.$eval(
					"button[data-crop-toggle]",
					(el) => !el.disabled,
				);
				check(
					"editor.html: selecting a placement enables its tools",
					cropEnabled,
				);

				// The live preview of *this* animation: a code placement is an iframe
				// in the DOM overlay, identified by its template name.
				const overlayBox = () =>
					page.evaluate((name) => {
						const boxes = [
							...document.querySelectorAll(".ed-code-overlay__box"),
						];
						const found = boxes.find((el) =>
							el
								.querySelector("iframe")
								?.getAttribute("title")
								?.startsWith(name),
						);
						return found ? `${found.style.left}|${found.style.top}` : null;
					}, "E2E Drag");
				const statusText = () =>
					page.evaluate(() =>
						(
							document.querySelector(".ed-canvas-status")?.textContent ?? ""
						).replace(/\s+/g, " "),
					);

				// --- the magnets measure the visible window, not the template box ---
				// The window's centre is 300 out px right of the placement's x, so
				// dragging it to the middle of the out must land x exactly on
				// (960 - 300)/1920. Snapping the *box* instead would put x at 34.53 %,
				// i.e. line up a part of the template that is not on screen at all.
				const fit = stage.w / 1920;
				const startX = (await readItem()).x;
				const windowCentre =
					(startX / 100) * 1920 + (crop.x + crop.width / 2) * scale;
				const wanted = ((960 - (crop.x + crop.width / 2) * scale) / 1920) * 100;
				const shift = (960 + 4 - windowCentre) * fit;
				await page.mouse.move(centerX, centerY);
				await page.mouse.down();
				await page.mouse.move(centerX + shift, centerY, { steps: 12 });
				const overlayDuring = await overlayBox();
				const duringStatus = await statusText();
				await page.mouse.up();
				await sleep(500);
				const snapped = await readItem();
				check(
					"editor.html: the code preview follows the drag before the mouse is released",
					Boolean(overlayDuring) &&
						overlayDuring !==
							`${first.left - stage.x}px|${first.top - stage.y}px`,
					String(overlayDuring),
				);
				check(
					"editor.html: the canvas reports the drag while it is in flight",
					/dragging/.test(duringStatus),
					duringStatus,
				);
				check(
					"editor.html: magnets snap the cropped window, not the template box",
					Math.abs((snapped?.x ?? 0) - wanted) < 0.011 &&
						(snapped?.y ?? 0) === 10,
					`x ${snapped?.x} (want ${wanted.toFixed(2)}), y ${snapped?.y}`,
				);

				// --- the size handle sticks to the same lines ------------------------
				// A resize has one degree of freedom, so dragging the corner until
				// the window's right edge is a few px past the middle of the out has
				// to land the scale exactly on (960 - left) / width, not on wherever
				// the pointer happened to stop.
				const sized = await readItem();
				const sizedWindow = await windowOnPage();
				const leftOut = (sized.x / 100) * 1920 + crop.x * sized.scale;
				const wantedScale = (960 - leftOut) / crop.width;
				await page.mouse.move(sizedWindow.right - 6, sizedWindow.bottom - 6);
				await page.mouse.down();
				await page.mouse.move(
					stage.x + ((960 + 4) / 1920) * stage.w,
					sizedWindow.bottom - 6,
					{ steps: 12 },
				);
				await page.mouse.up();
				await sleep(500);
				const resized = await readItem();
				check(
					"editor.html: the size handle snaps the window's edge to the out's centre",
					Math.abs((resized?.scale ?? 0) - wantedScale) < 0.0006,
					`scale ${resized?.scale} (want ${wantedScale.toFixed(4)}, was ${sized.scale})`,
				);
				// Back to the placement the crop checks below were written for.
				await fetch(`${BASE}/api/outs/${fixtureOut}/items/${itemId}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ x: sized.x, y: sized.y, scale: sized.scale }),
				});
				await sleep(500);

				// --- the crop tool -------------------------------------------------
				await page.click("button[data-crop-toggle]");
				await sleep(200);
				const toolOn = await page.$eval("button[data-crop-toggle]", (el) =>
					el.classList.contains("is-active"),
				);
				check("editor.html: the crop tool turns on", toolOn);

				const second = await windowOnPage();
				// The handles are centred on the window's corners, so the corner
				// itself is the middle of the bottom-right one.
				await page.mouse.move(second.right, second.bottom);
				await page.mouse.down();
				await page.mouse.move(second.right - 60, second.bottom - 40, {
					steps: 10,
				});
				await page.mouse.up();
				await sleep(500);
				const croppedItem = await readItem();
				check(
					"editor.html: the crop frame writes a visible window to the placement",
					Boolean(croppedItem?.crop) &&
						croppedItem.crop.width < crop.width &&
						croppedItem.crop.height < crop.height &&
						croppedItem.crop.x === crop.x &&
						croppedItem.crop.y === crop.y,
					JSON.stringify(croppedItem?.crop),
				);

				const cropInfo = await page.evaluate(
					() => document.querySelector("[data-crop-info]")?.textContent ?? "",
				);
				check(
					"editor.html: the inspector shows the crop",
					/\d+×\d+/.test(cropInfo),
					cropInfo,
				);
				await page.screenshot({
					path: path.join(outDir, "editor-crop.png"),
					fullPage: false,
				});

				// --- Scale Bounds ---------------------------------------------------
				// It takes over from the crop tool. Pulling a corner past the design
				// box grows the box the animation is rendered in; the animation keeps
				// its scale and the opposite corner stays where it was.
				await page.click("button[data-bounds-toggle]");
				await sleep(200);
				const boundsOn = await page.evaluate(() => ({
					bounds: document
						.querySelector("button[data-bounds-toggle]")
						.classList.contains("is-active"),
					crop: document
						.querySelector("button[data-crop-toggle]")
						.classList.contains("is-active"),
				}));
				check(
					"editor.html: Scale Bounds takes over from the crop tool",
					boundsOn.bounds && !boundsOn.crop,
					JSON.stringify(boundsOn),
				);
				const before = await windowOnPage();
				const scaleBefore = croppedItem?.scale ?? 1;
				const pullX = box.width * 0.6;
				const pullY = box.height * 0.6;
				await page.mouse.move(before.right, before.bottom);
				await page.mouse.down();
				await page.mouse.move(
					before.right + (pullX * scaleBefore * stage.w) / 1920,
					before.bottom + (pullY * scaleBefore * stage.h) / 1080,
					{ steps: 10 },
				);
				await page.mouse.up();
				await sleep(500);
				const boundedItem = await readItem();
				const after = await windowOnPage();
				const b = boundedItem?.bounds;
				check(
					"editor.html: Scale Bounds grows the box past the design box, not the animation",
					Boolean(b) &&
						!boundedItem.crop &&
						(boundedItem.scale ?? 1) === scaleBefore &&
						b.x + b.width > box.width &&
						b.y + b.height > box.height &&
						Math.abs(after.left - before.left) < 1 &&
						Math.abs(after.top - before.top) < 1,
					JSON.stringify({ bounds: b, crop: boundedItem?.crop, scale: boundedItem?.scale }),
				);
				const boundsInfo = await page.evaluate(
					() => document.querySelector("[data-bounds-info]")?.textContent ?? "",
				);
				check(
					"editor.html: the inspector shows the scaled bounds",
					/\d+×\d+/.test(boundsInfo),
					boundsInfo,
				);
				await page.screenshot({
					path: path.join(outDir, "editor-bounds.png"),
					fullPage: false,
				});

				await page.click("button[data-bounds-toggle]");
				await fetch(`${BASE}/api/outs/${fixtureOut}`, { method: "DELETE" });
				await fetch(`${BASE}/api/templates/${templateId}`, {
					method: "DELETE",
				});
			}

			if (panel.layoutTools) {
				// The bars are dragged by their inner edges, and the desk takes
				// what they give up.
				const sizes = () =>
					page.evaluate(() => {
						const width = (selector) =>
							Math.round(document.querySelector(selector).getBoundingClientRect().width);
						return {
							left: width(".ed-side"),
							right: width(".ed-side--right"),
							desk: width(".ed-center"),
							saved: localStorage.getItem("notgt.editor.layout") ?? "",
						};
					});
				const grab = async (edge) => {
					const box = await (await page.$(`[data-split="${edge}"]`)).boundingBox();
					return { x: box.x + box.width / 2, y: box.y + 240 };
				};
				const dragEdge = async (edge, dx) => {
					const at = await grab(edge);
					await page.mouse.move(at.x, at.y);
					await page.mouse.down();
					await page.mouse.move(at.x + dx, at.y, { steps: 6 });
					await page.mouse.up();
					await sleep(250);
				};
				const resetEdge = async (edge) => {
					const at = await grab(edge);
					await page.mouse.click(at.x, at.y);
					await page.mouse.click(at.x, at.y);
					await sleep(250);
				};

				const before = await sizes();
				await dragEdge("left", 90);
				const wider = await sizes();
				check(
					"editor.html: dragging the left bar's edge widens it and the desk gives way",
					wider.left === before.left + 90 &&
						wider.desk === before.desk - 90 &&
						wider.saved.includes('"left"'),
					JSON.stringify({ before, wider }),
				);
				await dragEdge("right", -70);
				const both = await sizes();
				check(
					"editor.html: dragging the right bar's edge widens it",
					both.right === before.right + 70 && both.desk === wider.desk - 70,
					JSON.stringify(both),
				);
				await resetEdge("left");
				await resetEdge("right");
				const reset = await sizes();
				check(
					"editor.html: a double click gives a bar its own width back",
					reset.left === before.left && reset.right === before.right && reset.desk === before.desk,
					JSON.stringify(reset),
				);

				// Full screen: the desk alone, with the canvas still on it.
				const desk = () =>
					page.evaluate(() => {
						const element = document.querySelector(".ed-center");
						const rect = element.getBoundingClientRect();
						return {
							native: document.fullscreenElement === element,
							filled: element.classList.contains("is-filled"),
							covers:
								Math.round(rect.width) === window.innerWidth &&
								Math.round(rect.height) === window.innerHeight,
							canvas: Boolean(element.querySelector("canvas")),
						};
					});
				await page.click("[data-desk-toggle]");
				await sleep(700);
				const full = await desk();
				check(
					"editor.html: the full-screen button gives the desk the whole screen",
					(full.native || full.filled) && full.covers && full.canvas,
					JSON.stringify(full),
				);
				await page.screenshot({
					path: path.join(outDir, "editor-desk-full.png"),
					fullPage: false,
				});
				await page.click("[data-desk-toggle]");
				await sleep(700);
				const windowed = await desk();
				const after = await sizes();
				check(
					"editor.html: the same button brings the bars back",
					!windowed.native && !windowed.filled && after.desk === before.desk,
					JSON.stringify({ windowed, after }),
				);
			}

			if (panel.listColumns) {
				// “Turn into a list” makes a list of plain values; a column added to
				// it makes a table, and the values keep a column of their own.
				const DATA = `${BASE}/api/data`;
				const stored = async (name) =>
					(await (await fetch(`${DATA}?path=${name}&raw=1`)).json()).value;
				const form = (name) => `.vlist[data-path="${name}"] [data-add-column="${name}"]`;
				const open = async (name) => {
					await page.click(`.vlist[data-path="${name}"] [data-add-column-toggle]`);
					await page.waitForSelector(form(name), { timeout: 5_000 });
				};
				const fill = async (selector, text) => {
					await page.focus(selector);
					await page.$eval(selector, (input) => input.select());
					await page.keyboard.type(text);
				};
				const refusal = () =>
					page.evaluate((selector) => {
						const root = document.querySelector(selector);
						return {
							error: root?.querySelector(".err")?.textContent ?? "",
							disabled: Boolean(root?.querySelector('button[type="submit"]')?.disabled),
						};
					}, form("Panel_Cols"));

				await fetch(DATA, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ Panel_Cols: ["Anna Reed", "Peter Holt"], Panel_Blank: [""] }),
				});
				await sleep(700);

				await open("Panel_Cols");
				const nameInput = `${form("Panel_Cols")} [data-column-name]`;
				const valueInput = `${form("Panel_Cols")} [data-value-column]`;
				const askedForValues = Boolean(await page.$(valueInput));
				await fill(valueInput, "Name");
				await fill(nameInput, "Role");
				await page.keyboard.press("Enter");
				await sleep(700);
				const table = await stored("Panel_Cols");
				check(
					"control.html: a column added to a list of plain values makes a table that keeps the values",
					askedForValues &&
						JSON.stringify(table) ===
							JSON.stringify([
								{ Name: "Anna Reed", Role: "" },
								{ Name: "Peter Holt", Role: "" },
							]),
					JSON.stringify({ askedForValues, table }),
				);
				const shown = await page.evaluate(() => ({
					head: [
						...document.querySelectorAll('.vlist[data-path="Panel_Cols"] .vlist__row--head .mono'),
					].map((cell) => cell.textContent),
					role: document.querySelectorAll('input[data-array="Panel_Cols"][data-leaf="Role"]').length,
				}));
				check(
					"control.html: the new column is shown as a column of the list",
					shown.head.join("|") === "Name|Role" && shown.role === 2,
					JSON.stringify(shown),
				);

				// The form stays for the next column and refuses names that cannot be one.
				await fill(nameInput, "Role");
				const duplicate = await refusal();
				await fill(nameInput, "a.b");
				const dotted = await refusal();
				check(
					"control.html: a column that exists, or a name with a dot, is refused",
					duplicate.error !== "" && duplicate.disabled && dotted.error !== "" && dotted.disabled,
					JSON.stringify({ duplicate, dotted }),
				);
				await fill(nameInput, "City");
				await page.keyboard.press("Enter");
				await sleep(700);
				const wider = await stored("Panel_Cols");
				await page.screenshot({
					path: path.join(outDir, "control-list-columns.png"),
					fullPage: false,
				});
				await page.keyboard.press("Escape");
				await sleep(200);
				const closed = !(await page.$(form("Panel_Cols")));
				check(
					"control.html: a second column goes into every row, and Escape closes the form",
					Array.isArray(wider) &&
						wider.every((entry) => entry.City === "" && entry.Role === "") &&
						closed,
					JSON.stringify({ wider, closed }),
				);

				// A list of empty values has nothing to keep: it just gets the column.
				await open("Panel_Blank");
				const blankAsked = Boolean(await page.$(`${form("Panel_Blank")} [data-value-column]`));
				await fill(`${form("Panel_Blank")} [data-column-name]`, "Name");
				await page.keyboard.press("Enter");
				await sleep(700);
				const blank = await stored("Panel_Blank");
				check(
					"control.html: a list of empty values just gets the column",
					!blankAsked && JSON.stringify(blank) === JSON.stringify([{ Name: "" }]),
					JSON.stringify({ blankAsked, blank }),
				);

				for (const name of ["Panel_Cols", "Panel_Blank"]) {
					await fetch(`${DATA}/${name}`, { method: "DELETE" });
				}
				await sleep(400);
			}

			if (panel.excelData) {
				// An Excel workbook as a data source: chosen in the form, then
				// dropped on the panel; its sheet is a list like any other, and an
				// edit of the list goes back into the workbook.
				const { createRequire } = await import("node:module");
				const ExcelJS = createRequire(import.meta.url)("exceljs");
				const SOURCES = `${BASE}/bundles/notGT/sources`;
				const workbook = (rows) => {
					const book = new ExcelJS.Workbook();
					book.addWorksheet("Panel Guests").addRows([["Name", "Role"], ...rows]);
					return book;
				};
				const file = path.join(outDir, "e2e-panel.xlsx");
				await workbook([
					["Anna Reed", "Expert"],
					["Peter Holt", "Studio guest"],
				]).xlsx.writeFile(file);

				const state = () =>
					page.evaluate(() => {
						const source = document.querySelector('[data-source="e2e-panel.xlsx"]');
						return {
							source: source?.textContent ?? "",
							mode: source?.getAttribute("data-source-mode") ?? "",
							tag: Boolean(
								document.querySelector('.vlist[data-path="Panel_Guests"] [data-excel-tag]'),
							),
							cells: [...document.querySelectorAll('input[data-array="Panel_Guests"]')]
								.filter((input) => input.type !== "radio")
								.map((input) => input.value),
							error: document.querySelector("[data-excel-error]")?.textContent ?? "",
						};
					});

				await page.click("[data-excel-toggle]");
				await sleep(200);
				await (await page.$("input[data-excel-file]")).uploadFile(file);
				await sleep(1500);
				const loaded = await state();
				check(
					"control.html: a workbook chosen in the Excel form becomes a list, marked as Excel",
					loaded.mode === "load" &&
						loaded.source.includes("Panel_Guests") &&
						loaded.tag &&
						loaded.cells.join("|") === "Anna Reed|Expert|Peter Holt|Studio guest",
					JSON.stringify(loaded),
				);
				await page.screenshot({
					path: path.join(outDir, "control-excel.png"),
					fullPage: false,
				});

				// Edit a cell the way an operator does.
				const cell = 'input[data-array="Panel_Guests"][data-index="1"][data-leaf="Role"]';
				await page.focus(cell);
				await page.$eval(cell, (input) => input.select());
				await page.keyboard.type("Host");
				// A cell that has the focus keeps what is being typed in it.
				await page.$eval(cell, (input) => input.blur());
				await sleep(1800);
				const listed = (await (await fetch(`${SOURCES}/`)).json()).sources ?? [];
				const sourceId = listed.find((entry) => entry.name === "e2e-panel.xlsx")?.id;
				const saved = new ExcelJS.Workbook();
				await saved.xlsx.load(
					Buffer.from(await (await fetch(`${SOURCES}/${sourceId}/download`)).arrayBuffer()),
				);
				check(
					"control.html: an edit of that list is written into the workbook",
					saved.getWorksheet("Panel Guests").getCell("B3").value === "Host",
					String(saved.getWorksheet("Panel Guests").getCell("B3").value),
				);

				// Dropping a file on the panel is the load mode too.
				const second = await workbook([
					["Maria Kim", "Analyst"],
					["Ivan Petrov", "Reporter"],
					["Olga Berg", "Producer"],
				]).xlsx.writeBuffer();
				const drop = (name, base64) =>
					page.evaluate(
						(name, base64) => {
							const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
							const transfer = new DataTransfer();
							transfer.items.add(new File([bytes], name));
							const target = document.querySelector(".ctl-data");
							for (const type of ["dragover", "drop"]) {
								target.dispatchEvent(
									new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
								);
							}
						},
						name,
						base64,
					);
				await drop("e2e-panel.xlsx", Buffer.from(second).toString("base64"));
				await sleep(1500);
				const afterDrop = await state();
				check(
					"control.html: a workbook dropped on the Data panel is loaded",
					afterDrop.cells.join("|") ===
						"Maria Kim|Analyst|Ivan Petrov|Reporter|Olga Berg|Producer",
					JSON.stringify(afterDrop),
				);
				await drop("e2e-notes.txt", Buffer.from("not a workbook").toString("base64"));
				await sleep(800);
				const refused = await state();
				check(
					"control.html: a dropped file that is not a workbook is explained, not swallowed",
					refused.error.includes(".xlsx"),
					JSON.stringify(refused.error),
				);

				await fetch(`${SOURCES}/${sourceId}`, { method: "DELETE" });
				await fetch(`${BASE}/api/data/Panel_Guests`, { method: "DELETE" });
				await sleep(400);
			}

			if (panel.heldToggle) {
				// The "показать" switch must put the placement on air and KEEP it
				// there (and take it off again), not just flip `enabled`.
				const created = await (
					await fetch(`${BASE}/api/outs/main/items`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							templateId: "code-sample",
							held: false,
							playback: {
								mode: "once",
								intervalMs: 10000,
								holdMs: 300,
								autoStart: false,
							},
						}),
					})
				).json();
				const itemId = created.item.id;

				await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
				await sleep(900);

				const switchSelector = `label.ctl-switch[data-out="main"][data-item="${itemId}"] input`;
				await page.waitForSelector(switchSelector, { timeout: 15_000 });

				const snapshot = async () => {
					const outs = await (await fetch(`${BASE}/api/outs`)).json();
					const out = outs.outs.find((o) => o.id === "main");
					const item = out?.items.find((i) => i.id === itemId);
					const state = await (await fetch(`${BASE}/api/state`)).json();
					return {
						held: Boolean(item?.held),
						enabled: Boolean(item?.enabled),
						playing: (state.playing?.main ?? []).includes(itemId),
					};
				};

				const off = await snapshot();
				check(
					"control.html: toggle starts off",
					!off.held && !off.playing,
					JSON.stringify(off),
				);

				await page.click(switchSelector);
				await sleep(400);
				const on = await snapshot();
				check(
					"control.html: toggle puts the placement on air and keeps it",
					on.held && on.playing && on.enabled,
					JSON.stringify(on),
				);

				await sleep(1400); // beyond the 300 ms holdMs
				const still = await snapshot();
				check(
					"control.html: held placement is still on air after holdMs",
					still.playing,
					JSON.stringify(still),
				);
				await page.screenshot({
					path: path.join(outDir, "control-held-on.png"),
					fullPage: false,
				});

				await page.click(switchSelector);
				await sleep(400);
				const back = await snapshot();
				check(
					"control.html: toggle takes it off air again",
					!back.held && !back.playing,
					JSON.stringify(back),
				);

				await fetch(`${BASE}/api/outs/main/items/${itemId}`, {
					method: "DELETE",
				});
			}

			await page.screenshot({
				path: path.join(outDir, panel.shot),
				fullPage: false,
			});
			await page.close();
		}
	} finally {
		await browser.close();
	}

	console.log(
		`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`,
	);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("E2E ERROR:", error);
	process.exit(2);
});
