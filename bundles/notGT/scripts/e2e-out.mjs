#!/usr/bin/env node
/**
 * notGT end-to-end smoke test.
 *
 * Verifies the acceptance criteria that can be checked without OBS:
 *   1. the out page renders a title with a fully transparent background,
 *   2. showing/hiding through the REST API puts the title on the out,
 *   3. changing variables in the dashboard store updates the on-screen text
 *      WITHOUT reloading the page (the JS context survives),
 *   4. a `kind: "code"` animation renders inside its sandboxed iframe,
 *   5. the loop scheduler marks items as playing and stops again.
 *
 * Usage (server must already be running on 127.0.0.1:9090):
 *   node scripts/e2e-out.mjs
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

async function main() {
	if (!CHROME) throw new Error("No Chromium binary found; set CHROME_PATH");
	fs.mkdirSync(outDir, { recursive: true });

	// Deterministic starting state.
	await api("POST", "/api/titles/hide", {});
	await api("POST", "/api/data?mode=replace", {
		speaker: { name: "Иван Петров", role: "Ведущий" },
		ticker: { label: "LIVE", text: "notGT проверка" },
	});

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

	const pageErrors = [];
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		page.on("console", (message) => {
			if (message.type() === "error") pageErrors.push(message.text());
		});

		const url = `${BASE}/bundles/notGT/graphics/out.html?out=main&debug=1`;
		await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

		// --- 1. transparent background -----------------------------------
		const background = await page.evaluate(() =>
			getComputedStyle(document.body).backgroundColor,
		);
		check(
			"transparent background",
			/rgba\(0, 0, 0, 0\)|transparent/.test(background),
			background,
		);

		// The debug overlay only shows once replicants have declared.
		await page.waitForFunction(
			() => document.getElementById("notgt-debug")?.textContent?.includes("out: main"),
			{ timeout: 15_000 },
		);
		check("out page registered its out", true);

		// --- 2. show through the API -------------------------------------
		const showStarted = Date.now();
		await api("POST", "/api/titles/lower-third/show", { label: "e2e" });
		await page.waitForSelector(".notgt-slot", { timeout: 10_000 });
		const showLatency = Date.now() - showStarted;
		check(
			"show latency under 500 ms (Companion criterion)",
			showLatency < 500,
			`${showLatency} ms`,
		);
		await sleep(700); // let the entrance transition settle

		const readTexts = () =>
			page.evaluate(() =>
				[...document.querySelectorAll(".notgt-slot .notgt-layer")].map((el) =>
					(el.textContent ?? "").trim(),
				),
			);

		let texts = await readTexts();
		check(
			"lower third shows the bound speaker name",
			texts.includes("Иван Петров"),
			JSON.stringify(texts),
		);
		check(
			"lower third shows the bound speaker role",
			texts.includes("Ведущий"),
			JSON.stringify(texts),
		);

		// --- 3. live data update without a reload -------------------------
		await page.evaluate(() => {
			window.__notgtE2eMarker = "alive";
		});
		const nameHandleBefore = await page.evaluateHandle(() =>
			[...document.querySelectorAll(".notgt-slot .notgt-layer")].find(
				(el) => (el.textContent ?? "").trim() === "Иван Петров",
			),
		);

		const dataStarted = Date.now();
		await api("POST", "/api/data?mode=merge", {
			speaker: { name: "Пётр Обновлённый" },
		});
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll(".notgt-slot .notgt-layer")].some(
					(el) => (el.textContent ?? "").trim() === "Пётр Обновлённый",
				),
			{ timeout: 8_000 },
		);
		const dataLatency = Date.now() - dataStarted;
		check(
			"data change latency under 500 ms",
			dataLatency < 500,
			`${dataLatency} ms`,
		);

		texts = await readTexts();
		check(
			"data change reaches the graphic",
			texts.includes("Пётр Обновлённый"),
			JSON.stringify(texts),
		);

		const markerSurvived = await page.evaluate(() => window.__notgtE2eMarker === "alive");
		check("no page reload on data change (JS context survived)", markerSurvived);

		const sameNode = await page.evaluate((handle) => {
			const nodes = [...document.querySelectorAll(".notgt-slot .notgt-layer")];
			return nodes.includes(handle);
		}, nameHandleBefore);
		check("text node reused, not re-created (no flicker)", sameNode);
		await nameHandleBefore.dispose();

		await page.screenshot({ path: path.join(outDir, "lower-third.png") });

		// --- 4. code animation -------------------------------------------
		await api("POST", "/api/titles/hide", {});
		await sleep(600);
		await api("POST", "/api/titles/code-sample/show", {});
		await page.waitForSelector(".notgt-code-frame", { timeout: 10_000 });
		await sleep(900);

		const iframeInfo = await page.evaluate(() => {
			const frame = document.querySelector(".notgt-code-frame");
			if (!(frame instanceof HTMLIFrameElement)) return { found: false };
			const doc = frame.contentDocument;
			return {
				found: true,
				hasBadge: Boolean(doc?.querySelector(".badge")),
				badgeText: doc?.querySelector(".badge")?.textContent?.trim() ?? "",
				tickerText: doc?.querySelector(".text")?.textContent?.trim() ?? "",
			};
		});
		check("code animation iframe rendered", iframeInfo.found);
		check(
			"code animation sees its variables",
			iframeInfo.badgeText === "LIVE" && iframeInfo.tickerText.includes("notGT"),
			JSON.stringify(iframeInfo),
		);
		await page.screenshot({ path: path.join(outDir, "code-sample.png") });

		// --- 4b. animation authored as a FILE ----------------------------
		await api("POST", "/api/titles/hide", {});
		await sleep(600);
		if (process.env.SKIP_FILE_ANIMATION !== "1") {
			await api("POST", "/api/data?mode=merge", {
				sponsor: {
					label: "Партнёр",
					name: "ACME",
					meta: "Официальный партнёр трансляции",
					accent: "#ff3b30",
				},
			});
			const sync = await api("POST", "/api/animations/sync", {});
			check("file animations discovered on disk", sync.total >= 1, JSON.stringify(sync));

			await api("POST", "/api/titles/file-example-file-animation/show", {});
			await page.waitForSelector(".notgt-code-frame", { timeout: 10_000 });
			await sleep(1200);
			const fileInfo = await page.evaluate(() => {
				const frame = document.querySelector(".notgt-code-frame");
				if (!(frame instanceof HTMLIFrameElement)) return { found: false };
				const doc = frame.contentDocument;
				const bug = doc?.querySelector("#bug");
				return {
					found: true,
					visible: bug?.classList.contains("is-visible") ?? false,
					name: doc?.querySelector('[data-bind="sponsor.name"]')?.textContent?.trim() ?? "",
					accent: bug ? getComputedStyle(bug).getPropertyValue("--accent").trim() : "",
				};
			});
			check("file animation rendered in its iframe", fileInfo.found);
			check(
				"file animation got {{...}} substitution and data-bind values",
				fileInfo.name === "ACME",
				JSON.stringify(fileInfo),
			);
			check(
				"file animation ran its onData (vars + class toggle)",
				fileInfo.visible && fileInfo.accent === "#ff3b30",
				JSON.stringify(fileInfo),
			);
			await page.screenshot({ path: path.join(outDir, "file-animation.png") });
			await api("POST", "/api/titles/hide", {});
			await sleep(400);
		}

		// --- 5. loop scheduler -------------------------------------------
		await api("POST", "/api/titles/hide", {});
		const created = await api("POST", "/api/outs/main/items", {
			templateId: "lower-third",
			playback: { mode: "loop", intervalMs: 1500, holdMs: 900, autoStart: true },
		});
		const itemId = created.item.id;
		await sleep(300);
		let playing = (await api("GET", "/api/state")).playing?.main ?? [];
		check("loop item is playing after autoStart", playing.includes(itemId), JSON.stringify(playing));

		let sawGap = false;
		for (let i = 0; i < 12; i++) {
			await sleep(200);
			playing = (await api("GET", "/api/state")).playing?.main ?? [];
			if (!playing.includes(itemId)) sawGap = true;
		}
		check("loop item stops again after holdMs", sawGap);

		await api("DELETE", `/api/outs/main/items/${itemId}`);
		await sleep(200);
		playing = (await api("GET", "/api/state")).playing?.main ?? [];
		check("deleting the item stops playback", !playing.includes(itemId));

		// --- 6. no runtime errors ----------------------------------------
		check(
			"no page/console errors",
			pageErrors.length === 0,
			pageErrors.slice(0, 3).join(" | "),
		);
	} finally {
		await browser.close();
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
