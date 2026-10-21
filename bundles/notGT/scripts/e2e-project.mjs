#!/usr/bin/env node
/**
 * notGT end-to-end test of the `.ngt` project file.
 *
 * Saves the show, opens a project built here (with media files in it), opens
 * it again and with a namesake file, saves again and compares, refuses
 * damaged files, and opens the first save back so the server ends where it
 * started.
 *
 * The file is read and written here by this script's own code, from the
 * layout written down in `src/extension/ngt.ts`, so the server is also held to
 * the format as documented.
 *
 * Usage (server must already be running on 127.0.0.1:9090, without sign-in):
 *   node scripts/e2e-project.mjs
 */
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const PROJECT = `${BASE}/bundles/notGT/project`;
const MEDIA = `${BASE}/bundles/notGT/media`;
const SOURCES = `${BASE}/bundles/notGT/sources`;
const MEDIA_PREFIX = "/assets/notGT/media/";
const MAGIC = Buffer.from([0x89, 0x4e, 0x47, 0x54, 0x0d, 0x0a, 0x1a, 0x0a]);

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

// ------------------------------------------------------------------ format

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes, previous = 0) {
	let crc = ~previous >>> 0;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return ~crc >>> 0;
}

function chunk(type, payload) {
	const head = Buffer.alloc(12);
	head.write(type, 0, 4, "latin1");
	head.writeBigUInt64LE(BigInt(payload.length), 4);
	const tail = Buffer.alloc(4);
	tail.writeUInt32LE(crc32(payload, crc32(head.subarray(0, 4))));
	return Buffer.concat([head, payload, tail]);
}

const jsonChunk = (type, value) => chunk(type, zlib.deflateRawSync(Buffer.from(JSON.stringify(value))));

function mediaChunk(name, bytes) {
	const encoded = Buffer.from(name, "utf8");
	const length = Buffer.alloc(2);
	length.writeUInt16LE(encoded.length);
	return chunk("MDIA", Buffer.concat([length, encoded, bytes]));
}

function encode({ titles, outs, data, selection = {}, files = [], version = 1 }) {
	const header = Buffer.alloc(12);
	MAGIC.copy(header);
	header.writeUInt32LE(version, 8);
	return Buffer.concat([
		header,
		jsonChunk("TITL", titles),
		jsonChunk("OUTS", outs),
		jsonChunk("VARS", { data, selection }),
		...files.map(([name, bytes]) => mediaChunk(name, bytes)),
		chunk("DONE", Buffer.alloc(0)),
	]);
}

/** Every chunk of a file, checked; throws on anything out of place. */
function decode(file) {
	if (!file.subarray(0, 8).equals(MAGIC)) throw new Error("no magic");
	const version = file.readUInt32LE(8);
	const chunks = [];
	let at = 12;
	for (;;) {
		const type = file.toString("latin1", at, at + 4);
		const length = Number(file.readBigUInt64LE(at + 4));
		const payload = file.subarray(at + 12, at + 12 + length);
		const stored = file.readUInt32LE(at + 12 + length);
		if (crc32(payload, crc32(file.subarray(at, at + 4))) !== stored) throw new Error(`${type}: bad CRC`);
		chunks.push({ type, payload });
		at += 12 + length + 4;
		if (type === "DONE") break;
	}
	if (at !== file.length) throw new Error(`${file.length - at} bytes after DONE`);
	const json = (type) => {
		const found = chunks.find((entry) => entry.type === type);
		return found ? JSON.parse(zlib.inflateRawSync(found.payload).toString("utf8")) : undefined;
	};
	const media = new Map();
	for (const entry of chunks.filter((c) => c.type === "MDIA")) {
		const nameLength = entry.payload.readUInt16LE(0);
		media.set(entry.payload.toString("utf8", 2, 2 + nameLength), entry.payload.subarray(2 + nameLength));
	}
	return {
		version,
		types: chunks.map((entry) => entry.type),
		info: json("INFO"),
		titles: json("TITL"),
		outs: json("OUTS"),
		vars: json("VARS"),
		media,
	};
}

// ------------------------------------------------------------------ server

async function save() {
	const response = await fetch(`${PROJECT}/save`);
	return {
		status: response.status,
		disposition: response.headers.get("content-disposition") ?? "",
		bytes: Buffer.from(await response.arrayBuffer()),
	};
}

async function open(bytes) {
	const response = await fetch(`${PROJECT}/open`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: bytes,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, json };
}

async function api(path) {
	return (await fetch(`${BASE}/api/${path}`)).json();
}

async function state() {
	const [{ templates }, { outs }, { data }, { selection }] = await Promise.all([
		api("templates"),
		api("outs"),
		api("data"),
		api("selection"),
	]);
	return { templates, outs, data, selection };
}

/** A served media file, once the server has it. */
async function served(name) {
	for (let attempt = 0; attempt < 10; attempt++) {
		const response = await fetch(`${BASE}${MEDIA_PREFIX}${encodeURIComponent(name)}`);
		if (response.ok) return Buffer.from(await response.arrayBuffer());
		await sleep(200);
	}
	return undefined;
}

// ----------------------------------------------------------------- fixture

const run = Date.now().toString(36);
const imageName = `e2e-ngt-кадр-${run}.png`;
const photoName = `e2e-ngt-photo-${run}.png`;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const otherPng = Buffer.concat([PNG, Buffer.from(`another file ${run}`)]);
const photoPng = Buffer.concat([PNG, Buffer.from(`photo ${run}`)]);
const playback = { mode: "once", intervalMs: 10000, holdMs: 3000, autoStart: false };
const fade = { type: "fade", durationMs: 300, easing: "ease-out" };

const template = {
	id: `e2e_ngt_${run}`,
	name: "E2E project title",
	kind: "layers",
	width: 1920,
	height: 1080,
	layers: [
		{
			id: "img",
			type: "image",
			x: 0,
			y: 0,
			width: 10,
			height: 10,
			src: `${MEDIA_PREFIX}${encodeURIComponent(imageName)}`,
			style: {},
			z: 0,
		},
		{ id: "txt", type: "text", x: 10, y: 10, text: "{{e2e.name}}", style: { fontSize: 48 }, z: 1 },
	],
	inTransition: fade,
	outTransition: fade,
	playback,
	createdAt: 1,
	updatedAt: 1,
};
const out = {
	id: `e2e-ngt-${run}`,
	name: "E2E project out",
	width: 1920,
	height: 1080,
	items: [
		{ id: "on-air", templateId: template.id, x: 5, y: 70, scale: 1, playback, enabled: true, held: true, order: 0 },
		{ id: "orphan", templateId: "no_such_template", x: 0, y: 0, scale: 1, playback, enabled: true, order: 1 },
	],
	createdAt: 1,
	updatedAt: 1,
};
const data = {
	e2e: { name: "Project file" },
	guests: [{ name: "Anna" }, { name: "Peter" }],
	photo: `${MEDIA_PREFIX}${encodeURIComponent(photoName)}`,
};
const selection = { guests: 1 };
const fixture = { titles: [template], outs: [out], data, selection };
const created = new Set();

// ------------------------------------------------------------------- steps

const before = await state();
const baseline = await save();
check("save answers 200", baseline.status === 200, `HTTP ${baseline.status}`);
check("save is offered as an .ngt file", /filename="notGT-[\d-]+\.ngt"/.test(baseline.disposition), baseline.disposition);
for (const [asked, expected] of [
	["my-show.ngt", "my-show.ngt"],
	['a"b.ngt', null],
	["notes.txt", null],
]) {
	const response = await fetch(`${PROJECT}/save?name=${encodeURIComponent(asked)}`);
	const disposition = response.headers.get("content-disposition") ?? "";
	await response.arrayBuffer();
	check(
		expected ? `save takes the panel's name ${asked}` : `save keeps ${asked} out of the header`,
		expected ? disposition.includes(`filename="${expected}"`) : /filename="notGT-[\d-]+\.ngt"$/.test(disposition),
		disposition,
	);
}
let saved;
try {
	saved = decode(baseline.bytes);
	check("the saved file reads back chunk by chunk", true, saved.types.join(" "));
} catch (error) {
	check("the saved file reads back chunk by chunk", false, String(error));
	process.exit(1);
}
check("format version 1", saved.version === 1);
check("INFO, TITL, OUTS, VARS and DONE are there", ["INFO", "TITL", "OUTS", "VARS", "DONE"].every((type) => saved.types.includes(type)));
check("DONE comes last", saved.types.at(-1) === "DONE");
check("INFO counts what was saved", saved.info?.app === "notGT" && saved.info.titles === before.templates.length && saved.info.outs === before.outs.length);
check("TITL holds every animation", isDeepStrictEqual(saved.titles, before.templates));
check("OUTS holds every out", isDeepStrictEqual(saved.outs, before.outs));
check("VARS holds the variables and the selection", isDeepStrictEqual(saved.vars, { data: before.data, selection: before.selection }));

// Open a project built here.
const first = await open(encode({ ...fixture, files: [[imageName, PNG], [photoName, photoPng]] }));
check("open answers 200", first.status === 200, JSON.stringify(first.json));
check("open counts what it took", first.json.titles === 1 && first.json.outs === 1 && first.json.variables === 3);
check("both media files were written", first.json.media?.added === 2 && first.json.media.renamed.length === 0, JSON.stringify(first.json.media));
if (first.json.media?.added === 2) {
	created.add(imageName);
	created.add(photoName);
}
let now = await state();
check("the animations are the file's", isDeepStrictEqual(now.templates, [template]));
check("the outs are the file's", now.outs.length === 1 && now.outs[0].id === out.id);
check("a placement of a missing animation is dropped", now.outs[0]?.items.map((item) => item.id).join() === "on-air");
check("nothing comes back on air", now.outs[0]?.items.every((item) => item.held === false));
check("the variables are the file's", isDeepStrictEqual(now.data, data));
check("the chosen row is the file's", isDeepStrictEqual(now.selection, selection));
check("the image is served under its non-Latin name", (await served(imageName))?.equals(PNG) === true);
check("a file a variable points at came along", (await served(photoName))?.equals(photoPng) === true);

// The same file again: the media is there already.
const again = await open(encode({ ...fixture, files: [[imageName, PNG], [photoName, photoPng]] }));
check("opening again reuses the media", again.json.media?.reused === 2 && again.json.media.added === 0, JSON.stringify(again.json.media));

// A different file under a name that is taken.
const namesake = await open(encode({ ...fixture, files: [[imageName, otherPng], [photoName, photoPng]] }));
const renamedTo = namesake.json.media?.renamed?.[0]?.[1];
check("a namesake is saved under a new name", namesake.status === 200 && namesake.json.media.renamed.length === 1 && renamedTo === imageName.replace(/\.png$/, "-2.png"), JSON.stringify(namesake.json.media));
if (renamedTo) created.add(renamedTo);
now = await state();
check("the animation points at the new name", now.templates[0]?.layers[0]?.src === `${MEDIA_PREFIX}${encodeURIComponent(renamedTo ?? "")}`, now.templates[0]?.layers[0]?.src);
check("the new name serves the new file", (await served(renamedTo ?? ""))?.equals(otherPng) === true);
check("the old name keeps the old file", (await served(imageName))?.equals(PNG) === true);

// Save again: the media goes with it.
const second = decode((await save()).bytes);
check("the media the animations use is saved", second.media.get(renamedTo ?? "")?.equals(otherPng) === true);
check("the media the variables use is saved", second.media.get(photoName)?.equals(photoPng) === true);
check("a file nothing points at stays out", !second.media.has(imageName));
check("the animations survive the round trip", isDeepStrictEqual(second.titles, now.templates));

// Refusals: each leaves the show as it was.
const good = encode(fixture);
const titlAt = 12 + 12 + 4;
const flipped = Buffer.from(good);
flipped[titlAt] ^= 0xff;
const refusals = [
	["random bytes", Buffer.from("this is a text file, not a project"), "not_ngt"],
	["a newer format", encode({ ...fixture, version: 99 }), "newer"],
	["a flipped byte", flipped, "damaged"],
	["no DONE", good.subarray(0, good.length - 16), "truncated"],
	["a media name with a folder", encode({ ...fixture, files: [["../escape.png", PNG]] }), "damaged"],
];
for (const [what, bytes, problem] of refusals) {
	const refused = await open(bytes);
	check(`${what} is refused as ${problem}`, refused.status === 400 && refused.json.error === problem, `HTTP ${refused.status} ${JSON.stringify(refused.json)}`);
}
const after = await state();
check("a refused file changes nothing", isDeepStrictEqual(after.templates, now.templates) && isDeepStrictEqual(after.data, now.data));

// A list that mirrors a connected workbook keeps following the workbook:
// taking the file's version would write it into the workbook.
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("E2E Ngt Guests");
sheet.addRow(["Name"]);
sheet.addRow(["From the workbook"]);
const connected = await (
	await fetch(`${SOURCES}/upload?name=${encodeURIComponent(`e2e-ngt-${run}.xlsx`)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: new Uint8Array(await workbook.xlsx.writeBuffer()),
	})
).json();
const bound = connected.source?.sheets?.[0]?.variable;
check("a workbook is connected for the next checks", Boolean(bound), JSON.stringify(connected).slice(0, 200));
if (bound) {
	const fromBook = (await state()).data[bound];
	const over = await open(encode({ ...fixture, data: { ...data, [bound]: [{ Name: "From the project" }] } }));
	check("a list a workbook mirrors keeps the workbook's rows", over.json.kept?.includes(bound) && isDeepStrictEqual((await state()).data[bound], fromBook), JSON.stringify(over.json.kept));
	const sources = (await (await fetch(`${SOURCES}/`)).json()).sources ?? [];
	check("the workbook stays connected", sources.some((source) => source.id === connected.source.id && source.state === "ok"));
	await fetch(`${SOURCES}/${connected.source.id}`, { method: "DELETE" });
}

// Back to where the server started.
const restored = await open(baseline.bytes);
check("the first save opens", restored.status === 200, JSON.stringify(restored.json));
const end = await state();
check("the animations are back", isDeepStrictEqual(end.templates, before.templates));
check(
	"the outs are back",
	isDeepStrictEqual(
		end.outs,
		before.outs.map((o) => ({ ...o, items: o.items.map((item) => ({ ...item, held: false })) })),
	),
);
check("the variables are back", isDeepStrictEqual(end.data, before.data));

for (const name of created) {
	await fetch(`${MEDIA}/file/${encodeURIComponent(name)}`, { method: "DELETE" });
}

console.log(failures.length === 0 ? "\nAll project file checks passed." : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
