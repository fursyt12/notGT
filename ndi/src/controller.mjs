/**
 * Keeps the NDI sources in step with the outs a notGT server asks for, and
 * tells the server how they are doing. Nothing here touches Electron or NDI:
 * the outputs come from the factory it is given.
 *
 *   GET  /api/ndi         { outs: [{ id, ndiName, url, width, height, designWidth, designHeight, fps, alpha, groups? }] }
 *   POST /api/ndi/status  { id, host, version, ndi, outs: [{ id, ndiName, state, connections, fps, width, height, error? }] }
 */

/**
 * @typedef {object} OutputConfig
 * @property {string} id
 * @property {string} ndiName
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
	}

	/** Starts what is new, restarts what changed, stops what is gone. */
	apply(configs) {
		const wanted = new Map(configs.map((config) => [config.id, config]));
		for (const [id, entry] of this.outputs) {
			const next = wanted.get(id);
			if (next && sameSource(entry.config, next)) continue;
			entry.output?.stop();
			this.outputs.delete(id);
			if (!next) this.log(`stopped “${entry.config.ndiName}”`);
		}
		for (const config of configs) {
			if (this.outputs.has(config.id)) continue;
			try {
				const output = this.create(config);
				output.start();
				this.outputs.set(config.id, { config, output });
				this.log(
					`sending “${config.ndiName}” ${config.width}×${config.height} @ ${config.fps} fps`,
				);
			} catch (error) {
				// Kept, so the dashboard hears why; tried again when the config changes.
				this.outputs.set(config.id, {
					config,
					output: null,
					error: error.message,
				});
				this.log(`“${config.ndiName}”: ${error.message}`);
			}
		}
	}

	status() {
		return [...this.outputs.values()].map(({ config, output, error }) =>
			output
				? output.status()
				: {
						id: config.id,
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

/** Talks to the notGT server's `/api`. */
export class ServerClient {
	constructor({ server, token, fetch = globalThis.fetch }) {
		this.server = server.endsWith("/") ? server : `${server}/`;
		this.token = token;
		this.fetch = fetch;
	}

	headers(extra = {}) {
		return {
			Accept: "application/json",
			...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
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
		return configsFromServer(await this.request("api/ndi"), this.server);
	}

	async report(status) {
		await this.request("api/ndi/status", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(status),
		});
	}
}
