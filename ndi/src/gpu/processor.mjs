/**
 * The GPU half of an out: a hidden page with no picture of its own, which
 * gets each frame the out page paints as a texture on the GPU — never in
 * memory — and turns it into what NDI sends:
 *
 *   texture ─ shader ─► UYVA / UYVY ─ one read back ─► NDI
 *
 * The shader divides the alpha out and converts to NDI's own 4:2:2 (see
 * `shaders.mjs`), so the CPU neither converts nor copies pixels, and reads
 * back 3 bytes a pixel (2 when opaque) instead of 4. Two ways to do it:
 *  - WebGL2, the one used: a fragment shader, read back into memory;
 *  - WebGPU, only when asked for (NOTGT_NDI_CONVERTER=webgpu) and only
 *    where Chromium offers a real adapter on its own: a compute shader, and
 *    NDI reads straight out of the mapped read-back buffer. Unproven on
 *    any platform; it is never forced on.
 *
 * The NDI source lives here, next to the pixels. When frames go out is the
 * out's frame clock (`../clock.mjs`), every sink's: no more frames than the
 * out's rate, following Chromium's own clock, and the last one again while
 * nothing is painted. Frames are converted
 * whether anyone watches or not (unwatched, the page paints ten times a second
 * at most), so the newest is there the moment a receiver connects.
 *
 * It talks to `sink.mjs` in the main process:
 *   → texture (sharedTexture), "stop"
 *   ← "ready", "done" (a texture may be reused), "connections" (as they
 *     change), "stats", "log", "trace", "failed", "stopped"
 */
import { createRequire } from "node:module";
import { FrameClock } from "../clock.mjs";
import { loadNdi } from "../ndi.mjs";
import { Tally } from "../telemetry.mjs";
import {
	VERTEX_SHADER,
	colourStandard,
	computeShader,
	fragmentShader,
	isSoftwareRenderer,
	layout,
} from "./shaders.mjs";

const require = createRequire(import.meta.url);
const { ipcRenderer, sharedTexture } = require("electron");

const config = JSON.parse(
	new URLSearchParams(globalThis.location.search).get("config"),
);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

/** How long the GPU may take over one frame before it is given up. */
const FENCE_MS = 2000;

let failed = false;
function fail(message) {
	if (failed) return;
	failed = true;
	send("failed", message);
}

/** WebGL2: draws both planes into one RGBA8 picture, read back by a PBO. */
class WebglConverter {
	static create() {
		const canvas = new OffscreenCanvas(1, 1);
		const gl = canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			preserveDrawingBuffer: false,
			powerPreference: "high-performance",
		});
		if (!gl) throw new Error("WebGL2 is not available");
		canvas.addEventListener("webglcontextlost", () =>
			fail("the GPU took the WebGL context away"),
		);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
		gl.bindVertexArray(gl.createVertexArray());
		const info = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = String(
			gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
		);
		return {
			name: `WebGL2 on ${renderer}`,
			software: isSoftwareRenderer(renderer),
			make: (width, height, alpha) =>
				new WebglConverter(gl, width, height, alpha),
		};
	}

	constructor(gl, width, height, alpha) {
		this.gl = gl;
		this.width = width;
		this.height = height;
		this.shape = layout(width, height, alpha);
		const program = gl.createProgram();
		for (const [type, source] of [
			[gl.VERTEX_SHADER, VERTEX_SHADER],
			[gl.FRAGMENT_SHADER, fragmentShader(width, height, alpha)],
		]) {
			const shader = gl.createShader(type);
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
				throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
			gl.attachShader(program, shader);
		}
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS))
			throw new Error(`shader: ${gl.getProgramInfoLog(program)}`);
		this.program = program;

		this.source = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.source);
		for (const [key, value] of [
			[gl.TEXTURE_MIN_FILTER, gl.NEAREST],
			[gl.TEXTURE_MAG_FILTER, gl.NEAREST],
			[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
			[gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
		])
			gl.texParameteri(gl.TEXTURE_2D, key, value);

		const { drawWidth, drawHeight, bytes } = this.shape;
		this.target = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.target);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, drawWidth, drawHeight);
		this.framebuffer = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
		gl.framebufferTexture2D(
			gl.FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			this.target,
			0,
		);
		this.pack = gl.createBuffer();
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pack);
		gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
		// One being read by NDI, one waiting for its turn, one being written.
		this.buffers = [0, 1, 2].map(() => Buffer.alloc(bytes));
	}

	/** Draws `frame` into `this.buffers[index]`; `uploaded` runs once the GPU has its copy. */
	async convert(frame, index, uploaded) {
		const { gl } = this;
		const { drawWidth, drawHeight } = this.shape;
		gl.useProgram(this.program);
		gl.bindTexture(gl.TEXTURE_2D, this.source);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
		gl.viewport(0, 0, drawWidth, drawHeight);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pack);
		gl.readPixels(0, 0, drawWidth, drawHeight, gl.RGBA, gl.UNSIGNED_BYTE, 0);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
		const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
		gl.flush();
		const queued = performance.now();
		// Waited for without blocking: the GPU draws while the page idles —
		// but not for ever: a GPU that never finishes is given up.
		while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
			if (performance.now() - queued > FENCE_MS) {
				gl.deleteSync(fence);
				throw new Error(`the GPU did not finish a frame in ${FENCE_MS / 1000} s`);
			}
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		gl.deleteSync(fence);
		uploaded();
		const drawn = performance.now();
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pack);
		gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.buffers[index]);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
		return { gpuMs: drawn - queued, readMs: performance.now() - drawn };
	}
}

/**
 * WebGPU: a compute shader writes the result into a storage buffer, copied
 * into one of three read-back buffers. A mapped read-back buffer is the
 * memory Chromium brought the result back into: NDI reads it where it is,
 * and it is unmapped only when it is written again.
 */
class WebgpuConverter {
	static async create() {
		if (!globalThis.navigator?.gpu) return undefined;
		const adapter = await navigator.gpu.requestAdapter({
			powerPreference: "high-performance",
		});
		if (!adapter) return undefined;
		const info = adapter.info ?? {};
		const device = await adapter.requestDevice();
		device.lost.then((lost) => {
			if (lost.reason !== "destroyed")
				fail(`the GPU took the WebGPU device away: ${lost.message}`);
		});
		const label = [info.vendor, info.architecture, info.description]
			.filter(Boolean)
			.join(" ");
		return {
			name: `WebGPU on ${label || "an adapter"}`,
			software: info.isFallbackAdapter || isSoftwareRenderer(label),
			make: (width, height, alpha) =>
				new WebgpuConverter(device, width, height, alpha),
		};
	}

	constructor(device, width, height, alpha) {
		this.device = device;
		this.width = width;
		this.height = height;
		this.shape = layout(width, height, alpha);
		const { bytes } = this.shape;
		this.pipeline = device.createComputePipeline({
			layout: "auto",
			compute: {
				module: device.createShaderModule({
					code: computeShader(width, height, alpha),
				}),
				entryPoint: "main",
			},
		});
		this.storage = device.createBuffer({
			size: bytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		});
		this.readback = [0, 1, 2].map(() =>
			device.createBuffer({
				size: bytes,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
			}),
		);
		/** The mapped read-back buffers, as NDI is given them. */
		this.buffers = [null, null, null];
		const groups = Math.ceil(bytes / 4 / 256);
		const limit = device.limits.maxComputeWorkgroupsPerDimension;
		this.groupsX = Math.min(groups, limit);
		this.groupsY = Math.ceil(groups / this.groupsX);
	}

	async convert(frame, index, uploaded) {
		const { device } = this;
		if (this.buffers[index]) {
			// Not with NDI any more (see the clock): write over it.
			this.buffers[index] = null;
			this.readback[index].unmap();
		}
		const queued = performance.now();
		const bindings = device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [
				{
					binding: 0,
					resource: device.importExternalTexture({ source: frame }),
				},
				{ binding: 1, resource: { buffer: this.storage } },
			],
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindings);
		pass.dispatchWorkgroups(this.groupsX, this.groupsY);
		pass.end();
		encoder.copyBufferToBuffer(
			this.storage,
			0,
			this.readback[index],
			0,
			this.shape.bytes,
		);
		device.queue.submit([encoder.finish()]);
		await this.readback[index].mapAsync(GPUMapMode.READ);
		uploaded();
		const drawn = performance.now();
		this.buffers[index] = Buffer.from(this.readback[index].getMappedRange());
		return { gpuMs: drawn - queued, readMs: performance.now() - drawn };
	}
}

// ------------------------------------------------------------- the clock
let ndi;
let sender;
let kind;
let converter;
let watching = false;
let connections = 0;
/** When frames go out: the out's frame clock (../clock.mjs). */
let clock;
/** What the frames cost, since the last stats. */
const totals = { frames: 0, gpuMs: 0, readMs: 0 };
/**
 * What was converted, and what the clock sent new, again or not at all:
 * drained into the out's tally in the main process with each stats.
 */
const tally = new Tally({
	trace: process.env.NOTGT_NDI_TRACE ? (line) => send("trace", line) : undefined,
});

function transmit(index) {
	sender.sendAsync(
		converter.buffers[index],
		converter.width,
		converter.height,
		{
			fps: config.fps,
			format: converter.shape.format,
		},
	);
	return true;
}

function watch() {
	if (failed || !sender) return;
	const counted = sender.connections(0);
	// Told at once: the main process paints for receivers as soon as it knows.
	if (counted !== connections) send("connections", counted);
	connections = counted;
	if (connections > 0 && !watching) {
		watching = true;
		clock.setWatching(true);
	} else if (connections === 0 && watching) {
		watching = false;
		clock.setWatching(false);
	}
}

// ------------------------------------------------------------ the frames
let queue = Promise.resolve();

async function handle(imported, id) {
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		imported.release();
		send("done", id);
	};
	try {
		if (failed) return;
		const frame = imported.getVideoFrame();
		try {
			const width = frame.visibleRect?.width ?? frame.codedWidth;
			const height = frame.visibleRect?.height ?? frame.codedHeight;
			if (
				!converter ||
				converter.width !== width ||
				converter.height !== height
			) {
				// NDI may still read the old buffers: let it finish first.
				if (converter) sender.flush();
				clock.reset();
				converter = kind.make(width, height, config.alpha);
				send(
					"log",
					`${width}×${height} ${converter.shape.format.toUpperCase()}, ${colourStandard(width, height).name}, ${kind.name}`,
				);
			}
			const index = clock.freeSlot();
			const times = await converter.convert(frame, index, release);
			totals.frames++;
			totals.gpuMs += times.gpuMs;
			totals.readMs += times.readMs;
			tally.count("converted");
			tally.time("convert", times.gpuMs + times.readMs);
			clock.frameReady(index);
		} finally {
			frame.close();
		}
	} catch (error) {
		fail(`the GPU could not convert a frame: ${error.message}`);
	} finally {
		release();
	}
}

/** The converter to use: WebGL2, or WebGPU when asked for and really there. */
async function chooseConverter() {
	if (process.env.NOTGT_NDI_CONVERTER === "webgpu") {
		const webgpu = await WebgpuConverter.create();
		if (!webgpu) throw new Error("WebGPU is not available here");
		if (webgpu.software)
			throw new Error(`WebGPU runs in software here (${webgpu.name})`);
		return webgpu;
	}
	const webgl = WebglConverter.create();
	// NOTGT_NDI_SOFTWARE_GL=1: tests only, to run this page with no GPU.
	if (webgl.software && !process.env.NOTGT_NDI_SOFTWARE_GL)
		throw new Error(`the GPU is emulated in software (${webgl.name})`);
	return webgl;
}

async function start() {
	ndi = loadNdi(config.ndiFile ? [config.ndiFile] : undefined);
	sender = ndi.createSender(config.ndiName, { groups: config.groups });
	kind = await chooseConverter();
	clock = new FrameClock({ fps: config.fps, transmit, tally });
	sharedTexture.setSharedTextureReceiver(
		async ({ importedSharedTexture }, id) => {
			queue = queue.then(() => handle(importedSharedTexture, id));
		},
	);
	setInterval(watch, 50);
	setInterval(() => {
		const n = totals.frames || 1;
		send("stats", {
			connections,
			watching,
			sent: clock.sent,
			converted: totals.frames,
			gpuMs: totals.gpuMs / n,
			readMs: totals.readMs / n,
			tally: tally.drain(),
		});
		totals.frames = totals.gpuMs = totals.readMs = 0;
	}, 1000);
	send("ready", { renderer: kind.name });
}

ipcRenderer.on("stop", () => {
	watching = false;
	clock?.stop();
	// Waits for NDI to let go of the last frame.
	sender?.destroy();
	send("stopped");
});

start().catch((error) =>
	fail(`the GPU processor could not start: ${error.message}`),
);
