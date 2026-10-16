/**
 * One out as one NDI source: the out page rendered in an offscreen window,
 * each painted frame handed to NDI.
 *
 * What it costs is kept to what is seen:
 *  - Chromium paints only when something on the page moves, so a still title
 *    or an empty out sends nothing;
 *  - only the changed rectangle of a frame is converted (see `frame.mjs`);
 *  - with nobody receiving the source, the page is painted once a second at
 *    most and nothing is converted or sent — it keeps running, so a title on
 *    air is there the moment someone connects. (Pausing painting outright
 *    looks cheaper, but Chromium then resumes with the picture from before
 *    the pause, and whatever changed in between never shows.)
 *  - NDI compresses and sends on its own threads.
 */
import { BrowserWindow } from "electron";
import { FramePair } from "./frame.mjs";

/** While nothing moves, the last frame is sent again this often, for receivers that time out. */
const KEEPALIVE_MS = 1000;
const WATCH_MS = 500;
/** Painting rate while nobody receives: the lowest Chromium takes. */
const IDLE_FPS = 1;
const RETRY_MS = 3000;

export class Output {
	/**
	 * @param {object} options
	 * @param {import("./ndi.mjs").Ndi} options.ndi
	 * @param {import("./controller.mjs").OutputConfig} options.config
	 * @param {(line: string) => void} options.log
	 */
	constructor({ ndi, config, log }) {
		this.ndi = ndi;
		this.config = config;
		this.log = log;
		this.state = "loading";
		this.error = undefined;
		this.connections = 0;
		this.watching = false;
		this.sent = 0;
		this.fps = 0;
		this.lastSend = 0;
		this.frames = new FramePair(config.width, config.height, {
			alpha: config.alpha,
		});
		this.sender = ndi.createSender(config.ndiName, { groups: config.groups });
		this.window = undefined;
		this.timers = [];
		this.stopped = false;
		this.debug = process.env.NOTGT_NDI_DEBUG ? log : () => {};
		/** Time spent in the paint handler: copying, converting, handing over. */
		this.busyMs = 0;
	}

	start() {
		const { width, height, designWidth } = this.config;
		const window = new BrowserWindow({
			show: false,
			width,
			height,
			useContentSize: true,
			frame: false,
			transparent: true,
			backgroundColor: "#00000000",
			enableLargerThanScreen: true,
			paintWhenInitiallyHidden: true,
			webPreferences: {
				offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
				// The page lays out at the out's own size and is drawn smaller.
				zoomFactor: width / designWidth,
				backgroundThrottling: false,
				autoplayPolicy: "no-user-gesture-required",
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: false,
			},
		});
		this.window = window;
		const contents = window.webContents;
		contents.setFrameRate(IDLE_FPS);
		contents.setAudioMuted(true);

		contents.on("paint", (_event, dirty, image) => this.paint(dirty, image));
		contents.on("did-finish-load", () => {
			this.state = this.watching ? "sending" : "idle";
			this.error = undefined;
		});
		contents.on(
			"did-fail-load",
			(_event, code, description, _url, isMainFrame) => {
				if (!isMainFrame || code === -3) return; // -3: replaced by a newer load
				this.fail(`could not load the out page: ${description} (${code})`);
			},
		);
		contents.on("render-process-gone", (_event, details) => {
			this.fail(`the page stopped: ${details.reason}`);
		});
		contents.setWindowOpenHandler(() => ({ action: "deny" }));

		this.timers.push(setInterval(() => this.watch(), WATCH_MS));
		let lastCount = 0;
		this.timers.push(
			setInterval(() => {
				this.fps = (this.sent - lastCount) / 2;
				lastCount = this.sent;
				if (this.watching) {
					this.debug(
						`${this.config.ndiName}: ${this.fps} fps, ${this.frames.converted} px converted, ${(this.busyMs / 20).toFixed(1)}% of a core in paint, ${this.connections} receiver(s)`,
					);
				}
				this.busyMs = 0;
			}, 2000),
		);
		this.load();
	}

	load() {
		if (this.stopped || !this.window) return;
		this.state = "loading";
		this.window.webContents.loadURL(this.config.url).catch(() => {
			// `did-fail-load` reports it.
		});
	}

	fail(message) {
		if (this.stopped) return;
		this.state = "error";
		if (this.error !== message)
			this.log(`${this.config.ndiName}: ${message}; retrying`);
		this.error = message;
		clearTimeout(this.retry);
		this.retry = setTimeout(() => this.load(), RETRY_MS);
	}

	/** Follows the receivers: paints for them, rests without them. */
	watch() {
		if (this.stopped || !this.window) return;
		const contents = this.window.webContents;
		this.connections = this.sender.connections(0);
		if (this.connections > 0 && !this.watching) {
			this.debug(
				`${this.config.ndiName}: ${this.connections} receiver(s), painting`,
			);
			this.watching = true;
			this.frames.invalidate();
			// The last frame sent may be from long ago; the keepalive waits for a fresh one.
			this.frames.current = null;
			// Chromium paints at whole rates; 29.97 is painted at 30 and sent as 30000/1001.
			contents.setFrameRate(Math.round(this.config.fps));
			contents.invalidate();
			if (this.state === "idle") this.state = "sending";
		} else if (this.connections === 0 && this.watching) {
			this.debug(`${this.config.ndiName}: no receivers, resting`);
			this.watching = false;
			contents.setFrameRate(IDLE_FPS);
			if (this.state === "sending") this.state = "idle";
		}
		if (
			this.watching &&
			this.frames.current &&
			Date.now() - this.lastSend >= KEEPALIVE_MS
		) {
			this.send(this.frames.current);
		}
	}

	paint(dirty, image) {
		const began = performance.now();
		this.handle(dirty, image);
		this.busyMs += performance.now() - began;
	}

	handle(dirty, image) {
		if (this.stopped || !this.window) return;
		if (!this.watching) return;
		if (image.isEmpty()) {
			// The page has no picture yet.
			this.repaintSoon();
			return;
		}
		const size = image.getSize();
		if (
			size.width !== this.frames.width ||
			size.height !== this.frames.height
		) {
			// The window came out another size than asked; follow the picture.
			this.sender.flush();
			this.frames = new FramePair(size.width, size.height, {
				alpha: this.config.alpha,
			});
		}
		const full = this.frames.width;
		const buffer = this.frames.update(dirty, (rect) => {
			const whole =
				rect.x === 0 &&
				rect.y === 0 &&
				rect.width === full &&
				rect.height === this.frames.height;
			const data = (whole ? image : image.crop(rect)).toBitmap();
			return { data, stride: rowBytes(data, rect) };
		});
		this.send(buffer);
	}

	repaintSoon() {
		if (this.repaint) return;
		this.repaint = setTimeout(() => {
			this.repaint = undefined;
			if (!this.stopped && this.window) this.window.webContents.invalidate();
		}, 100);
	}

	send(buffer) {
		this.sender.sendAsync(buffer, this.frames.width, this.frames.height, {
			fps: this.config.fps,
			opaque: !this.config.alpha,
		});
		this.lastSend = Date.now();
		this.sent++;
	}

	status() {
		return {
			id: this.config.id,
			ndiName: this.config.ndiName,
			state: this.state,
			connections: this.connections,
			fps: Math.round(this.fps * 10) / 10,
			width: this.frames.width,
			height: this.frames.height,
			...(this.error ? { error: this.error } : {}),
		};
	}

	stop() {
		this.stopped = true;
		for (const timer of this.timers) clearInterval(timer);
		clearTimeout(this.retry);
		clearTimeout(this.repaint);
		if (this.window && !this.window.isDestroyed()) this.window.destroy();
		this.window = undefined;
		// Destroying the sender waits for NDI to let go of the last frame.
		this.sender.destroy();
	}
}

/** Bytes per row of a bitmap that holds `rect`, padding included. */
function rowBytes(data, rect) {
	if (rect.height <= 1) return rect.width * 4;
	return (data.length - rect.width * 4) / (rect.height - 1);
}
