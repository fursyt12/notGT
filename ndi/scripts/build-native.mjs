#!/usr/bin/env node
/**
 * Builds the native converter (native/) for this machine and puts the addon
 * where src/native.mjs looks for it: native/notgt-ndi-native.<os>-<arch>.node.
 *
 *   npm run build:native
 *
 * Needs Rust (cargo). The shader is compiled again when glslc is there (the
 * Vulkan SDK, or shaderc); otherwise the committed convert.spv is used.
 *
 * The addon links against this machine's C library: built on a newer Linux
 * than the one it runs on, it will not load there — build it where it runs,
 * or in the same Debian release as the Docker image (rust:1-bookworm).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addonName } from "../src/native.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const crate = path.resolve(here, "..", "native");

function run(command, args) {
	const done = spawnSync(command, args, { stdio: "inherit", cwd: crate });
	if (done.error?.code === "ENOENT") return false;
	if (done.status !== 0) process.exit(done.status ?? 1);
	return true;
}

const shaders = path.join(crate, "core", "shaders");
if (
	!run("glslc", [
		"--target-env=vulkan1.1",
		"-O",
		"-o",
		path.join(shaders, "convert.spv"),
		path.join(shaders, "convert.comp"),
	])
)
	console.log("glslc is not here: using the committed convert.spv");

if (!run("cargo", ["build", "--release"])) {
	console.error("cargo is not here: install Rust (https://rustup.rs) to build the native converter");
	process.exit(1);
}

const built = {
	linux: "libnotgt_ndi_native.so",
	darwin: "libnotgt_ndi_native.dylib",
	win32: "notgt_ndi_native.dll",
}[process.platform];
const target = path.join(crate, addonName());
fs.copyFileSync(path.join(crate, "target", "release", built), target);
console.log(`built ${path.relative(process.cwd(), target)}`);
