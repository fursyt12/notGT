/**
 * One out as one NDI source: the out page rendered in an offscreen window,
 * each painted frame handed to NDI.
 *
 * What it costs is kept to what is seen:
 *  - Chromium paints only when something on the page moves, so a still title
 *    or an empty out costs no drawing and no converting; the last frame is
 *    sent again at the out's rate, because receivers want a steady one;
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
		this.frames = new FramePair(config.width, config.height, {
			alpha: config.alpha,
		});
		this.sender = ndi.createSender(config.ndiName, { groups: config.groups });
		this.window = undefined;
		this.timers = [];
		this.stopped = false;
		this.debug = process.env.NOTGT_NDI_DEBUG ? log : () => {};
		/**
		 * Device pixels per window pixel. A desktop cuts a window to its screen,
		 * offscreen or not; drawing a smaller window at 2× or 3× gets the whole
		 * picture back where Chromium honours it (see checkSize).
		 */
		this.scale = 1;
		this.sizeChecked = false;
		this.sizeGivenUp = false;
		/**
		 * Share of the asked size the picture is drawn at — below 1 only when
		 * the screen leaves no other way; the whole out is then drawn smaller,
		 * never cut.
		 */
		this.shrink = 1;
		/** Said in the dashboard when the picture cannot come out at its size. */
		this.warning = undefined;
		/** Time spent in the paint handler: copying, converting, handing over. */
		this.busyMs = 0;
	}

	start() {
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
		this.openWindow();
	}

	/** The offscreen window, at `this.scale`; replaces the one there was. */
	openWindow() {
		if (this.window && !this.window.isDestroyed()) this.window.destroy();
		this.sizeChecked = false;
		const { designWidth } = this.config;
		const width = Math.round((this.config.width * this.shrink) / this.scale);
		const height = Math.round((this.config.height * this.shrink) / this.scale);
		// The page lays out at the out's own size, whatever it is drawn at.
		const zoom = width / designWidth;
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
				offscreen: { useSharedTexture: false, deviceScaleFactor: this.scale },
				zoomFactor: zoom,
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
		contents.setFrameRate(
			this.watching ? Math.round(this.config.fps) : IDLE_FPS,
		);
		contents.setAudioMuted(true);

		contents.on("paint", (_event, dirty, image) => {
			if (this.window === window) this.paint(dirty, image);
		});
		contents.on("did-finish-load", () => {
			// Set again once loaded: at 2× and up Chromium drops the zoom it was given.
			contents.setZoomFactor(zoom);
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
		this.load();
	}

	/**
	 * The first picture of a window says whether the desktop let it be the
	 * size asked. If not, it is tried once at a higher scale; if that does not
	 * help either, the picture goes out at the size it comes, and the
	 * dashboard says why.
	 */
	checkSize(image) {
		if (this.sizeChecked) return;
		this.sizeChecked = true;
		const { width, height } = image.getSize();
		const want = this.config;
		const expectWidth = Math.round(want.width * this.shrink);
		const expectHeight = Math.round(want.height * this.shrink);
		if (width === expectWidth && height === expectHeight) {
			if (this.scale > 1) {
				this.log(
					`${want.ndiName}: drawn at ${this.scale}× to fit the screen; ${width}×${height} as asked`,
				);
			}
			if (this.shrink === 1) this.warning = undefined;
			return;
		}
		if (!this.sizeGivenUp && this.scale === 1 && this.shrink === 1) {
			this.cut = { width, height };
			const scale = Math.ceil(
				Math.max(want.width / width, want.height / height),
			);
			if (scale >= 2 && scale <= 4) {
				this.log(
					`${want.ndiName}: the screen cuts the window to ${width}×${height}; drawing it at ${scale}× instead`,
				);
				this.scale = scale;
				setImmediate(() => !this.stopped && this.openWindow());
				return;
			}
		}
		if (!this.sizeGivenUp) {
			// No scale helps here: draw the whole out, smaller, inside the
			// window the screen allows — the right shape, nothing cut off.
			this.sizeGivenUp = true;
			const cut = this.cut ?? { width, height };
			this.scale = 1;
			this.shrink = Math.min(
				cut.width / want.width,
				cut.height / want.height,
				1,
			);
			const w = Math.round(want.width * this.shrink);
			const h = Math.round(want.height * this.shrink);
			this.warning = `this computer's screen, at its display scaling, is smaller than the out: the picture goes out ${w}×${h} instead of ${want.width}×${want.height} — lower the display scaling, or choose a smaller NDI picture size`;
			this.log(`${want.ndiName}: ${this.warning}`);
			setImmediate(() => !this.stopped && this.openWindow());
			return;
		}
		// Still not the size asked: send what comes, and say so.
		this.warning = `the picture goes out ${width}×${height} instead of ${want.width}×${want.height}: the screen of this computer is smaller than the out — choose a smaller NDI picture size`;
		this.log(`${want.ndiName}: ${this.warning}`);
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
			clearTimeout(this.repeat);
			contents.setFrameRate(IDLE_FPS);
			if (this.state === "sending") this.state = "idle";
		}
	}

	paint(dirty, image) {
		const began = performance.now();
		this.handle(dirty, image);
		this.busyMs += performance.now() - began;
	}

	handle(dirty, image) {
		if (this.stopped || !this.window) return;
		if (image.isEmpty()) {
			// The page has no picture yet.
			if (this.watching) this.repaintSoon();
			return;
		}
		this.checkSize(image);
		if (!this.watching) return;
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

	/** A newly painted frame. */
	send(buffer) {
		this.transmit(buffer);
		// Half a frame of grace, so a paint a little late is not sent twice.
		this.repeatSoon(1.5);
	}

	/**
	 * Receivers want a steady frame rate: OBS, Resolume and NDI Studio Monitor
	 * take a source that sends one frame a second for a 1 fps source, and
	 * stutter when it starts to move. So while someone watches and nothing is
	 * painted, the last frame goes out again at the out's rate — NDI compresses
	 * it again, nothing is drawn or converted.
	 */
	repeatSoon(frames) {
		clearTimeout(this.repeat);
		if (this.stopped || !this.watching) return;
		const frameMs = 1000 / this.config.fps;
		// Each repeat is due a frame after the last one was due, not after it
		// ran: timers run late, and a late timer must not slow the rate down.
		this.repeatDue =
			(frames === 1 ? this.repeatDue : performance.now()) + frames * frameMs;
		this.repeat = setTimeout(
			() => {
				if (this.stopped || !this.watching || !this.frames.current) return;
				this.transmit(this.frames.current);
				this.repeatSoon(1);
			},
			Math.max(0, this.repeatDue - performance.now()),
		);
	}

	transmit(buffer) {
		this.sender.sendAsync(buffer, this.frames.width, this.frames.height, {
			fps: this.config.fps,
			opaque: !this.config.alpha,
		});
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
			...(this.warning ? { warning: this.warning } : {}),
		};
	}

	stop() {
		this.stopped = true;
		for (const timer of this.timers) clearInterval(timer);
		clearTimeout(this.retry);
		clearTimeout(this.repaint);
		clearTimeout(this.repeat);
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
