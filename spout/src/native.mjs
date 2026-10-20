/**
 * The Spout addon (native/, Rust): the one built for this platform. Only
 * Windows has Spout.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The addon's file name for this platform: native/notgt-spout-native.win32-x64.node. */
export function addonName(platform = process.platform, arch = process.arch) {
	return `notgt-spout-native.${platform}-${arch}.node`;
}

let loaded;

/**
 * The addon, or why there is none.
 * @returns {{ module: any, file: string } | { why: string }}
 */
export function loadSpout() {
	if (loaded) return loaded;
	if (process.platform !== "win32") {
		loaded = { why: "Spout is only on Windows" };
		return loaded;
	}
	const file = `../native/${addonName()}`;
	try {
		loaded = { module: require(file), file: require.resolve(file) };
	} catch (error) {
		loaded = {
			why:
				error.code === "MODULE_NOT_FOUND"
					? `no Spout addon is built for ${process.platform}-${process.arch} (npm run build:native in spout/)`
					: `the Spout addon cannot be loaded: ${error.message}`,
		};
	}
	return loaded;
}
