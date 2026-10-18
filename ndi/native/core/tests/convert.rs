//! The GPU's conversion against the CPU reference, on whatever Vulkan device
//! is there — lavapipe, Mesa's CPU one, is enough and needs no GPU:
//!
//!   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
//!     cargo test -p notgt-ndi-core -- --ignored
#![cfg(any(target_os = "linux", windows))]

use notgt_ndi_core::reference::{compare, convert, test_pattern};
use notgt_ndi_core::vulkan::{probe, Options, Vulkan};
use notgt_ndi_core::Layout;

fn options() -> Options {
	Options { render_node: None, pci: None, allow_software: true, shared: false }
}

fn check(vulkan: &mut Vulkan, width: u32, height: u32, alpha: bool) {
	let rgba = test_pattern(width, height);
	let mut resized = 0;
	let got = vulkan
		.convert_pixels(width, height, &rgba, 1, &mut || resized += 1)
		.unwrap_or_else(|e| panic!("{width}×{height}: {e}"));
	let want = convert(&rgba, &Layout::new(width, height, alpha).unwrap());
	assert_eq!(got.len(), want.len(), "{width}×{height}: result size");
	let (worst, differ) = compare(&got, &want);
	println!("{width}×{height} alpha={alpha}: {differ} byte(s) differ, by {worst} at most");
	assert_eq!((worst, differ), (0, 0), "{width}×{height} alpha={alpha}: the GPU's bytes are not the reference's");
}

#[test]
#[ignore = "needs a Vulkan device (lavapipe will do): cargo test -- --ignored"]
fn converts_like_the_reference_with_alpha() {
	let mut vulkan = Vulkan::new(&options(), true).expect("Vulkan");
	println!("{}", vulkan.name());
	// Small, SD, HD, UHD, and sizes that are not a multiple of a workgroup.
	for (w, h) in [(64, 32), (720, 576), (1920, 1080), (2, 2), (642, 362), (3840, 2160)] {
		check(&mut vulkan, w, h, true);
	}
}

#[test]
#[ignore = "needs a Vulkan device (lavapipe will do): cargo test -- --ignored"]
fn converts_like_the_reference_opaque() {
	let mut vulkan = Vulkan::new(&options(), false).expect("Vulkan");
	for (w, h) in [(64, 32), (1920, 1080), (642, 362)] {
		check(&mut vulkan, w, h, false);
	}
}

#[test]
#[ignore = "needs a Vulkan device (lavapipe will do): cargo test -- --ignored"]
fn every_slot_holds_its_own_frame() {
	let mut vulkan = Vulkan::new(&options(), true).expect("Vulkan");
	let (w, h) = (64, 32);
	let a = test_pattern(w, h);
	let b: Vec<u8> = a.iter().rev().copied().collect();
	vulkan.convert_pixels(w, h, &a, 0, &mut || {}).unwrap();
	vulkan.convert_pixels(w, h, &b, 1, &mut || {}).unwrap();
	let layout = Layout::new(w, h, true).unwrap();
	let read = |slot| {
		let (ptr, layout) = vulkan.slot(slot).unwrap();
		unsafe { std::slice::from_raw_parts(ptr as *const u32, layout.words as usize) }.to_vec()
	};
	assert_eq!(read(0), convert(&a, &layout));
	assert_eq!(read(1), convert(&b, &layout));
}

#[test]
#[ignore = "needs a Vulkan device (lavapipe will do): cargo test -- --ignored"]
fn a_new_size_lets_go_of_the_old_memory_first() {
	let mut vulkan = Vulkan::new(&options(), true).expect("Vulkan");
	let mut flushed = 0;
	vulkan.convert_pixels(64, 32, &test_pattern(64, 32), 0, &mut || flushed += 1).unwrap();
	assert_eq!(flushed, 0, "nothing to let go of the first time");
	vulkan.convert_pixels(64, 32, &test_pattern(64, 32), 1, &mut || flushed += 1).unwrap();
	assert_eq!(flushed, 0, "same size: same memory");
	vulkan.convert_pixels(128, 64, &test_pattern(128, 64), 0, &mut || flushed += 1).unwrap();
	assert_eq!(flushed, 1, "a new size flushes NDI before the memory goes");
}

#[test]
#[ignore = "needs a Vulkan device (lavapipe will do): cargo test -- --ignored"]
fn probe_says_why_a_device_cannot_take_frames() {
	let reports = probe(&Options { render_node: None, pci: None, allow_software: false, shared: true }).expect("Vulkan");
	assert!(!reports.is_empty());
	for r in &reports {
		println!("{r:?}");
		assert_eq!(r.usable, r.why.is_none());
	}
}

#[test]
fn odd_sizes_are_refused() {
	assert!(Layout::new(641, 360, true).is_err());
	assert!(Layout::new(640, 361, false).is_err());
	let l = Layout::new(1920, 1080, true).unwrap();
	assert_eq!(l.bytes(), 1920 * 1080 * 3);
	assert_eq!(Layout::new(1920, 1080, false).unwrap().bytes(), 1920 * 1080 * 2);
}

#[test]
fn fixed_point_keeps_black_white_and_greys_exact() {
	use notgt_ndi_core::Colour;
	for colour in [
		Colour::NDI,
		// The arithmetic holds for the other standards too.
		Colour { name: "BT.601", kr: 0.299, kb: 0.114 },
		Colour { name: "Rec.2020", kr: 0.2627, kb: 0.0593 },
	] {
		let k = colour.fixed();
		let weigh = |c: [i32; 3], v: [i32; 3]| (c[0] * v[0] + c[1] * v[1] + c[2] * v[2] + 32768) >> 16;
		for g in 0..=255 {
			let px = [g, g, g];
			let y = 16 + weigh(k.y, px);
			let want = (16.0 + 219.0 * g as f64 / 255.0).round() as i32;
			assert!((y - want).abs() <= 1, "{}: grey {g} gives Y {y}, not {want}", colour.name);
			assert_eq!(128 + weigh(k.cb, [2 * g; 3]), 128, "{}: grey {g} has colour", colour.name);
			assert_eq!(128 + weigh(k.cr, [2 * g; 3]), 128, "{}: grey {g} has colour", colour.name);
		}
		assert_eq!(16 + weigh(k.y, [0; 3]), 16);
		assert_eq!(16 + weigh(k.y, [255; 3]), 235);
		// Every colour within 1 of the exact formula.
		let (kr, kb) = (colour.kr as f64, colour.kb as f64);
		let kg = 1.0 - kr - kb;
		let mut worst = 0;
		for r in (0..=255).step_by(5) {
			for g in (0..=255).step_by(5) {
				for b in (0..=255).step_by(5) {
					let (fr, fg, fb) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
					let yf = kr * fr + kg * fg + kb * fb;
					let exact = [
						16.0 + 219.0 * yf,
						128.0 + 224.0 * (fb - yf) / (2.0 * (1.0 - kb)),
						128.0 + 224.0 * (fr - yf) / (2.0 * (1.0 - kr)),
					];
					let got = [
						16 + weigh(k.y, [r, g, b]),
						128 + weigh(k.cb, [2 * r, 2 * g, 2 * b]),
						128 + weigh(k.cr, [2 * r, 2 * g, 2 * b]),
					];
					for i in 0..3 {
						worst = worst.max((got[i] - exact[i].round() as i32).abs());
					}
				}
			}
		}
		assert!(worst <= 1, "{}: off the exact formula by {worst}", colour.name);
	}
}
