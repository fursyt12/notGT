//! The native half of the NDI sender.
//!
//! Chromium draws each out on the GPU and shares the frame as a texture; a
//! backend here takes that texture as it is — no copy through memory, no
//! other process — converts it on the GPU to NDI's own 4:2:2 (see
//! `shaders/convert.comp`) straight into memory NDI reads, and the sender
//! (`ndi.rs`) hands that memory to NDI:
//!
//!   shared texture ─ import ─ compute shader ─► mapped memory ─► NDI
//!
//! One read back a frame, and no copy by the CPU.
//!
//! Backends:
//!  - `vulkan`: on Linux, the dmabufs Chromium shares its frames as; on
//!    Windows, the D3D11 textures it shares them as (NT handles).
//!
//! What is common to all of them is here: the frame, the layout of what NDI
//! is given, the colour standard, and the reference conversion the GPU's
//! result is checked against.

pub mod ndi;
pub mod reference;

#[cfg(target_os = "linux")]
pub mod dmabuf;
#[cfg(windows)]
pub mod textures;
#[cfg(any(target_os = "linux", windows))]
pub mod vulkan;

/// What can go wrong, said for the log and the dashboard.
pub type Result<T> = std::result::Result<T, String>;

/// How Chromium's texture holds its pixels; both premultiplied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
	Bgra,
	Rgba,
}

impl PixelFormat {
	pub fn parse(name: &str) -> Result<Self> {
		match name {
			"bgra" => Ok(Self::Bgra),
			"rgba" => Ok(Self::Rgba),
			other => Err(format!("frames in {other} cannot be converted")),
		}
	}
}

/// One plane of a dmabuf, as Electron describes it.
#[derive(Clone, Copy, Debug)]
pub struct Plane {
	pub fd: i32,
	pub offset: u64,
	pub stride: u64,
}

/// How Chromium shares a frame it drew, as Electron hands it over.
#[derive(Clone, Debug)]
pub enum FrameHandle {
	/// Linux: a dmabuf in a DRM format modifier, an fd a plane.
	Dmabuf { modifier: u64, planes: Vec<Plane> },
	/// Windows: a D3D11 texture's NT handle, this process's own.
	D3d11 { handle: usize },
}

/// A frame Chromium drew, still on the GPU.
#[derive(Clone, Debug)]
pub struct SharedFrame {
	pub width: u32,
	pub height: u32,
	pub format: PixelFormat,
	pub handle: FrameHandle,
}

/// What NDI is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
	pub width: u32,
	pub height: u32,
	pub alpha: bool,
	/// The UYVY plane's 32-bit words: two pixels each.
	pub pairs: u32,
	/// All 32-bit words, the alpha plane's included.
	pub words: u32,
}

impl Layout {
	pub fn new(width: u32, height: u32, alpha: bool) -> Result<Self> {
		if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
			return Err(format!(
				"{width}×{height}: NDI's 4:2:2 wants an even size"
			));
		}
		let pairs = width / 2 * height;
		let words = if alpha { pairs + width * height / 4 } else { pairs };
		Ok(Self { width, height, alpha, pairs, words })
	}

	pub fn bytes(&self) -> usize {
		self.words as usize * 4
	}

	/// Bytes per row of the UYVY plane; the alpha plane's rows are `width`.
	pub fn stride(&self) -> u32 {
		self.width * 2
	}

	/// NDI's FourCC for it: UYVA, or UYVY when opaque.
	pub fn fourcc(&self) -> u32 {
		fourcc(if self.alpha { b"UYVA" } else { b"UYVY" })
	}
}

pub fn fourcc(code: &[u8; 4]) -> u32 {
	u32::from_le_bytes(*code)
}

/// The colour standard of what NDI is given: Rec.709, studio range, at every
/// size. NDI's documentation says BT.601 up to 720×576 and Rec.2020 above
/// 1920×1080, but NDI 6.3's receivers decode UYVY as Rec.709 at all of them
/// (measured 2026-10-18 from 64×32 to 3840×2160: Rec.709 comes back within
/// NDI's own 12, BT.601 40 off, Rec.2020 16).
#[derive(Clone, Copy, Debug)]
pub struct Colour {
	pub name: &'static str,
	pub kr: f32,
	pub kb: f32,
}

impl Colour {
	pub const NDI: Colour = Colour { name: "Rec.709", kr: 0.2126, kb: 0.0722 };

	pub fn kg(&self) -> f32 {
		1.0 - self.kr - self.kb
	}

	/// The conversion in 16.16 fixed point, so that every GPU and the CPU
	/// get the same bytes (float division differs between drivers):
	///
	///   Y  = 16  + (y·rgb       + 2^15) >> 16   rgb: straight, 0–255
	///   Cb = 128 + (cb·(rgb₁+rgb₂) + 2^15) >> 16   over the pair
	///   Cr = 128 + (cr·(rgb₁+rgb₂) + 2^15) >> 16
	///
	/// Black is 16, white 235 and every grey's Cb and Cr 128, exactly: the
	/// weights add up to what they have to (219/255, and 0).
	pub fn fixed(&self) -> Fixed {
		let one = 65536.0f64;
		let (kr, kb) = (self.kr as f64, self.kb as f64);
		let kg = 1.0 - kr - kb;
		let scale = 219.0 / 255.0 * one;
		let y_r = (kr * scale).round() as i32;
		let y_b = (kb * scale).round() as i32;
		let y_g = scale.round() as i32 - y_r - y_b;
		// Over the sum of two pixels: half of each.
		let c = 224.0 / 255.0 * one / 2.0;
		let cb_r = (-kr / (2.0 * (1.0 - kb)) * c).round() as i32;
		let cb_g = (-kg / (2.0 * (1.0 - kb)) * c).round() as i32;
		let cr_g = (-kg / (2.0 * (1.0 - kr)) * c).round() as i32;
		let cr_b = (-kb / (2.0 * (1.0 - kr)) * c).round() as i32;
		Fixed {
			y: [y_r, y_g, y_b],
			cb: [cb_r, cb_g, -cb_r - cb_g],
			cr: [-cr_g - cr_b, cr_g, cr_b],
		}
	}
}

/// See `Colour::fixed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fixed {
	pub y: [i32; 3],
	pub cb: [i32; 3],
	pub cr: [i32; 3],
}

/// How long a conversion took, in milliseconds.
#[derive(Clone, Copy, Debug, Default)]
pub struct Timing {
	/// The texture was new to the backend and had to be imported.
	pub imported: bool,
	pub import_ms: f64,
	/// It waited for Chromium's drawing to finish (a sync file); false where
	/// the kernel cannot tell, and the frame was taken as it was.
	pub synced: bool,
	/// From handing the work to the GPU until its result is in memory.
	pub gpu_ms: f64,
	pub total_ms: f64,
}

/// A GPU, as a backend sees it: for the log, and to say why it is not used.
#[derive(Clone, Debug, Default)]
pub struct DeviceReport {
	pub backend: String,
	pub name: String,
	/// "integrated", "discrete", "virtual", "cpu" or "other".
	pub kind: String,
	pub driver: String,
	pub api: String,
	/// The DRM render node's major and minor number, where the backend says.
	pub render_node: Option<(u64, u64)>,
	/// PCI vendor and device id.
	pub pci: (u32, u32),
	/// Ways it can import Chromium's BGRA frames: DRM format modifiers on
	/// Linux; on Windows 1 if it can import D3D11 textures at all.
	pub layouts: u32,
	pub usable: bool,
	pub why: Option<String>,
}

pub fn ms_since(start: std::time::Instant) -> f64 {
	start.elapsed().as_secs_f64() * 1000.0
}
