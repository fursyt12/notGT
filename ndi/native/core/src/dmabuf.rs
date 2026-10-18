//! What the kernel says about a dmabuf, and the one thing asked of it:
//! a sync file for the drawing still going on into it.

use std::os::fd::RawFd;

use crate::Result;

/// Which buffer this is: the same buffer has the same identity whatever fd
/// it comes as, so an import can be kept for the next frame drawn into it.
pub fn identity(fd: RawFd) -> Result<(u64, u64)> {
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	if unsafe { libc::fstat(fd, &mut stat) } != 0 {
		return Err(format!(
			"the frame's dmabuf cannot be read: {}",
			std::io::Error::last_os_error()
		));
	}
	Ok((stat.st_dev as u64, stat.st_ino as u64))
}

/// A copy of `fd` that the GPU driver may take over.
pub fn dup(fd: RawFd) -> Result<RawFd> {
	let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
	if copy < 0 {
		return Err(format!(
			"the frame's dmabuf cannot be duplicated: {}",
			std::io::Error::last_os_error()
		));
	}
	Ok(copy)
}

pub fn close(fd: RawFd) {
	unsafe { libc::close(fd) };
}

#[repr(C)]
struct ExportSyncFile {
	flags: u32,
	fd: i32,
}

/// `_IOWR('b', 2, struct dma_buf_export_sync_file)`.
const DMA_BUF_IOCTL_EXPORT_SYNC_FILE: libc::c_ulong = 0xC008_6202;
const DMA_BUF_SYNC_READ: u32 = 1;

/// A sync file that signals once everything drawing into the buffer is done
/// (Linux 6.0 and up); `None` where the kernel cannot give one.
///
/// Chromium's GPU process draws with GL, which leaves its fences on the
/// buffer itself (implicit sync); Vulkan waits only for what it is given.
/// This turns the one into the other.
pub fn sync_file(fd: RawFd) -> Result<Option<RawFd>> {
	let mut arg = ExportSyncFile { flags: DMA_BUF_SYNC_READ, fd: -1 };
	let done = unsafe { libc::ioctl(fd, DMA_BUF_IOCTL_EXPORT_SYNC_FILE as _, &mut arg) };
	if done == 0 {
		return Ok(Some(arg.fd));
	}
	let error = std::io::Error::last_os_error();
	match error.raw_os_error() {
		Some(libc::ENOTTY) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => Ok(None),
		_ => Err(format!("the frame's fences cannot be read: {error}")),
	}
}

/// The major and minor number of a device node, e.g. /dev/dri/renderD128.
pub fn device_number(path: &str) -> Option<(u64, u64)> {
	let name = std::ffi::CString::new(path).ok()?;
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	if unsafe { libc::stat(name.as_ptr(), &mut stat) } != 0 {
		return None;
	}
	let rdev = stat.st_rdev;
	Some((libc::major(rdev) as u64, libc::minor(rdev) as u64))
}

/// Waits until everything drawing into the buffer is done. `Ok(false)`: the
/// kernel cannot say (before Linux 6.0), and the frame is taken as it is.
pub fn wait_for_writers(fd: RawFd, timeout_ms: i32) -> Result<bool> {
	let Some(sync) = sync_file(fd)? else {
		return Ok(false);
	};
	let mut poll = libc::pollfd { fd: sync, events: libc::POLLIN, revents: 0 };
	let ready = loop {
		let n = unsafe { libc::poll(&mut poll, 1, timeout_ms) };
		if n >= 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
			break n;
		}
	};
	close(sync);
	match ready {
		1 => Ok(true),
		0 => Err(format!("Chromium's drawing of the frame did not finish in {timeout_ms} ms")),
		_ => Err(format!(
			"the frame's fences cannot be waited for: {}",
			std::io::Error::last_os_error()
		)),
	}
}
