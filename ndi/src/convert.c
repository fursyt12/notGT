/*
 * frame.mjs's two conversions in WebAssembly SIMD, four pixels at a time —
 * about three times quicker than the JavaScript loops, and the same pixels
 * to the bit (test/frame.test.mjs checks every alpha and channel).
 *
 * Built into convert.wasm, which is committed so nobody needs a compiler:
 *
 *   npm run build:wasm      (clang with the wasm32 target, and wasm-ld)
 *
 * Strides and widths count pixels. Little-endian BGRA, as frame.mjs.
 */
#include <stdint.h>
#include <wasm_simd128.h>

/* round(c * 255 / a), at most 255, for four pixels; opaque and clear ones as they are. */
static inline v128_t unpremultiply4(v128_t px) {
	v128_t alpha = wasm_u32x4_shr(px, 24);
	v128_t keep = wasm_v128_or(wasm_i32x4_eq(alpha, wasm_i32x4_splat(255)),
		wasm_i32x4_eq(alpha, wasm_i32x4_splat(0)));
	if (wasm_i32x4_all_true(keep)) return px;
	v128_t m = wasm_i32x4_splat(255);
	v128_t k = wasm_f32x4_splat(255.0f);
	v128_t half = wasm_f32x4_splat(0.5f);
	v128_t a = wasm_f32x4_convert_i32x4(alpha);
	v128_t out = wasm_i32x4_shl(alpha, 24);
	for (int shift = 0; shift < 24; shift += 8) {
		v128_t c = wasm_f32x4_convert_i32x4(wasm_v128_and(wasm_u32x4_shr(px, shift), m));
		/* c * 255 is exact and the division rounds correctly, so ties stay ties
		 * and + 0.5 rounds them up, as Math.round does. */
		v128_t q = wasm_f32x4_add(wasm_f32x4_div(wasm_f32x4_mul(c, k), a), half);
		out = wasm_v128_or(out, wasm_i32x4_shl(wasm_i32x4_min(wasm_i32x4_trunc_sat_f32x4(q), m), shift));
	}
	return wasm_v128_bitselect(px, out, keep);
}

static inline uint32_t unpremultiply1(uint32_t px) {
	uint32_t a = px >> 24;
	if (a == 0 || a == 255) return px;
	uint32_t out = a << 24;
	for (int shift = 0; shift < 24; shift += 8) {
		uint32_t c = (uint32_t)((float)((px >> shift) & 255) * 255.0f / (float)a + 0.5f);
		out |= (c > 255 ? 255 : c) << shift;
	}
	return out;
}

void unpremultiply(const uint32_t *src, uint32_t srcStride, uint32_t *dst,
		uint32_t dstStride, uint32_t width, uint32_t height) {
	for (uint32_t row = 0; row < height; row++) {
		const uint32_t *s = src + row * srcStride;
		uint32_t *d = dst + row * dstStride;
		uint32_t x = 0;
		for (; x + 4 <= width; x += 4)
			wasm_v128_store(d + x, unpremultiply4(wasm_v128_load(s + x)));
		for (; x < width; x++) d[x] = unpremultiply1(s[x]);
	}
}

/* Premultiplied colour is the colour over black already: alpha to 255. */
void opaque(const uint32_t *src, uint32_t srcStride, uint32_t *dst,
		uint32_t dstStride, uint32_t width, uint32_t height) {
	v128_t full = wasm_i32x4_splat((int32_t)0xff000000);
	for (uint32_t row = 0; row < height; row++) {
		const uint32_t *s = src + row * srcStride;
		uint32_t *d = dst + row * dstStride;
		uint32_t x = 0;
		for (; x + 4 <= width; x += 4)
			wasm_v128_store(d + x, wasm_v128_or(wasm_v128_load(s + x), full));
		for (; x < width; x++) d[x] = s[x] | 0xff000000u;
	}
}
