import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { type RawData, type WebSocket, WebSocketServer } from "ws";

import { version as BUNDLE_VERSION } from "../../package.json";
import { getByPathRaw } from "../shared/binding";
import { BUNDLE_NAME, type PublicState, type TitleData } from "../shared/types";
import { asObject, buildPublicState, isPlainObject, pickNumber, pickString } from "./api";
import { type Access, EVERYTHING, extractToken, type Principal } from "./auth";
import type { Scheduler } from "./scheduler";
import type { BundleConfig, ServerAPI, Store } from "./store";
import { timerTickMs, timerWithin } from "../shared/timer";
import type { Team } from "./team";
import { TimerError, type Timers } from "./timers";
import { playTemplateOnce } from "./trigger";

/**
 * The WebSocket API: the live counterpart of the REST API, made for the
 * Bitfocus Companion module (and anything else that would otherwise poll
 * `GET /api/state`).
 *
 * It is a plain WebSocket — not Socket.IO — on `/api/ws`, speaking JSON text
 * frames. Every frame is an object with a `type`:
 *
 *   server -> client   hello · state · data · timers · reply · error
 *   client -> server   login · subscribe · show · hide · toggle · trigger · timer · …
 *
 * Each client frame is answered by exactly one `reply` that echoes the frame's
 * `id`. `state` is pushed on its own whenever what is on air changes, so a
 * client never has to ask twice.
 *
 * A client reaches as far as what it signed in with: the global key and an
 * administrator reach every out; a group's key, or a member of groups, only
 * the outs of those groups — in what it is told and in what it may do. The
 * same goes for timers: a client sees and drives the timers shared with its
 * groups (and those shared with everyone).
 */

/** Bumped when a frame changes in a way an existing client would trip over. */
export const WS_PROTOCOL = 1;

/** Close codes of our own (4000–4999 is the range left to applications). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GOING_AWAY = 1001;

/** How long a connection may stay open without signing in. */
const LOGIN_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** Replicant changes come in bursts (a show writes two of them); send one frame. */
const PUSH_DEBOUNCE_MS = 10;
const MAX_PAYLOAD = 1024 * 1024;

/**
 *   state  — what is on air, pushed when it changes (on by default);
 *   data   — the variable store;
 *   timers — what every timer within reach shows, pushed when it changes:
 *            once a second, or every tenth for a timer that shows tenths.
 */
const TOPICS = ["state", "data", "timers"] as const;
type Topic = (typeof TOPICS)[number];

interface Client {
	socket: WebSocket;
	/** Who signed in; null until someone has. */
	principal: Principal | null;
	/** The last `state` frame sent, so an unchanged one is not sent again. */
	lastState: string;
	/** The last `timers` frame sent. */
	lastTimers: string;
	topics: Set<Topic>;
	alive: boolean;
	loginTimer?: ReturnType<typeof setTimeout>;
}

class CommandError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type Params = Record<string, unknown>;

export interface WsApi {
	/** Paths the endpoint answers on. */
	readonly paths: string[];
	readonly clients: () => number;
	close(): void;
}

export function createWsApi(
	nodecg: ServerAPI,
	store: Store,
	scheduler: Scheduler,
	access: Access,
	team: Team,
	timers: Timers,
): WsApi | undefined {
	const log = nodecg.log;
	const paths = ["/api/ws", `/bundles/${BUNDLE_NAME}/api/ws`];

	// NodeCG hands extensions its Socket.IO namespace but not the HTTP server
	// under it; the server is one step away.
	const io = nodecg.getSocketIOServer() as unknown as { server?: { httpServer?: HttpServer } };
	const httpServer = io.server?.httpServer;
	if (!httpServer) {
		log.error("WebSocket API is off: the HTTP server of NodeCG is not reachable from the extension");
		return undefined;
	}

	// The whole state: `hideApiState` is about the size of a *polled* answer,
	// and here a frame goes out only when something changed.
	const stateConfig = { ...((nodecg.bundleConfig ?? {}) as BundleConfig), hideApiState: false };
	const readState = (): PublicState => buildPublicState(store, stateConfig, timers);

	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
	const clients = new Set<Client>();

	const send = (client: Client, frame: Record<string, unknown>): void => {
		if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(frame));
	};

	// ---------------------------------------------------------------- push

	let stateTimer: ReturnType<typeof setTimeout> | undefined;
	let dataTimer: ReturnType<typeof setTimeout> | undefined;

	/** The state as far as this client reaches. */
	const stateFor = (client: Client, full: PublicState = readState()): PublicState => {
		const groups = client.principal?.groups() ?? null;
		if (groups) {
			full = {
				...full,
				timers: full.timers?.filter((timer) => timer.groups.length === 0 || timer.groups.some((id) => groups.includes(id))),
			};
		}
		const outs = client.principal?.outs();
		if (!outs) return full;
		const reach = new Set(outs);
		// A title shown by hand on somebody else's out is not this client's news.
		const foreign = full.active.outId !== null && !reach.has(full.active.outId);
		return {
			...full,
			...(foreign
				? {
						active: { templateId: null, visible: false, outId: null, data: {}, updatedAt: full.active.updatedAt },
						activeTemplateId: null,
						activeVisible: false,
						activeOutId: null,
					}
				: {}),
			playing: Object.fromEntries(Object.entries(full.playing).filter(([outId]) => reach.has(outId))),
			outs: full.outs?.filter((out) => reach.has(out.id)),
		};
	};
	const sendState = (client: Client, full?: PublicState): void => {
		const frame = JSON.stringify({ type: "state", state: stateFor(client, full) });
		// Most edits in the editor do not change what an integration sees.
		if (frame === client.lastState) return;
		client.lastState = frame;
		if (client.socket.readyState === client.socket.OPEN) client.socket.send(frame);
	};

	const pushState = (): void => {
		stateTimer = undefined;
		const full = readState();
		for (const client of clients) {
			if (client.principal && client.topics.has("state")) sendState(client, full);
		}
	};
	const pushData = (): void => {
		dataTimer = undefined;
		let frame: string | undefined;
		for (const client of clients) {
			if (!client.principal || !client.topics.has("data")) continue;
			frame ??= JSON.stringify({ type: "data", data: store.readData() });
			if (client.socket.readyState === client.socket.OPEN) client.socket.send(frame);
		}
	};
	const stateChanged = (): void => {
		stateTimer ??= setTimeout(pushState, PUSH_DEBOUNCE_MS);
	};
	const dataChanged = (): void => {
		dataTimer ??= setTimeout(pushData, PUSH_DEBOUNCE_MS);
	};

	store.activeTitle.on("change", stateChanged);
	store.runtime.on("change", stateChanged);
	store.selection.on("change", stateChanged);
	store.outs.on("change", stateChanged);
	store.templates.on("change", stateChanged);
	store.titleData.on("change", dataChanged);
	timers.onChange(stateChanged);

	/** What the timers within a client's reach show now, as a `timers` frame. */
	const timersFrame = (client: Client, now: number): string => {
		const groups = client.principal?.groups() ?? null;
		const list = timers
			.list()
			.filter((timer) => timerWithin(timer, groups))
			.map((timer) => {
				// `ms` and `progress` move on every look; a frame goes out when
				// what a button would show changes.
				const { ms: _ms, progress: _progress, ...vars } = timers.read(timer, now).vars;
				return { id: timer.id, key: timer.key, ...vars };
			});
		return JSON.stringify({ type: "timers", timers: list });
	};
	const sendTimers = (client: Client, now = Date.now(), force = false): void => {
		const frame = timersFrame(client, now);
		if (!force && frame === client.lastTimers) return;
		client.lastTimers = frame;
		if (client.socket.readyState === client.socket.OPEN) client.socket.send(frame);
	};
	let timersTick: ReturnType<typeof setTimeout> | undefined;
	const tickTimers = (): void => {
		const now = Date.now();
		let listening = false;
		for (const client of clients) {
			if (!client.principal || !client.topics.has("timers")) continue;
			listening = true;
			sendTimers(client, now);
		}
		timersTick = listening ? setTimeout(tickTimers, timerTickMs(timers.list())) : undefined;
	};
	const watchTimers = (): void => {
		timersTick ??= setTimeout(tickTimers, 0);
	};
	timers.onChange(watchTimers);

	// ------------------------------------------------------------- commands

	const requireString = (params: Params, ...names: string[]): string => {
		for (const name of names) {
			const value = pickString(params[name]);
			if (value !== undefined) return value;
		}
		throw new CommandError("bad_request", `Missing \`${names[0]}\``);
	};
	const outOf = (params: Params): string | undefined => pickString(params["out"] ?? params["outId"]);
	const dataOf = (params: Params): TitleData | undefined =>
		isPlainObject(params["data"]) ? (params["data"] as TitleData) : undefined;
	const unknownTemplate = (id: string): CommandError =>
		new CommandError("not_found", `Unknown template: ${id}`);

	/** Refuses an out that is out of the client's reach. */
	const within = (client: Client, outId: string): string => {
		const outs = client.principal?.outs();
		if (outs && !outs.includes(outId)) {
			throw new CommandError("forbidden", `This key does not reach the out "${outId}"`);
		}
		return outId;
	};
	/**
	 * The out a command puts something on: null = every out. A client that does
	 * not reach every out has to name one — unless it reaches exactly one.
	 */
	const targetOut = (params: Params, client: Client): string | null => {
		const outId = outOf(params);
		if (outId) return within(client, outId);
		const outs = client.principal?.outs();
		if (!outs) return null;
		if (outs.length === 1) return outs[0]!;
		throw new CommandError(
			"bad_request",
			outs.length === 0 ? "This key reaches no outs yet" : `Name the \`out\`: this key reaches ${outs.join(", ")}`,
		);
	};
	/** The outs a command takes something off: undefined = every out there is. */
	const reachOf = (params: Params, client: Client): string[] | undefined => {
		const outId = outOf(params);
		if (outId) return [within(client, outId)];
		return client.principal?.outs() ?? undefined;
	};

	/** What the client may do once it is in. Each returns the `result` of the reply. */
	const commands: Record<string, (params: Params, client: Client) => unknown> = {
		ping: () => ({ time: Date.now() }),

		subscribe: (params, client) => {
			const added = topicsOf(params).filter((topic) => !client.topics.has(topic));
			for (const topic of added) client.topics.add(topic);
			// A topic starts with what it currently holds.
			if (added.includes("state")) {
				client.lastState = "";
				sendState(client);
			}
			if (added.includes("data")) send(client, { type: "data", data: store.readData() });
			if (added.includes("timers")) {
				sendTimers(client, Date.now(), true);
				watchTimers();
			}
			return { topics: [...client.topics] };
		},
		unsubscribe: (params, client) => {
			for (const topic of topicsOf(params)) client.topics.delete(topic);
			return { topics: [...client.topics] };
		},

		getState: (_params, client) => ({ state: stateFor(client) }),
		getData: (params) => {
			const path = pickString(params["path"]);
			if (!path) return { data: store.readData() };
			// As in `GET /api/data`: resolved the way bindings resolve it, unless `raw`.
			const raw = params["raw"] === true;
			return { path, raw, value: raw ? getByPathRaw(store.readData(), path) : store.readPath(path) };
		},

		show: (params, client) => {
			const templateId = requireString(params, "templateId");
			const active = store.show(templateId, {
				outId: targetOut(params, client),
				data: dataOf(params),
				label: pickString(params["label"]),
			});
			if (!active) throw unknownTemplate(templateId);
			return { active };
		},
		hide: (params, client) => {
			const templateId = pickString(params["templateId"]);
			const outs = reachOf(params, client);
			if (!outs) {
				const active = store.hide({ templateId });
				if (!templateId) scheduler.stopOut();
				return { active };
			}
			for (const outId of outs) {
				store.hide({ outId, templateId });
				if (!templateId) scheduler.stopOut(outId);
			}
			return { active: stateFor(client).active };
		},
		toggle: (params, client) => {
			const templateId = requireString(params, "templateId");
			const active = store.toggle(templateId, {
				outId: targetOut(params, client),
				data: dataOf(params),
				label: pickString(params["label"]),
			});
			if (!active) throw unknownTemplate(templateId);
			return { active };
		},
		/** One-shot: of a placement (`out` + `itemId`), or of a template wherever it is placed. */
		trigger: (params, client) => {
			const holdMs = pickNumber(params["holdMs"]);
			const itemId = pickString(params["itemId"]);
			if (itemId) {
				const outId = within(client, requireString(params, "out", "outId"));
				if (!scheduler.trigger(outId, itemId, holdMs)) {
					throw new CommandError("not_found", `Unknown item: ${outId}/${itemId}`);
				}
				return { mode: "items", triggered: 1 };
			}
			const templateId = requireString(params, "templateId");
			const result = playTemplateOnce(store, scheduler, templateId, {
				outId: targetOut(params, client),
				holdMs,
				data: dataOf(params),
				label: pickString(params["label"]),
			});
			if (!result) throw unknownTemplate(templateId);
			return result;
		},
		/** The live on/off toggle of a placement. Without `held` it flips. */
		hold: (params, client) => {
			const outId = within(client, requireString(params, "out", "outId"));
			const itemId = requireString(params, "itemId");
			const found = store.getItem(outId, itemId);
			if (!found) throw new CommandError("not_found", `Unknown item: ${outId}/${itemId}`);
			const held = typeof params["held"] === "boolean" ? params["held"] : !found.item.held;
			store.upsertOut({
				...found.out,
				items: found.out.items.map((item) => (item.id === itemId ? { ...item, held } : item)),
			});
			scheduler.sync();
			return { outId, itemId, held };
		},
		stop: (params, client) => {
			const outs = reachOf(params, client);
			if (!outs) scheduler.stopOut();
			else for (const outId of outs) scheduler.stopOut(outId);
			return { outs: outs ?? "all" };
		},
		reset: (_params, client) => {
			const outs = client.principal?.outs();
			if (!outs) {
				scheduler.stopOut();
				return { active: store.resetActive() };
			}
			// Within reach only: the rest of the show is somebody else's.
			for (const outId of outs) {
				scheduler.stopOut(outId);
				store.hide({ outId });
			}
			return { active: stateFor(client).active };
		},

		setData: (params) => {
			if (!isPlainObject(params["data"])) throw new CommandError("bad_request", "Missing `data` object");
			const mode = params["mode"] === "replace" ? "replace" : "merge";
			store.setData(params["data"] as TitleData, mode);
			return { mode };
		},
		deleteData: (params) => {
			store.deleteData(requireString(params, "path"));
			return {};
		},
		/**
		 * Chooses the element of a list variable: `index` for a given one, or
		 * `delta` to step from the current one (`+1` = next), wrapping around the
		 * list unless `wrap` is false.
		 */
		select: (params) => {
			const path = requireString(params, "path");
			let index = pickNumber(params["index"]);
			if (index === undefined) {
				const delta = pickNumber(params["delta"]);
				if (delta === undefined) throw new CommandError("bad_request", "Missing numeric `index` or `delta`");
				const list = getByPathRaw(store.readData(), path);
				const length = Array.isArray(list) ? list.length : 0;
				index = (store.readSelection()[path] ?? 0) + Math.trunc(delta);
				if (length > 0) {
					index =
						params["wrap"] === false
							? Math.min(length - 1, Math.max(0, index))
							: ((index % length) + length) % length;
				}
			}
			if (index < 0) throw new CommandError("bad_request", "`index` must not be negative");
			return { path, index: Math.floor(index), selection: store.setSelection({ [path]: index }) };
		},
		clearSelection: (params) => ({ selection: store.clearSelection(requireString(params, "path")) }),

		/**
		 * Drives a timer: `action` is start · pause · toggle · reset · restart ·
		 * set {value} · adjust {delta} · create · update · remove; `timer` is
		 * its id or key. Within the groups the client reaches.
		 */
		timer: (params, client) => {
			const action = requireString(params, "action", "command");
			const { action: _action, command: _command, ...rest } = params;
			try {
				const result = timers.command(action, rest, client.principal?.groups() ?? null);
				return result.timer ? { timer: timers.read(result.timer) } : { removed: result.removed };
			} catch (error) {
				if (error instanceof TimerError) throw new CommandError(error.code, error.message);
				throw error;
			}
		},
		getTimers: (_params, client) => {
			const groups = client.principal?.groups() ?? null;
			const now = Date.now();
			return {
				serverTime: now,
				timers: timers
					.list()
					.filter((timer) => timerWithin(timer, groups))
					.map((timer) => timers.read(timer, now)),
			};
		},
	};

	// --------------------------------------------------------------- session

	const admit = (client: Client, principal: Principal): void => {
		client.principal = principal;
		if (client.loginTimer) clearTimeout(client.loginTimer);
		client.loginTimer = undefined;
		if (client.topics.has("state")) sendState(client);
	};

	const reject = (client: Client, frame: Record<string, unknown>): void => {
		send(client, frame);
		client.socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
	};

	/** What a client is told about itself once it is in. */
	const describe = (principal: Principal): Record<string, unknown> => ({
		user: principal.user,
		group: principal.group?.name ?? null,
		outs: principal.outs() ?? "all",
	});

	const login = (client: Client, params: Params, id: unknown): void => {
		if (access.ws.open) {
			// Nothing to check: a client written for a protected server still works.
			send(client, { type: "reply", id, command: "login", ok: true, result: describe(EVERYTHING) });
			if (!client.principal) admit(client, EVERYTHING);
			return;
		}
		const principal = access.ws.signIn({
			token: params["token"] ?? params["key"],
			username: params["username"],
			password: params["password"],
		});
		if (!principal) {
			const username = pickString(params["username"]);
			log.warn("WebSocket API: sign-in refused (%s)", username ? `user "${username}"` : "key");
			reject(client, {
				type: "reply",
				id,
				command: "login",
				ok: false,
				error: { code: "unauthorized", message: "Wrong key, or wrong username or password" },
			});
			return;
		}
		send(client, { type: "reply", id, command: "login", ok: true, result: describe(principal) });
		client.lastState = "";
		admit(client, principal);
	};

	// The team was edited: a revoked key or a removed user is shown the door,
	// and everyone else is told what they reach now.
	team.onChange(() => {
		for (const client of clients) {
			if (client.principal && !client.principal.valid()) {
				reject(client, { type: "error", code: "unauthorized", message: "This key or user is no longer on the team" });
			}
		}
		stateChanged();
	});

	const onMessage = (client: Client, raw: RawData, isBinary: boolean): void => {
		let message: Params;
		try {
			if (isBinary) throw new Error("binary");
			const parsed: unknown = JSON.parse(raw.toString());
			if (!isPlainObject(parsed)) throw new Error("not an object");
			message = parsed;
		} catch {
			send(client, { type: "error", code: "bad_request", message: "A frame must be a JSON object" });
			return;
		}

		const { type, id, ...params } = message;
		const command = typeof type === "string" ? type : "";
		if (command === "login") {
			login(client, params, id);
			return;
		}
		if (!client.principal) {
			reject(client, {
				type: "reply",
				id,
				command,
				ok: false,
				error: { code: "unauthorized", message: "Sign in first: send a `login` frame" },
			});
			return;
		}

		const run = Object.prototype.hasOwnProperty.call(commands, command) ? commands[command] : undefined;
		if (!run) {
			send(client, {
				type: "reply",
				id,
				command,
				ok: false,
				error: { code: "unknown_command", message: `Unknown command: ${command || "(no `type`)"}` },
			});
			return;
		}
		try {
			send(client, { type: "reply", id, command, ok: true, result: run(asObject(params), client) });
		} catch (error) {
			if (!(error instanceof CommandError)) log.error("WebSocket API: `%s` failed:", command, error);
			send(client, {
				type: "reply",
				id,
				command,
				ok: false,
				error:
					error instanceof CommandError
						? { code: error.code, message: error.message }
						: { code: "internal", message: "The command failed; see the server log" },
			});
		}
	};

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const client: Client = {
			socket,
			principal: access.ws.open ? EVERYTHING : null,
			lastState: "",
			lastTimers: "",
			topics: new Set<Topic>(["state"]),
			alive: true,
		};
		clients.add(client);

		socket.on("pong", () => {
			client.alive = true;
		});
		socket.on("message", (raw, isBinary) => onMessage(client, raw, isBinary));
		socket.on("error", (error) => log.debug("WebSocket API: socket error:", error.message));
		socket.on("close", () => {
			if (client.loginTimer) clearTimeout(client.loginTimer);
			clients.delete(client);
		});

		// A token may come with the handshake, the way it does for the REST API.
		const url = new URL(req.url ?? "/", "http://localhost");
		const presented = extractToken({
			headers: req.headers,
			query: Object.fromEntries(url.searchParams),
		});
		if (!client.principal && presented !== undefined) {
			const principal = access.ws.signIn({ token: presented });
			if (!principal) {
				log.warn("WebSocket API: connection refused (wrong key in the handshake)");
				reject(client, { type: "error", code: "unauthorized", message: "Wrong key" });
				return;
			}
			client.principal = principal;
		}

		send(client, {
			type: "hello",
			protocol: WS_PROTOCOL,
			bundle: BUNDLE_NAME,
			version: BUNDLE_VERSION,
			authRequired: !access.ws.open,
			authenticated: client.principal !== null,
			// How far this connection reaches, once it is in.
			...(client.principal ? describe(client.principal) : {}),
			// What a `login` frame may carry on this server.
			login: [...(access.ws.hasToken ? ["token"] : []), ...(access.hasUsers ? ["password"] : [])],
		});

		if (client.principal) {
			admit(client, client.principal);
		} else {
			client.loginTimer = setTimeout(() => {
				reject(client, { type: "error", code: "unauthorized", message: "No `login` frame received in time" });
			}, LOGIN_TIMEOUT_MS);
		}
	});

	// Socket.IO listens for upgrades on the same server and leaves alone the
	// ones that are not for its own path, so the two coexist.
	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
		if (!paths.includes(pathname)) return;
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	};
	httpServer.on("upgrade", onUpgrade);

	// Drops the connections whose other end is gone without a close frame.
	const heartbeat = setInterval(() => {
		for (const client of clients) {
			if (!client.alive) {
				client.socket.terminate();
				continue;
			}
			client.alive = false;
			client.socket.ping();
		}
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	return {
		paths,
		clients: () => clients.size,
		close() {
			clearInterval(heartbeat);
			if (stateTimer) clearTimeout(stateTimer);
			if (dataTimer) clearTimeout(dataTimer);
			if (timersTick) clearTimeout(timersTick);
			httpServer.off("upgrade", onUpgrade);
			for (const client of clients) client.socket.close(CLOSE_GOING_AWAY, "server stopping");
			wss.close();
		},
	};
}

function topicsOf(params: Params): Topic[] {
	const raw = params["topics"] ?? params["topic"];
	const list = Array.isArray(raw) ? raw : [raw];
	const topics = list.filter((topic): topic is Topic => TOPICS.includes(topic as Topic));
	if (topics.length === 0) {
		throw new CommandError("bad_request", `\`topics\` must name at least one of: ${TOPICS.join(", ")}`);
	}
	return topics;
}
