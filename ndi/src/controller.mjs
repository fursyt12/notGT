/**
 * Keeps the NDI sources in step with the outs a notGT server asks for, and
 * tells the server how they are doing. Nothing here touches Electron or NDI:
 * the outputs come from the factory it is given.
 *
 *   GET  /api/ndi         { outs: [{ id, kind?, ndiName, url, width, height, designWidth, designHeight, fps, alpha, groups? }] }
 *   POST /api/ndi/status  { id, host, version, ndi, outs: [{ id, kind?, ndiName, state, connections, fps, width, height, error? }] }
 *
 * `kind: "spout"`: the out is shared as a Spout sender on this computer
 * (Windows), `ndiName` its Spout name; only a sender that asks for them
 * (`/api/ndi?spout=1`) is given those. An out may come twice, once each way.
 */

/**
 * @typedef {object} OutputConfig
 * @property {string} id
 * @property {"spout"} [kind] a Spout sender rather than an NDI source
 * @property {string} ndiName      NDI or Spout name
 * @property {string} url          absolute address of the out page
 * @property {number} width        size of the NDI picture
 * @property {number} height
 * @property {number} designWidth  size the page lays out at
 * @property {number} designHeight
 * @property {number} fps
 * @property {boolean} alpha       `false`: sent opaque, over black
 * @property {string} [groups]
 */

/** Even, at least 2: NDI's 4:2:2 compression works on pixel pairs. */
export function evenSize(value) {
	const rounded = Math.round(Number(value) / 2) * 2;
	return Number.isFinite(rounded) && rounded >= 2 ? rounded : 2;
}

export function clampFps(value) {
	const fps = Number(value);
	if (!Number.isFinite(fps) || fps <= 0) return 30;
	return Math.min(60, Math.max(1, fps));
}

/** The outs of a `GET /api/ndi` answer, with their addresses made absolute. */
export function configsFromServer(body, server) {
	const outs = Array.isArray(body?.outs) ? body.outs : [];
	const configs = [];
	for (const out of outs) {
		if (!out || typeof out.id !== "string" || typeof out.url !== "string")
			continue;
		const designWidth = evenSize(out.designWidth ?? out.width ?? 1920);
		const designHeight = evenSize(out.designHeight ?? out.height ?? 1080);
		configs.push({
			id: out.id,
			...(out.kind === "spout" ? { kind: "spout" } : {}),
			ndiName: String(out.ndiName || out.name || out.id),
			url: new URL(out.url, server).href,
			width: evenSize(out.width ?? designWidth),
			height: evenSize(out.height ?? designHeight),
			designWidth,
			designHeight,
			fps: clampFps(out.fps),
			alpha: out.alpha !== false,
			...(typeof out.groups === "string" && out.groups
				? { groups: out.groups }
				: {}),
		});
	}
	return configs;
}

/** Two configs that would make the same source. */
function sameSource(a, b) {
	return (
		a.kind === b.kind &&
		a.ndiName === b.ndiName &&
		a.url === b.url &&
		a.width === b.width &&
		a.height === b.height &&
		a.designWidth === b.designWidth &&
		a.designHeight === b.designHeight &&
		a.fps === b.fps &&
		a.alpha === b.alpha &&
		(a.groups ?? "") === (b.groups ?? "")
	);
}

/** What tells outputs apart: an out may go out over NDI and Spout at once. */
export function outputKey(config) {
	return config.kind ? `${config.kind}:${config.id}` : config.id;
}

function describe(config) {
	return config.kind === "spout"
		? `“${config.ndiName}” over Spout`
		: `“${config.ndiName}”`;
}

export class Controller {
	/**
	 * @param {object} options
	 * @param {(config: OutputConfig) => { start(): void, stop(): void, status(): object }} options.create
	 * @param {(line: string) => void} [options.log]
	 */
	constructor({ create, log = () => {} }) {
		this.create = create;
		this.log = log;
		/** @type {Map<string, { config: OutputConfig, output: ReturnType<typeof create> | null, error?: string }>} */
		this.outputs = new Map();
		/** The last failure of each out, so a retry that fails the same way stays quiet. */
		this.failures = new Map();
	}

	/** Starts what is new, restarts what changed, stops what is gone. */
	apply(configs) {
		const wanted = new Map(configs.map((config) => [outputKey(config), config]));
		for (const [id, entry] of this.outputs) {
			const next = wanted.get(id);
			// A source that could not start is tried again on every round.
			if (next && entry.output && sameSource(entry.config, next)) continue;
			entry.output?.stop();
			this.outputs.delete(id);
			if (!next) {
				this.failures.delete(id);
				if (entry.output) this.log(`stopped ${describe(entry.config)}`);
			}
		}
		for (const config of configs) {
			const key = outputKey(config);
			if (this.outputs.has(key)) continue;
			try {
				const output = this.create(config);
				output.start();
				this.outputs.set(key, { config, output });
				this.failures.delete(key);
				this.log(
					`sending ${describe(config)} ${config.width}×${config.height} @ ${config.fps} fps`,
				);
			} catch (error) {
				// Kept, so the dashboard hears why; tried again next round.
				this.outputs.set(key, {
					config,
					output: null,
					error: error.message,
				});
				if (this.failures.get(key) !== error.message) {
					this.log(`${describe(config)}: ${error.message}`);
				}
				this.failures.set(key, error.message);
			}
		}
	}

	status() {
		return [...this.outputs.values()].map(({ config, output, error }) =>
			output
				? output.status()
				: {
						id: config.id,
						...(config.kind ? { kind: config.kind } : {}),
						ndiName: config.ndiName,
						state: "error",
						connections: 0,
						fps: 0,
						width: config.width,
						height: config.height,
						error,
					},
		);
	}

	stopAll() {
		for (const { output } of this.outputs.values()) output?.stop();
		this.outputs.clear();
	}
}

/**
 * The key for the server: a fixed one, or a file read again on every request
 * — the server rewrites it when the key is replaced, and it may not be there
 * yet when the sender starts.
 */
export function tokenFrom({ tokenFile, token, read }) {
	if (!tokenFile) return token;
	return () => {
		try {
			return read(tokenFile).trim() || token;
		} catch {
			return token;
		}
	};
}

/**
 * Follows a notGT server: every `pollMs` asks what to send, applies it to
 * the controller, and reports how each out is doing. The sources stay as
 * they are while the server is away; a key the server refuses (replaced in
 * the dashboard) takes them down. Returns a function that stops it.
 * @param {object} o
 * @param {ServerClient} o.client
 * @param {Controller} o.controller
 * @param {object} o.sender what the report says about this sender:
 *   { id, host, platform, version }
 * @param {() => string} o.ndiVersion
 * @param {() => (string | undefined)} o.discoveryProblem why receivers may
 *   not find the sources (no Avahi), checked every round
 */
export function followServer({
	client,
	controller,
	sender,
	ndiVersion,
	discoveryProblem,
	log,
	pollMs,
	server,
}) {
	let stopped = false;
	let timer;
	let lastProblem = "";
	let discovery = discoveryProblem();
	if (discovery) log(discovery);
	log(`following ${server}`);
	const tick = async () => {
		try {
			controller.apply(await client.outputs());
			// Checked every round: starting Avahi is enough, no restart.
			const now = discoveryProblem();
			if (now !== discovery)
				log(now ?? "avahi-daemon is running: receivers can find the sources");
			discovery = now;
			await client.report({
				...sender,
				ndi: ndiVersion(),
				outs: controller
					.status()
					.map((out) =>
						discovery && !out.warning && !out.error
							? { ...out, warning: discovery }
							: out,
					),
			});
			if (lastProblem) log("the server answers again");
			lastProblem = "";
		} catch (error) {
			const problem = error.cause?.code ?? error.message;
			if (error.refused) controller.apply([]);
			if (problem !== lastProblem) {
				const cause = error.cause?.code ? ` (${error.cause.code})` : "";
				log(`server ${server}: ${error.message}${cause}; trying again`);
			}
			lastProblem = problem;
		}
		if (!stopped) timer = setTimeout(tick, pollMs);
	};
	tick();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

/** Talks to the notGT server's `/api`. */
export class ServerClient {
	/**
	 * @param {object} o
	 * @param {boolean} [o.spout] ask for the outs shared over Spout too: only
	 *   Windows has Spout
	 */
	constructor({ server, token, fetch = globalThis.fetch, spout = process.platform === "win32" }) {
		this.server = server.endsWith("/") ? server : `${server}/`;
		this.token = token;
		this.fetch = fetch;
		this.spout = spout;
	}

	headers(extra = {}) {
		// The key may come from a file that is rewritten when the key changes.
		const token = typeof this.token === "function" ? this.token() : this.token;
		return {
			Accept: "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...extra,
		};
	}

	async request(path, init = {}) {
		const response = await this.fetch(new URL(path, this.server), {
			...init,
			headers: this.headers(init.headers),
			signal: AbortSignal.timeout(5000),
		});
		if (response.status === 401 || response.status === 403) {
			const error = new Error(
				`the server refused the key (${response.status}): pass --token with the key shown in Titles & Outs → NDI senders, or the server's apiToken`,
			);
			error.refused = true;
			throw error;
		}
		if (response.status === 404) {
			throw new Error(
				"the server has no /api/ndi: it is older than notGT 0.11",
			);
		}
		if (!response.ok) throw new Error(`the server answered ${response.status}`);
		return response.json();
	}

	async outputs() {
		return configsFromServer(
			await this.request(this.spout ? "api/ndi?spout=1" : "api/ndi"),
			this.server,
		);
	}

	async report(status) {
		await this.request("api/ndi/status", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(status),
		});
	}
}
