//! The addon Electron's main process loads (src/native.mjs): one `NativeOut`
//! per out, holding its GPU backend and its NDI source.
//!
//! A conversion runs on Node's worker threads (`convert` returns a promise),
//! so the main process never waits for the GPU; sending and counting
//! receivers are quick calls on the main thread. The two never wait for each
//! other: the backend and the NDI side have a lock each.
//!
//! The frame clock — when a frame goes out, when the last one goes out again
//! — stays in JavaScript (src/clock.mjs); here are only the pixels.

use std::sync::{Arc, Mutex, MutexGuard};

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use notgt_ndi_core as native;

#[napi(object)]
pub struct DeviceInfo {
	pub backend: String,
	pub name: String,
	pub kind: String,
	pub driver: String,
	pub api: String,
	/// "major:minor" of its DRM render node, where it says.
	pub render_node: Option<String>,
	pub vendor_id: u32,
	pub device_id: u32,
	/// Ways it can import Chromium's frames (DRM modifiers; on Windows 1).
	pub layouts: u32,
	pub usable: bool,
	pub why: Option<String>,
}

#[napi(object)]
pub struct ProbeResult {
	pub backend: String,
	pub devices: Vec<DeviceInfo>,
	/// Why there is no backend here at all.
	pub error: Option<String>,
}

#[napi(object)]
pub struct OutOptions {
	/// The NDI library src/ndi.mjs opened.
	pub ndi_file: String,
	pub ndi_name: String,
	pub groups: Option<String>,
	pub fps: f64,
	pub alpha: bool,
	/// Linux: the render node Chromium draws on, e.g. /dev/dri/renderD128.
	pub render_node: Option<String>,
	/// Windows: the PCI ids of the GPU Chromium draws on (app.getGPUInfo).
	pub vendor_id: Option<u32>,
	pub device_id: Option<u32>,
	/// Tests only: accept a GPU emulated on the CPU.
	pub allow_software: Option<bool>,
	/// Tests only: false opens a device that cannot import frames, for
	/// `selfTest` and `send` alone.
	pub shared: Option<bool>,
}

/// Which GPU Chromium draws on, for `probe`.
#[napi(object)]
pub struct ProbeOptions {
	pub render_node: Option<String>,
	pub vendor_id: Option<u32>,
	pub device_id: Option<u32>,
}

#[napi(object)]
pub struct PlaneInfo {
	pub fd: i32,
	pub offset: u32,
	pub stride: u32,
}

/// A painted frame as Electron describes it (`texture.textureInfo`): a
/// dmabuf's modifier and planes on Linux, a D3D11 texture's NT handle (the
/// Buffer Electron gives) on Windows.
#[napi(object)]
pub struct FrameInfo {
	pub width: u32,
	pub height: u32,
	pub format: String,
	pub modifier: Option<String>,
	pub planes: Option<Vec<PlaneInfo>>,
	pub nt_handle: Option<Buffer>,
}

#[napi(object)]
pub struct Converted {
	pub slot: u32,
	pub width: u32,
	pub height: u32,
	pub imported: bool,
	pub synced: bool,
	pub import_ms: f64,
	pub gpu_ms: f64,
	pub total_ms: f64,
}

fn reason(e: String) -> Error {
	Error::from_reason(e)
}

fn pci(vendor: Option<u32>, device: Option<u32>) -> Option<(u32, u32)> {
	Some((vendor?, device?))
}

fn node_number(path: &Option<String>) -> Option<(u64, u64)> {
	#[cfg(target_os = "linux")]
	{
		path.as_deref().and_then(native::dmabuf::device_number)
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		None
	}
}

/// Every GPU the backend sees here, usable or not and why: for the log.
#[napi]
pub fn probe(options: Option<ProbeOptions>) -> ProbeResult {
	#[cfg(any(target_os = "linux", windows))]
	{
		let options = options.unwrap_or(ProbeOptions { render_node: None, vendor_id: None, device_id: None });
		let options = native::vulkan::Options {
			render_node: node_number(&options.render_node),
			pci: pci(options.vendor_id, options.device_id),
			allow_software: false,
			shared: true,
		};
		match native::vulkan::probe(&options) {
			Ok(devices) => ProbeResult {
				backend: "Vulkan".into(),
				devices: devices
					.into_iter()
					.map(|d| DeviceInfo {
						backend: d.backend,
						name: d.name,
						kind: d.kind,
						driver: d.driver,
						api: d.api,
						render_node: d.render_node.map(|(a, b)| format!("{a}:{b}")),
						vendor_id: d.pci.0,
						device_id: d.pci.1,
						layouts: d.layouts,
						usable: d.usable,
						why: d.why,
					})
					.collect(),
				error: None,
			},
			Err(e) => ProbeResult { backend: "Vulkan".into(), devices: vec![], error: Some(e) },
		}
	}
	#[cfg(not(any(target_os = "linux", windows)))]
	{
		let _ = options;
		ProbeResult {
			backend: String::new(),
			devices: vec![],
			error: Some(format!("no native GPU backend for {} yet", std::env::consts::OS)),
		}
	}
}

/// The NDI side: the source, and where each slot's frame is in memory.
struct Ndi {
	sender: Option<native::ndi::Sender>,
	/// The slots' memory (addresses), and their layout; none while the
	/// backend lets go of it for a new size.
	slots: Option<([usize; 3], native::Layout)>,
}

#[cfg(any(target_os = "linux", windows))]
type Backend = native::vulkan::Vulkan;
#[cfg(not(any(target_os = "linux", windows)))]
type Backend = ();

struct Shared {
	backend: Mutex<Option<Backend>>,
	ndi: Mutex<Ndi>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
	// A panic elsewhere must not take every later frame down with it.
	m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
	/// Before the backend lets go of the memory NDI may be reading.
	fn release_slots(&self) {
		let mut ndi = lock(&self.ndi);
		if let Some(sender) = &ndi.sender {
			sender.flush();
		}
		ndi.slots = None;
	}

	fn publish_slots(&self, backend: &Backend) {
		let Some(layout) = backend.layout() else { return };
		let addr = |i| backend.slot(i).map_or(0, |(p, _)| p as usize);
		lock(&self.ndi).slots = Some(([addr(0), addr(1), addr(2)], layout));
	}
}

/// One out: its GPU backend and its NDI source.
#[napi]
pub struct NativeOut {
	shared: Arc<Shared>,
	name: String,
}

fn parse_modifier(text: &str) -> Result<u64> {
	let parsed = match text.strip_prefix("0x") {
		Some(hex) => u64::from_str_radix(hex, 16),
		None => text.parse(),
	};
	parsed.map_err(|_| reason(format!("the frame's modifier {text:?} is not a number")))
}

pub struct ConvertTask {
	shared: Arc<Shared>,
	frame: native::SharedFrame,
	slot: usize,
}

impl Task for ConvertTask {
	type Output = (native::Timing, native::Layout);
	type JsValue = Converted;

	fn compute(&mut self) -> Result<Self::Output> {
		let shared = self.shared.clone();
		let mut backend = lock(&self.shared.backend);
		let backend = backend.as_mut().ok_or_else(|| reason("the out is closed".into()))?;
		let timing = backend
			.convert(&self.frame, self.slot, &mut || shared.release_slots())
			.map_err(reason)?;
		self.shared.publish_slots(backend);
		let layout = backend.layout().ok_or_else(|| reason("no result".into()))?;
		Ok((timing, layout))
	}

	fn resolve(&mut self, _env: Env, (timing, layout): Self::Output) -> Result<Self::JsValue> {
		Ok(Converted {
			slot: self.slot as u32,
			width: layout.width,
			height: layout.height,
			imported: timing.imported,
			synced: timing.synced,
			import_ms: timing.import_ms,
			gpu_ms: timing.gpu_ms,
			total_ms: timing.total_ms,
		})
	}
}

#[napi]
impl NativeOut {
	/// Opens the GPU and the NDI source; throws, saying why, when either
	/// cannot be had.
	#[napi(constructor)]
	pub fn new(options: OutOptions) -> Result<Self> {
		#[cfg(not(any(target_os = "linux", windows)))]
		{
			let _ = options;
			return Err(reason(format!("no native GPU backend for {} yet", std::env::consts::OS)));
		}
		#[cfg(any(target_os = "linux", windows))]
		{
			let backend = native::vulkan::Vulkan::new(
				&native::vulkan::Options {
					render_node: node_number(&options.render_node),
					pci: pci(options.vendor_id, options.device_id),
					allow_software: options.allow_software.unwrap_or(false),
					shared: options.shared.unwrap_or(true),
				},
				options.alpha,
			)
			.map_err(reason)?;
			let name = backend.name();
			let sender = native::ndi::Sender::new(
				&options.ndi_file,
				&options.ndi_name,
				options.groups.as_deref(),
				options.fps,
			)
			.map_err(reason)?;
			Ok(Self {
				shared: Arc::new(Shared {
					backend: Mutex::new(Some(backend)),
					ndi: Mutex::new(Ndi { sender: Some(sender), slots: None }),
				}),
				name,
			})
		}
	}

	/// What converts: API, GPU and driver.
	#[napi(getter)]
	pub fn backend(&self) -> String {
		self.name.clone()
	}

	/// Converts a test picture on the GPU and checks every byte against the
	/// CPU's result (integer arithmetic: they are the same to the byte on a
	/// GPU that works); throws if any differs.
	#[napi]
	pub fn self_test(&self) -> Result<String> {
		let (w, h) = (64, 32);
		let rgba = native::reference::test_pattern(w, h);
		let shared = self.shared.clone();
		let mut backend = lock(&self.shared.backend);
		let backend = backend.as_mut().ok_or_else(|| reason("the out is closed".into()))?;
		let got = backend
			.convert_pixels(w, h, &rgba, 0, &mut || shared.release_slots())
			.map_err(reason)?;
		self.shared.publish_slots(backend);
		let layout = backend.layout().ok_or_else(|| reason("no result".into()))?;
		let want = native::reference::convert(&rgba, &layout);
		let (worst, differ) = native::reference::compare(&got, &want);
		if differ > 0 {
			return Err(reason(format!(
				"the GPU converts wrongly: {differ} byte(s) of the test picture differ from the CPU's, by up to {worst}"
			)));
		}
		Ok(format!("a {w}×{h} test picture comes out as on the CPU, to the byte"))
	}

	/// Converts a painted frame into `slot`. The promise settles once the
	/// GPU is done with the frame — only then may it be released.
	#[napi]
	pub fn convert(&self, frame: FrameInfo, slot: u32) -> Result<AsyncTask<ConvertTask>> {
		if slot as usize >= 3 {
			return Err(reason(format!("there is no slot {slot}")));
		}
		let handle = if let Some(nt) = &frame.nt_handle {
			// HANDLE as Electron writes it: the pointer's bytes, this machine's order.
			let bytes: &[u8] = nt.as_ref();
			let mut value = [0u8; 8];
			let n = bytes.len().min(8);
			value[..n].copy_from_slice(&bytes[..n]);
			native::FrameHandle::D3d11 { handle: u64::from_ne_bytes(value) as usize }
		} else {
			native::FrameHandle::Dmabuf {
				modifier: parse_modifier(frame.modifier.as_deref().unwrap_or(""))?,
				planes: frame
					.planes
					.as_deref()
					.unwrap_or_default()
					.iter()
					.map(|p| native::Plane { fd: p.fd, offset: p.offset as u64, stride: p.stride as u64 })
					.collect(),
			}
		};
		let frame = native::SharedFrame {
			width: frame.width,
			height: frame.height,
			format: native::PixelFormat::parse(&frame.format).map_err(reason)?,
			handle,
		};
		Ok(AsyncTask::new(ConvertTask { shared: self.shared.clone(), frame, slot: slot as usize }))
	}

	/// Hands NDI the frame in `slot`; false when there is none to send.
	/// NDI reads it until the next `send` or `flush`: the slot must not be
	/// converted into before then.
	#[napi]
	pub fn send(&self, slot: u32) -> bool {
		let ndi = lock(&self.shared.ndi);
		let (Some(sender), Some((slots, layout))) = (&ndi.sender, &ndi.slots) else {
			return false;
		};
		let Some(&address) = slots.get(slot as usize) else { return false };
		unsafe { sender.send(address as *const u8, layout) };
		true
	}

	#[napi]
	pub fn connections(&self) -> i32 {
		lock(&self.shared.ndi).sender.as_ref().map_or(0, |s| s.connections())
	}

	/// Returns once NDI no longer reads any slot.
	#[napi]
	pub fn flush(&self) {
		if let Some(sender) = &lock(&self.shared.ndi).sender {
			sender.flush();
		}
	}

	/// Takes the source down (once NDI lets go of its last frame) and lets
	/// go of the GPU.
	#[napi]
	pub fn close(&self) {
		let sender = {
			let mut ndi = lock(&self.shared.ndi);
			ndi.slots = None;
			ndi.sender.take()
		};
		drop(sender);
		drop(lock(&self.shared.backend).take());
	}
}
