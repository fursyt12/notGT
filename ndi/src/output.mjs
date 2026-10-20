/**
 * One out as one NDI source — or, for a config of kind "spout", one Spout
 * sender (../spout's sink: the GPU's texture when Chromium shares it, the
 * bitmap otherwise): the out page rendered in an offscreen window,
 * each painted frame handed to NDI by a sink. When Chromium draws on the GPU
 * the frame stays a texture there, converted to NDI's own format by:
 *  - `NativeSink` (native-sink.mjs): the native addon, in this process;
 *  - `GpuSink` (gpu/sink.mjs): a hidden page, with WebGL2;
 * and otherwise, or when no GPU sink works, `CpuSink` (cpu-sink.mjs): the
 * frame comes as a bitmap, converted where it changed.
 *
 * The GPU sinks are tried in the order asked for, and the CPU one always
 * comes last. Giving one up is never quiet: the log says which, why, and
 * what converts instead, and so does the dashboard (the out's warning).
 *
 * What it costs is kept to what is seen:
 *  - Chromium paints only when something on the page moves, so a still title
 *    or an empty out costs no drawing and no converting; the last frame is
 *    sent again at the out's rate, because receivers want a steady one;
 *  - with nobody receiving the source, the page is painted once a second at
 *    most and nothing is converted or sent — it keeps running, so a title on
 *    air is there the moment someone connects. (Pausing painting outright
 *    looks cheaper, but Chromium then resumes with the picture from before
 *    the pause, and whatever changed in between never shows.)
 *  - NDI compresses and sends on its own threads.
 */
import { BrowserWindow } from "electron";
import { CpuSink } from "./cpu-sink.mjs";
import { GpuSink } from "./gpu/sink.mjs";
import { NativeSink } from "./native-sink.mjs";

const WATCH_MS = 500;
/** Painting rate while nobody receives: the lowest Chromium takes. */
const IDLE_FPS = 1;
const RETRY_MS = 3000;
/** What each converter is called in the log and the dashboard. */
const LABELS = {
	native: "the native GPU converter",
	webgl: "WebGL2 on the GPU",
	spout: "Spout on the GPU",
	cpu: "the CPU",
};

export class Output {
	/**
	 * @param {object} options
	 * @param {import("./ndi.mjs").Ndi} options.ndi
	 * @param {import("./controller.mjs").OutputConfig} options.config
	 * @param {(line: string) => void} options.log
	 * @param {boolean} [options.gpu] Chromium draws on the GPU: keep frames there
	 * @param {string[]} [options.converters] GPU converters to try, best
	 *   first: "native", "webgl"
	 * @param {{ module?: any, renderNode?: string, vendorId?: number, deviceId?: number, why?: string }} [options.native]
	 *   the native addon, or why there is none
	 * @param {{ module?: any, Sink?: any, vendorId?: number, deviceId?: number, why?: string }} [options.spout]
	 *   for a Spout out: the Spout library (../spout), or why there is none
	 */
	constructor({ ndi, config, log, gpu = false, converters = ["webgl"], native, spout }) {
		this.ndi = ndi;
		this.config = config;
		this.log = log;
		this.state = "loading";
		this.error = undefined;
		this.connections = 0;
		this.watching = false;
		this.fps = 0;
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
		this.native = native;
		this.spout = spout;
		/** Converters still to try, best first; the CPU is always last. */
		this.chain = gpu ? (config.kind === "spout" ? ["spout"] : [...converters]) : [];
		/** Why a converter was given up, for the dashboard. */
		this.renderNote = undefined;
		this.sink = this.nextSink();
	}

	/** The first converter left that starts; the CPU when none does. */
	nextSink() {
		while (this.chain.length) {
			const kind = this.chain.shift();
			try {
				const sink = this.makeSink(kind);
				this.sinkKind = kind;
				return sink;
			} catch (error) {
				this.giveUp(kind, error.message);
			}
		}
		this.sinkKind = "cpu";
		if (this.config.kind === "spout") return this.spoutSink(false);
		return new CpuSink({ ndi: this.ndi, config: this.config });
	}

	spoutSink(shared) {
		if (!this.spout?.module)
			throw new Error(this.spout?.why ?? "Spout needs its library (spout/)");
		return new this.spout.Sink({
			native: this.spout.module,
			config: this.config,
			shared,
			gpu: this.spout,
			log: this.log,
			onFail: (reason) => this.fallBack(reason),
		});
	}

	makeSink(kind) {
		const onFail = (reason) => this.fallBack(reason);
		if (kind === "native") {
			if (!this.native?.module)
				throw new Error(this.native?.why ?? "the native converter is not loaded");
			return new NativeSink({
				native: this.native.module,
				config: this.config,
				ndiFile: this.ndi.file,
				gpu: this.native,
				log: this.log,
				onFail,
			});
		}
		if (kind === "spout") return this.spoutSink(true);
		if (kind === "webgl")
			return new GpuSink({
				config: this.config,
				ndiFile: this.ndi.file,
				log: this.log,
				onFail,
			});
		throw new Error(`there is no converter called ${kind}`);
	}

	/** Says that `kind` is given up, why, and what comes next. */
	giveUp(kind, reason) {
		const next = LABELS[this.chain[0] ?? "cpu"];
		const label = LABELS[kind] ?? kind;
		this.log(
			`${this.config.ndiName}: ${label} cannot be used: ${reason}; converting with ${next} instead`,
		);
		this.renderNote = `${label} cannot be used here (${reason}); converting with ${next}`;
	}

	start() {
		this.timers.push(setInterval(() => this.watch(), WATCH_MS));
		let lastCount = 0;
		this.timers.push(
			setInterval(() => {
				const sent = this.sink.sent;
				this.fps = Math.max(0, sent - lastCount) / 2;
				lastCount = sent;
				if (this.watching) {
					this.debug(
						`${this.config.ndiName}: ${this.fps} fps on ${this.sink.name}, ${this.sink.report(2)}, ${this.connections} receiver(s)`,
					);
				}
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
				offscreen: {
					useSharedTexture: this.sink.shared,
					deviceScaleFactor: this.scale,
				},
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

		contents.on("paint", (event, dirty, image) => {
			if (this.window === window && !this.stopped)
				this.paint(event, dirty, image);
			else event.texture?.release();
		});
		contents.on("did-finish-load", () => {
			// Set again once loaded: at 2× and up Chromium drops the zoom it was given.
			contents.setZoomFactor(zoom);
			this.state = this.watching ? "sending" : "idle";
			this.error = undefined;
			this.sink.loaded?.();
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
	checkSize({ width, height }) {
		if (this.sizeChecked) return;
		this.sizeChecked = true;
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
		this.connections = this.sink.connections();
		if (this.connections > 0 && !this.watching) {
			this.debug(
				`${this.config.ndiName}: ${this.connections} receiver(s), painting`,
			);
			this.watching = true;
			this.sink.setWatching(true);
			// Chromium paints at whole rates; 29.97 is painted at 30 and sent as 30000/1001.
			contents.setFrameRate(Math.round(this.config.fps));
			contents.invalidate();
			if (this.state === "idle") this.state = "sending";
		} else if (this.connections === 0 && this.watching) {
			this.debug(`${this.config.ndiName}: no receivers, resting`);
			this.watching = false;
			this.sink.setWatching(false);
			contents.setFrameRate(IDLE_FPS);
			if (this.state === "sending") this.state = "idle";
		}
	}

	paint(event, dirty, image) {
		const texture = event.texture;
		if (texture) {
			const info = texture.textureInfo;
			this.checkSize(info.visibleRect ?? info.codedSize);
			if (this.sink.shared) this.sink.paintTexture(texture);
			else texture.release();
			return;
		}
		// With shared textures, an invalidate() comes back as a paint with no
		// picture at all: nothing to do with it.
		if (this.sink.shared) return;
		if (image.isEmpty()) {
			// The page has no picture yet.
			if (this.watching) {
				this.repaintSoon();
				// Never a picture at all, though: say so, rather than send nothing.
				this.emptyPaints = (this.emptyPaints ?? 0) + 1;
				if (this.emptyPaints === 50) {
					this.warning = "Chromium paints this out with no picture in it: nothing is sent — NOTGT_NDI_DEBUG=1 shows the sender's messages";
					this.log(`${this.config.ndiName}: ${this.warning}`);
				}
			}
			return;
		}
		if (this.emptyPaints >= 50) this.warning = undefined;
		this.emptyPaints = 0;
		this.checkSize(image.getSize());
		if (!this.sink.shared) this.sink.paint(dirty, image);
	}

	repaintSoon() {
		if (this.repaint) return;
		this.repaint = setTimeout(() => {
			this.repaint = undefined;
			if (!this.stopped && this.window) this.window.webContents.invalidate();
		}, 100);
	}

	/**
	 * The converter could not go on for this out: the same out, with the
	 * next one. The NDI source goes down and comes back under the same name.
	 */
	async fallBack(reason) {
		if (this.stopped || this.fallingBack || !this.sink.shared) return;
		this.fallingBack = true;
		this.giveUp(this.sinkKind, reason);
		try {
			await this.sink.stop();
		} catch (error) {
			this.log(`${this.config.ndiName}: the converter given up did not stop cleanly: ${error.message}`);
		}
		this.fallingBack = false;
		if (this.stopped) return;
		this.replaceSink();
	}

	/**
	 * The next converter, and a window that hands it frames as it takes them.
	 * Never quiet when it fails: the out shows why, and it is tried again.
	 */
	replaceSink() {
		try {
			this.sink = this.nextSink();
			this.sink.setWatching(this.watching);
			this.emptyPaints = 0;
			this.openWindow();
			this.debug(`${this.config.ndiName}: now converting with ${this.sink.name}`);
		} catch (error) {
			const message = `no converter could take over: ${error.message}`;
			this.log(`${this.config.ndiName}: ${message}; trying again`);
			this.state = "error";
			this.error = message;
			clearTimeout(this.retrySink);
			this.retrySink = setTimeout(() => !this.stopped && this.replaceSink(), RETRY_MS);
		}
	}

	status() {
		return {
			id: this.config.id,
			...(this.config.kind ? { kind: this.config.kind } : {}),
			ndiName: this.config.ndiName,
			state: this.state,
			connections: this.connections,
			fps: Math.round(this.fps * 10) / 10,
			...this.sink.size(),
			render: this.sink.kind,
			...(this.error ? { error: this.error } : {}),
			...(this.warning || this.renderNote
				? {
						warning: [this.warning, this.renderNote]
							.filter(Boolean)
							.join("; "),
					}
				: {}),
		};
	}

	stop() {
		this.stopped = true;
		for (const timer of this.timers) clearInterval(timer);
		clearTimeout(this.retry);
		clearTimeout(this.retrySink);
		clearTimeout(this.repaint);
		if (this.window && !this.window.isDestroyed()) this.window.destroy();
		this.window = undefined;
		return this.sink.stop();
	}
}
