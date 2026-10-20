//! Chromium's textures on Windows, known by what they are rather than by
//! the handle they come with.
//!
//! Every frame comes with an NT handle of its own, which Electron closes
//! once the frame is released, and Windows hands the same value out again to
//! whatever is opened next. A handle's value says nothing about which of
//! Chromium's few textures it is: taken for a key, it imported every frame
//! anew, or took one texture for another. So each texture seen gets an id,
//! and a handle of this process's own on it, kept to compare the next
//! handles against (`CompareObjectHandles`, Windows 10): the same texture
//! gets the same id whatever handle it comes with.
#![cfg(windows)]

windows_link::link!("api-ms-win-core-handle-l1-1-0.dll" "system" fn CompareObjectHandles(first: isize, second: isize) -> i32);
windows_link::link!("kernel32.dll" "system" fn DuplicateHandle(source_process: isize, source: isize, target_process: isize, target: *mut isize, access: u32, inherit: i32, options: u32) -> i32);
windows_link::link!("kernel32.dll" "system" fn GetCurrentProcess() -> isize);
windows_link::link!("kernel32.dll" "system" fn CloseHandle(handle: isize) -> i32);

const DUPLICATE_SAME_ACCESS: u32 = 2;
/// Textures known at once: more than the imports kept (vulkan.rs), so an
/// import is not left with no way to be found.
const KNOWN: usize = 16;

struct Entry {
	/// This process's own handle on the texture.
	handle: isize,
	id: u64,
	used: u64,
}

/// The ids of the textures seen.
#[derive(Default)]
pub struct Known {
	entries: Vec<Entry>,
	next: u64,
	tick: u64,
}

impl Known {
	/// The id of the texture `handle` is on: the same for every handle on it.
	pub fn id(&mut self, handle: usize) -> u64 {
		self.tick += 1;
		let tick = self.tick;
		let handle = handle as isize;
		if let Some(entry) = self.entries.iter_mut().find(|e| unsafe { CompareObjectHandles(handle, e.handle) } != 0) {
			entry.used = tick;
			return entry.id;
		}
		self.next += 1;
		let id = self.next;
		let mut own = 0isize;
		let me = unsafe { GetCurrentProcess() };
		if unsafe { DuplicateHandle(me, handle, me, &mut own, 0, 0, DUPLICATE_SAME_ACCESS) } == 0 {
			// With no handle of its own it cannot be known again: a new id each time.
			return id;
		}
		if self.entries.len() >= KNOWN {
			let oldest = (0..self.entries.len()).min_by_key(|&i| self.entries[i].used).unwrap();
			let gone = self.entries.swap_remove(oldest);
			unsafe { CloseHandle(gone.handle) };
		}
		self.entries.push(Entry { handle: own, id, used: tick });
		id
	}
}

impl Drop for Known {
	fn drop(&mut self) {
		for entry in &self.entries {
			unsafe { CloseHandle(entry.handle) };
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	windows_link::link!("kernel32.dll" "system" fn CreateEventA(attributes: isize, manual: i32, initial: i32, name: isize) -> isize);

	fn duplicate(handle: isize) -> isize {
		let mut copy = 0isize;
		let me = unsafe { GetCurrentProcess() };
		assert_ne!(unsafe { DuplicateHandle(me, handle, me, &mut copy, 0, 0, DUPLICATE_SAME_ACCESS) }, 0);
		copy
	}

	#[test]
	fn one_object_one_id_whatever_its_handle() {
		let first = unsafe { CreateEventA(0, 1, 0, 0) };
		let second = unsafe { CreateEventA(0, 1, 0, 0) };
		let mut known = Known::default();
		let id = known.id(first as usize);
		// A new handle on the same object, the old one closed — as Electron does.
		let again = duplicate(first);
		unsafe { CloseHandle(first) };
		assert_eq!(known.id(again as usize), id);
		assert_ne!(known.id(second as usize), id);
		unsafe {
			CloseHandle(again);
			CloseHandle(second);
		}
	}

	#[test]
	fn the_least_used_is_forgotten_first() {
		let events: Vec<isize> = (0..=KNOWN).map(|_| unsafe { CreateEventA(0, 1, 0, 0) }).collect();
		let mut known = Known::default();
		let first = known.id(events[0] as usize);
		let second = known.id(events[1] as usize);
		for &e in &events[2..KNOWN] {
			known.id(e as usize);
			// The first stays in use; the second is not seen again.
			assert_eq!(known.id(events[0] as usize), first);
		}
		// One more than are kept: the second goes.
		known.id(events[KNOWN] as usize);
		assert_eq!(known.id(events[0] as usize), first, "kept: used last");
		assert_ne!(known.id(events[1] as usize), second, "forgotten: used least");
		for e in events {
			unsafe { CloseHandle(e) };
		}
	}
}
