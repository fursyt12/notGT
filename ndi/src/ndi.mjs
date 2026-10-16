/**
 * The NDI library, called straight through koffi — no addon to compile, so the
 * same code runs on x64, arm64 and the 32-bit Raspberry Pi builds.
 *
 * The library itself is not shipped: the NDI licence wants it to come from NDI.
 * It is looked for where the NDI runtime and SDK installers put it, and
 * `NDI_LIB` names the file outright.
 */
import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";

/** `NDI_LIB_FOURCC('B','G','R','A')`: 8-bit, straight (not premultiplied) alpha. */
export const FOURCC_BGRA = fourcc("BGRA");
/** The same layout, with the promise that every alpha is 255. */
export const FOURCC_BGRX = fourcc("BGRX");

const FRAME_PROGRESSIVE = 1;
const TIMECODE_SYNTHESIZE = 0x7fffffffffffffffn;
const FRAME_TYPE_VIDEO = 1;
const RECV_COLOR_BGRX_BGRA = 0;
const RECV_BANDWIDTH_HIGHEST = 100;

export const REDIST_URL = {
	win32: "https://ndi.link/NDIRedistV6",
	darwin: "https://ndi.link/NDIRedistV6Apple",
	linux: "https://ndi.video/for-developers/ndi-sdk/",
};

/**
 * NDI's frame rate as a fraction: the broadcast rates 23.976, 29.97 and 59.94
 * are exactly 24000/1001, 30000/1001 and 60000/1001, the rest n/1.
 */
export function frameRate(fps) {
	const ntsc = Math.round((fps * 1001) / 1000);
	if (!Number.isInteger(fps) && Math.abs((ntsc * 1000) / 1001 - fps) < 0.005) {
		return { frame_rate_N: ntsc * 1000, frame_rate_D: 1001 };
	}
	return { frame_rate_N: Math.round(fps * 1000), frame_rate_D: 1000 };
}

function fourcc(code) {
	return (
		(code.charCodeAt(0) |
			(code.charCodeAt(1) << 8) |
			(code.charCodeAt(2) << 16) |
			(code.charCodeAt(3) << 24)) >>>
		0
	);
}

/**
 * Where the NDI library may be, most specific first. Bare names are left to
 * the system loader (`ld.so.conf`, `LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`).
 */
export function libraryCandidates(
	env = process.env,
	platform = process.platform,
	arch = process.arch,
) {
	const list = [];
	if (env.NDI_LIB) list.push(env.NDI_LIB);
	const runtimeDirs = [env.NDI_RUNTIME_DIR_V6, env.NDI_RUNTIME_DIR_V5].filter(
		Boolean,
	);
	if (platform === "win32") {
		const name =
			arch === "ia32"
				? "Processing.NDI.Lib.x86.dll"
				: "Processing.NDI.Lib.x64.dll";
		for (const dir of runtimeDirs) list.push(path.join(dir, name));
		list.push(
			path.join("C:\\Program Files\\NDI\\NDI 6 Runtime\\v6", name),
			path.join("C:\\Program Files\\NDI\\NDI 6 SDK\\Bin\\x64", name),
			name,
		);
	} else if (platform === "darwin") {
		for (const dir of runtimeDirs) list.push(path.join(dir, "libndi.dylib"));
		list.push(
			"/usr/local/lib/libndi.dylib",
			"/Library/NDI SDK for Apple/lib/macOS/libndi.dylib",
			"libndi.dylib",
		);
	} else {
		for (const dir of runtimeDirs) list.push(path.join(dir, "libndi.so.6"));
		list.push(
			"libndi.so.6",
			"libndi.so",
			"/usr/local/lib/libndi.so.6",
			"/usr/lib/libndi.so.6",
			"libndi.so.5",
		);
	}
	return list;
}

/** Which folder of the Linux SDK holds the library for this machine. */
export function linuxSdkFolder(arch = process.arch) {
	if (arch === "x64") return "x86_64-linux-gnu";
	if (arch === "arm64") return "aarch64-rpi4-linux-gnueabi";
	if (arch === "arm") return "arm-rpi4-linux-gnueabihf";
	if (arch === "ia32") return "i686-linux-gnu";
	return undefined;
}

export class NdiMissingError extends Error {
	constructor(tried) {
		super(
			`The NDI library was not found (tried: ${tried.join(", ")}). Install the NDI runtime (${REDIST_URL[process.platform] ?? REDIST_URL.linux}) or point NDI_LIB at libndi.`,
		);
		this.name = "NdiMissingError";
		this.tried = tried;
	}
}

function openLibrary(candidates) {
	const errors = [];
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
		try {
			return { lib: koffi.load(candidate), file: candidate };
		} catch (error) {
			errors.push(`${candidate}: ${error.message}`);
		}
	}
	const err = new NdiMissingError(candidates);
	err.details = errors;
	throw err;
}

/** The C structs, declared once per process: koffi names types globally. */
let types;
function declareTypes() {
	koffi.struct("NDIlib_send_create_t", {
		p_ndi_name: "const char *",
		p_groups: "const char *",
		clock_video: "bool",
		clock_audio: "bool",
	});
	koffi.struct("NDIlib_video_frame_v2_t", {
		xres: "int",
		yres: "int",
		FourCC: "uint32_t",
		frame_rate_N: "int",
		frame_rate_D: "int",
		picture_aspect_ratio: "float",
		frame_format_type: "int",
		timecode: "int64_t",
		p_data: "void *",
		line_stride_in_bytes: "int",
		p_metadata: "const char *",
		timestamp: "int64_t",
	});
	const Source = koffi.struct("NDIlib_source_t", {
		p_ndi_name: "const char *",
		p_url_address: "const char *",
	});
	koffi.struct("NDIlib_find_create_t", {
		show_local_sources: "bool",
		p_groups: "const char *",
		p_extra_ips: "const char *",
	});
	koffi.struct("NDIlib_recv_create_v3_t", {
		source_to_connect_to: Source,
		color_format: "int",
		bandwidth: "int",
		allow_video_fields: "bool",
		p_ndi_recv_name: "const char *",
	});
	return { Source };
}

let loaded;

/**
 * Opens and initialises the library once per process.
 * @returns {Ndi}
 */
export function loadNdi(candidates = libraryCandidates()) {
	if (loaded) return loaded;
	const { lib, file } = openLibrary(candidates);

	const { Source } = (types ??= declareTypes());

	const fn = {
		initialize: lib.func("bool NDIlib_initialize(void)"),
		destroy: lib.func("void NDIlib_destroy(void)"),
		version: lib.func("const char *NDIlib_version(void)"),
		sendCreate: lib.func(
			"void *NDIlib_send_create(const NDIlib_send_create_t *settings)",
		),
		sendDestroy: lib.func("void NDIlib_send_destroy(void *send)"),
		sendVideo: lib.func(
			"void NDIlib_send_send_video_v2(void *send, const NDIlib_video_frame_v2_t *frame)",
		),
		sendVideoAsync: lib.func(
			"void NDIlib_send_send_video_async_v2(void *send, const NDIlib_video_frame_v2_t *frame)",
		),
		connections: lib.func(
			"int NDIlib_send_get_no_connections(void *send, uint32_t timeout_ms)",
		),
		findCreate: lib.func(
			"void *NDIlib_find_create_v2(const NDIlib_find_create_t *settings)",
		),
		findDestroy: lib.func("void NDIlib_find_destroy(void *find)"),
		findWait: lib.func(
			"bool NDIlib_find_wait_for_sources(void *find, uint32_t timeout_ms)",
		),
		findSources: lib.func(
			"void *NDIlib_find_get_current_sources(void *find, _Out_ uint32_t *count)",
		),
		recvCreate: lib.func(
			"void *NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *settings)",
		),
		recvDestroy: lib.func("void NDIlib_recv_destroy(void *recv)"),
		recvCapture: lib.func(
			"int NDIlib_recv_capture_v2(void *recv, _Out_ NDIlib_video_frame_v2_t *video, void *audio, void *metadata, uint32_t timeout_ms)",
		),
		recvFreeVideo: lib.func(
			"void NDIlib_recv_free_video_v2(void *recv, const NDIlib_video_frame_v2_t *video)",
		),
	};

	if (!fn.initialize()) {
		throw new Error(
			"NDI refused to start: this CPU is not supported by the NDI library.",
		);
	}

	loaded = {
		file,
		version: fn.version(),
		createSender: (name, options) => new NdiSender(fn, name, options),
		findSources: (timeoutMs, extraIps) =>
			findSources(fn, Source, timeoutMs, extraIps),
		createReceiver: (source, name) => new NdiReceiver(fn, source, name),
		destroy: () => {
			fn.destroy();
			loaded = undefined;
		},
	};
	return loaded;
}

/**
 * @typedef {ReturnType<typeof loadNdi>} Ndi
 */

/** One NDI source on the network. */
export class NdiSender {
	constructor(fn, name, { groups } = {}) {
		this.fn = fn;
		this.name = name;
		// The pace comes from the renderer, which only paints when something
		// moved; letting NDI clock video would block the caller on every frame.
		this.handle = fn.sendCreate({
			p_ndi_name: name,
			p_groups: groups || null,
			clock_video: false,
			clock_audio: false,
		});
		if (!this.handle)
			throw new Error(`NDI could not create the source “${name}”.`);
		/** The buffer NDI may still be reading; kept alive until the next send. */
		this.inFlight = null;
	}

	/** How many receivers watch this source. */
	connections(timeoutMs = 0) {
		return this.handle ? this.fn.connections(this.handle, timeoutMs) : 0;
	}

	/**
	 * Hands a frame over and returns at once; compression and sending run on
	 * NDI's own threads. `buffer` must not change until the next call.
	 */
	sendAsync(buffer, width, height, { fps = 30, opaque = false } = {}) {
		if (!this.handle) return;
		this.fn.sendVideoAsync(this.handle, {
			xres: width,
			yres: height,
			FourCC: opaque ? FOURCC_BGRX : FOURCC_BGRA,
			...frameRate(fps),
			picture_aspect_ratio: width / height,
			frame_format_type: FRAME_PROGRESSIVE,
			timecode: TIMECODE_SYNTHESIZE,
			p_data: koffi.address(buffer),
			line_stride_in_bytes: width * 4,
			p_metadata: null,
			timestamp: 0n,
		});
		this.inFlight = buffer;
	}

	/** Waits until NDI no longer reads the last frame. */
	flush() {
		if (!this.handle) return;
		this.fn.sendVideo(this.handle, null);
		this.inFlight = null;
	}

	destroy() {
		if (!this.handle) return;
		this.fn.sendDestroy(this.handle);
		this.handle = null;
		this.inFlight = null;
	}
}

function findSources(fn, Source, timeoutMs = 3000, extraIps = null) {
	const finder = fn.findCreate({
		show_local_sources: true,
		p_groups: null,
		p_extra_ips: extraIps || null,
	});
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline)
			fn.findWait(finder, Math.max(1, deadline - Date.now()));
		const count = [0];
		const ptr = fn.findSources(finder, count);
		if (!ptr || count[0] === 0) return [];
		return koffi.decode(ptr, koffi.array(Source, count[0])).map((source) => ({
			name: source.p_ndi_name,
			url: source.p_url_address,
		}));
	} finally {
		fn.findDestroy(finder);
	}
}

/** Receives frames from one source — used by the probe, not by the sender. */
export class NdiReceiver {
	constructor(fn, source, name = "notGT probe") {
		this.fn = fn;
		this.handle = fn.recvCreate({
			source_to_connect_to: {
				p_ndi_name: source.name,
				p_url_address: source.url ?? null,
			},
			color_format: RECV_COLOR_BGRX_BGRA,
			bandwidth: RECV_BANDWIDTH_HIGHEST,
			allow_video_fields: false,
			p_ndi_recv_name: name,
		});
		if (!this.handle)
			throw new Error(`NDI could not connect to “${source.name}”.`);
	}

	/**
	 * The next video frame, or `null` when none came in time. `read` gets the
	 * frame while its pixels are still valid.
	 */
	captureVideo(timeoutMs, read) {
		const frame = {};
		const type = this.fn.recvCapture(this.handle, frame, null, null, timeoutMs);
		if (type !== FRAME_TYPE_VIDEO) return null;
		try {
			const stride = frame.line_stride_in_bytes;
			const pixels = Buffer.from(
				koffi.decode(frame.p_data, "uint8_t", stride * frame.yres),
			);
			return read({
				width: frame.xres,
				height: frame.yres,
				stride,
				fourcc: String.fromCharCode(
					frame.FourCC & 255,
					(frame.FourCC >> 8) & 255,
					(frame.FourCC >> 16) & 255,
					(frame.FourCC >>> 24) & 255,
				),
				fps: frame.frame_rate_N / frame.frame_rate_D,
				pixels,
			});
		} finally {
			this.fn.recvFreeVideo(this.handle, frame);
		}
	}

	destroy() {
		if (this.handle) this.fn.recvDestroy(this.handle);
		this.handle = null;
	}
}
