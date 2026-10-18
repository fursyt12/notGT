/**
 * The GPU half of an out, as the main process sees it. Each frame the out
 * page paints arrives as a texture on the GPU; it goes to the processor page
 * (`processor.mjs`), which converts it there and sends it to NDI. The pixels
 * never pass through this process.
 *
 * Every texture goes to the processor, watched or not (unwatched, the page
 * paints once a second at most): a still page paints once, and an
 * invalidate() does not bring a texture back, so a picture thrown away is
 * one that may never come again.
 *
 * At most two textures are with the processor at a time; Chromium has only a
 * few, and one it waits for is one it cannot paint into. A paint that comes
 * while both are out, or before the processor is ready, is kept — only the
 * newest — and goes next, so the last picture of an animation is never the
 * one left behind.
 */
import { fileURLToPath } from "node:url";
import { BrowserWindow, sharedTexture } from "electron";

const PAGE = fileURLToPath(new URL("./processor.html", import.meta.url));
const IN_FLIGHT = 2;
/** How long the processor has to get going before the CPU takes over. */
const START_MS = 10_000;
/**
 * How long a first frame may take once the page is loaded. Where Chromium
 * can draw on the GPU but not share what it drew (no GBM, under Xvfb), no
 * frame ever comes.
 */
const FIRST_FRAME_MS = 5000;
/** How long a frame may stay with the processor before the converter is given up. */
const STUCK_MS = 3000;

export class GpuSink {
	/**
	 * @param {object} options
	 * @param {import("../controller.mjs").OutputConfig} options.config
	 * @param {string} [options.ndiFile] the NDI library the main process opened
	 * @param {(line: string) => void} options.log
	 * @param {(reason: string) => void} options.onFail the CPU should take over
	 */
	constructor({ config, ndiFile, log, onFail }) {
		this.config = config;
		this.log = log;
		this.onFail = onFail;
		this.debug = process.env.NOTGT_NDI_DEBUG ? log : () => {};
		/** Frames come as shared textures. */
		this.shared = true;
		this.name = "GPU";
		this.kind = "gpu";
		this.renderer = "";
		this.ready = false;
		this.failed = false;
		this.watching = false;
		this.stats = { connections: 0, sent: 0 };
		this.width = config.width;
		this.height = config.height;
		this.nextId = 0;
		/** Textures with the processor, by id. */
		this.out = new Map();
		/** The newest paint that had to wait. */
		this.waiting = undefined;
		/** When each texture with the processor went to it. */
		this.sentAt = new Map();

		const window = new BrowserWindow({
			show: false,
			width: 16,
			height: 16,
			webPreferences: {
				// It never shows anything; offscreen keeps it off any display.
				offscreen: true,
				nodeIntegration: true,
				contextIsolation: false,
				sandbox: false,
				backgroundThrottling: false,
				spellcheck: false,
			},
		});
		this.window = window;
		const contents = window.webContents;
		contents.setFrameRate(1);
		contents.ipc.on("ready", (_event, { renderer }) => {
			clearTimeout(this.startTimer);
			this.ready = true;
			this.renderer = renderer;
			// What was painted meanwhile.
			this.passWaiting();
		});
		contents.ipc.on("log", (_event, line) =>
			this.debug(`${config.ndiName}: ${line}`),
		);
		contents.ipc.on("done", (_event, id) => this.done(id));
		contents.ipc.on("stats", (_event, stats) => {
			this.stats = stats;
		});
		contents.ipc.on("failed", (_event, reason) => this.fail(reason));
		contents.on("render-process-gone", (_event, details) =>
			this.fail(`the GPU processor stopped: ${details.reason}`),
		);
		this.startTimer = setTimeout(
			() => this.fail("the GPU processor did not start in time"),
			START_MS,
		);
		// A frame the processor never gives back stalls the out for good: the
		// textures it holds are the ones Chromium paints into.
		this.watchdog = setInterval(() => {
			const now = Date.now();
			for (const sentAt of this.sentAt.values()) {
				if (now - sentAt > STUCK_MS) {
					this.fail(`the GPU processor has not finished a frame in ${STUCK_MS / 1000} s`);
					return;
				}
			}
		}, 1000);
		contents
			.loadFile(PAGE, {
				query: {
					config: JSON.stringify({
						ndiName: config.ndiName,
						groups: config.groups,
						fps: config.fps,
						alpha: config.alpha,
						ndiFile,
					}),
				},
			})
			.catch((error) =>
				this.fail(`the GPU processor did not load: ${error.message}`),
			);
	}

	get sent() {
		return this.stats.sent;
	}

	connections() {
		return this.stats.connections;
	}

	size() {
		return { width: this.width, height: this.height };
	}

	/** The processor watches the receivers itself. */
	setWatching(watching) {
		this.watching = watching;
	}

	/** The out page has loaded: a first frame is due. */
	loaded() {
		if (this.framed || this.failed) return;
		clearTimeout(this.frameTimer);
		this.frameTimer = setTimeout(
			() => this.fail("no frame came as a shared texture"),
			FIRST_FRAME_MS,
		);
	}

	/** A painted frame, as a texture this sink has to release. */
	paintTexture(texture) {
		if (this.failed) {
			texture.release();
			return;
		}
		if (!this.framed) {
			this.framed = true;
			clearTimeout(this.frameTimer);
		}
		const { width, height } =
			texture.textureInfo.visibleRect ?? texture.textureInfo.codedSize;
		this.width = width;
		this.height = height;
		if (!this.ready || this.out.size >= IN_FLIGHT) {
			this.dropWaiting();
			this.waiting = texture;
			return;
		}
		this.pass(texture);
	}

	async pass(texture) {
		const id = ++this.nextId;
		this.out.set(id, texture);
		this.sentAt.set(id, Date.now());
		let imported;
		try {
			imported = sharedTexture.importSharedTexture({
				textureInfo: texture.textureInfo,
			});
			await sharedTexture.sendSharedTexture(
				{
					frame: this.window.webContents.mainFrame,
					importedSharedTexture: imported,
				},
				id,
			);
		} catch (error) {
			this.done(id);
			this.fail(
				`a frame could not be handed to the GPU processor: ${error.message}`,
			);
		} finally {
			imported?.release();
		}
	}

	/** The processor has its copy of texture `id`. */
	done(id) {
		const texture = this.out.get(id);
		if (!texture) return;
		this.out.delete(id);
		this.sentAt.delete(id);
		texture.release();
		this.passWaiting();
	}

	passWaiting() {
		if (!this.waiting || this.failed || !this.ready) return;
		const next = this.waiting;
		this.waiting = undefined;
		this.pass(next);
	}

	dropWaiting() {
		this.waiting?.release();
		this.waiting = undefined;
	}

	fail(reason) {
		if (this.failed) return;
		this.failed = true;
		clearInterval(this.watchdog);
		clearTimeout(this.startTimer);
		clearTimeout(this.frameTimer);
		this.dropWaiting();
		this.onFail(reason);
	}

	report() {
		const { gpuMs = 0, readMs = 0, converted = 0 } = this.stats;
		return `${converted} frames converted on the GPU, ${gpuMs.toFixed(1)} ms on the GPU and ${readMs.toFixed(1)} ms reading back each`;
	}

	/** Takes the NDI source down; resolves once it is gone. */
	stop() {
		clearInterval(this.watchdog);
		clearTimeout(this.startTimer);
		clearTimeout(this.frameTimer);
		this.dropWaiting();
		for (const texture of this.out.values()) texture.release();
		this.out.clear();
		this.sentAt.clear();
		const window = this.window;
		if (!window || window.isDestroyed()) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				if (!window.isDestroyed()) window.destroy();
				resolve();
			};
			// NDI lets go of its last frame first; a stuck page is not waited for.
			const timer = setTimeout(finish, 2000);
			window.webContents.ipc.once("stopped", finish);
			window.webContents.send("stop");
		});
	}
}
