//! An NDI source, in the library the JavaScript side found and opened
//! (src/ndi.mjs): the same file, so the same library in the process.
//! The structures are the NDI SDK's (Processing.NDI.structs.h), as
//! src/ndi.mjs declares them.

use std::ffi::{c_char, c_void, CString};
use std::ptr;

use crate::Result;

#[repr(C)]
struct SendCreate {
	p_ndi_name: *const c_char,
	p_groups: *const c_char,
	clock_video: bool,
	clock_audio: bool,
}

#[repr(C)]
struct VideoFrameV2 {
	xres: i32,
	yres: i32,
	four_cc: u32,
	frame_rate_n: i32,
	frame_rate_d: i32,
	picture_aspect_ratio: f32,
	frame_format_type: i32,
	timecode: i64,
	p_data: *const u8,
	line_stride_in_bytes: i32,
	p_metadata: *const c_char,
	timestamp: i64,
}

const FRAME_PROGRESSIVE: i32 = 1;
const TIMECODE_SYNTHESIZE: i64 = i64::MAX;

type Initialize = unsafe extern "C" fn() -> bool;
type SendCreateFn = unsafe extern "C" fn(*const SendCreate) -> *mut c_void;
type SendDestroy = unsafe extern "C" fn(*mut c_void);
type SendVideo = unsafe extern "C" fn(*mut c_void, *const VideoFrameV2);
type Connections = unsafe extern "C" fn(*mut c_void, u32) -> i32;

struct Library {
	_lib: libloading::Library,
	send_create: SendCreateFn,
	send_destroy: SendDestroy,
	send_video: SendVideo,
	send_video_async: SendVideo,
	connections: Connections,
}

/// The frame rate as NDI wants it: 29.97, 23.976 and 59.94 are exactly
/// 30000/1001 and so on, the rest n/1000 (src/ndi.mjs `frameRate`).
pub fn frame_rate(fps: f64) -> (i32, i32) {
	let ntsc = (fps * 1001.0 / 1000.0).round();
	if fps.fract() != 0.0 && (ntsc * 1000.0 / 1001.0 - fps).abs() < 0.005 {
		((ntsc * 1000.0) as i32, 1001)
	} else {
		((fps * 1000.0).round() as i32, 1000)
	}
}

/// A source on the network.
pub struct Sender {
	lib: Library,
	handle: *mut c_void,
	frame_rate: (i32, i32),
}

// NDI's sender may be used from any thread, one call at a time — the caller
// keeps it behind a lock.
unsafe impl Send for Sender {}

impl Sender {
	pub fn new(file: &str, name: &str, groups: Option<&str>, fps: f64) -> Result<Self> {
		let lib = unsafe { libloading::Library::new(file) }
			.map_err(|e| format!("the NDI library {file} cannot be opened: {e}"))?;
		macro_rules! symbol {
			($name:literal, $ty:ty) => {
				*unsafe { lib.get::<$ty>($name) }.map_err(|e| {
					format!(
						"the NDI library {file} has no {}: {e}",
						String::from_utf8_lossy(&$name[..$name.len() - 1])
					)
				})?
			};
		}
		let initialize = symbol!(b"NDIlib_initialize\0", Initialize);
		let lib = Library {
			send_create: symbol!(b"NDIlib_send_create\0", SendCreateFn),
			send_destroy: symbol!(b"NDIlib_send_destroy\0", SendDestroy),
			send_video: symbol!(b"NDIlib_send_send_video_v2\0", SendVideo),
			send_video_async: symbol!(b"NDIlib_send_send_video_async_v2\0", SendVideo),
			connections: symbol!(b"NDIlib_send_get_no_connections\0", Connections),
			_lib: lib,
		};
		// Already done by the JavaScript side; asking again is harmless.
		if !unsafe { initialize() } {
			return Err("NDI refused to start: this CPU is not supported by the NDI library".into());
		}
		let c_name = CString::new(name).map_err(|_| "the NDI name has a NUL in it".to_string())?;
		let c_groups = groups
			.filter(|g| !g.is_empty())
			.map(CString::new)
			.transpose()
			.map_err(|_| "the NDI groups have a NUL in them".to_string())?;
		let settings = SendCreate {
			p_ndi_name: c_name.as_ptr(),
			p_groups: c_groups.as_ref().map_or(ptr::null(), |g| g.as_ptr()),
			// The pace is the out's frame clock (src/clock.mjs), not NDI's.
			clock_video: false,
			clock_audio: false,
		};
		let handle = unsafe { (lib.send_create)(&settings) };
		if handle.is_null() {
			return Err(format!("NDI could not create the source “{name}”"));
		}
		Ok(Self { lib, handle, frame_rate: frame_rate(fps) })
	}

	/// Hands NDI a frame and returns at once; NDI compresses and sends it on
	/// its own threads, reading `data` until the next call to `send` or
	/// `flush`. `data` must stay as it is until then.
	///
	/// # Safety
	/// `data` points at a whole frame of `layout`, alive until the next call.
	pub unsafe fn send(&self, data: *const u8, layout: &crate::Layout) {
		let frame = VideoFrameV2 {
			xres: layout.width as i32,
			yres: layout.height as i32,
			four_cc: layout.fourcc(),
			frame_rate_n: self.frame_rate.0,
			frame_rate_d: self.frame_rate.1,
			picture_aspect_ratio: layout.width as f32 / layout.height as f32,
			frame_format_type: FRAME_PROGRESSIVE,
			timecode: TIMECODE_SYNTHESIZE,
			p_data: data,
			line_stride_in_bytes: layout.stride() as i32,
			p_metadata: ptr::null(),
			timestamp: 0,
		};
		(self.lib.send_video_async)(self.handle, &frame);
	}

	/// Returns once NDI no longer reads the last frame it was given.
	pub fn flush(&self) {
		unsafe { (self.lib.send_video)(self.handle, ptr::null()) };
	}

	pub fn connections(&self) -> i32 {
		unsafe { (self.lib.connections)(self.handle, 0) }
	}
}

impl Drop for Sender {
	fn drop(&mut self) {
		// Waits for NDI to let go of the last frame.
		unsafe { (self.lib.send_destroy)(self.handle) };
	}
}

#[cfg(test)]
mod tests {
	use super::frame_rate;

	#[test]
	fn frame_rates_are_ndis() {
		assert_eq!(frame_rate(30.0), (30000, 1000));
		assert_eq!(frame_rate(29.97), (30000, 1001));
		assert_eq!(frame_rate(59.94), (60000, 1001));
		assert_eq!(frame_rate(23.976), (24000, 1001));
		assert_eq!(frame_rate(25.0), (25000, 1000));
	}
}
