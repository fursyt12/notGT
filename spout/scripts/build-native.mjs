#!/usr/bin/env node
/**
 * Builds the Spout addon (native/) for this machine and puts it where
 * src/native.mjs looks for it: native/notgt-spout-native.win32-x64.node.
 *
 *   npm run build:native
 *
 * Needs Rust (cargo), on Windows: Spout is Windows' alone. Elsewhere the
 * tests can still run under wine (README.md).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addonName } from "../src/native.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const crate = path.resolve(here, "..", "native");

if (process.platform !== "win32") {
	console.error("Spout is only on Windows: build the addon there (README.md runs the tests under wine)");
	process.exit(1);
}
const done = spawnSync("cargo", ["build", "--release"], { stdio: "inherit", cwd: crate });
if (done.error?.code === "ENOENT") {
	console.error("cargo is not here: install Rust (https://rustup.rs) to build the Spout addon");
	process.exit(1);
}
if (done.status !== 0) process.exit(done.status ?? 1);

const target = path.join(crate, addonName());
fs.copyFileSync(path.join(crate, "target", "release", "notgt_spout_native.dll"), target);
console.log(`built ${path.relative(process.cwd(), target)}`);
