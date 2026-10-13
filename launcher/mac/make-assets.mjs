#!/usr/bin/env node
/**
 * Regenerates the macOS launcher's icon from the brand files in media/brand:
 *
 *   assets/notgt.icns   the program's icon (Finder, Dock)
 *
 * The result is committed, so building the launcher needs none of this. Run it
 * only after the logo changed:
 *
 *   node launcher/mac/make-assets.mjs        (needs `rsvg-convert` from librsvg)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const brand = path.resolve(here, "..", "..", "media", "brand");
const assets = path.join(here, "assets");

const png = (svg, size) =>
	execFileSync(
		"rsvg-convert",
		["--height", String(size), path.join(brand, svg)],
		{
			maxBuffer: 16 * 1024 * 1024,
		},
	);

/**
 * An .icns is a list of images, each under a four-letter type that says which
 * size it is; an entry may simply be a PNG file, which is what every one here
 * is. These are the types macOS reads PNG from in every version the launcher
 * runs on; the smaller sizes are scaled down from them.
 */
const TYPES = [
	["ic11", 32], // 16 pt @2x
	["ic12", 64], // 32 pt @2x
	["ic07", 128],
	["ic13", 256], // 128 pt @2x
	["ic08", 256],
	["ic14", 512], // 256 pt @2x
	["ic09", 512],
	["ic10", 1024], // 512 pt @2x
];

function icns(images) {
	const entries = images.map(({ type, data }) => {
		const header = Buffer.alloc(8);
		header.write(type, 0, "latin1");
		header.writeUInt32BE(data.length + 8, 4);
		return Buffer.concat([header, data]);
	});
	const body = Buffer.concat(entries);
	const header = Buffer.alloc(8);
	header.write("icns", 0, "latin1");
	header.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([header, body]);
}

fs.mkdirSync(assets, { recursive: true });
const drawn = new Map();
fs.writeFileSync(
	path.join(assets, "notgt.icns"),
	icns(
		TYPES.map(([type, size]) => {
			if (!drawn.has(size)) drawn.set(size, png("notgt-mark.svg", size));
			return { type, data: drawn.get(size) };
		}),
	),
);
console.log("launcher/mac/assets: notgt.icns");
