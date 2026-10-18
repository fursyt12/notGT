/**
 * What the GPU makes of a painted frame: NDI's own 4:2:2 formats, so NDI
 * neither converts colour nor reads more bytes than it needs.
 *
 *  - with alpha, UYVA: a UYVY plane (U Y0 V Y1 for each two pixels), then a
 *    plane of one alpha byte a pixel — 3 bytes a pixel against BGRA's 4;
 *  - opaque, UYVY: 2 bytes a pixel.
 *
 * Both planes are drawn into one RGBA8 picture half the frame wide, read back
 * in one go: the UYVY plane is its first `height` rows, the alpha plane the
 * `height / 2` rows after it (two rows of alpha bytes to a picture row).
 *
 * The colour is Rec.709, studio range, with the alpha at full range, at every
 * size. NDI's documentation says BT.601 up to 720×576 and Rec.2020 above
 * 1920×1080, but NDI 6.3's receivers decode UYVY as Rec.709 at all of them
 * (measured 2026-10-18, 64×32 to 3840×2160; the native converter's
 * core/src/lib.rs `Colour::NDI` says the same).
 */

/** Luma weights of the standard NDI decodes UYVY in, whatever the size. */
export function colourStandard() {
	return { name: "Rec.709", kr: 0.2126, kb: 0.0722 };
}

/**
 * Studio-range Y, Cb, Cr (0–255 scale) of a colour with straight channels
 * from 0 to 1 — what the shader computes, for tests to check it against.
 */
export function yuv([r, g, b], { kr, kb }) {
	const y = kr * r + (1 - kr - kb) * g + kb * b;
	return [
		16 + 219 * y,
		128 + (224 * (b - y)) / (2 * (1 - kb)),
		128 + (224 * (r - y)) / (2 * (1 - kr)),
	];
}

/** Sizes of what is drawn, read back and handed to NDI. */
export function layout(width, height, alpha) {
	if (width % 2 || height % 2)
		throw new Error(`${width}×${height}: NDI's 4:2:2 wants an even size`);
	const drawWidth = width / 2;
	const drawHeight = alpha ? height + height / 2 : height;
	return {
		format: alpha ? "uyva" : "uyvy",
		drawWidth,
		drawHeight,
		bytes: drawWidth * drawHeight * 4,
		stride: width * 2,
	};
}

export const VERTEX_SHADER = `#version 300 es
// One triangle over the whole picture.
void main() {
	vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID & 2) * 2 - 1));
	gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * The fragment shader for a `width`×`height` frame. The texture holds the
 * frame as Chromium paints it, premultiplied; `alpha: false` keeps that
 * colour — the picture over black.
 */
export function fragmentShader(width, height, alpha) {
	const { kr, kb } = colourStandard(width, height);
	const f = (n) => n.toFixed(6);
	return `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D frame;
out vec4 result;
const int W = ${width};
const int H = ${height};
const vec3 LUMA = vec3(${f(kr)}, ${f(1 - kr - kb)}, ${f(kb)});

vec3 colour(int x, int y) {
	vec4 c = texelFetch(frame, ivec2(x, y), 0);
	${alpha ? "return c.a > 0.0 ? min(c.rgb / c.a, vec3(1.0)) : vec3(0.0);" : "return c.rgb;"}
}

void main() {
	int col = int(gl_FragCoord.x);
	int row = int(gl_FragCoord.y);
	if (row < H) {
		vec3 a = colour(2 * col, row);
		vec3 b = colour(2 * col + 1, row);
		vec3 m = (a + b) * 0.5;
		float ym = dot(m, LUMA);
		result = vec4(
			128.0 + 224.0 * (m.b - ym) / ${f(2 * (1 - kb))},
			16.0 + 219.0 * dot(a, LUMA),
			128.0 + 224.0 * (m.r - ym) / ${f(2 * (1 - kr))},
			16.0 + 219.0 * dot(b, LUMA)
		) / 255.0;
		return;
	}
	// The alpha plane: four alpha bytes of the frame, read in order.
	int first = (row - H) * 2 * W + col * 4;
	vec4 a;
	for (int k = 0; k < 4; k++) {
		int i = first + k;
		a[k] = texelFetch(frame, ivec2(i % W, i / W), 0).a;
	}
	result = a;
}`;
}

/**
 * The same conversion as a WebGPU compute shader: each invocation writes one
 * 32-bit word of the result — U Y0 V Y1 of two pixels, or four alpha bytes
 * — into a storage buffer laid out exactly as NDI reads it.
 */
export function computeShader(width, height, alpha) {
	const { kr, kb } = colourStandard(width, height);
	const f = (n) => n.toFixed(6);
	const { bytes } = layout(width, height, alpha);
	return `@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var<storage, read_write> words: array<u32>;
const W = ${width}u;
const H = ${height}u;
const PAIRS = ${(width / 2) * height}u;
const WORDS = ${bytes / 4}u;
const LUMA = vec3f(${f(kr)}, ${f(1 - kr - kb)}, ${f(kb)});

fn colour(x: u32, y: u32) -> vec3f {
	let c = textureLoad(frame, vec2u(x, y));
	${alpha ? "return select(vec3f(0.0), min(c.rgb / c.a, vec3f(1.0)), c.a > 0.0);" : "return c.rgb;"}
}

fn byte(v: f32) -> u32 {
	return u32(clamp(floor(v + 0.5), 0.0, 255.0));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
	let i = id.x + id.y * groups.x * 256u;
	if (i >= WORDS) {
		return;
	}
	if (i < PAIRS) {
		let x = (i % (W / 2u)) * 2u;
		let y = i / (W / 2u);
		let a = colour(x, y);
		let b = colour(x + 1u, y);
		let m = (a + b) * 0.5;
		let ym = dot(m, LUMA);
		words[i] = byte(128.0 + 224.0 * (m.b - ym) / ${f(2 * (1 - kb))})
			| (byte(16.0 + 219.0 * dot(a, LUMA)) << 8u)
			| (byte(128.0 + 224.0 * (m.r - ym) / ${f(2 * (1 - kr))}) << 16u)
			| (byte(16.0 + 219.0 * dot(b, LUMA)) << 24u);
		return;
	}
	// The alpha plane: four alpha bytes of the frame, in order.
	let first = (i - PAIRS) * 4u;
	var word = 0u;
	for (var k = 0u; k < 4u; k++) {
		let p = first + k;
		word = word | (byte(textureLoad(frame, vec2u(p % W, p / W)).a * 255.0) << (8u * k));
	}
	words[i] = word;
}`;
}

/** WebGL renderers that are the CPU pretending: no gain over drawing on the CPU. */
export function isSoftwareRenderer(name) {
	return /swiftshader|llvmpipe|lavapipe|softpipe|basic render|software/i.test(
		String(name),
	);
}
