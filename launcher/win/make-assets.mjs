#!/usr/bin/env node
/**
 * Regenerates the launcher's images from the brand files in media/brand:
 *
 *   assets/notgt.ico   the program's icon (window, taskbar, tray, Explorer)
 *   assets/logo.png    the logo in the window's header, for the dark ground
 *
 * The results are committed, so building the launcher needs none of this. Run
 * it only after the logo changed:
 *
 *   node launcher/win/make-assets.mjs        (needs `rsvg-convert` from librsvg)
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
 * An .ico is a directory of images; since Windows Vista an entry may simply be
 * a PNG file, which is what every size here is.
 */
function ico(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);
	const entries = [];
	let offset = 6 + 16 * images.length;
	for (const { size, data } of images) {
		const entry = Buffer.alloc(16);
		entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
		entry.writeUInt8(size >= 256 ? 0 : size, 1);
		entry.writeUInt16LE(1, 4); // colour planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(data.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += data.length;
		entries.push(entry);
	}
	return Buffer.concat([
		header,
		...entries,
		...images.map((image) => image.data),
	]);
}

fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(
	path.join(assets, "notgt.ico"),
	ico(
		[16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({
			size,
			data: png("notgt-mark.svg", size),
		})),
	),
);
// Drawn at 44 px tall in the window; three times that keeps it sharp at 200 %+.
fs.writeFileSync(
	path.join(assets, "logo.png"),
	png("notgt-logo-on-dark.svg", 132),
);
console.log("launcher/win/assets: notgt.ico, logo.png");
