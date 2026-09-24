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

				const clicked = await page.evaluate(() => {
					const target = [...document.querySelectorAll("button")].find((button) =>
						/preview|проиграть/i.test(button.textContent ?? ""),
					);
					if (!target) return false;
					target.click();
					return true;
				});
				check("editor.html: Preview button present", clicked);

				let visible = false;
				for (let i = 0; i < 20 && !visible; i++) {
					await sleep(150);
					const state = await (await fetch(`${BASE}/api/state`)).json();
					visible = Boolean(state.activeVisible);
				}
				check(
					"editor.html: Preview reaches the out (message -> extension -> state)",
					visible,
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
