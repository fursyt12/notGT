//! The conversion done on the CPU, in the shader's arithmetic and order:
//! what a backend's result is checked against, in the tests and in each
//! out's self-test before it goes on air.

use crate::{Colour, Layout};

/// Straight (not premultiplied) 8-bit RGB of a pixel: the alpha divided
/// out, rounded; with no alpha wanted, the picture over black as it is.
fn straight(px: &[u8], alpha: bool) -> [i32; 3] {
	let [r, g, b, a] = [px[0] as u32, px[1] as u32, px[2] as u32, px[3] as u32];
	if !alpha {
		return [r as i32, g as i32, b as i32];
	}
	if a == 0 {
		return [0; 3];
	}
	[r, g, b].map(|c| ((c * 255 + a / 2) / a).min(255) as i32)
}

fn weigh(w: [i32; 3], v: [i32; 3]) -> i32 {
	(w[0] * v[0] + w[1] * v[1] + w[2] * v[2] + 32768) >> 16
}

fn clamp(v: i32) -> u32 {
	v.clamp(0, 255) as u32
}

/// `rgba`: premultiplied RGBA bytes, `width * height * 4` of them.
pub fn convert(rgba: &[u8], layout: &Layout) -> Vec<u32> {
	let (w, h) = (layout.width as usize, layout.height as usize);
	assert_eq!(rgba.len(), w * h * 4);
	let k = Colour::NDI.fixed();
	let pixel = |x: usize, y: usize| straight(&rgba[(y * w + x) * 4..][..4], layout.alpha);
	let mut words = Vec::with_capacity(layout.words as usize);
	for y in 0..h {
		for x in (0..w).step_by(2) {
			let a = pixel(x, y);
			let b = pixel(x + 1, y);
			let sum = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
			words.push(
				clamp(128 + weigh(k.cb, sum))
					| clamp(16 + weigh(k.y, a)) << 8
					| clamp(128 + weigh(k.cr, sum)) << 16
					| clamp(16 + weigh(k.y, b)) << 24,
			);
		}
	}
	if layout.alpha {
		for i in (0..w * h).step_by(4) {
			let mut word = 0;
			for k in 0..4 {
				word |= (rgba[(i + k) * 4 + 3] as u32) << (8 * k);
			}
			words.push(word);
		}
	}
	words
}

/// A test picture with every case the conversion has to get right: solid
/// colours, greys, the channel extremes, partly and fully transparent
/// pixels, and gradients across both. Premultiplied RGBA.
pub fn test_pattern(width: u32, height: u32) -> Vec<u8> {
	const SOLID: [[u8; 4]; 12] = [
		[255, 0, 0, 255],
		[0, 255, 0, 255],
		[0, 0, 255, 255],
		[255, 255, 255, 255],
		[128, 128, 128, 255],
		[32, 32, 32, 255],
		[255, 128, 0, 255],
		[0, 0, 0, 0],
		[0, 0, 0, 255],
		[1, 2, 3, 4],
		[200, 100, 50, 200],
		[64, 0, 0, 64],
	];
	let mut out = Vec::with_capacity((width * height * 4) as usize);
	for y in 0..height {
		for x in 0..width {
			let block = (x / 8 + y / 8) as usize;
			let px = if y < height / 2 {
				SOLID[block % SOLID.len()]
			} else {
				// Gradients: alpha down, colour across; kept premultiplied.
				let a = ((x * 7 + y * 13) % 256) as u8;
				let c = |n: u32| ((n % 256) as u16 * a as u16 / 255) as u8;
				[c(x * 3), c(y * 5 + x), c(255 - x % 256), a]
			};
			out.extend_from_slice(&px);
		}
	}
	out
}

/// The most two results differ by in any byte, and in how many bytes.
pub fn compare(a: &[u32], b: &[u32]) -> (u32, usize) {
	let mut worst = 0;
	let mut differ = 0;
	for (x, y) in a.iter().zip(b) {
		for k in 0..4 {
			let d = ((x >> (8 * k)) & 255).abs_diff((y >> (8 * k)) & 255);
			if d > 0 {
				differ += 1;
				worst = worst.max(d);
			}
		}
	}
	(worst, differ)
}
