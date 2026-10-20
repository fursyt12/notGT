//! Spout 2 senders: an out shared with programs on the same Windows machine
//! — Resolume, TouchDesigner, OBS with the Spout2 plugin — as a D3D11
//! texture, with no copy through memory and nothing on the network.
//!
//! The protocol is the Spout SDK's (github.com/leadedge/Spout2, BSD):
//!
//!  - the shared memory `SpoutSenderNames` lists every sender's name, 256
//!    bytes each, in order, up to `MaxSenders` (64 unless the registry says
//!    otherwise); `<map>_mutex` guards it;
//!  - `ActiveSenderName` holds the name receivers take when given none;
//!  - shared memory named after the sender holds its `SharedTextureInfo`:
//!    the texture's legacy (32-bit) share handle, size and DXGI format;
//!  - `<name>_SpoutAccessMutex` is held while the texture is written or read;
//!  - `<name>_Count_Semaphore` counts the frames, for receivers that ask.
//!
//! The texture is BGRA with premultiplied alpha, as Chromium draws it and as
//! Resolume and TouchDesigner take it: a glow at a tenth of its alpha keeps a
//! tenth of its colour. (Divided out to straight alpha, faint pixels came out
//! at full colour, and Resolume showed every glow as a solid blob.) A pixel
//! shader draws each frame into it — its visible part, or over black with
//! the alpha set to 1, sent opaque.
//!
//! Windows only: elsewhere the crate is empty.
#![cfg(windows)]

use std::collections::BTreeSet;
use std::ffi::{c_void, CString};
use std::time::{Duration, Instant};

use windows::core::{Interface, PCSTR};
use windows::Win32::Foundation::{
	CloseHandle, CompareObjectHandles, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, HMODULE, INVALID_HANDLE_VALUE,
	WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::Globalization::{MultiByteToWideChar, WideCharToMultiByte, CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{
	ID3DBlob, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL,
	D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
	D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIResource};
use windows::Win32::System::Memory::{
	CreateFileMappingA, MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, VirtualQuery, FILE_MAP_ALL_ACCESS,
	MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::System::Registry::{RegGetValueA, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::System::Threading::{
	CreateMutexA, CreateSemaphoreA, GetCurrentProcess, ReleaseMutex, ReleaseSemaphore, WaitForSingleObject,
};

/// What can go wrong, said for the log and the dashboard.
pub type Result<T> = std::result::Result<T, String>;

/// Bytes of a name in `SpoutSenderNames`, its NUL included.
const NAME_LEN: usize = 256;
const DEFAULT_MAX_SENDERS: u32 = 64;
/// How long a lock is waited for: four frames at 60 fps, as the SDK does.
const LOCK_MS: u32 = 67;
const INFO_LEN: usize = 280;
/// How long the GPU may take to draw one frame before the sender gives up.
const GPU_TIMEOUT: Duration = Duration::from_secs(2);
/// Chromium's textures kept open: it draws into a few of them in turn.
const OPENED: usize = 8;

const SHADER: &str = r"
cbuffer Params : register(b0) { int2 origin; int opaque; int pad; };
Texture2D<float4> frame : register(t0);
float4 vs(uint id : SV_VertexID) : SV_Position {
	float2 uv = float2((id << 1) & 2, id & 2);
	return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 ps(float4 position : SV_Position) : SV_Target {
	float4 c = frame.Load(int3(int2(position.xy) + origin, 0));
	if (opaque != 0) return float4(c.rgb, 1);
	return c;
}
";

#[repr(C)]
#[derive(Clone, Copy)]
struct Params {
	origin: [i32; 2],
	opaque: i32,
	pad: i32,
}

fn fail(what: &str) -> impl FnOnce(windows::core::Error) -> String + '_ {
	move |e| format!("{what}: {}", e.message().trim_end())
}

/// A name as Spout keeps it: the system's ANSI code page, as every Spout
/// program passes it, under 256 bytes, with no backslash (kernel object
/// names take it for a namespace).
pub fn spout_name(name: &str) -> Result<Vec<u8>> {
	let clean: String = name.trim().chars().map(|c| if c == '\\' || c.is_control() { '/' } else { c }).collect();
	if clean.is_empty() {
		return Err("the Spout name is empty".into());
	}
	let wide: Vec<u16> = clean.encode_utf16().collect();
	let mut bytes = if clean.is_ascii() {
		clean.into_bytes()
	} else {
		unsafe {
			let n = WideCharToMultiByte(CP_ACP, 0, &wide, None, PCSTR::null(), None);
			let mut out = vec![0u8; n.max(0) as usize];
			WideCharToMultiByte(CP_ACP, 0, &wide, Some(&mut out), PCSTR::null(), None);
			out
		}
	};
	bytes.truncate(NAME_LEN - 1);
	if bytes.contains(&0) {
		return Err("the Spout name cannot hold a NUL".into());
	}
	Ok(bytes)
}

/// The name back as text, for the log.
fn name_text(bytes: &[u8]) -> String {
	if bytes.is_ascii() {
		return String::from_utf8_lossy(bytes).into_owned();
	}
	unsafe {
		let n = MultiByteToWideChar(CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, None);
		let mut wide = vec![0u16; n.max(0) as usize];
		MultiByteToWideChar(CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, Some(&mut wide));
		String::from_utf16_lossy(&wide)
	}
}

fn cstring(bytes: &[u8]) -> CString {
	CString::new(bytes.to_vec()).expect("no NUL in Spout names")
}

/// A Win32 handle closed when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
	fn drop(&mut self) {
		if !self.0.is_invalid() {
			unsafe {
				let _ = CloseHandle(self.0);
			}
		}
	}
}

// Kernel handles may be used from any thread.
unsafe impl Send for Owned {}

/// Shared memory as `SpoutSharedMemory` makes it: a page-file mapping, and a
/// mutex named after it.
struct SharedMemory {
	map: Owned,
	view: MEMORY_MAPPED_VIEW_ADDRESS,
	len: usize,
	mutex: Owned,
}

unsafe impl Send for SharedMemory {}

impl SharedMemory {
	/// Opens the mapping, or makes it when no one has: then it is all zeros.
	fn create(name: &[u8], len: usize) -> Result<Self> {
		let c = cstring(name);
		unsafe {
			let map = CreateFileMappingA(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, len as u32, PCSTR(c.as_ptr() as _))
				.map_err(fail("shared memory"))?;
			Self::mapped(Owned(map), name)
		}
	}

	/// Opens a mapping someone else made; `None` when there is none.
	fn open(name: &[u8]) -> Option<Self> {
		let c = cstring(name);
		unsafe {
			let map = OpenFileMappingA(FILE_MAP_ALL_ACCESS.0, false, PCSTR(c.as_ptr() as _)).ok()?;
			Self::mapped(Owned(map), name).ok()
		}
	}

	unsafe fn mapped(map: Owned, name: &[u8]) -> Result<Self> {
		let view = MapViewOfFile(map.0, FILE_MAP_ALL_ACCESS, 0, 0, 0);
		if view.Value.is_null() {
			return Err(format!("shared memory: {}", windows::core::Error::from_thread().message()));
		}
		// Whoever made it decided its size (MaxSenders may differ).
		let mut info = MEMORY_BASIC_INFORMATION::default();
		VirtualQuery(Some(view.Value), &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>());
		let mut mutex_name = name.to_vec();
		mutex_name.extend_from_slice(b"_mutex");
		let m = cstring(&mutex_name);
		let mutex = match CreateMutexA(None, false, PCSTR(m.as_ptr() as _)) {
			Ok(mutex) => mutex,
			Err(e) => {
				let _ = UnmapViewOfFile(view);
				return Err(fail("shared memory's mutex")(e));
			}
		};
		Ok(Self { map, view, len: info.RegionSize, mutex: Owned(mutex) })
	}

	fn bytes(&mut self) -> &mut [u8] {
		unsafe { std::slice::from_raw_parts_mut(self.view.Value as *mut u8, self.len) }
	}

	/// Runs `f` with the memory locked; an error when the lock does not come.
	fn locked<T>(&mut self, f: impl FnOnce(&mut [u8]) -> T) -> Result<T> {
		let wait = unsafe { WaitForSingleObject(self.mutex.0, LOCK_MS) };
		if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
			return Err("Spout's list of senders stays locked by another program".into());
		}
		let result = f(self.bytes());
		unsafe {
			let _ = ReleaseMutex(self.mutex.0);
		}
		Ok(result)
	}
}

impl Drop for SharedMemory {
	fn drop(&mut self) {
		unsafe {
			let _ = UnmapViewOfFile(self.view);
		}
		let _ = &self.map;
	}
}

fn max_senders() -> u32 {
	let mut value = 0u32;
	let mut size = 4u32;
	let found = unsafe {
		RegGetValueA(
			HKEY_CURRENT_USER,
			PCSTR(c"Software\\Leading Edge\\Spout".as_ptr() as _),
			PCSTR(c"MaxSenders".as_ptr() as _),
			RRF_RT_REG_DWORD,
			None,
			Some(&mut value as *mut u32 as *mut c_void),
			Some(&mut size),
		)
	};
	if found.is_ok() && value > 0 {
		value
	} else {
		DEFAULT_MAX_SENDERS
	}
}

/// The names in `SpoutSenderNames`, as the SDK reads them.
fn read_names(buf: &[u8]) -> BTreeSet<Vec<u8>> {
	let mut names = BTreeSet::new();
	for slot in buf.chunks_exact(NAME_LEN) {
		let len = slot.iter().position(|&b| b == 0).unwrap_or(NAME_LEN - 1);
		if len == 0 {
			break;
		}
		names.insert(slot[..len].to_vec());
	}
	names
}

/// The names back, sorted (the SDK keeps them in a `std::set`), a NUL after
/// the last when there is room.
fn write_names(buf: &mut [u8], names: &BTreeSet<Vec<u8>>) {
	let mut slots = buf.chunks_exact_mut(NAME_LEN);
	for name in names {
		let Some(slot) = slots.next() else { return };
		slot.fill(0);
		slot[..name.len()].copy_from_slice(name);
	}
	if let Some(slot) = slots.next() {
		slot[0] = 0;
	}
}

fn read_active(buf: &[u8]) -> Vec<u8> {
	let len = buf.iter().position(|&b| b == 0).unwrap_or(0);
	buf[..len].to_vec()
}

fn write_active(buf: &mut [u8], name: &[u8]) {
	buf[..NAME_LEN].fill(0);
	buf[..name.len()].copy_from_slice(name);
}

/// The sender's name in Spout's lists, its info and its sync objects; taken
/// out of the lists when dropped.
struct Registration {
	name: Vec<u8>,
	names: SharedMemory,
	info: SharedMemory,
	access: Owned,
	frames: Owned,
	/// `ActiveSenderName`, held open: a mapping nobody holds is gone, and
	/// the name in it with it.
	active: Option<SharedMemory>,
}

impl Registration {
	fn new(name: Vec<u8>) -> Result<Self> {
		let max = max_senders() as usize;
		let mut names = SharedMemory::create(b"SpoutSenderNames", max * NAME_LEN)?;
		names.locked(|buf| {
			let mut list = read_names(buf);
			if list.contains(&name) {
				// The name stays listed after a sender that crashed; its info
				// goes with its process.
				if SharedMemory::open(&name).is_some() {
					return Err(format!(
						"another Spout sender called “{}” is running on this computer: give this one another name",
						name_text(&name)
					));
				}
			} else {
				if list.len() >= buf.len() / NAME_LEN {
					return Err(format!("Spout's list of senders is full ({} of them)", list.len()));
				}
				list.insert(name.clone());
				write_names(buf, &list);
			}
			Ok(())
		})??;
		let objects = (|| -> Result<(SharedMemory, Owned, Owned)> {
			let info = SharedMemory::create(&name, INFO_LEN)?;
			let mut access_name = name.clone();
			access_name.extend_from_slice(b"_SpoutAccessMutex");
			let a = cstring(&access_name);
			let access = unsafe { CreateMutexA(None, false, PCSTR(a.as_ptr() as _)) }.map_err(fail("Spout's access mutex"))?;
			let access = Owned(access);
			let mut count_name = name.clone();
			count_name.extend_from_slice(b"_Count_Semaphore");
			let c = cstring(&count_name);
			let frames = unsafe { CreateSemaphoreA(None, 1, i32::MAX, PCSTR(c.as_ptr() as _)) }
				.map_err(fail("Spout's frame counter"))?;
			Ok((info, access, Owned(frames)))
		})();
		match objects {
			Ok((info, access, frames)) => {
				let mut reg = Self { name, names, info, access, frames, active: None };
				reg.claim_active();
				Ok(reg)
			}
			Err(e) => {
				let _ = names.locked(|buf| {
					let mut list = read_names(buf);
					list.remove(&name);
					write_names(buf, &list);
				});
				Err(e)
			}
		}
	}

	/// The active sender, when there is none (or it is gone): this one.
	fn claim_active(&mut self) {
		let Ok(active) = SharedMemory::create(b"ActiveSenderName", NAME_LEN) else { return };
		let listed = self.names.locked(|buf| read_names(buf)).unwrap_or_default();
		let name = self.name.clone();
		let active = self.active.insert(active);
		let _ = active.locked(|buf| {
			let current = read_active(buf);
			if current.is_empty() || !listed.contains(&current) {
				write_active(buf, &name);
			}
		});
	}

	fn describe(&mut self, handle: u32, width: u32, height: u32) {
		let mut info = [0u8; INFO_LEN];
		info[0..4].copy_from_slice(&handle.to_le_bytes());
		info[4..8].copy_from_slice(&width.to_le_bytes());
		info[8..12].copy_from_slice(&height.to_le_bytes());
		info[12..16].copy_from_slice(&(DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32).to_le_bytes());
		// usage 0; the description is the program's path, as the SDK writes it.
		if let Ok(exe) = std::env::current_exe() {
			let path = exe.to_string_lossy();
			let bytes = path.as_bytes();
			let n = bytes.len().min(255);
			info[20..20 + n].copy_from_slice(&bytes[..n]);
		}
		let _ = self.info.locked(|buf| buf[..INFO_LEN].copy_from_slice(&info));
	}
}

impl Drop for Registration {
	fn drop(&mut self) {
		let name = self.name.clone();
		let left = self
			.names
			.locked(|buf| {
				let mut list = read_names(buf);
				list.remove(&name);
				write_names(buf, &list);
				list
			})
			.unwrap_or_default();
		let active = self.active.take().or_else(|| SharedMemory::create(b"ActiveSenderName", NAME_LEN).ok());
		if let Some(mut active) = active {
			let _ = active.locked(|buf| {
				if read_active(buf) == name {
					write_active(buf, left.iter().next().map_or(&[][..], |n| n.as_slice()));
				}
			});
		}
	}
}

/// What one frame cost.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sent {
	pub width: u32,
	pub height: u32,
	/// A receiver held the texture too long: this frame was not written.
	pub skipped: bool,
	/// Chromium's texture was opened for this frame, not kept from before.
	pub opened: bool,
	pub gpu_ms: f64,
	pub total_ms: f64,
}

/// The texture receivers read, and the view it is drawn through.
struct Target {
	texture: ID3D11Texture2D,
	view: ID3D11RenderTargetView,
	width: u32,
	height: u32,
}

/// One of Chromium's textures, opened once and kept: opening it again for
/// every frame costs a call into the driver each time. Known by what it is,
/// not by the handle it comes with — every frame brings a handle of its own,
/// and Windows gives a closed handle's value out again — through a handle of
/// this process's own on it, which the next ones are compared against.
struct Opened {
	handle: Owned,
	view: ID3D11ShaderResourceView,
	used: u64,
}

/// Frames drawn on the CPU go through this texture.
struct Upload {
	texture: ID3D11Texture2D,
	view: ID3D11ShaderResourceView,
	width: u32,
	height: u32,
}

/// One Spout sender.
pub struct Sender {
	device: ID3D11Device,
	context: ID3D11DeviceContext,
	vs: ID3D11VertexShader,
	ps: ID3D11PixelShader,
	params: ID3D11Buffer,
	done: ID3D11Query,
	opaque: bool,
	adapter: String,
	target: Option<Target>,
	upload: Option<Upload>,
	opened: Vec<Opened>,
	tick: u64,
	reg: Registration,
	/// False only in tests where textures cannot be shared (wine).
	share: bool,
}

// The device and its context are only used under the addon's lock.
unsafe impl Send for Sender {}

fn adapter_name(adapter: &IDXGIAdapter1) -> (String, u32, u32) {
	let desc = unsafe { adapter.GetDesc1() }.unwrap_or_default();
	let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
	(String::from_utf16_lossy(&desc.Description[..len]), desc.VendorId, desc.DeviceId)
}

/// The adapter with these PCI ids, when there is one.
fn find_adapter(pci: (u32, u32)) -> Option<IDXGIAdapter1> {
	let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
	(0..).map_while(|i| unsafe { factory.EnumAdapters1(i) }.ok()).find(|a| {
		let (_, vendor, device) = adapter_name(a);
		(vendor, device) == pci
	})
}

fn create_device(adapter: Option<&IDXGIAdapter1>, warp: bool) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
	let levels: [D3D_FEATURE_LEVEL; 4] =
		[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0];
	let adapter: Option<IDXGIAdapter> = adapter.and_then(|a| a.cast().ok());
	let driver = if adapter.is_some() {
		D3D_DRIVER_TYPE_UNKNOWN
	} else if warp {
		D3D_DRIVER_TYPE_WARP
	} else {
		D3D_DRIVER_TYPE_HARDWARE
	};
	let mut device = None;
	let mut context = None;
	let made = |levels: &[D3D_FEATURE_LEVEL], device: &mut Option<ID3D11Device>, context: &mut Option<ID3D11DeviceContext>| unsafe {
		D3D11CreateDevice(
			adapter.as_ref(),
			driver,
			HMODULE::default(),
			D3D11_CREATE_DEVICE_BGRA_SUPPORT,
			Some(levels),
			D3D11_SDK_VERSION,
			Some(device),
			None,
			Some(context),
		)
	};
	// Windows 7's runtime refuses a list with 11.1 in it.
	if made(&levels, &mut device, &mut context).is_err() {
		made(&levels[1..], &mut device, &mut context).map_err(fail("Direct3D 11"))?;
	}
	Ok((device.ok_or("Direct3D 11 made no device")?, context.ok_or("Direct3D 11 made no context")?))
}

fn compile(entry: &str, target: &str) -> Result<Vec<u8>> {
	let entry = CString::new(entry).unwrap();
	let target = CString::new(target).unwrap();
	let mut code: Option<ID3DBlob> = None;
	let mut errors: Option<ID3DBlob> = None;
	let done = unsafe {
		D3DCompile(
			SHADER.as_ptr() as *const c_void,
			SHADER.len(),
			PCSTR(c"spout.hlsl".as_ptr() as _),
			None,
			None,
			PCSTR(entry.as_ptr() as _),
			PCSTR(target.as_ptr() as _),
			0,
			0,
			&mut code,
			Some(&mut errors),
		)
	};
	let blob_bytes = |blob: &ID3DBlob| unsafe {
		std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize()).to_vec()
	};
	if let Err(e) = done {
		let said = errors.as_ref().map(|b| String::from_utf8_lossy(&blob_bytes(b)).into_owned()).unwrap_or_default();
		return Err(format!("the Spout shader does not compile: {} {said}", e.message()));
	}
	Ok(blob_bytes(code.as_ref().ok_or("the Spout shader compiled to nothing")?))
}

impl Sender {
	/// Opens Direct3D 11 — on the GPU with these PCI ids, the one Chromium
	/// draws on, when given — and lists the sender in Spout. `shared`: frames
	/// will come as Chromium's textures, which only that GPU can open.
	pub fn new(name: &str, alpha: bool, pci: Option<(u32, u32)>, shared: bool) -> Result<Self> {
		Self::make(name, alpha, pci, shared, true)
	}

	/// Tests only, where textures cannot be shared (wine): everything as
	/// `new`, but no receiver can open the texture.
	#[doc(hidden)]
	pub fn unshared(name: &str, alpha: bool) -> Result<Self> {
		Self::make(name, alpha, None, false, false)
	}

	fn make(name: &str, alpha: bool, pci: Option<(u32, u32)>, shared: bool, share: bool) -> Result<Self> {
		let name = spout_name(name)?;
		let adapter = pci.and_then(find_adapter);
		if let (true, Some((v, d)), None) = (shared, pci, adapter.as_ref()) {
			return Err(format!("Direct3D 11 has no adapter with PCI ids {v:#06x}:{d:#06x}, the GPU Chromium draws on"));
		}
		let (device, context) = match create_device(adapter.as_ref(), false) {
			Ok(made) => made,
			// No GPU at all: frames drawn on the CPU can still go out.
			Err(_) if !shared => create_device(None, true)?,
			Err(e) => return Err(e),
		};
		let adapter = device
			.cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>()
			.and_then(|d| unsafe { d.GetAdapter() })
			.and_then(|a| a.cast::<IDXGIAdapter1>())
			.map(|a| adapter_name(&a).0)
			.unwrap_or_else(|_| "an unknown adapter".into());

		let vs_code = compile("vs", "vs_4_0")?;
		let ps_code = compile("ps", "ps_4_0")?;
		let mut vs = None;
		let mut ps = None;
		let mut params = None;
		let mut done = None;
		unsafe {
			device.CreateVertexShader(&vs_code, None, Some(&mut vs)).map_err(fail("vertex shader"))?;
			device.CreatePixelShader(&ps_code, None, Some(&mut ps)).map_err(fail("pixel shader"))?;
			let desc = D3D11_BUFFER_DESC {
				ByteWidth: std::mem::size_of::<Params>() as u32,
				Usage: D3D11_USAGE_DEFAULT,
				BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
				..Default::default()
			};
			device.CreateBuffer(&desc, None, Some(&mut params)).map_err(fail("constant buffer"))?;
			let desc = D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 };
			device.CreateQuery(&desc, Some(&mut done)).map_err(fail("GPU query"))?;
		}
		let reg = Registration::new(name)?;
		Ok(Self {
			device,
			context,
			vs: vs.unwrap(),
			ps: ps.unwrap(),
			params: params.unwrap(),
			done: done.unwrap(),
			opaque: !alpha,
			adapter,
			target: None,
			upload: None,
			opened: Vec::new(),
			tick: 0,
			reg,
			share,
		})
	}

	/// The name receivers list, as Spout has it.
	pub fn name(&self) -> String {
		name_text(&self.reg.name)
	}

	/// The GPU it draws on.
	pub fn adapter(&self) -> &str {
		&self.adapter
	}

	/// The share handle receivers open; 0 before the first frame.
	pub fn share_handle(&self) -> u32 {
		match &self.target {
			Some(t) if self.share => self.handle_of(&t.texture).unwrap_or(0),
			_ => 0,
		}
	}

	fn handle_of(&self, texture: &ID3D11Texture2D) -> Result<u32> {
		let resource: IDXGIResource = texture.cast().map_err(fail("shared texture"))?;
		let handle = unsafe { resource.GetSharedHandle() }.map_err(fail("shared texture's handle"))?;
		// Legacy share handles are 32 bits wide, whatever the process.
		Ok(handle.0 as usize as u32)
	}

	/// The texture receivers read, `width`×`height`; a new one (and a new
	/// handle in the sender's info) when the size changes.
	fn target(&mut self, width: u32, height: u32) -> Result<()> {
		if self.target.as_ref().is_some_and(|t| t.width == width && t.height == height) {
			return Ok(());
		}
		self.target = None;
		let desc = D3D11_TEXTURE2D_DESC {
			Width: width,
			Height: height,
			MipLevels: 1,
			ArraySize: 1,
			Format: DXGI_FORMAT_B8G8R8A8_UNORM,
			SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
			Usage: D3D11_USAGE_DEFAULT,
			BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
			CPUAccessFlags: 0,
			MiscFlags: if self.share { D3D11_RESOURCE_MISC_SHARED.0 as u32 } else { 0 },
		};
		let mut texture = None;
		let mut view = None;
		unsafe {
			self.device.CreateTexture2D(&desc, None, Some(&mut texture)).map_err(fail("Spout texture"))?;
			let texture = texture.as_ref().unwrap();
			self.device.CreateRenderTargetView(texture, None, Some(&mut view)).map_err(fail("Spout texture's view"))?;
		}
		let texture = texture.unwrap();
		let handle = if self.share { self.handle_of(&texture)? } else { 0 };
		self.reg.describe(handle, width, height);
		self.target = Some(Target { texture, view: view.unwrap(), width, height });
		Ok(())
	}

	/// A frame Chromium drew, shared as an NT handle: drawn into the Spout
	/// texture. Returns once the GPU is done reading it.
	pub fn send_shared(&mut self, nt_handle: usize, visible: (u32, u32, u32, u32)) -> Result<Sent> {
		let began = Instant::now();
		let (view, opened) = self.view_of(HANDLE(nt_handle as *mut c_void))?;
		let mut sent = self.draw(&view, visible, began)?;
		sent.opened = opened;
		Ok(sent)
	}

	/// A view of the texture `handle` is on: kept from before, or opened now (true).
	fn view_of(&mut self, handle: HANDLE) -> Result<(ID3D11ShaderResourceView, bool)> {
		self.tick += 1;
		let tick = self.tick;
		if let Some(o) = self.opened.iter_mut().find(|o| unsafe { CompareObjectHandles(handle, o.handle.0) }.as_bool()) {
			o.used = tick;
			return Ok((o.view.clone(), false));
		}
		let device: ID3D11Device1 = self.device.cast().map_err(fail("Direct3D 11.1"))?;
		let frame: ID3D11Texture2D = unsafe { device.OpenSharedResource1(handle) }.map_err(fail("Chromium's frame"))?;
		let mut view = None;
		unsafe { self.device.CreateShaderResourceView(&frame, None, Some(&mut view)) }.map_err(fail("Chromium's frame's view"))?;
		let view = view.unwrap();
		let mut own = HANDLE::default();
		let me = unsafe { GetCurrentProcess() };
		// With no handle of its own the texture cannot be known again: opened anew next time.
		if unsafe { DuplicateHandle(me, handle, me, &mut own, 0, false, DUPLICATE_SAME_ACCESS) }.is_ok() {
			if self.opened.len() >= OPENED {
				let oldest = (0..self.opened.len()).min_by_key(|&i| self.opened[i].used).unwrap();
				self.opened.swap_remove(oldest);
			}
			self.opened.push(Opened { handle: Owned(own), view: view.clone(), used: tick });
		}
		Ok((view, true))
	}

	/// A frame drawn on the CPU (premultiplied BGRA): `pixels` hold the
	/// rectangle `dirty` of a `width`×`height` picture, `stride` bytes a row.
	pub fn send_pixels(
		&mut self,
		width: u32,
		height: u32,
		pixels: &[u8],
		stride: u32,
		dirty: (u32, u32, u32, u32),
	) -> Result<Sent> {
		let began = Instant::now();
		let (x, y, w, h) = dirty;
		if x + w > width || y + h > height || (h > 0 && pixels.len() < (stride * (h - 1) + w * 4) as usize) {
			return Err(format!("the frame's rectangle {w}×{h} at {x},{y} does not fit its {width}×{height} picture"));
		}
		if !self.upload.as_ref().is_some_and(|u| u.width == width && u.height == height) {
			self.upload = None;
			let desc = D3D11_TEXTURE2D_DESC {
				Width: width,
				Height: height,
				MipLevels: 1,
				ArraySize: 1,
				Format: DXGI_FORMAT_B8G8R8A8_UNORM,
				SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
				Usage: D3D11_USAGE_DEFAULT,
				BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
				CPUAccessFlags: 0,
				MiscFlags: 0,
			};
			let mut texture = None;
			let mut view = None;
			unsafe {
				self.device.CreateTexture2D(&desc, None, Some(&mut texture)).map_err(fail("upload texture"))?;
				self.device
					.CreateShaderResourceView(texture.as_ref().unwrap(), None, Some(&mut view))
					.map_err(fail("upload texture's view"))?;
			}
			self.upload = Some(Upload { texture: texture.unwrap(), view: view.unwrap(), width, height });
		}
		let upload = self.upload.as_ref().unwrap();
		if w > 0 && h > 0 {
			let area = D3D11_BOX { left: x, top: y, front: 0, right: x + w, bottom: y + h, back: 1 };
			unsafe {
				self.context.UpdateSubresource(&upload.texture, 0, Some(&area), pixels.as_ptr() as *const c_void, stride, 0);
			}
		}
		let view = upload.view.clone();
		self.draw(&view, (0, 0, width, height), began)
	}

	fn draw(&mut self, source: &ID3D11ShaderResourceView, visible: (u32, u32, u32, u32), began: Instant) -> Result<Sent> {
		let (x, y, width, height) = visible;
		self.target(width, height)?;
		let mut sent = Sent { width, height, ..Default::default() };
		// Receivers hold this while they copy the texture; the frame waits
		// for them, but not for long.
		let wait = unsafe { WaitForSingleObject(self.reg.access.0, LOCK_MS) };
		if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
			sent.skipped = true;
			sent.total_ms = began.elapsed().as_secs_f64() * 1000.0;
			return Ok(sent);
		}
		let drawn = self.draw_locked(source, x, y, width, height);
		unsafe {
			let _ = ReleaseMutex(self.reg.access.0);
		}
		sent.gpu_ms = drawn?;
		// A new frame for receivers that count them: the SDK's -1 then +2.
		unsafe {
			WaitForSingleObject(self.reg.frames.0, 0);
			let _ = ReleaseSemaphore(self.reg.frames.0, 2, None);
		}
		sent.total_ms = began.elapsed().as_secs_f64() * 1000.0;
		Ok(sent)
	}

	fn draw_locked(&mut self, source: &ID3D11ShaderResourceView, x: u32, y: u32, width: u32, height: u32) -> Result<f64> {
		let target = self.target.as_ref().unwrap();
		let params = Params { origin: [x as i32, y as i32], opaque: self.opaque as i32, pad: 0 };
		let c = &self.context;
		let viewport = D3D11_VIEWPORT {
			TopLeftX: 0.0,
			TopLeftY: 0.0,
			Width: width as f32,
			Height: height as f32,
			MinDepth: 0.0,
			MaxDepth: 1.0,
		};
		let gpu = Instant::now();
		unsafe {
			c.UpdateSubresource(&self.params, 0, None, &params as *const Params as *const c_void, 0, 0);
			c.OMSetRenderTargets(Some(&[Some(target.view.clone())]), None);
			c.RSSetViewports(Some(&[viewport]));
			c.IASetInputLayout(None);
			c.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
			c.VSSetShader(&self.vs, None);
			c.PSSetShader(&self.ps, None);
			c.PSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
			c.PSSetShaderResources(0, Some(&[Some(source.clone())]));
			c.Draw(3, 0);
			// Let go of the frame: Chromium gets it back once this returns.
			c.PSSetShaderResources(0, Some(&[None]));
			c.OMSetRenderTargets(None, None);
			c.End(&self.done);
			c.Flush();
		}
		// Waited for: Chromium draws into its texture again once released,
		// and receivers read ours once the mutex is let go.
		loop {
			let mut finished = windows::core::BOOL(0);
			let asked = unsafe {
				c.GetData(
					&self.done,
					Some(&mut finished as *mut _ as *mut c_void),
					std::mem::size_of_val(&finished) as u32,
					0,
				)
			};
			if asked.is_err() {
				return Err("the GPU was lost while drawing the Spout frame".into());
			}
			if finished.as_bool() {
				break;
			}
			if gpu.elapsed() > GPU_TIMEOUT {
				return Err("the GPU took over 2 s to draw the Spout frame".into());
			}
			std::thread::yield_now();
		}
		Ok(gpu.elapsed().as_secs_f64() * 1000.0)
	}

	/// Tests: the Spout texture as BGRA bytes, `width * 4` a row.
	pub fn read_back(&mut self) -> Result<Vec<u8>> {
		let target = self.target.as_ref().ok_or("nothing was sent yet")?;
		let mut desc = D3D11_TEXTURE2D_DESC::default();
		unsafe { target.texture.GetDesc(&mut desc) };
		desc.Usage = D3D11_USAGE_STAGING;
		desc.BindFlags = 0;
		desc.MiscFlags = 0;
		desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
		let mut staging = None;
		unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(fail("staging texture"))?;
		let staging = staging.unwrap();
		let mut out = vec![0u8; (desc.Width * desc.Height * 4) as usize];
		unsafe {
			self.context.CopyResource(&staging, &target.texture);
			let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
			self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(fail("staging texture's map"))?;
			let row = (desc.Width * 4) as usize;
			for y in 0..desc.Height as usize {
				let src = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
				std::ptr::copy_nonoverlapping(src, out[y * row..].as_mut_ptr(), row);
			}
			self.context.Unmap(&staging, 0);
		}
		Ok(out)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn names_are_listed_sorted_and_ended() {
		let mut buf = vec![0xffu8; NAME_LEN * 4];
		buf[0] = 0;
		assert!(read_names(&buf).is_empty());
		let names: BTreeSet<Vec<u8>> = [b"b".to_vec(), b"a".to_vec()].into();
		write_names(&mut buf, &names);
		assert_eq!(&buf[..2], b"a\0");
		assert_eq!(&buf[NAME_LEN..NAME_LEN + 2], b"b\0");
		assert_eq!(buf[2 * NAME_LEN], 0);
		assert_eq!(read_names(&buf), names);
	}

	#[test]
	fn a_full_list_has_no_end_mark() {
		let mut buf = vec![0u8; NAME_LEN * 2];
		let names: BTreeSet<Vec<u8>> = [b"x".to_vec(), b"y".to_vec(), b"z".to_vec()].into();
		write_names(&mut buf, &names);
		assert_eq!(read_names(&buf).len(), 2);
	}

	#[test]
	fn names_lose_backslashes_and_fit() {
		assert_eq!(spout_name(" notGT\\Main ").unwrap(), b"notGT/Main");
		assert_eq!(spout_name(&"n".repeat(400)).unwrap().len(), NAME_LEN - 1);
		assert!(spout_name("  ").is_err());
	}
}
