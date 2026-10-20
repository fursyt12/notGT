//! The addon the notGT sender loads for its Spout outs (../../src/native.mjs):
//! one `SpoutOut` per out, each frame drawn into the texture Spout receivers
//! open, on Node's worker threads — the main process never waits for the GPU.

use std::sync::{Arc, Mutex, MutexGuard};

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
#[cfg(windows)]
use notgt_spout_core as native;

fn reason(e: String) -> Error {
	Error::from_reason(e)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn pci(vendor: Option<u32>, device: Option<u32>) -> Option<(u32, u32)> {
	Some((vendor?, device?))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
	// A panic elsewhere must not take every later frame down with it.
	m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A HANDLE as Electron writes it: the pointer's bytes, this machine's order.
fn nt_handle(buffer: &Buffer) -> usize {
	let bytes: &[u8] = buffer.as_ref();
	let mut value = [0u8; 8];
	let n = bytes.len().min(8);
	value[..n].copy_from_slice(&bytes[..n]);
	u64::from_ne_bytes(value) as usize
}

#[napi(object)]
pub struct SpoutOptions {
	/// The name receivers list.
	pub name: String,
	pub alpha: bool,
	/// Frames will come as Chromium's textures (`sendTexture`), not bitmaps.
	pub shared: bool,
	/// The PCI ids of the GPU Chromium draws on (app.getGPUInfo).
	pub vendor_id: Option<u32>,
	pub device_id: Option<u32>,
}

#[napi(object)]
pub struct Rect {
	pub x: u32,
	pub y: u32,
	pub width: u32,
	pub height: u32,
}

/// A painted frame as a texture (`texture.textureInfo`): its NT handle, and
/// the part of it that is the picture.
#[napi(object)]
pub struct SpoutTexture {
	pub nt_handle: Buffer,
	pub width: u32,
	pub height: u32,
	pub visible: Option<Rect>,
}

#[napi(object)]
pub struct SpoutSent {
	pub width: u32,
	pub height: u32,
	/// A receiver held the texture too long: the frame was dropped.
	pub skipped: bool,
	pub gpu_ms: f64,
	pub total_ms: f64,
}

#[cfg(windows)]
type SpoutBackend = native::Sender;
#[cfg(not(windows))]
type SpoutBackend = ();

#[cfg_attr(not(windows), allow(dead_code))]
enum SpoutFrame {
	Texture { handle: usize, visible: (u32, u32, u32, u32) },
	Pixels { width: u32, height: u32, pixels: Vec<u8>, dirty: (u32, u32, u32, u32) },
}

pub struct SpoutTask {
	sender: Arc<Mutex<Option<SpoutBackend>>>,
	frame: SpoutFrame,
}

impl Task for SpoutTask {
	type Output = SpoutSent;
	type JsValue = SpoutSent;

	fn compute(&mut self) -> Result<Self::Output> {
		let mut sender = lock(&self.sender);
		let sender = sender.as_mut().ok_or_else(|| reason("the Spout sender is closed".into()))?;
		#[cfg(windows)]
		{
			let sent = match &self.frame {
				SpoutFrame::Texture { handle, visible } => sender.send_shared(*handle, *visible),
				SpoutFrame::Pixels { width, height, pixels, dirty } => {
					sender.send_pixels(*width, *height, pixels, dirty.2 * 4, *dirty)
				}
			}
			.map_err(reason)?;
			Ok(SpoutSent {
				width: sent.width,
				height: sent.height,
				skipped: sent.skipped,
				gpu_ms: sent.gpu_ms,
				total_ms: sent.total_ms,
			})
		}
		#[cfg(not(windows))]
		{
			let _ = (sender, &self.frame);
			Err(reason("Spout is only on Windows".into()))
		}
	}

	fn resolve(&mut self, _env: Env, sent: Self::Output) -> Result<Self::JsValue> {
		Ok(sent)
	}
}

/// One out as a Spout sender (Windows).
#[napi]
pub struct SpoutOut {
	sender: Arc<Mutex<Option<SpoutBackend>>>,
	name: String,
	adapter: String,
}

#[napi]
impl SpoutOut {
	/// Opens Direct3D 11 and lists the sender in Spout; throws, saying why,
	/// when either cannot be done.
	#[napi(constructor)]
	pub fn new(options: SpoutOptions) -> Result<Self> {
		#[cfg(windows)]
		{
			let sender = native::Sender::new(
				&options.name,
				options.alpha,
				pci(options.vendor_id, options.device_id),
				options.shared,
			)
			.map_err(reason)?;
			Ok(Self {
				name: sender.name(),
				adapter: sender.adapter().to_string(),
				sender: Arc::new(Mutex::new(Some(sender))),
			})
		}
		#[cfg(not(windows))]
		{
			let _ = options;
			Err(reason("Spout is only on Windows".into()))
		}
	}

	/// The name receivers list, as Spout keeps it.
	#[napi(getter)]
	pub fn name(&self) -> String {
		self.name.clone()
	}

	/// The GPU it draws on.
	#[napi(getter)]
	pub fn adapter(&self) -> String {
		self.adapter.clone()
	}

	/// Draws a frame Chromium shared as a texture into Spout's. The promise
	/// settles once the GPU is done reading it: only then may it be released.
	#[napi]
	pub fn send_texture(&self, frame: SpoutTexture) -> AsyncTask<SpoutTask> {
		let visible = frame.visible.map_or((0, 0, frame.width, frame.height), |r| (r.x, r.y, r.width, r.height));
		AsyncTask::new(SpoutTask {
			sender: self.sender.clone(),
			frame: SpoutFrame::Texture { handle: nt_handle(&frame.nt_handle), visible },
		})
	}

	/// A frame drawn on the CPU: `pixels` (premultiplied BGRA, `stride`
	/// bytes a row) hold the rectangle `dirty` of a `width`×`height` picture.
	#[napi]
	pub fn send_pixels(
		&self,
		pixels: Buffer,
		stride: u32,
		width: u32,
		height: u32,
		dirty: Rect,
	) -> Result<AsyncTask<SpoutTask>> {
		let row = dirty.width as usize * 4;
		let bytes: &[u8] = pixels.as_ref();
		let stride = stride as usize;
		if dirty.height > 0 && (stride < row || bytes.len() < stride * (dirty.height as usize - 1) + row) {
			return Err(reason(format!(
				"{} bytes do not hold a {}×{} picture of {stride} bytes a row",
				bytes.len(),
				dirty.width,
				dirty.height
			)));
		}
		// Copied: the worker thread cannot hold on to JavaScript's buffer.
		let mut tight = Vec::with_capacity(row * dirty.height as usize);
		for y in 0..dirty.height as usize {
			tight.extend_from_slice(&bytes[y * stride..y * stride + row]);
		}
		Ok(AsyncTask::new(SpoutTask {
			sender: self.sender.clone(),
			frame: SpoutFrame::Pixels {
				width,
				height,
				pixels: tight,
				dirty: (dirty.x, dirty.y, dirty.width, dirty.height),
			},
		}))
	}

	/// Takes the sender out of Spout's list (after the frame being drawn).
	#[napi]
	pub fn close(&self) {
		let sender = lock(&self.sender).take();
		#[cfg(windows)]
		drop(sender);
		#[cfg(not(windows))]
		let _ = sender;
	}
}
