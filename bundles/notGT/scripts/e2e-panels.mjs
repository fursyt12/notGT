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
