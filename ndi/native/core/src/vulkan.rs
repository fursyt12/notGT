//! The Vulkan backend: Chromium's frames imported as they are, read by the
//! compute shader, and the result written straight into memory the CPU can
//! read, where NDI reads it.
//!  - Linux: dmabufs (VK_EXT_external_memory_dma_buf, with the DRM format
//!    modifier Chromium drew them in);
//!  - Windows: D3D11 textures (VK_KHR_external_memory_win32, an NT handle).
//!
//! Chromium's texture is only ever read: it is taken from the "foreign"
//! queue (Chromium's GL) and given back in the GENERAL layout it came in,
//! so the driver has no reason to write to it — no decompression, nothing.
//!
//! Each frame waits for Chromium's drawing to finish first where the system
//! can say (Linux: a sync file from the dmabuf, see dmabuf.rs; Windows:
//! Electron gives no fence for BGRA frames), and for the GPU's own work to finish
//! before it returns: nothing is left running on the GPU between frames,
//! and a texture is never given back to Chromium while it is read.

use std::ffi::CStr;
use std::time::Instant;

use ash::vk;

#[cfg(target_os = "linux")]
use crate::dmabuf;
use crate::{ms_since, Colour, DeviceReport, FrameHandle, Layout, PixelFormat, Result, SharedFrame, Timing};

const SPIRV: &[u8] = include_bytes!("../shaders/convert.spv");
/// One frame being read by NDI, one waiting for its turn, one being written.
pub const SLOTS: usize = 3;
/// Imports kept: Chromium draws into a few buffers in turn.
const CACHE: usize = 8;
/// How long the GPU may take over one frame before it is taken for stuck.
const GPU_TIMEOUT_NS: u64 = 2_000_000_000;
#[cfg(target_os = "linux")]
const DRAW_TIMEOUT_MS: i32 = 2000;

/// Which GPU, and whether frames will come shared by Chromium.
#[derive(Clone, Debug, Default)]
pub struct Options {
	/// Linux: the render node Chromium draws on (major, minor) — the GPU to
	/// use, as one GPU's frames are not another's to read.
	pub render_node: Option<(u64, u64)>,
	/// Windows: the PCI vendor and device id of the GPU Chromium draws on.
	pub pci: Option<(u32, u32)>,
	/// Accept a GPU that is the CPU pretending (lavapipe): for tests only.
	pub allow_software: bool,
	/// Frames come shared by Chromium; false only for tests, which upload
	/// pixels.
	pub shared: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Push {
	width: u32,
	height: u32,
	pairs: u32,
	total: u32,
	alpha: u32,
	groups_x: u32,
	y: [i32; 3],
	cb: [i32; 3],
	cr: [i32; 3],
}

/// What a device offers that the backend needs or can use.
struct Plan {
	device: vk::PhysicalDevice,
	queue_family: u32,
	extensions: Vec<&'static CStr>,
	foreign: bool,
	report: DeviceReport,
	software: bool,
	node_matches: Option<bool>,
}

#[derive(Clone, PartialEq, Eq)]
struct Key {
	/// Which buffer: (device, inode) of a dmabuf, or (handle, 0).
	id: (u64, u64),
	width: u32,
	height: u32,
	format: vk::Format,
	modifier: u64,
	planes: Vec<(u64, u64)>,
}

struct Imported {
	key: Key,
	image: vk::Image,
	memory: vk::DeviceMemory,
	view: vk::ImageView,
	used: u64,
}

struct Output {
	layout: Layout,
	buffers: [vk::Buffer; SLOTS],
	memory: [vk::DeviceMemory; SLOTS],
	mapped: [*mut u8; SLOTS],
	coherent: bool,
}

pub struct Vulkan {
	_entry: ash::Entry,
	instance: ash::Instance,
	device: ash::Device,
	memory_types: vk::PhysicalDeviceMemoryProperties,
	max_groups_x: u32,
	queue: vk::Queue,
	queue_family: u32,
	foreign_family: u32,
	#[cfg(target_os = "linux")]
	memory_fd: Option<ash::khr::external_memory_fd::Device>,
	/// The formats, and on Linux the DRM format modifiers, it imports frames
	/// in, with their plane counts.
	layouts: Vec<(vk::Format, u64, u32)>,
	sampler: vk::Sampler,
	set_layout: vk::DescriptorSetLayout,
	pipeline_layout: vk::PipelineLayout,
	pipeline: vk::Pipeline,
	descriptor_pool: vk::DescriptorPool,
	sets: [vk::DescriptorSet; SLOTS],
	command_pool: vk::CommandPool,
	commands: [vk::CommandBuffer; SLOTS],
	fences: [vk::Fence; SLOTS],
	output: Option<Output>,
	imports: Vec<Imported>,
	tick: u64,
	broken: Option<String>,
	pub report: DeviceReport,
	alpha: bool,
}

// Vulkan handles are used from one thread at a time: the owner keeps the
// backend behind a lock.
unsafe impl Send for Vulkan {}

fn vk_error(what: &str) -> impl Fn(vk::Result) -> String + '_ {
	move |e| format!("Vulkan: {what} failed ({e:?})")
}

fn load() -> Result<(ash::Entry, ash::Instance, u32)> {
	let entry = unsafe { ash::Entry::load() }
		.map_err(|e| format!("there is no Vulkan here (libvulkan cannot be loaded: {e})"))?;
	let version = unsafe { entry.try_enumerate_instance_version() }
		.map_err(vk_error("asking the Vulkan version"))?
		.unwrap_or(vk::API_VERSION_1_0);
	if version < vk::API_VERSION_1_1 {
		return Err(format!(
			"Vulkan here is {}.{}, older than the 1.1 needed",
			vk::api_version_major(version),
			vk::api_version_minor(version)
		));
	}
	let api = version.min(vk::API_VERSION_1_2);
	let app = vk::ApplicationInfo::default()
		.application_name(c"notGT NDI sender")
		.engine_name(c"notgt-ndi")
		.api_version(api);
	let info = vk::InstanceCreateInfo::default().application_info(&app);
	let instance =
		unsafe { entry.create_instance(&info, None) }.map_err(vk_error("starting Vulkan"))?;
	Ok((entry, instance, api))
}

fn c_str(bytes: &[std::ffi::c_char]) -> String {
	let bytes: Vec<u8> = bytes.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
	String::from_utf8_lossy(&bytes).into_owned()
}

fn vk_format(format: PixelFormat) -> vk::Format {
	match format {
		PixelFormat::Bgra => vk::Format::B8G8R8A8_UNORM,
		PixelFormat::Rgba => vk::Format::R8G8B8A8_UNORM,
	}
}

/// The DRM format modifiers `format` can be sampled in, with plane counts.
#[cfg(target_os = "linux")]
fn modifiers_for(instance: &ash::Instance, device: vk::PhysicalDevice, format: vk::Format) -> Vec<(u64, u32)> {
	let mut list = vk::DrmFormatModifierPropertiesListEXT::default();
	{
		let mut props = vk::FormatProperties2::default().push_next(&mut list);
		unsafe { instance.get_physical_device_format_properties2(device, format, &mut props) };
	}
	let mut entries = vec![vk::DrmFormatModifierPropertiesEXT::default(); list.drm_format_modifier_count as usize];
	let mut list = vk::DrmFormatModifierPropertiesListEXT::default().drm_format_modifier_properties(&mut entries);
	{
		let mut props = vk::FormatProperties2::default().push_next(&mut list);
		unsafe { instance.get_physical_device_format_properties2(device, format, &mut props) };
	}
	let count = list.drm_format_modifier_count as usize;
	entries
		.iter()
		.take(count)
		.filter(|m| m.drm_format_modifier_tiling_features.contains(vk::FormatFeatureFlags::SAMPLED_IMAGE))
		.map(|m| (m.drm_format_modifier, m.drm_format_modifier_plane_count))
		.collect()
}

fn inspect(instance: &ash::Instance, api: u32, device: vk::PhysicalDevice, options: &Options) -> Plan {
	let props = unsafe { instance.get_physical_device_properties(device) };
	let available: Vec<String> = unsafe { instance.enumerate_device_extension_properties(device) }
		.unwrap_or_default()
		.iter()
		.map(|e| c_str(&e.extension_name))
		.collect();
	let has = |name: &CStr| available.iter().any(|e| e.as_bytes() == name.to_bytes());
	let device_api = props.api_version.min(api);

	let mut driver = vk::PhysicalDeviceDriverProperties::default();
	let mut drm = vk::PhysicalDeviceDrmPropertiesEXT::default();
	let has_driver = device_api >= vk::API_VERSION_1_2 || has(ash::khr::driver_properties::NAME);
	let has_drm = has(ash::ext::physical_device_drm::NAME);
	{
		let mut props2 = vk::PhysicalDeviceProperties2::default();
		if has_driver {
			props2 = props2.push_next(&mut driver);
		}
		if has_drm {
			props2 = props2.push_next(&mut drm);
		}
		unsafe { instance.get_physical_device_properties2(device, &mut props2) };
	}
	let kind = match props.device_type {
		vk::PhysicalDeviceType::INTEGRATED_GPU => "integrated",
		vk::PhysicalDeviceType::DISCRETE_GPU => "discrete",
		vk::PhysicalDeviceType::VIRTUAL_GPU => "virtual",
		vk::PhysicalDeviceType::CPU => "cpu",
		_ => "other",
	};
	let software = props.device_type == vk::PhysicalDeviceType::CPU;
	let render_node = (has_drm && drm.has_render != 0).then_some((drm.render_major as u64, drm.render_minor as u64));
	let mut report = DeviceReport {
		backend: "Vulkan".into(),
		name: c_str(&props.device_name),
		kind: kind.into(),
		driver: if has_driver {
			format!("{} {}", c_str(&driver.driver_name), c_str(&driver.driver_info)).trim().to_string()
		} else {
			String::new()
		},
		api: format!("{}.{}", vk::api_version_major(device_api), vk::api_version_minor(device_api)),
		render_node,
		pci: (props.vendor_id, props.device_id),
		..Default::default()
	};

	let queue_family = unsafe { instance.get_physical_device_queue_family_properties(device) }
		.iter()
		.position(|q| q.queue_flags.contains(vk::QueueFlags::COMPUTE))
		.map(|i| i as u32);

	let mut extensions: Vec<&'static CStr> = Vec::new();
	let mut missing: Vec<&str> = Vec::new();
	if options.shared {
		for name in shared_extensions(device_api) {
			if has(name) {
				extensions.push(name);
			} else {
				missing.push(name.to_str().unwrap_or("?"));
			}
		}
	}
	let foreign = cfg!(target_os = "linux") && options.shared && has(ash::ext::queue_family_foreign::NAME);
	if foreign {
		extensions.push(ash::ext::queue_family_foreign::NAME);
	}
	if missing.is_empty() && options.shared {
		report.layouts = frame_layouts(instance, device, vk::Format::B8G8R8A8_UNORM).len() as u32;
	}
	// The GPU Chromium draws on: its frames are not another GPU's to read.
	let node_matches = if cfg!(windows) {
		options.pci.map(|want| want == report.pci)
	} else {
		match (options.render_node, render_node) {
			(Some(want), Some(have)) => Some(want == have),
			_ => None,
		}
	};

	report.why = if device_api < vk::API_VERSION_1_1 {
		Some(format!("Vulkan {} is older than the 1.1 needed", report.api))
	} else if queue_family.is_none() {
		Some("it has no compute queue".into())
	} else if !missing.is_empty() {
		Some(format!("it cannot import Chromium's frames (no {})", missing.join(", ")))
	} else if options.shared && report.layouts == 0 {
		Some(if cfg!(windows) {
			"it cannot import Chromium's D3D11 frames (BGRA)".into()
		} else {
			"it reads BGRA frames in no DRM layout (modifier)".into()
		})
	} else if software && !options.allow_software {
		Some("it is the CPU emulating a GPU".into())
	} else if node_matches == Some(false) {
		Some("Chromium draws on another GPU".into())
	} else {
		None
	};
	report.usable = report.why.is_none();
	Plan {
		device,
		queue_family: queue_family.unwrap_or(0),
		extensions,
		foreign,
		report,
		software,
		node_matches,
	}
}

/// Every Vulkan device here, as the backend sees it; the error says why
/// there is no Vulkan at all.
pub fn probe(options: &Options) -> Result<Vec<DeviceReport>> {
	let (entry, instance, api) = load()?;
	let devices = unsafe { instance.enumerate_physical_devices() }.unwrap_or_default();
	let reports = devices.iter().map(|&d| inspect(&instance, api, d, options).report).collect();
	unsafe { instance.destroy_instance(None) };
	drop(entry);
	Ok(reports)
}

fn find_memory(types: &vk::PhysicalDeviceMemoryProperties, bits: u32, wants: &[vk::MemoryPropertyFlags]) -> Option<(u32, vk::MemoryPropertyFlags)> {
	for want in wants {
		for i in 0..types.memory_type_count {
			let flags = types.memory_types[i as usize].property_flags;
			if bits & (1 << i) != 0 && flags.contains(*want) {
				return Some((i, flags));
			}
		}
	}
	None
}

impl Vulkan {
	pub fn new(options: &Options, alpha: bool) -> Result<Self> {
		let (entry, instance, api) = load()?;
		match Self::open(&entry, &instance, api, options, alpha) {
			Ok(parts) => Ok(parts.finish(entry, instance)),
			Err(e) => {
				unsafe { instance.destroy_instance(None) };
				Err(e)
			}
		}
	}

	fn open(_entry: &ash::Entry, instance: &ash::Instance, api: u32, options: &Options, alpha: bool) -> Result<Parts> {
		let devices = unsafe { instance.enumerate_physical_devices() }.map_err(vk_error("listing GPUs"))?;
		let plans: Vec<Plan> = devices.iter().map(|&d| inspect(instance, api, d, options)).collect();
		// Chromium's own GPU first, then a real GPU over an emulated one.
		let chosen = plans
			.iter()
			.filter(|p| p.report.usable)
			.max_by_key(|p| (p.node_matches == Some(true), !p.software))
			.ok_or_else(|| {
				if plans.is_empty() {
					"Vulkan sees no GPU here".to_string()
				} else {
					plans
						.iter()
						.map(|p| format!("{}: {}", p.report.name, p.report.why.clone().unwrap_or_default()))
						.collect::<Vec<_>>()
						.join("; ")
				}
			})?;

		let priorities = [1.0f32];
		let queues = [vk::DeviceQueueCreateInfo::default()
			.queue_family_index(chosen.queue_family)
			.queue_priorities(&priorities)];
		let names: Vec<*const std::ffi::c_char> = chosen.extensions.iter().map(|n| n.as_ptr()).collect();
		let info = vk::DeviceCreateInfo::default().queue_create_infos(&queues).enabled_extension_names(&names);
		let device = unsafe { instance.create_device(chosen.device, &info, None) }
			.map_err(vk_error("opening the GPU"))?;
		let parts = Parts::build(instance, device, chosen, options, alpha);
		parts
	}

	pub fn name(&self) -> String {
		let r = &self.report;
		let driver = if r.driver.is_empty() { String::new() } else { format!(", {}", r.driver) };
		format!("Vulkan {} on {}{}", r.api, r.name, driver)
	}

	/// The memory NDI reads for `slot`, as long as the layout stays.
	pub fn slot(&self, slot: usize) -> Option<(*const u8, Layout)> {
		let out = self.output.as_ref()?;
		Some((out.mapped[slot] as *const u8, out.layout))
	}

	pub fn layout(&self) -> Option<Layout> {
		self.output.as_ref().map(|o| o.layout)
	}

	/// Converts a frame Chromium drew into `slot`. `before_resize` runs when
	/// the size changes, before the memory NDI may be reading is let go.
	pub fn convert(&mut self, frame: &SharedFrame, slot: usize, before_resize: &mut dyn FnMut()) -> Result<Timing> {
		self.usable()?;
		let start = Instant::now();
		let mut timing = Timing::default();
		let format = vk_format(frame.format);
		let key = self.key_for(frame, format)?;
		let index = match self.imports.iter().position(|i| i.key == key) {
			Some(i) => i,
			None => {
				let began = Instant::now();
				let imported = self.import(&key, &frame.handle)?;
				timing.imported = true;
				timing.import_ms = ms_since(began);
				if self.imports.len() >= CACHE {
					let oldest = (0..self.imports.len()).min_by_key(|&i| self.imports[i].used).unwrap();
					let old = self.imports.swap_remove(oldest);
					self.destroy_import(old);
				}
				self.imports.push(imported);
				self.imports.len() - 1
			}
		};
		self.tick += 1;
		self.imports[index].used = self.tick;
		self.ensure_output(frame.width, frame.height, before_resize)?;
		timing.synced = wait_for_drawing(&frame.handle)?;
		let image = self.imports[index].image;
		let view = self.imports[index].view;
		let began = Instant::now();
		self.run(slot, view, move |device: &ash::Device, cmd: vk::CommandBuffer, family, foreign| {
			// From Chromium's GL to this queue, in the layout it came in.
			let acquire = [ownership(image, foreign, family, vk::AccessFlags::empty(), vk::AccessFlags::SHADER_READ)];
			unsafe {
				device.cmd_pipeline_barrier(
					cmd,
					vk::PipelineStageFlags::TOP_OF_PIPE,
					vk::PipelineStageFlags::COMPUTE_SHADER,
					vk::DependencyFlags::empty(),
					&[],
					&[],
					&acquire,
				)
			};
			move |device: &ash::Device, cmd: vk::CommandBuffer| {
				let release = [ownership(image, family, foreign, vk::AccessFlags::SHADER_READ, vk::AccessFlags::empty())];
				unsafe {
					device.cmd_pipeline_barrier(
						cmd,
						vk::PipelineStageFlags::COMPUTE_SHADER,
						vk::PipelineStageFlags::BOTTOM_OF_PIPE,
						vk::DependencyFlags::empty(),
						&[],
						&[],
						&release,
					)
				};
			}
		})?;
		timing.gpu_ms = ms_since(began);
		timing.total_ms = ms_since(start);
		Ok(timing)
	}

	/// Converts premultiplied RGBA pixels from memory into `slot`: the tests,
	/// and each out's self-test before it goes on air.
	pub fn convert_pixels(&mut self, width: u32, height: u32, rgba: &[u8], slot: usize, before_resize: &mut dyn FnMut()) -> Result<Vec<u32>> {
		self.usable()?;
		if rgba.len() != (width * height * 4) as usize {
			return Err("the test picture has the wrong size".into());
		}
		self.ensure_output(width, height, before_resize)?;
		let upload = Upload::new(self, width, height, rgba)?;
		let result = self.run(slot, upload.view, |device: &ash::Device, cmd: vk::CommandBuffer, _, _| {
			upload.record(device, cmd);
			|_: &ash::Device, _: vk::CommandBuffer| {}
		});
		upload.destroy(&self.device);
		result?;
		let (ptr, layout) = self.slot(slot).unwrap();
		let words = unsafe { std::slice::from_raw_parts(ptr as *const u32, layout.words as usize) };
		Ok(words.to_vec())
	}

	fn usable(&self) -> Result<()> {
		match &self.broken {
			Some(why) => Err(why.clone()),
			None => Ok(()),
		}
	}

	/// The plane count of `modifier`, if the device reads `format` in it.
	fn check_layout(&self, format: vk::Format, modifier: u64, planes: usize) -> Result<u32> {
		let found = self.layouts.iter().find(|(f, m, _)| *f == format && *m == modifier);
		let Some(&(_, _, count)) = found else {
			return Err(if cfg!(windows) {
				format!("{} cannot import Chromium's {format:?} frames", self.report.name)
			} else {
				format!(
					"frames come in a memory layout (DRM modifier {modifier:#x}) {} cannot read",
					self.report.name
				)
			});
		};
		if planes < count as usize {
			return Err(format!("the frame has {planes} plane(s), its layout {modifier:#x} needs {count}"));
		}
		Ok(count)
	}

	/// Which buffer a frame is in, and that the device can read it.
	#[cfg(target_os = "linux")]
	fn key_for(&self, frame: &SharedFrame, format: vk::Format) -> Result<Key> {
		let FrameHandle::Dmabuf { modifier, planes } = &frame.handle else {
			return Err("frames come as dmabufs on Linux".into());
		};
		let plane_count = self.check_layout(format, *modifier, planes.len())? as usize;
		let first = planes.first().ok_or("the frame has no planes")?;
		let id = dmabuf::identity(first.fd)?;
		for plane in &planes[1..plane_count] {
			if dmabuf::identity(plane.fd)? != id {
				return Err("the frame's planes are in separate buffers, which is not supported yet".into());
			}
		}
		Ok(Key {
			id,
			width: frame.width,
			height: frame.height,
			format,
			modifier: *modifier,
			planes: planes[..plane_count].iter().map(|p| (p.offset, p.stride)).collect(),
		})
	}

	#[cfg(windows)]
	fn key_for(&self, frame: &SharedFrame, format: vk::Format) -> Result<Key> {
		let FrameHandle::D3d11 { handle } = &frame.handle else {
			return Err("frames come as D3D11 textures on Windows".into());
		};
		self.check_layout(format, 0, 1)?;
		Ok(Key {
			id: (*handle as u64, 0),
			width: frame.width,
			height: frame.height,
			format,
			modifier: 0,
			planes: Vec::new(),
		})
	}

	#[cfg(target_os = "linux")]
	fn import(&mut self, key: &Key, handle: &FrameHandle) -> Result<Imported> {
		let FrameHandle::Dmabuf { planes, .. } = handle else { unreachable!() };
		self.import_dmabuf(key, planes[0].fd)
	}

	#[cfg(windows)]
	fn import(&mut self, key: &Key, handle: &FrameHandle) -> Result<Imported> {
		let FrameHandle::D3d11 { handle } = handle else { unreachable!() };
		self.import_d3d11(key, *handle)
	}

	/// A D3D11 texture, as Chromium shares it: an NT handle, which stays
	/// Electron's (an import does not take an NT handle over).
	#[cfg(windows)]
	fn import_d3d11(&mut self, key: &Key, handle: usize) -> Result<Imported> {
		let mut external =
			vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::D3D11_TEXTURE);
		let info = vk::ImageCreateInfo::default()
			.image_type(vk::ImageType::TYPE_2D)
			.format(key.format)
			.extent(vk::Extent3D { width: key.width, height: key.height, depth: 1 })
			.mip_levels(1)
			.array_layers(1)
			.samples(vk::SampleCountFlags::TYPE_1)
			.tiling(vk::ImageTiling::OPTIMAL)
			.usage(vk::ImageUsageFlags::SAMPLED)
			.sharing_mode(vk::SharingMode::EXCLUSIVE)
			.initial_layout(vk::ImageLayout::UNDEFINED)
			.push_next(&mut external);
		let device = &self.device;
		let image = unsafe { device.create_image(&info, None) }.map_err(vk_error("describing the frame"))?;
		let cleanup_image = |e: String| {
			unsafe { device.destroy_image(image, None) };
			e
		};
		let needs = unsafe { device.get_image_memory_requirements(image) };
		let (type_index, _) = find_memory(
			&self.memory_types,
			needs.memory_type_bits,
			&[vk::MemoryPropertyFlags::DEVICE_LOCAL, vk::MemoryPropertyFlags::empty()],
		)
		.ok_or_else(|| cleanup_image("the frame's memory is of no kind this GPU can read".into()))?;
		let mut import = vk::ImportMemoryWin32HandleInfoKHR::default()
			.handle_type(vk::ExternalMemoryHandleTypeFlags::D3D11_TEXTURE)
			.handle(handle as vk::HANDLE);
		let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
		let allocate = vk::MemoryAllocateInfo::default()
			.allocation_size(needs.size)
			.memory_type_index(type_index)
			.push_next(&mut import)
			.push_next(&mut dedicated);
		let memory = unsafe { device.allocate_memory(&allocate, None) }
			.map_err(vk_error("importing the frame"))
			.map_err(cleanup_image)?;
		if let Err(e) = unsafe { device.bind_image_memory(image, memory, 0) } {
			unsafe { device.free_memory(memory, None) };
			return Err(cleanup_image(vk_error("binding the frame")(e)));
		}
		let view_info = vk::ImageViewCreateInfo::default()
			.image(image)
			.view_type(vk::ImageViewType::TYPE_2D)
			.format(key.format)
			.subresource_range(color_range());
		let view = match unsafe { device.create_image_view(&view_info, None) } {
			Ok(view) => view,
			Err(e) => {
				unsafe { device.free_memory(memory, None) };
				return Err(cleanup_image(vk_error("viewing the frame")(e)));
			}
		};
		Ok(Imported { key: key.clone(), image, memory, view, used: 0 })
	}

	#[cfg(target_os = "linux")]
	fn import_dmabuf(&mut self, key: &Key, fd: i32) -> Result<Imported> {
		let memory_fd = self.memory_fd.as_ref().ok_or("this device was not opened for dmabufs")?;
		let layouts: Vec<vk::SubresourceLayout> = key
			.planes
			.iter()
			.map(|&(offset, stride)| vk::SubresourceLayout {
				offset,
				size: 0,
				row_pitch: stride,
				array_pitch: 0,
				depth_pitch: 0,
			})
			.collect();
		let mut explicit = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default()
			.drm_format_modifier(key.modifier)
			.plane_layouts(&layouts);
		let mut external =
			vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
		let info = vk::ImageCreateInfo::default()
			.image_type(vk::ImageType::TYPE_2D)
			.format(key.format)
			.extent(vk::Extent3D { width: key.width, height: key.height, depth: 1 })
			.mip_levels(1)
			.array_layers(1)
			.samples(vk::SampleCountFlags::TYPE_1)
			.tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
			.usage(vk::ImageUsageFlags::SAMPLED)
			.sharing_mode(vk::SharingMode::EXCLUSIVE)
			.initial_layout(vk::ImageLayout::UNDEFINED)
			.push_next(&mut external)
			.push_next(&mut explicit);
		let device = &self.device;
		let image = unsafe { device.create_image(&info, None) }.map_err(vk_error("describing the frame"))?;
		let cleanup_image = |e: String| {
			unsafe { device.destroy_image(image, None) };
			e
		};
		let mut fd_props = vk::MemoryFdPropertiesKHR::default();
		unsafe { memory_fd.get_memory_fd_properties(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT, fd, &mut fd_props) }
			.map_err(vk_error("reading the frame's memory"))
			.map_err(cleanup_image)?;
		let needs = unsafe { device.get_image_memory_requirements(image) };
		let (type_index, _) = find_memory(&self.memory_types, needs.memory_type_bits & fd_props.memory_type_bits, &[vk::MemoryPropertyFlags::empty()])
			.ok_or_else(|| cleanup_image("the frame's memory is of no kind this GPU can read".into()))?;
		let owned = dmabuf::dup(fd).map_err(cleanup_image)?;
		let mut import = vk::ImportMemoryFdInfoKHR::default()
			.handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
			.fd(owned);
		let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
		let allocate = vk::MemoryAllocateInfo::default()
			.allocation_size(needs.size)
			.memory_type_index(type_index)
			.push_next(&mut import)
			.push_next(&mut dedicated);
		let memory = match unsafe { device.allocate_memory(&allocate, None) } {
			Ok(memory) => memory,
			Err(e) => {
				// Only a successful import takes the fd over.
				dmabuf::close(owned);
				return Err(cleanup_image(vk_error("importing the frame")(e)));
			}
		};
		if let Err(e) = unsafe { device.bind_image_memory(image, memory, 0) } {
			unsafe { device.free_memory(memory, None) };
			return Err(cleanup_image(vk_error("binding the frame")(e)));
		}
		let view_info = vk::ImageViewCreateInfo::default()
			.image(image)
			.view_type(vk::ImageViewType::TYPE_2D)
			.format(key.format)
			.subresource_range(color_range());
		let view = match unsafe { device.create_image_view(&view_info, None) } {
			Ok(view) => view,
			Err(e) => {
				unsafe { device.free_memory(memory, None) };
				return Err(cleanup_image(vk_error("viewing the frame")(e)));
			}
		};
		Ok(Imported { key: key.clone(), image, memory, view, used: 0 })
	}

	fn destroy_import(&self, imported: Imported) {
		unsafe {
			self.device.destroy_image_view(imported.view, None);
			self.device.destroy_image(imported.image, None);
			self.device.free_memory(imported.memory, None);
		}
	}

	fn ensure_output(&mut self, width: u32, height: u32, before_resize: &mut dyn FnMut()) -> Result<()> {
		let layout = Layout::new(width, height, self.alpha)?;
		if self.output.as_ref().is_some_and(|o| o.layout == layout) {
			return Ok(());
		}
		if let Some(old) = self.output.take() {
			before_resize();
			self.destroy_output(old);
		}
		self.output = Some(self.create_output(layout)?);
		Ok(())
	}

	fn create_output(&self, layout: Layout) -> Result<Output> {
		let device = &self.device;
		let mut buffers = [vk::Buffer::null(); SLOTS];
		let mut memory = [vk::DeviceMemory::null(); SLOTS];
		let mut mapped = [std::ptr::null_mut(); SLOTS];
		let mut coherent = true;
		let fail = |buffers: &[vk::Buffer; SLOTS], memory: &[vk::DeviceMemory; SLOTS], e: String| {
			for (&b, &m) in buffers.iter().zip(memory) {
				unsafe {
					if m != vk::DeviceMemory::null() {
						device.free_memory(m, None);
					}
					if b != vk::Buffer::null() {
						device.destroy_buffer(b, None);
					}
				}
			}
			e
		};
		for i in 0..SLOTS {
			let info = vk::BufferCreateInfo::default()
				.size(layout.bytes() as u64)
				.usage(vk::BufferUsageFlags::STORAGE_BUFFER)
				.sharing_mode(vk::SharingMode::EXCLUSIVE);
			buffers[i] = unsafe { device.create_buffer(&info, None) }
				.map_err(vk_error("making room for the result"))
				.map_err(|e| fail(&buffers, &memory, e))?;
			let needs = unsafe { device.get_buffer_memory_requirements(buffers[i]) };
			// The CPU reads all of it, NDI does: cached memory, or reading
			// it costs more than the conversion saves.
			let host = vk::MemoryPropertyFlags::HOST_VISIBLE;
			let cached = vk::MemoryPropertyFlags::HOST_CACHED;
			let coherent_flag = vk::MemoryPropertyFlags::HOST_COHERENT;
			let (index, flags) = find_memory(
				&self.memory_types,
				needs.memory_type_bits,
				&[host | cached | coherent_flag, host | cached],
			)
			.ok_or_else(|| fail(&buffers, &memory, "this GPU has no memory the CPU can read quickly (host-cached)".into()))?;
			coherent &= flags.contains(coherent_flag);
			let allocate = vk::MemoryAllocateInfo::default().allocation_size(needs.size).memory_type_index(index);
			memory[i] = unsafe { device.allocate_memory(&allocate, None) }
				.map_err(vk_error("allocating the result"))
				.map_err(|e| fail(&buffers, &memory, e))?;
			unsafe { device.bind_buffer_memory(buffers[i], memory[i], 0) }
				.map_err(vk_error("binding the result"))
				.map_err(|e| fail(&buffers, &memory, e))?;
			mapped[i] = unsafe { device.map_memory(memory[i], 0, vk::WHOLE_SIZE, vk::MemoryMapFlags::empty()) }
				.map_err(vk_error("mapping the result"))
				.map_err(|e| fail(&buffers, &memory, e))? as *mut u8;
		}
		Ok(Output { layout, buffers, memory, mapped, coherent })
	}

	fn destroy_output(&self, output: Output) {
		for i in 0..SLOTS {
			unsafe {
				self.device.unmap_memory(output.memory[i]);
				self.device.destroy_buffer(output.buffers[i], None);
				self.device.free_memory(output.memory[i], None);
			}
		}
	}

	/// Records and runs one conversion into `slot` from `view`: `before` adds
	/// what has to come first and returns what has to come after.
	fn run<B, A>(&mut self, slot: usize, view: vk::ImageView, before: B) -> Result<()>
	where
		B: FnOnce(&ash::Device, vk::CommandBuffer, u32, u32) -> A,
		A: FnOnce(&ash::Device, vk::CommandBuffer),
	{
		let (layout, buffer, memory, coherent) = {
			let output = self.output.as_ref().ok_or("no room for the result")?;
			(output.layout, output.buffers[slot], output.memory[slot], output.coherent)
		};
		let device = &self.device;
		let cmd = self.commands[slot];
		let set = self.sets[slot];
		let image_info = [vk::DescriptorImageInfo::default()
			.sampler(self.sampler)
			.image_view(view)
			.image_layout(vk::ImageLayout::GENERAL)];
		let buffer_info = [vk::DescriptorBufferInfo::default()
			.buffer(buffer)
			.offset(0)
			.range(vk::WHOLE_SIZE)];
		let writes = [
			vk::WriteDescriptorSet::default()
				.dst_set(set)
				.dst_binding(0)
				.descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
				.image_info(&image_info),
			vk::WriteDescriptorSet::default()
				.dst_set(set)
				.dst_binding(1)
				.descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
				.buffer_info(&buffer_info),
		];
		unsafe { device.update_descriptor_sets(&writes, &[]) };

		let groups = layout.words.div_ceil(256);
		let groups_x = groups.min(self.max_groups_x);
		let groups_y = groups.div_ceil(groups_x);
		let k = Colour::NDI.fixed();
		let push = Push {
			width: layout.width,
			height: layout.height,
			pairs: layout.pairs,
			total: layout.words,
			alpha: layout.alpha as u32,
			groups_x,
			y: k.y,
			cb: k.cb,
			cr: k.cr,
		};
		let push_bytes = unsafe {
			std::slice::from_raw_parts(&push as *const Push as *const u8, std::mem::size_of::<Push>())
		};

		let recorded: std::result::Result<(), vk::Result> = unsafe {
			(|| {
				device.reset_command_buffer(cmd, vk::CommandBufferResetFlags::empty())?;
				device.begin_command_buffer(
					cmd,
					&vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
				)?;
				let after = before(device, cmd, self.queue_family, self.foreign_family);
				device.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.pipeline);
				device.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.pipeline_layout, 0, &[set], &[]);
				device.cmd_push_constants(cmd, self.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, push_bytes);
				device.cmd_dispatch(cmd, groups_x, groups_y, 1);
				after(device, cmd);
				let to_host = [vk::BufferMemoryBarrier::default()
					.src_access_mask(vk::AccessFlags::SHADER_WRITE)
					.dst_access_mask(vk::AccessFlags::HOST_READ)
					.src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
					.dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
					.buffer(buffer)
					.offset(0)
					.size(vk::WHOLE_SIZE)];
				device.cmd_pipeline_barrier(
					cmd,
					vk::PipelineStageFlags::COMPUTE_SHADER,
					vk::PipelineStageFlags::HOST,
					vk::DependencyFlags::empty(),
					&[],
					&to_host,
					&[],
				);
				device.end_command_buffer(cmd)
			})()
		};
		recorded.map_err(vk_error("recording the conversion"))?;

		let fence = self.fences[slot];
		let commands = [cmd];
		let submit = [vk::SubmitInfo::default().command_buffers(&commands)];
		let ran = unsafe {
			device
				.reset_fences(&[fence])
				.and_then(|_| device.queue_submit(self.queue, &submit, fence))
				.and_then(|_| device.wait_for_fences(&[fence], true, GPU_TIMEOUT_NS))
		};
		if let Err(e) = ran {
			let why = match e {
				vk::Result::TIMEOUT => format!("the GPU did not finish a frame in {} s", GPU_TIMEOUT_NS / 1_000_000_000),
				vk::Result::ERROR_DEVICE_LOST => "the GPU was lost (the driver reset it)".to_string(),
				other => format!("Vulkan: running the conversion failed ({other:?})"),
			};
			// Nothing more is sent to a GPU that failed like this.
			self.broken = Some(why.clone());
			return Err(why);
		}
		if !coherent {
			let range = [vk::MappedMemoryRange::default()
				.memory(memory)
				.offset(0)
				.size(vk::WHOLE_SIZE)];
			unsafe { device.invalidate_mapped_memory_ranges(&range) }.map_err(vk_error("reading the result"))?;
		}
		Ok(())
	}
}

/// Device extensions needed to import Chromium's frames.
#[cfg(target_os = "linux")]
fn shared_extensions(api: u32) -> Vec<&'static CStr> {
	let mut names = vec![
		ash::khr::external_memory_fd::NAME,
		ash::ext::external_memory_dma_buf::NAME,
		ash::ext::image_drm_format_modifier::NAME,
	];
	if api < vk::API_VERSION_1_2 {
		names.push(ash::khr::image_format_list::NAME);
	}
	names
}

#[cfg(windows)]
fn shared_extensions(_api: u32) -> Vec<&'static CStr> {
	vec![ash::khr::external_memory_win32::NAME]
}

/// The ways `format` frames can be imported: (DRM modifier, planes) on
/// Linux; on Windows (0, 1) if D3D11 textures can be at all.
#[cfg(target_os = "linux")]
fn frame_layouts(instance: &ash::Instance, device: vk::PhysicalDevice, format: vk::Format) -> Vec<(u64, u32)> {
	modifiers_for(instance, device, format)
		.into_iter()
		.filter(|&(modifier, _)| importable(instance, device, format, modifier))
		.collect()
}

#[cfg(windows)]
fn frame_layouts(instance: &ash::Instance, device: vk::PhysicalDevice, format: vk::Format) -> Vec<(u64, u32)> {
	let mut external_info = vk::PhysicalDeviceExternalImageFormatInfo::default()
		.handle_type(vk::ExternalMemoryHandleTypeFlags::D3D11_TEXTURE);
	let info = vk::PhysicalDeviceImageFormatInfo2::default()
		.format(format)
		.ty(vk::ImageType::TYPE_2D)
		.tiling(vk::ImageTiling::OPTIMAL)
		.usage(vk::ImageUsageFlags::SAMPLED)
		.push_next(&mut external_info);
	let mut external = vk::ExternalImageFormatProperties::default();
	let mut props = vk::ImageFormatProperties2::default().push_next(&mut external);
	let ok = unsafe { instance.get_physical_device_image_format_properties2(device, &info, &mut props) }.is_ok();
	let importable = ok
		&& external
			.external_memory_properties
			.external_memory_features
			.contains(vk::ExternalMemoryFeatureFlags::IMPORTABLE);
	if importable {
		vec![(0, 1)]
	} else {
		Vec::new()
	}
}

/// Waits until Chromium's drawing into the frame is done, where the system
/// can say; false where it cannot, and the frame is taken as it is.
#[cfg(target_os = "linux")]
fn wait_for_drawing(handle: &FrameHandle) -> Result<bool> {
	match handle {
		FrameHandle::Dmabuf { planes, .. } => dmabuf::wait_for_writers(planes[0].fd, DRAW_TIMEOUT_MS),
		_ => Ok(false),
	}
}

/// Electron shares BGRA textures on Windows with no keyed mutex or fence:
/// nothing to wait for.
#[cfg(windows)]
fn wait_for_drawing(_handle: &FrameHandle) -> Result<bool> {
	Ok(false)
}

/// Hands Chromium's texture between queue families, its layout untouched.
fn ownership(
	image: vk::Image,
	from: u32,
	to: u32,
	src_access: vk::AccessFlags,
	dst_access: vk::AccessFlags,
) -> vk::ImageMemoryBarrier<'static> {
	vk::ImageMemoryBarrier::default()
		.src_access_mask(src_access)
		.dst_access_mask(dst_access)
		.old_layout(vk::ImageLayout::GENERAL)
		.new_layout(vk::ImageLayout::GENERAL)
		.src_queue_family_index(from)
		.dst_queue_family_index(to)
		.image(image)
		.subresource_range(color_range())
}

fn color_range() -> vk::ImageSubresourceRange {
	vk::ImageSubresourceRange::default()
		.aspect_mask(vk::ImageAspectFlags::COLOR)
		.level_count(1)
		.layer_count(1)
}

/// The device, opened and ready, before it becomes a `Vulkan`.
struct Parts {
	device: ash::Device,
	memory_types: vk::PhysicalDeviceMemoryProperties,
	max_groups_x: u32,
	queue: vk::Queue,
	queue_family: u32,
	foreign_family: u32,
	#[cfg(target_os = "linux")]
	memory_fd: Option<ash::khr::external_memory_fd::Device>,
	layouts: Vec<(vk::Format, u64, u32)>,
	sampler: vk::Sampler,
	set_layout: vk::DescriptorSetLayout,
	pipeline_layout: vk::PipelineLayout,
	pipeline: vk::Pipeline,
	descriptor_pool: vk::DescriptorPool,
	sets: [vk::DescriptorSet; SLOTS],
	command_pool: vk::CommandPool,
	commands: [vk::CommandBuffer; SLOTS],
	fences: [vk::Fence; SLOTS],
	report: DeviceReport,
	alpha: bool,
}

impl Parts {
	fn build(instance: &ash::Instance, device: ash::Device, plan: &Plan, options: &Options, alpha: bool) -> Result<Self> {
		// Everything made here goes again if a later step fails.
		let mut made = Made::default();
		let result = (|| -> Result<Parts> {
			let props = unsafe { instance.get_physical_device_properties(plan.device) };
			let memory_types = unsafe { instance.get_physical_device_memory_properties(plan.device) };
			let queue = unsafe { device.get_device_queue(plan.queue_family, 0) };
			#[cfg(target_os = "linux")]
			let memory_fd = options.shared.then(|| ash::khr::external_memory_fd::Device::new(instance, &device));
			let mut layouts = Vec::new();
			if options.shared {
				for format in [vk::Format::B8G8R8A8_UNORM, vk::Format::R8G8B8A8_UNORM] {
					for (modifier, planes) in frame_layouts(instance, plan.device, format) {
						layouts.push((format, modifier, planes));
					}
				}
				if layouts.is_empty() {
					return Err(format!("{} can import no BGRA or RGBA frame", plan.report.name));
				}
			}

			let sampler_info = vk::SamplerCreateInfo::default()
				.mag_filter(vk::Filter::NEAREST)
				.min_filter(vk::Filter::NEAREST)
				.mipmap_mode(vk::SamplerMipmapMode::NEAREST)
				.address_mode_u(vk::SamplerAddressMode::CLAMP_TO_EDGE)
				.address_mode_v(vk::SamplerAddressMode::CLAMP_TO_EDGE)
				.address_mode_w(vk::SamplerAddressMode::CLAMP_TO_EDGE);
			made.sampler = unsafe { device.create_sampler(&sampler_info, None) }.map_err(vk_error("making a sampler"))?;
			let bindings = [
				vk::DescriptorSetLayoutBinding::default()
					.binding(0)
					.descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
					.descriptor_count(1)
					.stage_flags(vk::ShaderStageFlags::COMPUTE),
				vk::DescriptorSetLayoutBinding::default()
					.binding(1)
					.descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
					.descriptor_count(1)
					.stage_flags(vk::ShaderStageFlags::COMPUTE),
			];
			made.set_layout = unsafe {
				device.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None)
			}
			.map_err(vk_error("describing the shader's inputs"))?;
			let set_layouts = [made.set_layout];
			let ranges = [vk::PushConstantRange::default()
				.stage_flags(vk::ShaderStageFlags::COMPUTE)
				.offset(0)
				.size(std::mem::size_of::<Push>() as u32)];
			made.pipeline_layout = unsafe {
				device.create_pipeline_layout(
					&vk::PipelineLayoutCreateInfo::default().set_layouts(&set_layouts).push_constant_ranges(&ranges),
					None,
				)
			}
			.map_err(vk_error("laying out the shader"))?;
			let code = ash::util::read_spv(&mut std::io::Cursor::new(SPIRV)).map_err(|e| format!("the shader is broken: {e}"))?;
			let module = unsafe { device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None) }
				.map_err(vk_error("loading the shader"))?;
			let stage = vk::PipelineShaderStageCreateInfo::default()
				.stage(vk::ShaderStageFlags::COMPUTE)
				.module(module)
				.name(c"main");
			let pipeline_info = [vk::ComputePipelineCreateInfo::default().stage(stage).layout(made.pipeline_layout)];
			let pipelines = unsafe { device.create_compute_pipelines(vk::PipelineCache::null(), &pipeline_info, None) };
			unsafe { device.destroy_shader_module(module, None) };
			made.pipeline = pipelines.map_err(|(_, e)| vk_error("building the shader")(e))?[0];

			let sizes = [
				vk::DescriptorPoolSize::default()
					.ty(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
					.descriptor_count(SLOTS as u32),
				vk::DescriptorPoolSize::default()
					.ty(vk::DescriptorType::STORAGE_BUFFER)
					.descriptor_count(SLOTS as u32),
			];
			made.descriptor_pool = unsafe {
				device.create_descriptor_pool(
					&vk::DescriptorPoolCreateInfo::default().max_sets(SLOTS as u32).pool_sizes(&sizes),
					None,
				)
			}
			.map_err(vk_error("making descriptor room"))?;
			let set_layouts_each = [made.set_layout; SLOTS];
			let sets = unsafe {
				device.allocate_descriptor_sets(
					&vk::DescriptorSetAllocateInfo::default()
						.descriptor_pool(made.descriptor_pool)
						.set_layouts(&set_layouts_each),
				)
			}
			.map_err(vk_error("allocating descriptors"))?;
			made.command_pool = unsafe {
				device.create_command_pool(
					&vk::CommandPoolCreateInfo::default()
						.flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER)
						.queue_family_index(plan.queue_family),
					None,
				)
			}
			.map_err(vk_error("making a command pool"))?;
			let commands = unsafe {
				device.allocate_command_buffers(
					&vk::CommandBufferAllocateInfo::default()
						.command_pool(made.command_pool)
						.level(vk::CommandBufferLevel::PRIMARY)
						.command_buffer_count(SLOTS as u32),
				)
			}
			.map_err(vk_error("allocating command buffers"))?;
			for i in 0..SLOTS {
				made.fences[i] = unsafe { device.create_fence(&vk::FenceCreateInfo::default(), None) }
					.map_err(vk_error("making a fence"))?;
			}
			Ok(Parts {
				device: device.clone(),
				memory_types,
				max_groups_x: props.limits.max_compute_work_group_count[0],
				queue,
				queue_family: plan.queue_family,
				foreign_family: if plan.foreign { vk::QUEUE_FAMILY_FOREIGN_EXT } else { vk::QUEUE_FAMILY_EXTERNAL },
				#[cfg(target_os = "linux")]
				memory_fd,
				layouts,
				sampler: made.sampler,
				set_layout: made.set_layout,
				pipeline_layout: made.pipeline_layout,
				pipeline: made.pipeline,
				descriptor_pool: made.descriptor_pool,
				sets: [sets[0], sets[1], sets[2]],
				command_pool: made.command_pool,
				commands: [commands[0], commands[1], commands[2]],
				fences: made.fences,
				report: plan.report.clone(),
				alpha,
			})
		})();
		if result.is_err() {
			made.destroy(&device);
			unsafe { device.destroy_device(None) };
		}
		result
	}

	fn finish(self, entry: ash::Entry, instance: ash::Instance) -> Vulkan {
		Vulkan {
			_entry: entry,
			instance,
			device: self.device,
			memory_types: self.memory_types,
			max_groups_x: self.max_groups_x,
			queue: self.queue,
			queue_family: self.queue_family,
			foreign_family: self.foreign_family,
			#[cfg(target_os = "linux")]
			memory_fd: self.memory_fd,
			layouts: self.layouts,
			sampler: self.sampler,
			set_layout: self.set_layout,
			pipeline_layout: self.pipeline_layout,
			pipeline: self.pipeline,
			descriptor_pool: self.descriptor_pool,
			sets: self.sets,
			command_pool: self.command_pool,
			commands: self.commands,
			fences: self.fences,
			output: None,
			imports: Vec::new(),
			tick: 0,
			broken: None,
			report: self.report,
			alpha: self.alpha,
		}
	}
}

/// Whether a `format` image in `modifier` can be imported from a dmabuf.
#[cfg(target_os = "linux")]
fn importable(instance: &ash::Instance, device: vk::PhysicalDevice, format: vk::Format, modifier: u64) -> bool {
	let mut modifier_info = vk::PhysicalDeviceImageDrmFormatModifierInfoEXT::default()
		.drm_format_modifier(modifier)
		.sharing_mode(vk::SharingMode::EXCLUSIVE);
	let mut external_info = vk::PhysicalDeviceExternalImageFormatInfo::default()
		.handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
	let info = vk::PhysicalDeviceImageFormatInfo2::default()
		.format(format)
		.ty(vk::ImageType::TYPE_2D)
		.tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
		.usage(vk::ImageUsageFlags::SAMPLED)
		.push_next(&mut modifier_info)
		.push_next(&mut external_info);
	let mut external = vk::ExternalImageFormatProperties::default();
	let mut props = vk::ImageFormatProperties2::default().push_next(&mut external);
	let ok = unsafe { instance.get_physical_device_image_format_properties2(device, &info, &mut props) }.is_ok();
	ok && external
		.external_memory_properties
		.external_memory_features
		.contains(vk::ExternalMemoryFeatureFlags::IMPORTABLE)
}

#[derive(Default)]
struct Made {
	sampler: vk::Sampler,
	set_layout: vk::DescriptorSetLayout,
	pipeline_layout: vk::PipelineLayout,
	pipeline: vk::Pipeline,
	descriptor_pool: vk::DescriptorPool,
	command_pool: vk::CommandPool,
	fences: [vk::Fence; SLOTS],
}

impl Made {
	fn destroy(&self, device: &ash::Device) {
		unsafe {
			for &fence in &self.fences {
				if fence != vk::Fence::null() {
					device.destroy_fence(fence, None);
				}
			}
			if self.command_pool != vk::CommandPool::null() {
				device.destroy_command_pool(self.command_pool, None);
			}
			if self.descriptor_pool != vk::DescriptorPool::null() {
				device.destroy_descriptor_pool(self.descriptor_pool, None);
			}
			if self.pipeline != vk::Pipeline::null() {
				device.destroy_pipeline(self.pipeline, None);
			}
			if self.pipeline_layout != vk::PipelineLayout::null() {
				device.destroy_pipeline_layout(self.pipeline_layout, None);
			}
			if self.set_layout != vk::DescriptorSetLayout::null() {
				device.destroy_descriptor_set_layout(self.set_layout, None);
			}
			if self.sampler != vk::Sampler::null() {
				device.destroy_sampler(self.sampler, None);
			}
		}
	}
}

/// A picture uploaded from memory: the tests' input, and the self-test's.
struct Upload {
	image: vk::Image,
	memory: vk::DeviceMemory,
	view: vk::ImageView,
	staging: vk::Buffer,
	staging_memory: vk::DeviceMemory,
	width: u32,
	height: u32,
}

impl Upload {
	fn new(vulkan: &Vulkan, width: u32, height: u32, rgba: &[u8]) -> Result<Self> {
		let device = &vulkan.device;
		let mut upload = Upload {
			image: vk::Image::null(),
			memory: vk::DeviceMemory::null(),
			view: vk::ImageView::null(),
			staging: vk::Buffer::null(),
			staging_memory: vk::DeviceMemory::null(),
			width,
			height,
		};
		let result = (|| -> Result<()> {
			let info = vk::ImageCreateInfo::default()
				.image_type(vk::ImageType::TYPE_2D)
				.format(vk::Format::R8G8B8A8_UNORM)
				.extent(vk::Extent3D { width, height, depth: 1 })
				.mip_levels(1)
				.array_layers(1)
				.samples(vk::SampleCountFlags::TYPE_1)
				.tiling(vk::ImageTiling::OPTIMAL)
				.usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST)
				.sharing_mode(vk::SharingMode::EXCLUSIVE)
				.initial_layout(vk::ImageLayout::UNDEFINED);
			upload.image = unsafe { device.create_image(&info, None) }.map_err(vk_error("making the test picture"))?;
			let needs = unsafe { device.get_image_memory_requirements(upload.image) };
			let (index, _) = find_memory(&vulkan.memory_types, needs.memory_type_bits, &[vk::MemoryPropertyFlags::DEVICE_LOCAL, vk::MemoryPropertyFlags::empty()])
				.ok_or("no memory for the test picture")?;
			upload.memory = unsafe {
				device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(needs.size).memory_type_index(index), None)
			}
			.map_err(vk_error("allocating the test picture"))?;
			unsafe { device.bind_image_memory(upload.image, upload.memory, 0) }.map_err(vk_error("binding the test picture"))?;
			upload.view = unsafe {
				device.create_image_view(
					&vk::ImageViewCreateInfo::default()
						.image(upload.image)
						.view_type(vk::ImageViewType::TYPE_2D)
						.format(vk::Format::R8G8B8A8_UNORM)
						.subresource_range(color_range()),
					None,
				)
			}
			.map_err(vk_error("viewing the test picture"))?;
			let info = vk::BufferCreateInfo::default()
				.size(rgba.len() as u64)
				.usage(vk::BufferUsageFlags::TRANSFER_SRC)
				.sharing_mode(vk::SharingMode::EXCLUSIVE);
			upload.staging = unsafe { device.create_buffer(&info, None) }.map_err(vk_error("making the upload buffer"))?;
			let needs = unsafe { device.get_buffer_memory_requirements(upload.staging) };
			let (index, _) = find_memory(
				&vulkan.memory_types,
				needs.memory_type_bits,
				&[vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT],
			)
			.ok_or("no memory to upload the test picture through")?;
			upload.staging_memory = unsafe {
				device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(needs.size).memory_type_index(index), None)
			}
			.map_err(vk_error("allocating the upload buffer"))?;
			unsafe {
				device.bind_buffer_memory(upload.staging, upload.staging_memory, 0).map_err(vk_error("binding the upload buffer"))?;
				let ptr = device
					.map_memory(upload.staging_memory, 0, vk::WHOLE_SIZE, vk::MemoryMapFlags::empty())
					.map_err(vk_error("mapping the upload buffer"))? as *mut u8;
				std::ptr::copy_nonoverlapping(rgba.as_ptr(), ptr, rgba.len());
				device.unmap_memory(upload.staging_memory);
			}
			Ok(())
		})();
		match result {
			Ok(()) => Ok(upload),
			Err(e) => {
				upload.destroy(device);
				Err(e)
			}
		}
	}

	fn record(&self, device: &ash::Device, cmd: vk::CommandBuffer) {
		let to_copy = [vk::ImageMemoryBarrier::default()
			.src_access_mask(vk::AccessFlags::empty())
			.dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
			.old_layout(vk::ImageLayout::UNDEFINED)
			.new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
			.src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
			.dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
			.image(self.image)
			.subresource_range(color_range())];
		let region = [vk::BufferImageCopy::default()
			.image_subresource(
				vk::ImageSubresourceLayers::default()
					.aspect_mask(vk::ImageAspectFlags::COLOR)
					.layer_count(1),
			)
			.image_extent(vk::Extent3D { width: self.width, height: self.height, depth: 1 })];
		let to_read = [vk::ImageMemoryBarrier::default()
			.src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
			.dst_access_mask(vk::AccessFlags::SHADER_READ)
			.old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
			.new_layout(vk::ImageLayout::GENERAL)
			.src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
			.dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
			.image(self.image)
			.subresource_range(color_range())];
		unsafe {
			device.cmd_pipeline_barrier(
				cmd,
				vk::PipelineStageFlags::TOP_OF_PIPE,
				vk::PipelineStageFlags::TRANSFER,
				vk::DependencyFlags::empty(),
				&[],
				&[],
				&to_copy,
			);
			device.cmd_copy_buffer_to_image(cmd, self.staging, self.image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &region);
			device.cmd_pipeline_barrier(
				cmd,
				vk::PipelineStageFlags::TRANSFER,
				vk::PipelineStageFlags::COMPUTE_SHADER,
				vk::DependencyFlags::empty(),
				&[],
				&[],
				&to_read,
			);
		}
	}

	fn destroy(&self, device: &ash::Device) {
		unsafe {
			if self.view != vk::ImageView::null() {
				device.destroy_image_view(self.view, None);
			}
			if self.image != vk::Image::null() {
				device.destroy_image(self.image, None);
			}
			if self.memory != vk::DeviceMemory::null() {
				device.free_memory(self.memory, None);
			}
			if self.staging != vk::Buffer::null() {
				device.destroy_buffer(self.staging, None);
			}
			if self.staging_memory != vk::DeviceMemory::null() {
				device.free_memory(self.staging_memory, None);
			}
		}
	}
}

impl Drop for Vulkan {
	fn drop(&mut self) {
		unsafe {
			let _ = self.device.device_wait_idle();
			for imported in std::mem::take(&mut self.imports) {
				self.destroy_import(imported);
			}
			if let Some(output) = self.output.take() {
				self.destroy_output(output);
			}
			Made {
				sampler: self.sampler,
				set_layout: self.set_layout,
				pipeline_layout: self.pipeline_layout,
				pipeline: self.pipeline,
				descriptor_pool: self.descriptor_pool,
				command_pool: self.command_pool,
				fences: self.fences,
			}
			.destroy(&self.device);
			self.device.destroy_device(None);
			self.instance.destroy_instance(None);
		}
	}
}
