//! The Spout sender against what a Spout receiver does: find the name in
//! `SpoutSenderNames`, read its info, open the texture by its share handle.
//! Windows only (run under wine on Linux: see the README's tests section).
#![cfg(windows)]

use std::ffi::c_void;

use notgt_spout_core::Sender;
use windows::core::{Interface, PCSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIResource1, DXGI_SHARED_RESOURCE_READ};
use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, FILE_MAP_ALL_ACCESS};

/// Wine draws, but shares no textures: there the sender's texture is
/// checked on its own device, and what receivers open is not.
fn wine() -> bool {
	unsafe {
		GetModuleHandleA(PCSTR(c"ntdll.dll".as_ptr() as _))
			.is_ok_and(|ntdll| GetProcAddress(ntdll, PCSTR(c"wine_get_version".as_ptr() as _)).is_some())
	}
}

fn open_sender(name: &str, alpha: bool) -> Sender {
	if wine() { Sender::unshared(name, alpha) } else { Sender::new(name, alpha, None, false) }.unwrap()
}

const W: u32 = 8;
const H: u32 = 4;

/// Premultiplied BGRA: every alpha, each colour at most the alpha.
fn pattern() -> Vec<u8> {
	let mut px = Vec::new();
	for y in 0..H {
		for x in 0..W {
			let a = ((x * 255) / (W - 1)) as u8;
			let k = |c: u32| ((c * a as u32) / 255) as u8;
			px.extend_from_slice(&[k(40 + y * 50), k(200), k(255 - y * 60), a]);
		}
	}
	px
}

/// What a receiver should read: the alpha divided out.
fn straight(px: &[u8]) -> Vec<u8> {
	px.chunks(4)
		.flat_map(|p| {
			let a = p[3] as f32;
			let c = |v: u8| if a == 0.0 { 0 } else { ((v as f32 * 255.0 / a).round()).min(255.0) as u8 };
			if p[3] == 0 { [0, 0, 0, 0] } else { [c(p[0]), c(p[1]), c(p[2]), p[3]] }
		})
		.collect()
}

fn close_enough(got: &[u8], want: &[u8]) {
	assert_eq!(got.len(), want.len());
	for (i, (g, w)) in got.iter().zip(want).enumerate() {
		// The alpha and the colours of opaque pixels are exact; dividing a
		// colour by a small alpha in floats may round the other way.
		assert!(g.abs_diff(*w) <= 1, "byte {i}: got {g}, want {w}");
	}
}

/// The shared memory a receiver opens, `len` bytes of it.
fn read_map(name: &str, len: usize) -> Option<Vec<u8>> {
	let c = std::ffi::CString::new(name).unwrap();
	unsafe {
		let map = OpenFileMappingA(FILE_MAP_ALL_ACCESS.0, false, PCSTR(c.as_ptr() as _)).ok()?;
		let view = MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, 0);
		let bytes = std::slice::from_raw_parts(view.Value as *const u8, len).to_vec();
		let _ = UnmapViewOfFile(view);
		let _ = CloseHandle(map);
		Some(bytes)
	}
}

fn listed() -> Vec<String> {
	let Some(buf) = read_map("SpoutSenderNames", 64 * 256) else { return vec![] };
	buf.chunks(256)
		.map(|s| String::from_utf8_lossy(&s[..s.iter().position(|&b| b == 0).unwrap()]).into_owned())
		.take_while(|s| !s.is_empty())
		.collect()
}

/// A receiver's device: on the GPU, or WARP where there is none (a CI
/// runner); `true` with the GPU.
fn device() -> (ID3D11Device, ID3D11DeviceContext, bool) {
	match device_of(D3D_DRIVER_TYPE_HARDWARE) {
		Some((d, c)) => (d, c, true),
		None => {
			let (d, c) = device_of(D3D_DRIVER_TYPE_WARP).expect("no Direct3D 11 device at all");
			(d, c, false)
		}
	}
}

fn device_of(driver: D3D_DRIVER_TYPE) -> Option<(ID3D11Device, ID3D11DeviceContext)> {
	let (mut d, mut c) = (None, None);
	unsafe {
		D3D11CreateDevice(
			None,
			driver,
			HMODULE::default(),
			D3D11_CREATE_DEVICE_BGRA_SUPPORT,
			None,
			D3D11_SDK_VERSION,
			Some(&mut d),
			None,
			Some(&mut c),
		)
		.ok()?;
	}
	Some((d?, c?))
}

fn read_texture(device: &ID3D11Device, context: &ID3D11DeviceContext, texture: &ID3D11Texture2D) -> Vec<u8> {
	let mut desc = D3D11_TEXTURE2D_DESC::default();
	unsafe { texture.GetDesc(&mut desc) };
	desc.Usage = D3D11_USAGE_STAGING;
	desc.BindFlags = 0;
	desc.MiscFlags = 0;
	desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
	let mut staging = None;
	let mut out = vec![];
	unsafe {
		device.CreateTexture2D(&desc, None, Some(&mut staging)).unwrap();
		let staging = staging.unwrap();
		context.CopyResource(&staging, texture);
		let mut m = D3D11_MAPPED_SUBRESOURCE::default();
		context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut m)).unwrap();
		for y in 0..desc.Height as usize {
			let row = std::slice::from_raw_parts((m.pData as *const u8).add(y * m.RowPitch as usize), desc.Width as usize * 4);
			out.extend_from_slice(row);
		}
		context.Unmap(&staging, 0);
	}
	out
}

#[test]
fn a_cpu_frame_reaches_a_receiver_with_straight_alpha() {
	let px = pattern();
	let mut sender = open_sender("notGT test cpu", true);
	assert_eq!(sender.name(), "notGT test cpu");
	assert!(listed().contains(&"notGT test cpu".to_string()), "listed: {:?}", listed());
	let sent = sender.send_pixels(W, H, &px, W * 4, (0, 0, W, H)).unwrap();
	assert!(!sent.skipped);
	close_enough(&sender.read_back().unwrap(), &straight(&px));

	// Only a rectangle changed: the rest stays.
	let mut changed = px.clone();
	let at = (W * 4 + 4) as usize; // (1, 1)
	changed[at..at + 4].copy_from_slice(&[0, 0, 128, 128]);
	sender.send_pixels(W, H, &changed[at..], W * 4, (1, 1, 1, 1)).unwrap();
	close_enough(&sender.read_back().unwrap(), &straight(&changed));

	// What a receiver reads in the sender's info.
	let info = read_map("notGT test cpu", 280).unwrap();
	let u = |i: usize| u32::from_le_bytes(info[i..i + 4].try_into().unwrap());
	assert_eq!(u(0), sender.share_handle());
	assert_eq!((u(4), u(8), u(12)), (W, H, DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32));
	assert!(String::from_utf8_lossy(&info[20..276]).to_lowercase().contains(".exe"));

	// A second sender of the same name is refused, the first one untouched.
	let again = Sender::new("notGT test cpu", true, None, false).err().unwrap();
	assert!(again.contains("another Spout sender"), "{again}");

	// …and the texture, opened by its handle on a device of its own.
	if !wine() {
		assert_ne!(u(0), 0);
		let (device, context, _) = device();
		let mut texture: Option<ID3D11Texture2D> = None;
		let opened = unsafe { device.OpenSharedResource(HANDLE(u(0) as usize as *mut c_void), &mut texture) }
			.and_then(|_| texture.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)));
		let texture = opened.unwrap_or_else(|e| panic!("a receiver cannot open the texture: {}", e.message()));
		close_enough(&read_texture(&device, &context, &texture), &straight(&changed));
	}

	drop(sender);
	assert!(!listed().contains(&"notGT test cpu".to_string()));
	// Its name is free again.
	drop(open_sender("notGT test cpu", true));
}

#[test]
fn opaque_frames_keep_their_colours_over_black() {
	let px = pattern();
	let mut sender = open_sender("notGT test opaque", false);
	sender.send_pixels(W, H, &px, W * 4, (0, 0, W, H)).unwrap();
	let want: Vec<u8> = px.chunks(4).flat_map(|p| [p[0], p[1], p[2], 255]).collect();
	close_enough(&sender.read_back().unwrap(), &want);
}

/// Chromium's frame: a texture shared as an NT handle, no keyed mutex.
#[test]
fn a_gpu_frame_is_drawn_from_its_nt_handle() {
	let px = pattern();
	let (device, _context, gpu) = device();
	if !gpu {
		eprintln!("no GPU here: Chromium's frames are on one, so there is nothing to test (skipped)");
		return;
	}
	let desc = D3D11_TEXTURE2D_DESC {
		Width: W,
		Height: H,
		MipLevels: 1,
		ArraySize: 1,
		Format: DXGI_FORMAT_B8G8R8A8_UNORM,
		SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
		Usage: D3D11_USAGE_DEFAULT,
		BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
		CPUAccessFlags: 0,
		MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED.0) as u32,
	};
	let data = D3D11_SUBRESOURCE_DATA { pSysMem: px.as_ptr() as *const c_void, SysMemPitch: W * 4, SysMemSlicePitch: 0 };
	let mut texture = None;
	let made = unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) };
	let handle = made.and_then(|_| unsafe {
		texture.as_ref().unwrap().cast::<IDXGIResource1>()?.CreateSharedHandle(None, DXGI_SHARED_RESOURCE_READ.0, None)
	});
	let handle = match handle {
		Ok(h) => h,
		Err(e) if wine() => {
			eprintln!("NT-handle textures: {} (skipped here)", e.message());
			return;
		}
		Err(e) => panic!("{}", e.message()),
	};
	let mut sender = Sender::new("notGT test gpu", true, None, true).unwrap();
	// A frame larger than what is visible of it: only that part goes out.
	let sent = sender.send_shared(handle.0 as usize, (2, 1, 4, 2)).unwrap();
	assert_eq!((sent.width, sent.height), (4, 2));
	let want: Vec<u8> = straight(&px)
		.chunks(W as usize * 4)
		.skip(1)
		.take(2)
		.flat_map(|row| row[8..24].to_vec())
		.collect();
	close_enough(&sender.read_back().unwrap(), &want);
	unsafe {
		let _ = CloseHandle(handle);
	}
}

#[test]
fn two_senders_are_listed_side_by_side() {
	let active = || {
		read_map("ActiveSenderName", 256).map(|b| String::from_utf8_lossy(&b[..b.iter().position(|&c| c == 0).unwrap()]).into_owned())
	};
	let a = open_sender("notGT test pair A", true);
	let b = open_sender("notGT test pair B", true);
	let names = listed();
	assert!(
		names.contains(&"notGT test pair A".to_string()) && names.contains(&"notGT test pair B".to_string()),
		"listed: {names:?}"
	);
	// The senders hold `ActiveSenderName` open: nobody else has to.
	let first = active().expect("ActiveSenderName is gone");
	assert!(listed().contains(&first), "the active sender {first:?} is not listed");

	drop(a);
	assert!(!listed().contains(&"notGT test pair A".to_string()));
	assert!(listed().contains(&"notGT test pair B".to_string()), "the second sender lost its place");
	assert_ne!(active().expect("ActiveSenderName is gone"), "notGT test pair A");
	drop(b);
}
