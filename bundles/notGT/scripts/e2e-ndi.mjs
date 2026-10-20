#!/usr/bin/env node
/**
 * notGT end-to-end test of the NDI outputs — the server's side of them.
 *
 * Checks, against a running server:
 *   1. switching NDI on for an out (`PATCH /api/outs/:id`) puts it in
 *      `GET /api/ndi`, with its source name, picture size, frame rate and the
 *      address of its page; switching it off takes it out again;
 *   2. a sender's report (`POST /api/ndi/status`) is taken, a broken one is
 *      refused, and the Titles & Outs panel shows it next to the out and in
 *      "NDI senders";
 *   3. a sender that stops reporting drops out of the panel;
 *   4. with the sign-in on, the senders' key opens `/api/ndi` and nothing else;
 *   5. the settings: transparency and NDI groups reach the sender, and the
 *      settings menu of the panel changes the frame rate and the size;
 *   6. Spout: an out shared over Spout is given only to a sender that asks
 *      (`/api/ndi?spout=1`, Windows), next to its NDI source; its report is
 *      shown on the Spout row and not the NDI one, and the switch turns it off.
 *
 * The sender itself (rendering, NDI) is tested in `ndi/` — see ndi/README.md.
 *
 * Usage (server must already be running):
 *   node scripts/e2e-ndi.mjs
 *
 *   NOTGT_BASE      http://127.0.0.1:9090
 *   NOTGT_TOKEN     the `apiToken`, when one is set
 *   NOTGT_USER      with NOTGT_PASSWORD: an administrator, when the sign-in is on
 */
import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const TOKEN = process.env.NOTGT_TOKEN ?? "";
const USER = process.env.NOTGT_USER ?? "";
const PASSWORD = process.env.NOTGT_PASSWORD ?? "";
const CHROME =
	process.env.CHROME_PATH ??
	["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));

const SENDER = "e2e-sender";
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

let cookie = "";

async function api(method, url, body, { key } = {}) {
	const bearer = key ?? TOKEN;
	const response = await fetch(`${BASE}${url}`, {
		method,
		redirect: "manual",
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			...(cookie && key === undefined ? { cookie } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, body: json };
}

async function signIn() {
	const response = await fetch(`${BASE}/login/local`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: USER, password: PASSWORD }),
	});
	cookie = response.headers
		.getSetCookie()
		.map((entry) => entry.split(";")[0])
		.join("; ");
}

const report = (outId, extra = {}) => ({
	id: SENDER,
	host: "e2e-host",
	platform: "linux-arm64",
	version: "0.0.0",
	ndi: "NDI SDK LINUX 6.3.2.0",
	outs: [
		{
			id: outId,
			ndiName: "E2E NDI",
			state: "sending",
			connections: 2,
			fps: 24.5,
			width: 960,
			height: 540,
			...extra,
		},
	],
});

async function panelText(browser, selector) {
	const page = await browser.newPage();
	if (cookie) {
		const url = new URL(BASE);
		await page.setCookie(
			...cookie.split("; ").map((pair) => {
				const [name, ...rest] = pair.split("=");
				return { name, value: rest.join("="), domain: url.hostname, path: "/" };
			}),
		);
	}
	await page.goto(`${BASE}/bundles/notGT/dashboard/titles.html?standalone=1`, { waitUntil: "networkidle2" });
	await page.waitForSelector(".tt-out", { timeout: 15000 });
	return {
		page,
		read: () => page.$eval(selector, (el) => el.textContent ?? "").catch(() => ""),
	};
}

async function main() {
	if (USER) await signIn();
	// Keys exist only while the sign-in is on.
	const login = (await api("GET", "/bundles/notGT/team/me")).body?.login === true;

	const state = await api("GET", "/api/state");
	if (state.status !== 200) throw new Error(`GET /api/state -> ${state.status}: set NOTGT_TOKEN or NOTGT_USER`);
	const out = state.body.outs[0];
	const before = (await api("GET", `/api/outs/${out.id}`)).body.out;

	try {
		// ------------------------------------------------------------ 1. config
		const patched = await api("PATCH", `/api/outs/${out.id}`, {
			ndi: { enabled: true, name: "E2E NDI", fps: 25, scale: 0.5, alpha: false, groups: "Stage, VJ!" },
		});
		check("NDI is switched on through the API", patched.status === 200 && patched.body.out?.ndi?.enabled === true);

		const listed = await api("GET", "/api/ndi");
		const entry = listed.body.outs?.find((candidate) => candidate.id === out.id);
		const even = (value) => Math.max(2, Math.round(value / 2) * 2);
		check(
			"GET /api/ndi lists the out with its name, size and rate",
			entry?.ndiName === "E2E NDI" &&
				entry.fps === 25 &&
				entry.width === even(out.width * 0.5) &&
				entry.height === even(out.height * 0.5) &&
				entry.designWidth === out.width,
			JSON.stringify(entry),
		);
		check(
			"…opaque, in the groups it was given (cleaned)",
			entry?.alpha === false && entry.groups === "Stage, VJ",
			JSON.stringify({ alpha: entry?.alpha, groups: entry?.groups }),
		);
		check(
			"…and the address of its page",
			typeof entry?.url === "string" && entry.url.includes(`out=${encodeURIComponent(out.id)}`) && (!login || entry.url.includes("key=")),
			entry?.url,
		);

		// ------------------------------------------------------------ 6. spout
		const spouted = await api("PATCH", `/api/outs/${out.id}`, {
			spout: { enabled: true, name: "E2E\\Spout", fps: 30, alpha: false },
		});
		check(
			"Spout is switched on through the API, its name cleaned",
			spouted.status === 200 && spouted.body.out?.spout?.enabled === true && spouted.body.out.spout.name === "E2E/Spout",
			JSON.stringify(spouted.body.out?.spout),
		);
		const plain = await api("GET", "/api/ndi");
		check(
			"a sender that does not ask is given no Spout out",
			!plain.body.outs?.some((candidate) => candidate.kind === "spout"),
		);
		const windows = (await api("GET", "/api/ndi?spout=1")).body.outs ?? [];
		const shared = windows.find((candidate) => candidate.id === out.id && candidate.kind === "spout");
		check(
			"a sender on Windows is given it, at the out's size, next to its NDI source",
			shared?.ndiName === "E2E/Spout" &&
				shared.fps === 30 &&
				shared.alpha === false &&
				shared.width === even(out.width) &&
				windows.some((candidate) => candidate.id === out.id && !candidate.kind),
			JSON.stringify(shared),
		);

		// ------------------------------------------------------------ 2. status
		const reported = await api("POST", "/api/ndi/status", report(out.id));
		check("a sender's report is taken", reported.status === 200, String(reported.status));
		const broken = await api("POST", "/api/ndi/status", { outs: [] });
		check("a report without a sender id is refused", broken.status === 400, String(broken.status));

		const browser = await puppeteer.launch({
			executablePath: CHROME,
			headless: "new",
			args: ["--no-sandbox"],
		});
		try {
			const panel = await panelText(browser, `[data-ndi="${out.id}"]`);
			const row = await panel.read();
			check("the out shows that it is sent", row.includes("e2e-host") && row.includes("2") && row.includes("24.5"), row);
			const senders = await panel.page
				.$eval(`[data-sender="${SENDER}"]`, (el) => el.textContent ?? "")
				.catch(() => "");
			check("…and the sender is listed", senders.includes("e2e-host") && senders.includes("6.3.2"), senders);
			const command = await panel.page.$eval(".tt-ndi-senders__how input", (el) => el.value).catch(() => "");
			check("…with the command that starts one", command.includes("npm start") && command.includes(BASE), command);

			// ---------------------------------------------------- 6b. spout
			await api("POST", "/api/ndi/status", {
				...report(out.id),
				id: "e2e-windows",
				host: "e2e-win",
				platform: "win32-x64",
				ndi: "",
				outs: [
					{ id: out.id, kind: "spout", ndiName: "E2E/Spout", state: "sending", connections: 1, fps: 29.5, width: 1920, height: 1080 },
				],
			});
			await sleep(800);
			const spoutRow = await panel.page.$eval(`[data-spout="${out.id}"]`, (el) => el.textContent ?? "").catch(() => "");
			check("the Spout row shows where it is shared from", spoutRow.includes("e2e-win") && spoutRow.includes("29.5"), spoutRow);
			check("…and the NDI row does not take it for NDI", !(await panel.read()).includes("e2e-win"));
			const windowsSender = await panel.page
				.$eval(`[data-sender="e2e-windows"]`, (el) => el.textContent ?? "")
				.catch(() => "");
			check("a sender without NDI is listed without an NDI version", windowsSender.includes("win32-x64") && !windowsSender.includes("NDI"), windowsSender);
			await panel.page.click(`[data-spout="${out.id}"] .tt-ndi__line input`);
			await sleep(800);
			const offAgain = (await api("GET", "/api/ndi?spout=1")).body.outs ?? [];
			check(
				"the Spout switch turns it off, NDI left on",
				!offAgain.some((candidate) => candidate.kind === "spout") && offAgain.some((candidate) => candidate.id === out.id),
			);

			// ---------------------------------------------------- 5. the menu
			await panel.page.click(`[data-ndi-open="${out.id}"]`);
			await panel.page.waitForSelector(`[data-ndi-settings="${out.id}"]`, { timeout: 5000 });
			await panel.page.select(`[data-ndi-settings="${out.id}"] [data-ndi-fps]`, "59.94");
			await panel.page.select(`[data-ndi-settings="${out.id}"] [data-ndi-scale]`, String(2 / 3));
			await sleep(800);
			const changed = (await api("GET", "/api/ndi")).body.outs?.find((candidate) => candidate.id === out.id);
			check(
				"the settings menu sets the frame rate and the size",
				changed?.fps === 59.94 && changed.width === even((out.width * 2) / 3),
				JSON.stringify({ fps: changed?.fps, width: changed?.width }),
			);
			await panel.page.click(`[data-ndi-alpha="${out.id}"] input`);
			await sleep(800);
			const alphaBack = (await api("GET", "/api/ndi")).body.outs?.find((candidate) => candidate.id === out.id);
			check("…and turns the transparency back on", alphaBack?.alpha === true, String(alphaBack?.alpha));
			const summary = await panel.page.$eval(`[data-ndi-open="${out.id}"]`, (el) => el.textContent ?? "");
			check("…and the row sums them up", summary.includes("59.94") && summary.includes("E2E NDI"), summary);

			await api("POST", "/api/ndi/status", report(out.id, { state: "error", connections: 0, error: "page failed" }));
			await sleep(800);
			const failed = await panel.read();
			check("an error the sender reports is shown", failed.includes("page failed"), failed);

			// ------------------------------------------------------- 3. expiry
			await sleep(12_500);
			const gone = await panel.read();
			check("a sender that stops reporting drops out", !gone.includes("e2e-host"), gone);
			await panel.page.close();
		} finally {
			await browser.close();
		}

		// -------------------------------------------------------------- 4. key
		if (login) {
			const me = await api("GET", "/bundles/notGT/team/me");
			const key = me.body?.ndiKey;
			check("an administrator is given the senders' key", typeof key === "string" && key.startsWith("ndi_"), String(key));
			if (key) {
				const withKey = await api("GET", "/api/ndi", undefined, { key });
				check("the key opens /api/ndi", withKey.status === 200, String(withKey.status));
				const status = await api("POST", "/api/ndi/status", report(out.id), { key });
				check("…and /api/ndi/status", status.status === 200, String(status.status));
				const elsewhere = await api("GET", "/api/state", undefined, { key });
				check("…and nothing else", elsewhere.status === 401, String(elsewhere.status));
			}
		}

		// ------------------------------------------------------------ 1b. off
		await api("PATCH", `/api/outs/${out.id}`, { ndi: { enabled: false } });
		const after = await api("GET", "/api/ndi");
		check("switched off, the out is not sent", !after.body.outs?.some((candidate) => candidate.id === out.id));
	} finally {
		await api("PATCH", `/api/outs/${out.id}`, { ndi: before.ndi ?? null, spout: before.spout ?? null });
	}

	console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll NDI checks passed");
	process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
