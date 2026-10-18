/**
 * The native converter (native/, Rust): loads the addon built for this
 * platform, and says what it finds — which GPU, which driver, and why a GPU
 * cannot be used. Nothing here decides; output.mjs does, and says so.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The addon's file name for this platform: native/notgt-ndi-native.linux-x64.node. */
export function addonName(platform = process.platform, arch = process.arch) {
	return `notgt-ndi-native.${platform}-${arch}.node`;
}

let loaded;

/**
 * The addon, or why there is none.
 * @returns {{ module: any, file: string } | { why: string }}
 */
export function loadNative() {
	if (loaded) return loaded;
	const file = `../native/${addonName()}`;
	try {
		loaded = { module: require(file), file: require.resolve(file) };
	} catch (error) {
		loaded = {
			why:
				error.code === "MODULE_NOT_FOUND"
					? `no native converter is built for ${process.platform}-${process.arch} (npm run build:native)`
					: `the native converter cannot be loaded: ${error.message}`,
		};
	}
	return loaded;
}

/** The probe's findings, a line each: every GPU, and whether it is usable. */
export function describeProbe(result) {
	if (result.error) return [`native converter: ${result.error}`];
	if (!result.devices.length) return [`native converter: ${result.backend} sees no GPU`];
	return result.devices.map((d) => {
		const what = [d.kind, d.driver, `${result.backend} ${d.api}`]
			.filter(Boolean)
			.join(", ");
		const hex = (n) => `0x${n.toString(16).padStart(4, "0")}`;
		const pci = `, PCI ${hex(d.vendorId)}:${hex(d.deviceId)}`;
		const node = d.renderNode ? `, render node ${d.renderNode}` : "";
		const layouts = d.layouts
			? process.platform === "win32"
				? ", imports D3D11 frames"
				: `, ${d.layouts} frame layout(s)`
			: "";
		return `native converter: ${d.name} (${what}${pci}${node}${layouts}): ${d.usable ? "usable" : `not usable — ${d.why}`}`;
	});
}
