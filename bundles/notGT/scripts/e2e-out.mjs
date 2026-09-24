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

	// Deterministic starting state. `merge` (not `replace`) so running the suite
	// never wipes variables the operator added.
	await api("POST", "/api/titles/hide", {});
	await api("POST", "/api/data?mode=merge", {
		speaker: { name: "Иван Петров", role: "Ведущий" },
		ticker: { label: "LIVE", text: "notGT проверка" },
		sponsor: {
			label: "Партнёр",
			name: "ACME",
			meta: "Официальный партнёр трансляции",
			accent: "#ff3b30",
		},
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

		// --- 4c. placement math (x/y/scale) is exactly what the editor mirrors ---
		await api("POST", "/api/titles/hide", {});
		await sleep(400);
		await api("POST", "/api/templates", {
			id: "e2e-placement",
			name: "E2E placement",
			kind: "layers",
			width: 1920,
			height: 1080,
			layers: [
				{
					id: "p_marker",
					type: "shape",
					shape: "rect",
					x: 10,
					y: 10,
					width: 20,
					height: 20,
					style: { fill: "#00ff00", opacity: 1, rotation: 0 },
					z: 1,
				},
			],
			inTransition: { type: "none", durationMs: 0 },
			outTransition: { type: "none", durationMs: 0 },
			playback: { mode: "once", intervalMs: 10000, holdMs: 5000, autoStart: false },
		});
		const placed = await api("POST", "/api/outs/main/items", {
			templateId: "e2e-placement",
			x: 25,
			y: 25,
			scale: 0.5,
			playback: { mode: "loop", intervalMs: 8000, holdMs: 6000, autoStart: true },
		});
		await page.waitForFunction(
			() => document.querySelector('.notgt-layer[data-layer-id="p_marker"]') !== null,
			{ timeout: 8000 },
		);
		await sleep(400);
		const box = await page.evaluate(() => {
			const el = document.querySelector('.notgt-layer[data-layer-id="p_marker"]');
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		});
		// out 1920x1080, item x/y = 25%, scale 0.5, layer at 10%/10% size 20% of the
		// 1920x1080 template box  ->  left 480+96, top 270+54, w 192, h 108.
		const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
		check(
			"placement x/y/scale renders exactly as the editor models it",
			near(box.x, 576) && near(box.y, 324) && near(box.w, 192) && near(box.h, 108),
			JSON.stringify(box),
		);
		await api("DELETE", `/api/outs/main/items/${placed.item.id}`);
		await api("DELETE", "/api/templates/e2e-placement");
		await api("POST", "/api/titles/hide", {});
		await sleep(300);

		// --- 4d. array variables resolve through the selected element -----
		await api("POST", "/api/titles/hide", {});
		await sleep(400);
		await api("POST", "/api/templates", {
			id: "e2e-array",
			name: "E2E array",
			kind: "layers",
			width: 1920,
			height: 1080,
			layers: [
				{
					id: "a_text",
					type: "text",
					x: 10,
					y: 40,
					width: 60,
					binding: "e2e_guests.name",
					style: { fontSize: 70, color: "#ffffff", opacity: 1, rotation: 0 },
					z: 1,
				},
			],
			inTransition: { type: "none", durationMs: 0 },
			outTransition: { type: "none", durationMs: 0 },
			playback: { mode: "once", intervalMs: 10000, holdMs: 30000, autoStart: false },
		});
		await api("POST", "/api/data?mode=merge", {
			e2e_guests: [{ name: "Первый" }, { name: "Второй" }],
		});
		await api("POST", "/api/selection", { path: "e2e_guests", index: 0 });
		await api("POST", "/api/titles/e2e-array/show", {});

		const showsText = (text) =>
			page.waitForFunction(
				(needle) =>
					[...document.querySelectorAll(".notgt-slot .notgt-layer")].some(
						(el) => (el.textContent ?? "").trim() === needle,
					),
				{ timeout: 8000 },
				text,
			);

		await showsText("Первый");
		check("array binding resolves the selected element (index 0)", true);

		await page.evaluate(() => {
			window.__notgtArrayMarker = "alive";
		});
		const selectionStarted = Date.now();
		await api("POST", "/api/selection", { path: "e2e_guests", index: 1 });
		await showsText("Второй");
		const selectionLatency = Date.now() - selectionStarted;
		check(
			"changing the selected element switches the on-air value",
			true,
			`${selectionLatency} ms`,
		);
		check(
			"selection switch latency under 500 ms",
			selectionLatency < 500,
			`${selectionLatency} ms`,
		);
		check(
			"no reload on selection change (JS context survived)",
			await page.evaluate(() => window.__notgtArrayMarker === "alive"),
		);

		await api("POST", "/api/titles/hide", {});
		await api("DELETE", "/api/selection/e2e_guests");
		await api("DELETE", "/api/data/e2e_guests");
		await api("DELETE", "/api/templates/e2e-array");
		await sleep(300);

		// --- 4e. "show it and keep it" toggle (held placements) -----------
		await api("POST", "/api/titles/hide", {});
		await sleep(400);
		const heldItem = await api("POST", "/api/outs/main/items", {
			templateId: "lower-third",
			held: true,
			// A deliberately tiny hold: a held placement must ignore it.
			playback: { mode: "once", intervalMs: 10000, holdMs: 300, autoStart: false },
		});
		const heldId = heldItem.item.id;
		const playingMain = async () => (await api("GET", "/api/state")).playing?.main ?? [];

		await sleep(250);
		check("held placement goes on air", (await playingMain()).includes(heldId), heldId);
		await page.waitForSelector(".notgt-slot", { timeout: 8000 });
		check("held placement is rendered on the out", true);

		await sleep(1600); // far beyond the 300 ms holdMs
		check(
			"held placement is still on air after holdMs (show and keep)",
			(await playingMain()).includes(heldId),
		);

		await api("PATCH", `/api/outs/main/items/${heldId}`, { held: false });
		await sleep(500);
		check("toggling held off takes it off air", !(await playingMain()).includes(heldId));

		await api("DELETE", `/api/outs/main/items/${heldId}`);
		await sleep(300);

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

		// --- restore the seeded values the suite overwrote ----------------
		await api("POST", "/api/titles/hide", {});
		await api("POST", "/api/data?mode=merge", {
			speaker: { name: "Иван Петров", role: "Ведущий" },
			ticker: { label: "LIVE", text: "notGT — титры, управляемые из Companion" },
		});
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
