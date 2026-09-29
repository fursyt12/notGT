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
	["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		(p) => fs.existsSync(p),
	);

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

const PANELS = [
	{
		file: "control.html",
		expectText: ["notGT — Control", "Данные (переменные)"],
		heldToggle: true,
		shot: "panel-control.png",
	},
	{
		file: "titles.html",
		expectText: ["Анимации / шаблоны", "Out'ы"],
		shot: "panel-titles.png",
	},
	{
		file: "editor.html",
		expectText: ["Editor"],
		expectCanvas: true,
		clickPreview: true,
		outSwitch: true,
		dragAndCrop: true,
		shot: "panel-editor.png",
	},
];

async function main() {
	if (!CHROME) throw new Error("No Chromium binary found; set CHROME_PATH");
	fs.mkdirSync(outDir, { recursive: true });

	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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
				`${BASE}/bundles/notGT/dashboard/${panel.file}?standalone=1`,
				{ waitUntil: "networkidle2", timeout: 30_000 },
			);

			// React must mount something into the panel root.
			let mounted = false;
			for (let i = 0; i < 40; i++) {
				mounted = await page.evaluate(
					() => (document.getElementById("notgt-root")?.childElementCount ?? 0) > 0,
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
				check(`${panel.file}: Konva canvas present`, canvases > 0, `${canvases} canvas`);
			}

			const apiReady = await page.evaluate(
				() => typeof (window).nodecg === "object" && (window).nodecg !== null,
			);
			check(`${panel.file}: NodeCG API available`, apiReady);

			check(
				`${panel.file}: no page/console errors`,
				errors.length === 0,
				errors.slice(0, 3).join(" | "),
			);

			if (panel.clickPreview) {
				await fetch(`${BASE}/api/titles/hide`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				await sleep(300);

				const readState = async () => await (await fetch(`${BASE}/api/state`)).json();
				const before = await readState();

				const clicked = await page.evaluate(() => {
					const target = [...document.querySelectorAll("button")].find((button) =>
						/preview|проиграть/i.test(button.textContent ?? ""),
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

				const options = await page.$$eval("select.ed-out-select option", (els) =>
					els.map((el) => (el.textContent ?? "").trim()),
				);
				check(
					"editor.html: Out selector offers outs and no \"все out'ы\"",
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
					/E2E Switch/.test(afterSwitch.status) && afterSwitch.status !== beforeSwitch.status,
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
				// the placement.
				const templateId = "e2e-drag-tpl";
				const fixtureOut = "main";
				await fetch(`${BASE}/api/templates/${templateId}`, { method: "DELETE" });
				await fetch(`${BASE}/api/templates`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: templateId,
						name: "E2E Drag",
						kind: "code",
						width: 800,
						height: 450,
						code: {
							html: "<div class='box'>drag me</div>",
							css: ".box{position:absolute;inset:0;background:#2b8cff;color:#fff;font:24px sans-serif}",
							js: "",
						},
					}),
				});
				const created = await (
					await fetch(`${BASE}/api/outs/${fixtureOut}/items`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ templateId, x: 20, y: 20, scale: 0.5 }),
					})
				).json();
				const itemId = created.item.id;

				await page.select("select.ed-out-select", fixtureOut);
				await sleep(900);

				const stage = await page.evaluate(() => {
					const el = document.querySelector(".konvajs-content");
					if (!el) return null;
					const r = el.getBoundingClientRect();
					return { x: r.x, y: r.y, w: r.width, h: r.height };
				});
				check("editor.html: the canvas stage has a box", Boolean(stage && stage.w > 0));

				const readItem = async () => {
					const outs = await (await fetch(`${BASE}/api/outs`)).json();
					const out = outs.outs.find((o) => o.id === fixtureOut);
					return out?.items.find((i) => i.id === itemId) ?? null;
				};
				// Where the placement's visible window sits on the page, in page px:
				// x/y are percent of the out, the window is the template box scaled.
				const windowOnPage = async () => {
					const item = await readItem();
					const w = (800 * (item?.scale ?? 1)) / 1920;
					const h = (450 * (item?.scale ?? 1)) / 1080;
					return {
						left: stage.x + ((item?.x ?? 0) / 100) * stage.w,
						top: stage.y + ((item?.y ?? 0) / 100) * stage.h,
						right: stage.x + ((item?.x ?? 0) / 100 + w) * stage.w,
						bottom: stage.y + ((item?.y ?? 0) / 100 + h) * stage.h,
					};
				};

				const first = await windowOnPage();
				const centerX = (first.left + first.right) / 2;
				const centerY = (first.top + first.bottom) / 2;

				// Select it in the list rather than by clicking the canvas: other
				// placements on `main` may sit under the same point, and the list is
				// what the operator uses anyway.
				const selected = await page.evaluate((name) => {
					const rows = [...document.querySelectorAll(".ed-list-item")];
					const row = rows.find(
						(el) => (el.querySelector(".ed-list-item__name")?.textContent ?? "") === name,
					);
					if (!row) return false;
					row.click();
					return true;
				}, "E2E Drag");
				check("editor.html: the placement can be selected in the list", selected);
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
						const boxes = [...document.querySelectorAll(".ed-code-overlay__box")];
						const box = boxes.find(
							(el) => el.querySelector("iframe")?.getAttribute("title")?.startsWith(name),
						);
						return box ? `${box.style.left}|${box.style.top}` : null;
					}, "E2E Drag");
				const statusText = () =>
					page.evaluate(() =>
						(document.querySelector(".ed-canvas-status")?.textContent ?? "").replace(
							/\s+/g,
							" ",
						),
					);

				const overlayBefore = await overlayBox();
				await page.mouse.move(centerX, centerY);
				await page.mouse.down();
				await page.mouse.move(centerX + 70, centerY + 45, { steps: 10 });
				const overlayDuring = await overlayBox();
				const duringStatus = await statusText();
				await page.mouse.up();
				await sleep(500);
				const movedItem = await readItem();
				check(
					"editor.html: the code preview follows the drag before the mouse is released",
					Boolean(overlayBefore) && overlayBefore !== overlayDuring,
					`${overlayBefore} -> ${overlayDuring}`,
				);
				check(
					"editor.html: the canvas reports the drag while it is in flight",
					/перетаскивание/.test(duringStatus),
					duringStatus,
				);
				check(
					"editor.html: the drag is saved on release",
					(movedItem?.x ?? 0) > 20 && (movedItem?.y ?? 0) > 20,
					JSON.stringify({ x: movedItem?.x, y: movedItem?.y }),
				);

				await page.click("button[data-crop-toggle]");
				await sleep(200);
				const toolOn = await page.$eval("button[data-crop-toggle]", (el) =>
					el.classList.contains("is-active"),
				);
				check("editor.html: the crop tool turns on", toolOn);

				const second = await windowOnPage();
				// The handles are centred on the window's corners, so the corner
				// itself is the middle of the bottom-right one.
				const handleX = second.right;
				const handleY = second.bottom;
				await page.mouse.move(handleX, handleY);
				await page.mouse.down();
				await page.mouse.move(handleX - 130, handleY - 70, { steps: 10 });
				await page.mouse.up();
				await sleep(500);
				const croppedItem = await readItem();
				check(
					"editor.html: the crop frame writes a visible window to the placement",
					Boolean(croppedItem?.crop) &&
						croppedItem.crop.width < 800 &&
						croppedItem.crop.height < 450 &&
						croppedItem.crop.x === 0 &&
						croppedItem.crop.y === 0,
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

				await page.click("button[data-crop-toggle]");
				await fetch(`${BASE}/api/outs/${fixtureOut}/items/${itemId}`, { method: "DELETE" });
				await fetch(`${BASE}/api/templates/${templateId}`, { method: "DELETE" });
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
							playback: { mode: "once", intervalMs: 10000, holdMs: 300, autoStart: false },
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
				check("control.html: toggle starts off", !off.held && !off.playing, JSON.stringify(off));

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

				await fetch(`${BASE}/api/outs/main/items/${itemId}`, { method: "DELETE" });
			}

			await page.screenshot({ path: path.join(outDir, panel.shot), fullPage: false });
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
