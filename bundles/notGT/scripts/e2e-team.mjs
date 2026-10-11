#!/usr/bin/env node
/**
 * notGT end-to-end test of the team: users, groups and the keys that belong to
 * an out or to a group.
 *
 * Needs a running server with the sign-in switched on and an administrator's
 * username and password:
 *
 *   NOTGT_BASE=http://127.0.0.1:9090 NOTGT_USER=admin NOTGT_PASSWORD=… \
 *     node scripts/e2e-team.mjs
 *
 * It checks that
 *   1. an administrator makes groups, users and keys, and a member cannot,
 *   2. a member sees the outs of their groups only,
 *   3. the key of an out opens that out's page — not another out, not the
 *      dashboard — and its socket only reads,
 *   4. the WebSocket key of a group sees and drives that group's outs only,
 *   5. taking a key or a user away takes the access away at once.
 *
 * It makes an out, two groups and a user, and removes them when it is done.
 */
import fs from "node:fs";
import puppeteer from "puppeteer";
import { WebSocket } from "ws";

const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const ADMIN = process.env.NOTGT_USER ?? "";
const ADMIN_PASSWORD = process.env.NOTGT_PASSWORD ?? "";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws`;
const TEAM = `${BASE}/bundles/notGT/team`;
const OUT_PAGE = `${BASE}/bundles/notGT/graphics/out.html`;
const CHROME =
	process.env.CHROME_PATH ??
	["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

/** Signs in to the dashboard; resolves with the session cookie. */
async function signIn(username, password) {
	const response = await fetch(`${BASE}/login/local`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username, password }),
	});
	const cookie = response.headers
		.getSetCookie()
		.map((entry) => entry.split(";")[0])
		.join("; ");
	return { cookie, location: response.headers.get("location") };
}

/** A request as a browser tab of that session would make it. */
async function http(cookie, method, url, body, headers = {}) {
	const response = await fetch(url, {
		method,
		redirect: "manual",
		headers: {
			...(cookie ? { cookie } : {}),
			...(body ? { "content-type": "application/json" } : {}),
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	return {
		status: response.status,
		location: response.headers.get("location"),
		json: await response
			.clone()
			.json()
			.catch(() => null),
	};
}

/** A WebSocket API connection that keeps its frames and can wait for one. */
function connect(url = WS_URL) {
	const socket = new WebSocket(url);
	const frames = [];
	const waiters = new Set();
	let nextId = 1;
	const conn = {
		frames,
		closed: new Promise((resolve) => socket.on("close", (code) => resolve(code))),
		opened: new Promise((resolve, reject) => {
			socket.on("open", resolve);
			socket.on("error", reject);
		}),
		wait(match, label = "frame", timeoutMs = 4000) {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			return new Promise((resolve, reject) => {
				const waiter = (frame) => {
					if (!match(frame)) return;
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(frame);
				};
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`timed out waiting for ${label}`));
				}, timeoutMs);
				waiters.add(waiter);
			});
		},
		async call(type, params = {}) {
			const id = nextId++;
			socket.send(JSON.stringify({ type, id, ...params }));
			return conn.wait((frame) => frame.type === "reply" && frame.id === id, `reply to ${type}`);
		},
		nextState(match = () => true, timeoutMs = 4000) {
			const from = frames.length;
			return conn.wait(
				(frame) => frame.type === "state" && frames.indexOf(frame) >= from && match(frame.state),
				"state push",
				timeoutMs,
			);
		},
		lastState() {
			return frames.filter((frame) => frame.type === "state").at(-1)?.state;
		},
		close() {
			socket.close();
		},
	};
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		frames.push(frame);
		for (const waiter of [...waiters]) waiter(frame);
	});
	return conn;
}

const withKey = (key) => `${WS_URL}?token=${encodeURIComponent(key)}`;
const ids = (outs) => (outs ?? []).map((out) => out.id).sort().join(",");

async function main() {
	if (!ADMIN || !ADMIN_PASSWORD) {
		check("an administrator to sign in as", false, "set NOTGT_USER and NOTGT_PASSWORD");
		return;
	}
	const stamp = Date.now().toString(36);
	const OUT_B = `team-b-${stamp}`;
	const MEMBER = `vj-${stamp}`;
	const MEMBER_PASSWORD = "member-pass";
	const cleanup = [];

	// --------------------------------------------------------- administrator
	const admin = await signIn(ADMIN, ADMIN_PASSWORD);
	check("the administrator signs in", admin.location === "/dashboard", String(admin.location));
	const me = await http(admin.cookie, "GET", `${TEAM}/me`);
	check(
		"…and is told they are one, with every out in sight",
		me.json?.login === true && me.json?.role === "admin" && me.json?.outs === "all",
		JSON.stringify({ role: me.json?.role, outs: me.json?.outs }),
	);
	const state = await http(admin.cookie, "GET", `${BASE}/api/state`);
	const OUT_A = state.json.outs[0].id;
	const templateId = state.json.templates[0].id;

	const madeOut = await http(admin.cookie, "POST", `${BASE}/api/outs`, { id: OUT_B, name: "Team test B" });
	check("a second out to share out", madeOut.status === 201, String(madeOut.status));
	cleanup.push(() => http(admin.cookie, "DELETE", `${BASE}/api/outs/${OUT_B}`));

	const vj = (await http(admin.cookie, "POST", `${TEAM}/groups`, { name: `VJ ${stamp}`, outs: [OUT_A] })).json?.group;
	const stream = (await http(admin.cookie, "POST", `${TEAM}/groups`, { name: `Stream ${stamp}`, outs: [OUT_B] })).json
		?.group;
	check("groups are made, each with its outs", vj?.outs?.[0] === OUT_A && stream?.outs?.[0] === OUT_B);
	cleanup.push(() => http(admin.cookie, "DELETE", `${TEAM}/groups/${vj.id}`));
	cleanup.push(() => http(admin.cookie, "DELETE", `${TEAM}/groups/${stream.id}`));

	const vjKey = (await http(admin.cookie, "POST", `${TEAM}/groups/${vj.id}/keys`, { label: "Companion" })).json?.group
		?.keys?.[0];
	const streamKey = (await http(admin.cookie, "POST", `${TEAM}/groups/${stream.id}/keys`, {})).json?.group?.keys?.[0];
	check(
		"each group gets a WebSocket key of its own",
		Boolean(vjKey?.key) && Boolean(streamKey?.key) && vjKey.key !== streamKey.key && vjKey.label === "Companion",
	);

	const weak = await http(admin.cookie, "POST", `${TEAM}/users`, { username: MEMBER, password: "123" });
	check("a password that is too short is refused", weak.status === 400, String(weak.status));
	const made = await http(admin.cookie, "POST", `${TEAM}/users`, {
		username: MEMBER,
		password: MEMBER_PASSWORD,
		groups: [vj.id],
	});
	const member = made.json?.user;
	check(
		"a user is made and put in a group",
		made.status === 201 && member?.role === "member" && member?.groups?.[0] === vj.id,
		JSON.stringify(made.json),
	);
	cleanup.push(() => http(admin.cookie, "DELETE", `${TEAM}/users/${member.id}`));
	const twice = await http(admin.cookie, "POST", `${TEAM}/users`, { username: MEMBER, password: MEMBER_PASSWORD });
	const asAdmin = await http(admin.cookie, "POST", `${TEAM}/users`, { username: ADMIN, password: MEMBER_PASSWORD });
	check("a name that is taken is refused", twice.status === 409 && asAdmin.status === 409);

	const team = await http(admin.cookie, "GET", `${TEAM}/state`);
	check(
		"the team lists users without their passwords",
		team.json?.users?.some((user) => user.username === MEMBER) &&
			team.json?.users?.some((user) => user.username === ADMIN && user.role === "admin") &&
			!JSON.stringify(team.json).includes("scrypt"),
	);
	const keyA = team.json?.outKeys?.[OUT_A];
	const keyB = team.json?.outKeys?.[OUT_B];
	check("every out has a key of its own for its OBS link", Boolean(keyA) && Boolean(keyB) && keyA !== keyB);
	const viaApi = await http(admin.cookie, "GET", `${BASE}/api/outs/${OUT_A}/url`);
	check("the REST API gives out the same link", viaApi.json?.url?.endsWith(`out=${OUT_A}&key=${keyA}`), viaApi.json?.url);

	// The administrator a new server starts with, while nobody has given it a password.
	const signInPage = await (await fetch(`${BASE}/login/`)).text();
	check(
		"the sign-in page names the default administrator only while its password is the default one",
		signInPage.includes('class="first-run"') === (me.json?.defaultPassword === true),
		`default password in use: ${me.json?.defaultPassword}`,
	);
	const self = team.json?.users?.find((user) => user.username === ADMIN);
	if (self && !self.builtin && team.json.users.filter((user) => user.role === "admin").length === 1) {
		const demote = await http(admin.cookie, "PATCH", `${TEAM}/users/${self.id}`, { role: "member" });
		const remove = await http(admin.cookie, "DELETE", `${TEAM}/users/${self.id}`);
		check(
			"the only administrator can be neither demoted nor deleted",
			demote.status === 409 && remove.status === 409,
			`${demote.status} ${remove.status}`,
		);
	}

	const forged = await http(admin.cookie, "POST", `${TEAM}/users`, { username: "x", password: "longenough" }, {
		origin: "http://evil.example",
	});
	check("another site cannot manage the team with the administrator's cookie", forged.status === 403);

	// ---------------------------------------------------------------- member
	const session = await signIn(MEMBER, MEMBER_PASSWORD);
	check("the new user signs in to the dashboard", session.location === "/dashboard", String(session.location));
	const mine = await http(session.cookie, "GET", `${TEAM}/me`);
	check(
		"a member sees the outs of their groups only",
		mine.json?.role === "member" &&
			JSON.stringify(mine.json?.outs) === JSON.stringify([OUT_A]) &&
			JSON.stringify(Object.keys(mine.json?.outKeys ?? {})) === JSON.stringify([OUT_A]),
		JSON.stringify({ outs: mine.json?.outs, links: Object.keys(mine.json?.outKeys ?? {}) }),
	);
	const peek = await http(session.cookie, "GET", `${TEAM}/state`);
	const promote = await http(session.cookie, "PATCH", `${TEAM}/users/${member.id}`, { role: "admin" });
	const grab = await http(session.cookie, "PATCH", `${TEAM}/groups/${vj.id}`, { outs: [OUT_A, OUT_B] });
	check(
		"a member cannot read or change the team",
		peek.status === 403 && promote.status === 403 && grab.status === 403,
		`${peek.status} ${promote.status} ${grab.status}`,
	);

	// ------------------------------------------------------- the key of an out
	const own = await http(null, "GET", `${OUT_PAGE}?out=${OUT_A}&key=${keyA}`);
	const other = await http(null, "GET", `${OUT_PAGE}?out=${OUT_B}&key=${keyA}`);
	const dashboard = await http(null, "GET", `${BASE}/dashboard/?key=${keyA}`);
	const panel = await http(null, "GET", `${BASE}/bundles/notGT/dashboard/control.html?key=${keyA}`);
	const none = await http(null, "GET", `${OUT_PAGE}?out=${OUT_A}`);
	check("the key of an out opens the page of that out", own.status === 200, String(own.status));
	check("…not the page of another out", other.status === 403, String(other.status));
	check("…and not the dashboard", dashboard.status === 403 && panel.status === 403, `${dashboard.status} ${panel.status}`);
	check("without a key the page asks to sign in", none.status === 302 && none.location === "/login");
	const script = await http(`socketToken=${keyA}`, "GET", `${BASE}/bundles/notGT/graphics/assets/out.js`);
	const viaCookie = await http(`socketToken=${keyA}`, "GET", `${BASE}/dashboard/`);
	const teamViaKey = await http(`socketToken=${keyA}`, "GET", `${TEAM}/me`);
	const restViaKey = await http(`socketToken=${keyA}`, "POST", `${BASE}/api/titles/reset`);
	check("the files the page loads come with the key as a cookie", script.status === 200, String(script.status));
	check(
		"…a cookie that opens nothing else",
		viaCookie.status === 302 && teamViaKey.status !== 200 && restViaKey.status === 401,
		`dashboard ${viaCookie.status}, team ${teamViaKey.status}, REST ${restViaKey.status}`,
	);

	// The socket of an out page watches and cannot touch.
	const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
	try {
		const page = await (await browser.createBrowserContext()).newPage();
		await page.goto(`${OUT_PAGE}?out=${OUT_A}&key=${keyA}`, { waitUntil: "networkidle0" });
		const result = await page.evaluate(async () => {
			const api = globalThis.nodecg;
			const data = api.Replicant("titleData", "notGT");
			const outs = api.Replicant("outs", "notGT");
			await globalThis.NodeCG.waitForReplicants(data, outs);
			const seesOuts = Array.isArray(outs.value) && outs.value.length > 0;
			data.value = { ...data.value, e2eTeamIntruder: true };
			outs.value = [];
			api.sendMessageToBundle("stop", "notGT", {});
			const invented = api.Replicant("e2eTeamInvented", "notGT", { defaultValue: 1 });
			await new Promise((resolve) => setTimeout(resolve, 700));
			return { connected: api.socket.connected, seesOuts, invented: invented.status };
		});
		const after = await http(admin.cookie, "GET", `${BASE}/api/data`);
		const outsAfter = await http(admin.cookie, "GET", `${BASE}/api/outs`);
		check("an out page opened with its key is connected and gets the show", result.connected && result.seesOuts);
		check(
			"…but what it writes is refused",
			after.json?.data?.e2eTeamIntruder === undefined && outsAfter.json?.outs?.length >= 2,
			`outs left: ${outsAfter.json?.outs?.length}`,
		);
	} finally {
		await browser.close();
	}

	// ------------------------------------------------- the key of a group
	await http(admin.cookie, "POST", `${BASE}/api/titles/reset`);
	const vjWs = connect(withKey(vjKey.key));
	const streamWs = connect(withKey(streamKey.key));
	await Promise.all([vjWs.opened, streamWs.opened]);
	const vjHello = await vjWs.wait((frame) => frame.type === "hello", "hello");
	check(
		"a group's key signs in as that group",
		vjHello.authenticated === true && vjHello.group === vj.name && JSON.stringify(vjHello.outs) === JSON.stringify([OUT_A]),
		JSON.stringify({ group: vjHello.group, outs: vjHello.outs }),
	);
	const vjFirst = await vjWs.wait((frame) => frame.type === "state", "state");
	const streamFirst = await streamWs.wait((frame) => frame.type === "state", "state");
	check(
		"…and is told about the outs of that group only",
		ids(vjFirst.state.outs) === OUT_A && ids(streamFirst.state.outs) === OUT_B,
		`VJ: ${ids(vjFirst.state.outs)}; Stream: ${ids(streamFirst.state.outs)}`,
	);

	let pushed = vjWs.nextState((s) => s.activeVisible === true);
	const shown = await vjWs.call("show", { templateId });
	check(
		"with one out in reach, a show without `out` goes to it",
		shown.ok === true && (await pushed).state.activeOutId === OUT_A,
		JSON.stringify(shown.result?.active?.outId),
	);
	await sleep(150);
	check("another group is not told about that title", streamWs.lastState().activeVisible === false);

	const reach = await vjWs.call("show", { templateId, out: OUT_B });
	const stop = await vjWs.call("stop", { out: OUT_B });
	const hold = await vjWs.call("hold", { out: OUT_B, itemId: "whatever" });
	const trigger = await vjWs.call("trigger", { templateId, out: OUT_B });
	check(
		"an out of another group is `forbidden`",
		[reach, stop, hold, trigger].every((reply) => reply.ok === false && reply.error.code === "forbidden"),
		[reach, stop, hold, trigger].map((reply) => reply.error?.code).join(" "),
	);
	await streamWs.call("reset");
	await sleep(150);
	check("another group's reset leaves this group's title on air", vjWs.lastState().activeVisible === true);
	pushed = vjWs.nextState((s) => s.activeVisible === false);
	await vjWs.call("hide");
	check("a hide without `out` takes off what is in reach", (await pushed).state.activeVisible === false);

	const asMember = connect();
	await asMember.opened;
	const memberLogin = await asMember.call("login", { username: MEMBER, password: MEMBER_PASSWORD });
	check(
		"a member's username and password reach their groups' outs",
		memberLogin.ok === true && JSON.stringify(memberLogin.result.outs) === JSON.stringify([OUT_A]),
		JSON.stringify(memberLogin.result),
	);
	const asAdminWs = connect();
	await asAdminWs.opened;
	const adminLogin = await asAdminWs.call("login", { username: ADMIN, password: ADMIN_PASSWORD });
	check("an administrator's reach every out", adminLogin.ok === true && adminLogin.result.outs === "all");
	asAdminWs.close();

	// ------------------------------------------------------ editing the team
	pushed = vjWs.nextState((s) => s.outs.length === 2);
	await http(admin.cookie, "PATCH", `${TEAM}/groups/${vj.id}`, { outs: [OUT_A, OUT_B] });
	check("an out added to a group reaches its key at once", ids((await pushed).state.outs) === [OUT_A, OUT_B].sort().join(","));
	const ambiguous = await vjWs.call("show", { templateId });
	check("with several outs in reach a show has to name one", ambiguous.ok === false && ambiguous.error.code === "bad_request");

	await http(admin.cookie, "DELETE", `${TEAM}/groups/${vj.id}/keys/${vjKey.id}`);
	check("a revoked key is disconnected with 4401", (await vjWs.closed) === 4401);
	const revoked = connect(withKey(vjKey.key));
	await revoked.opened;
	check("…and does not connect again", (await revoked.closed) === 4401);

	const rotated = (await http(admin.cookie, "POST", `${TEAM}/outs/${OUT_A}/key`)).json?.key;
	const oldLink = await http(null, "GET", `${OUT_PAGE}?out=${OUT_A}&key=${keyA}`);
	const newLink = await http(null, "GET", `${OUT_PAGE}?out=${OUT_A}&key=${rotated}`);
	check(
		"a new key for an out replaces its OBS link",
		Boolean(rotated) && rotated !== keyA && oldLink.status !== 200 && newLink.status === 200,
		`old ${oldLink.status}, new ${newLink.status}`,
	);

	const browserKey = (await http(session.cookie, "GET", `${BASE}/dashboard/`)).status;
	await http(admin.cookie, "DELETE", `${TEAM}/users/${member.id}`);
	cleanup.splice(cleanup.findIndex((step) => String(step).includes("/users/")), 1);
	const gone = await http(session.cookie, "GET", `${BASE}/dashboard/`);
	const again = await signIn(MEMBER, MEMBER_PASSWORD);
	check(
		"a removed user is signed out and cannot sign in",
		browserKey === 200 && gone.status === 302 && gone.location === "/login" && again.location !== "/dashboard",
		`before ${browserKey}, after ${gone.status} -> ${gone.location}; sign-in -> ${again.location}`,
	);
	check("…and their WebSocket is closed", (await asMember.closed) === 4401);
	streamWs.close();

	for (const step of cleanup.reverse()) await step();
	const left = await http(admin.cookie, "GET", `${TEAM}/state`);
	check(
		"the test leaves the team as it found it",
		!left.json?.groups?.some((group) => group.id === vj.id || group.id === stream.id) &&
			!left.json?.users?.some((user) => user.username === MEMBER),
	);
}

main()
	.catch((error) => {
		check("no unexpected error", false, error.stack ?? String(error));
	})
	.finally(() => {
		console.log(failures.length === 0 ? "\nAll team checks passed" : `\n${failures.length} check(s) failed`);
		process.exit(failures.length === 0 ? 0 : 1);
	});
