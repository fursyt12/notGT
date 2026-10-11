#!/usr/bin/env node
/**
 * notGT end-to-end test of the WebSocket API (`/api/ws`).
 *
 * Checks, against a running server:
 *   1. the handshake: `hello`, then `state` without asking,
 *   2. the verbs (show / hide / toggle / trigger / hold / select / data) and
 *      that each is answered by one `reply` carrying the frame's `id`,
 *   3. the push: a change made over REST arrives as a `state` frame,
 *   4. signing in, when the server asks for it: a token in the address, a
 *      `login` frame with a token, a `login` frame with a username and
 *      password — and that a stranger is turned away with close code 4401,
 *   5. Socket.IO (the dashboard's own socket) still answers on the same port.
 *
 * Usage (server must already be running):
 *   node scripts/e2e-ws.mjs
 *
 *   NOTGT_BASE      http://127.0.0.1:9090
 *   NOTGT_TOKEN     the `apiToken`, when one is set
 *   NOTGT_WS_TOKEN  the `wsToken`, when the WebSocket has a key of its own
 *   NOTGT_USER      \  an operator of the login, when it is switched on
 *   NOTGT_PASSWORD  /
 */
import { WebSocket } from "ws";

const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const TOKEN = process.env.NOTGT_TOKEN ?? "";
/** The key of the WebSocket: its own, or the REST one when it has none. */
const WS_KEY = process.env.NOTGT_WS_TOKEN || TOKEN;
const USER = process.env.NOTGT_USER ?? "";
const PASSWORD = process.env.NOTGT_PASSWORD ?? "";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws`;

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

/** A connection that keeps every frame it received and can wait for one. */
function connect(url = WS_URL, options = {}) {
	const socket = new WebSocket(url, options);
	const frames = [];
	const waiters = new Set();
	let nextId = 1;
	const conn = {
		socket,
		frames,
		closed: new Promise((resolve) => socket.on("close", (code) => resolve(code))),
		opened: new Promise((resolve, reject) => {
			socket.on("open", resolve);
			socket.on("error", reject);
		}),
		/** The first frame, received or yet to come, that `match` accepts. */
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
		/** Sends a command and resolves with its reply. */
		async call(type, params = {}) {
			const id = nextId++;
			socket.send(JSON.stringify({ type, id, ...params }));
			return conn.wait((frame) => frame.type === "reply" && frame.id === id, `reply to ${type}`);
		},
		/** The next `state` frame after this call that `match` accepts. */
		nextState(match = () => true, timeoutMs = 4000) {
			const from = frames.length;
			return conn.wait(
				(frame) => frame.type === "state" && frames.indexOf(frame) >= from && match(frame.state),
				"state push",
				timeoutMs,
			);
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

/** The dashboard's session, for REST on a server that has a login and no token. */
let sessionCookie = "";

async function signInToDashboard() {
	const response = await fetch(`${BASE}/login/local`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: USER, password: PASSWORD }),
	});
	sessionCookie = response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	return response;
}

async function rest(method, url, body) {
	const response = await fetch(`${BASE}${url}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
			...(!TOKEN && sessionCookie ? { cookie: sessionCookie } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: response.status, json: await response.json().catch(() => null) };
}

/** Signs in with whatever this run was given, the way a Companion module would. */
async function signIn(conn) {
	if (WS_KEY) return conn.call("login", { token: WS_KEY });
	return conn.call("login", { username: USER, password: PASSWORD });
}

async function main() {
	// ------------------------------------------------------------ handshake
	const probe = connect();
	await probe.opened;
	const hello = await probe.wait((frame) => frame.type === "hello", "hello");
	check(
		"hello names the bundle and the protocol",
		hello.bundle === "notGT" && hello.protocol === 1 && typeof hello.version === "string",
		JSON.stringify(hello),
	);
	const authRequired = hello.authRequired === true;
	console.log(`      server ${authRequired ? `asks to sign in (${hello.login.join(", ")})` : "is open"}`);

	if (authRequired && !WS_KEY && !USER) {
		check(
			"credentials for a protected server",
			false,
			"set NOTGT_WS_TOKEN, NOTGT_TOKEN or NOTGT_USER/NOTGT_PASSWORD",
		);
		probe.close();
		return;
	}

	// -------------------------------------------------------------- sign-in
	if (authRequired) {
		check("no state before signing in", !probe.frames.some((frame) => frame.type === "state"));
		const early = await probe.call("getState");
		check(
			"a command before `login` is refused",
			early.ok === false && early.error.code === "unauthorized",
			JSON.stringify(early.error),
		);
		check("…and the connection is closed with 4401", (await probe.closed) === 4401);

		const wrong = connect();
		await wrong.opened;
		const refused = await wrong.call("login", { token: "definitely-not-the-token" });
		check("a wrong token is refused", refused.ok === false && refused.error.code === "unauthorized");
		check("…and closed with 4401", (await wrong.closed) === 4401);

		if (hello.login.includes("password")) {
			const guess = connect();
			await guess.opened;
			const denied = await guess.call("login", { username: USER || "operator", password: "wrong-password" });
			check("a wrong password is refused", denied.ok === false && (await guess.closed) === 4401);
		}

		if (WS_KEY) {
			const badUrl = connect(`${WS_URL}?token=nope`);
			await badUrl.opened;
			check("a wrong token in the address closes with 4401", (await badUrl.closed) === 4401);

			const byUrl = connect(`${WS_URL}?token=${encodeURIComponent(WS_KEY)}`);
			await byUrl.opened;
			const urlHello = await byUrl.wait((frame) => frame.type === "hello", "hello");
			await byUrl.wait((frame) => frame.type === "state", "state");
			check("a token in the address signs in with the handshake", urlHello.authenticated === true);
			byUrl.close();

			const byHeader = connect(WS_URL, { headers: { authorization: `Bearer ${WS_KEY}` } });
			await byHeader.opened;
			const headerHello = await byHeader.wait((frame) => frame.type === "hello", "hello");
			check("so does an Authorization header", headerHello.authenticated === true);
			byHeader.close();
		}
		if (TOKEN && WS_KEY !== TOKEN) {
			// The two keys are two keys: neither opens the other door.
			const restKey = connect();
			await restKey.opened;
			const refusedKey = await restKey.call("login", { token: TOKEN });
			check("the REST key does not open the WebSocket", refusedKey.ok === false && (await restKey.closed) === 4401);
			const wsOnRest = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${WS_KEY}` } });
			check("the WebSocket key does not open REST", wsOnRest.status === 401, String(wsOnRest.status));
		}
		if (USER) {
			const byPassword = connect();
			await byPassword.opened;
			const reply = await byPassword.call("login", { username: USER, password: PASSWORD });
			check(
				"a username and password sign in",
				reply.ok === true && reply.result.user === USER,
				JSON.stringify(reply),
			);
			await byPassword.wait((frame) => frame.type === "state", "state");
			byPassword.close();
		}

		// REST has its own key: with only a `wsToken` set it is as open as before.
		const unauthenticated = await fetch(`${BASE}/api/state`, { redirect: "manual" });
		if (TOKEN || USER) {
			check("REST without credentials answers 401", unauthenticated.status === 401, String(unauthenticated.status));
		} else {
			check("REST is not closed by the WebSocket key", unauthenticated.status === 200, String(unauthenticated.status));
		}
		if (USER) {
			const signedIn = await signInToDashboard();
			check(
				"the dashboard login takes the same username and password",
				signedIn.status === 302 && signedIn.headers.get("location") === "/dashboard",
				`${signedIn.status} -> ${signedIn.headers.get("location")}`,
			);
			const withSession = await fetch(`${BASE}/api/state`, { headers: { cookie: sessionCookie } });
			check("REST lets a signed-in operator in", withSession.status === 200, String(withSession.status));
			const sameSite = await fetch(`${BASE}/api/state`, { headers: { cookie: sessionCookie, origin: BASE } });
			const crossSite = await fetch(`${BASE}/api/titles/reset`, {
				method: "POST",
				headers: { cookie: sessionCookie, origin: "http://evil.example" },
			});
			check(
				"…but not a request another site makes with the operator's cookie",
				sameSite.status === 200 && crossSite.status === 401,
				`same origin ${sameSite.status}, cross-site ${crossSite.status}`,
			);
			const dashboard = await fetch(`${BASE}/dashboard/`, { redirect: "manual" });
			check(
				"the dashboard sends a stranger to the sign-in page",
				dashboard.status === 302 && dashboard.headers.get("location") === "/login",
				`${dashboard.status} -> ${dashboard.headers.get("location")}`,
			);
		}
		check("…while /api/health stays open", (await fetch(`${BASE}/api/health`)).status === 200);
	} else {
		probe.close();
	}

	// ------------------------------------------------------------- commands
	const ws = connect();
	await ws.opened;
	if (authRequired) {
		const reply = await signIn(ws);
		check("signed in", reply.ok === true, JSON.stringify(reply));
	}
	const first = await ws.wait((frame) => frame.type === "state", "the first state");
	const state = first.state;
	check(
		"state arrives without asking, with outs and templates",
		Array.isArray(state.outs) && Array.isArray(state.templates) && state.templates.length > 0,
		`${state.templates?.length} templates, ${state.outs?.length} outs`,
	);
	const templateId = state.templates[0].id;
	const outId = state.outs[0].id;

	await ws.call("reset");

	let pushed = ws.nextState((s) => s.activeVisible === true && s.activeTemplateId === templateId);
	const shown = await ws.call("show", { templateId, out: outId, label: "e2e" });
	check("show is answered", shown.ok === true && shown.command === "show" && shown.result.active.visible === true);
	check("…and pushed as state", (await pushed).state.activeOutId === outId);

	pushed = ws.nextState((s) => s.activeVisible === false);
	const hidden = await ws.call("hide");
	check("hide is answered and pushed", hidden.ok === true && (await pushed).state.activeVisible === false);

	pushed = ws.nextState((s) => s.activeVisible === true);
	await ws.call("toggle", { templateId });
	await pushed;
	pushed = ws.nextState((s) => s.activeVisible === false);
	await ws.call("toggle", { templateId });
	check("toggle shows, then hides", (await pushed).state.activeVisible === false);

	const missing = await ws.call("show", { templateId: "no-such-template" });
	check("an unknown template is `not_found`", missing.ok === false && missing.error.code === "not_found");
	const incomplete = await ws.call("show");
	check("a missing parameter is `bad_request`", incomplete.ok === false && incomplete.error.code === "bad_request");
	const unknown = await ws.call("makeCoffee");
	check("an unknown command is `unknown_command`", unknown.ok === false && unknown.error.code === "unknown_command");

	ws.socket.send("this is not json");
	const garbage = await ws.wait((frame) => frame.type === "error", "error frame");
	check("a frame that is not JSON gets an `error`, not a hang-up", garbage.code === "bad_request");
	check("…and the connection survives it", (await ws.call("ping")).ok === true);

	// A one-shot of a template that is placed nowhere: shown, then hidden by itself.
	pushed = ws.nextState((s) => s.activeVisible === true);
	const oneShot = await ws.call("trigger", { templateId, holdMs: 400 });
	await pushed;
	const gone = await ws.nextState((s) => s.activeVisible === false, 3000);
	check("trigger plays once and takes itself off", oneShot.ok === true && gone.state.activeVisible === false);

	// ---------------------------------------------------------- placements
	const placed = await rest("POST", `/api/outs/${outId}/items`, { templateId });
	const itemId = placed.json?.item?.id;
	check("a placement to test with", placed.status === 201 && Boolean(itemId), String(placed.status));
	if (itemId) {
		const listed = await ws.wait(
			(frame) =>
				frame.type === "state" && frame.state.outs.some((out) => out.items.some((item) => item.id === itemId)),
			"state with the new placement",
		);
		check("a placement made over REST is pushed to the socket", Boolean(listed));

		pushed = ws.nextState((s) => (s.playing[outId] ?? []).includes(itemId));
		const held = await ws.call("hold", { out: outId, itemId, held: true });
		const onAir = await pushed;
		check(
			"hold puts a placement on air and keeps it",
			held.ok === true &&
				onAir.state.outs.find((out) => out.id === outId).items.find((item) => item.id === itemId).held === true,
		);

		pushed = ws.nextState((s) => !(s.playing[outId] ?? []).includes(itemId));
		const released = await ws.call("hold", { out: outId, itemId });
		check("hold without `held` flips it back", released.result.held === false && Boolean(await pushed));

		pushed = ws.nextState((s) => (s.playing[outId] ?? []).includes(itemId));
		const fired = await ws.call("trigger", { out: outId, itemId, holdMs: 300 });
		await pushed;
		const ended = await ws.nextState((s) => !(s.playing[outId] ?? []).includes(itemId), 3000);
		check("trigger of a placement plays it once", fired.ok === true && Boolean(ended));

		await rest("DELETE", `/api/outs/${outId}/items/${itemId}`);
	}

	// ----------------------------------------------------------------- data
	check("data is not pushed unless asked for", !ws.frames.some((frame) => frame.type === "data"));
	const subscribed = await ws.call("subscribe", { topics: ["data"] });
	await ws.wait((frame) => frame.type === "data", "the first data frame");
	check("subscribing to `data` sends it at once", subscribed.result.topics.includes("data"));

	const stamp = `e2e-${Date.now()}`;
	const dataPush = ws.wait((frame) => frame.type === "data" && frame.data.e2eWs?.note === stamp, "data push");
	await ws.call("setData", { data: { e2eWs: { note: stamp, list: ["a", "b", "c"] } } });
	check("setData is pushed to subscribers", Boolean(await dataPush));
	const read = await ws.call("getData", { path: "e2eWs.note" });
	check("getData reads a path", read.result.value === stamp);

	await ws.call("select", { path: "e2eWs.list", index: 2 });
	pushed = ws.nextState((s) => s.selection["e2eWs.list"] === 0);
	const stepped = await ws.call("select", { path: "e2eWs.list", delta: 1 });
	check("select steps through a list and wraps around", stepped.result.index === 0 && Boolean(await pushed));
	const back = await ws.call("select", { path: "e2eWs.list", delta: -1 });
	check("…in both directions", back.result.index === 2);
	const clamped = await ws.call("select", { path: "e2eWs.list", delta: 1, wrap: false });
	check("…or stops at the end when `wrap` is false", clamped.result.index === 2);

	await ws.call("clearSelection", { path: "e2eWs.list" });
	await ws.call("deleteData", { path: "e2eWs" });
	const cleaned = await ws.call("getData", { path: "e2eWs", raw: true });
	check("deleteData removes the branch", cleaned.result.value === undefined);

	// ----------------------------------------------------------- REST -> WS
	pushed = ws.nextState((s) => s.activeVisible === true && s.activeTemplateId === templateId);
	const viaRest = await rest("POST", `/api/titles/${templateId}/show`, { out: outId });
	check("a show made over REST is pushed to the socket", viaRest.status === 200 && Boolean(await pushed));
	const restState = await rest("GET", "/api/state");
	check(
		"GET /api/state lists the placements of an out too",
		Array.isArray(restState.json?.outs?.[0]?.items),
	);
	await ws.call("reset");

	// ------------------------------------------------------------- the rest
	const quiet = await ws.call("unsubscribe", { topics: ["state"] });
	const before = ws.frames.length;
	await ws.call("show", { templateId });
	await sleep(150);
	check(
		"unsubscribing from `state` stops the push",
		!quiet.result.topics.includes("state") && !ws.frames.slice(before).some((frame) => frame.type === "state"),
	);
	await ws.call("reset");
	ws.close();

	const polling = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`);
	check("Socket.IO still answers on the same port", polling.status === 200, String(polling.status));
	const elsewhere = connect(`${BASE.replace(/^http/, "ws")}/api/not-ws`);
	const outcome = await Promise.race([
		elsewhere.opened.then(() => "opened", () => "refused"),
		sleep(3000).then(() => "hung"),
	]);
	check("another path is not taken for the WebSocket API", outcome === "refused", outcome);
}

main()
	.catch((error) => {
		check("no unexpected error", false, error.stack ?? String(error));
	})
	.finally(() => {
		console.log(failures.length === 0 ? "\nAll WebSocket checks passed" : `\n${failures.length} check(s) failed`);
		process.exit(failures.length === 0 ? 0 : 1);
	});
