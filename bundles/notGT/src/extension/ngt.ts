/**
 * The `.ngt` file: a whole show — its animations, its outs and its variables,
 * with the media files the animations use — in one binary file that notGT
 * saves and opens (see `project.ts`).
 *
 * Every integer is little-endian.
 *
 *   header   8  magic: 89 4E 47 54 0D 0A 1A 0A ("\x89NGT\r\n\x1a\n")
 *            4  u32, the format version (1)
 *   chunk    4  type: four ASCII letters
 *            8  u64, the length of the payload
 *            n  the payload
 *            4  u32, CRC-32 of the type and the payload
 *   … more chunks, the last of them DONE.
 *
 * As in PNG, the high first byte and the line endings of the magic give away a
 * file that went through a text-mode transfer.
 *
 *   INFO  deflated JSON `NgtInfo`: what wrote the file, when, and what is in it
 *   TITL  deflated JSON `TitleTemplate[]`: the animations
 *   OUTS  deflated JSON `Out[]`: the outs and what is placed on them
 *   VARS  deflated JSON `{ data, selection }`: the variables, and the row
 *         chosen in each list
 *   MDIA  one media file: u16 length of its name, the name in UTF-8, then its
 *         bytes as they are (video is compressed already)
 *   DONE  empty: the file is whole
 *
 * "Deflated" is raw deflate (RFC 1951), without a zlib or gzip wrapper. A
 * reader skips the chunk types it does not know, so a later notGT can add one
 * and this one still opens the file; a newer format version is refused.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import type { Out, TitleData, TitleTemplate, VariableSelection } from "../shared/types";

export const NGT_MAGIC = Buffer.from([0x89, 0x4e, 0x47, 0x54, 0x0d, 0x0a, 0x1a, 0x0a]);
export const NGT_VERSION = 1;

const HEADER_BYTES = NGT_MAGIC.length + 4;
/** The type and the length in front of a payload. */
const CHUNK_HEAD_BYTES = 12;
const CRC_BYTES = 4;
/** No JSON chunk inflates past this: a damaged file must not take the server's memory. */
const MAX_JSON_BYTES = 512 * 1024 * 1024;
/** Media is read in pieces of this size. */
const PIECE_BYTES = 1024 * 1024;

/** What wrote the file and what is in it; the reader does not need it. */
export interface NgtInfo {
	app: string;
	version: string;
	schemaVersion: number;
	savedAt: string;
	titles: number;
	outs: number;
	variables: number;
	media: number;
}

/** What a `.ngt` file holds, the media aside. */
export interface NgtProject {
	info?: NgtInfo;
	titles: TitleTemplate[];
	outs: Out[];
	data: TitleData;
	selection: VariableSelection;
}

/** A media file to save: its name in the media folder, and the file on disk. */
export interface NgtMediaSource {
	name: string;
	file: string;
}

/** A media file inside a `.ngt` file. */
export interface NgtMediaEntry {
	name: string;
	/** Where its bytes start in the `.ngt` file. */
	offset: number;
	bytes: number;
	/** SHA-256 of its bytes, hex: tells the same file already on the server from a namesake. */
	sha256: string;
}

/**
 *   not_ngt   — not a `.ngt` file at all;
 *   newer     — a format version this notGT does not know;
 *   damaged   — a chunk does not match its CRC, or holds what it should not;
 *   truncated — the file ends before DONE.
 */
export type NgtProblem = "not_ngt" | "newer" | "damaged" | "truncated";

export class NgtError extends Error {
	constructor(
		readonly problem: NgtProblem,
		message: string,
	) {
		super(message);
	}
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** CRC-32 as zlib and PNG have it; pass the previous result to go on over more bytes. */
export function crc32(bytes: Uint8Array, previous = 0): number {
	if (nativeCrc32) return nativeCrc32(bytes, previous);
	let crc = ~previous >>> 0;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
	return ~crc >>> 0;
}

function chunkHead(type: string, length: number): Buffer {
	const head = Buffer.alloc(CHUNK_HEAD_BYTES);
	head.write(type, 0, 4, "latin1");
	head.writeBigUInt64LE(BigInt(length), 4);
	return head;
}

function crcBytes(crc: number): Buffer {
	const tail = Buffer.alloc(CRC_BYTES);
	tail.writeUInt32LE(crc >>> 0, 0);
	return tail;
}

/** A whole chunk, around a payload that is in memory. */
function chunk(type: string, payload: Buffer): Buffer {
	const head = chunkHead(type, payload.length);
	return Buffer.concat([head, payload, crcBytes(crc32(payload, crc32(head.subarray(0, 4))))]);
}

function jsonChunk(type: string, value: unknown): Buffer {
	return chunk(type, zlib.deflateRawSync(Buffer.from(JSON.stringify(value), "utf8")));
}

/**
 * The bytes of a `.ngt` file, piece by piece, so a show with long videos is
 * never in memory at once. A media file that shrinks while it is read stops
 * the file with an error before DONE, so what was sent cannot be opened.
 */
export async function* encodeNgt(
	project: NgtProject,
	media: NgtMediaSource[],
): AsyncGenerator<Buffer> {
	const header = Buffer.alloc(HEADER_BYTES);
	NGT_MAGIC.copy(header);
	header.writeUInt32LE(NGT_VERSION, NGT_MAGIC.length);
	yield header;
	if (project.info) yield jsonChunk("INFO", project.info);
	yield jsonChunk("TITL", project.titles);
	yield jsonChunk("OUTS", project.outs);
	yield jsonChunk("VARS", { data: project.data, selection: project.selection });
	for (const source of media) yield* mediaChunk(source);
	yield chunk("DONE", Buffer.alloc(0));
}

async function* mediaChunk(source: NgtMediaSource): AsyncGenerator<Buffer> {
	const name = Buffer.from(source.name, "utf8");
	const handle = await fs.promises.open(source.file, "r");
	try {
		const { size } = await handle.stat();
		const prefix = Buffer.alloc(2 + name.length);
		prefix.writeUInt16LE(name.length, 0);
		name.copy(prefix, 2);
		const head = chunkHead("MDIA", prefix.length + size);
		let crc = crc32(prefix, crc32(head.subarray(0, 4)));
		yield Buffer.concat([head, prefix]);
		let position = 0;
		while (position < size) {
			const piece = Buffer.allocUnsafe(Math.min(PIECE_BYTES, size - position));
			const { bytesRead } = await handle.read(piece, 0, piece.length, position);
			if (bytesRead === 0) break;
			const read = piece.subarray(0, bytesRead);
			crc = crc32(read, crc);
			position += bytesRead;
			yield read;
		}
		if (position !== size) throw new Error(`${source.name} changed while it was being saved`);
		yield crcBytes(crc);
	} finally {
		await handle.close();
	}
}

const JSON_CHUNKS = new Set(["INFO", "TITL", "OUTS", "VARS"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasId(value: unknown): value is Record<string, unknown> & { id: string } {
	return isRecord(value) && typeof value["id"] === "string" && value["id"] !== "";
}

function uniqueIds(list: Array<{ id: string }>): boolean {
	return new Set(list.map((entry) => entry.id)).size === list.length;
}

function damaged(message: string): NgtError {
	return new NgtError("damaged", message);
}

/** The pieces of a project, checked for the shape the rest of notGT relies on. */
function projectOf(json: Map<string, unknown>): NgtProject {
	const titles = json.get("TITL");
	const outs = json.get("OUTS");
	const vars = json.get("VARS");
	if (titles === undefined || outs === undefined || vars === undefined) {
		throw damaged("The file has no animations, outs or variables in it");
	}
	if (
		!Array.isArray(titles) ||
		!titles.every(
			(title) =>
				hasId(title) &&
				typeof title["name"] === "string" &&
				(title["kind"] === "layers" || title["kind"] === "code") &&
				Array.isArray(title["layers"]),
		) ||
		!uniqueIds(titles)
	) {
		throw damaged("The animations in the file are not what notGT writes");
	}
	if (
		!Array.isArray(outs) ||
		!outs.every(
			(out) =>
				hasId(out) &&
				Array.isArray(out["items"]) &&
				(out["items"] as unknown[]).every((item) => hasId(item) && typeof item["templateId"] === "string"),
		) ||
		!uniqueIds(outs)
	) {
		throw damaged("The outs in the file are not what notGT writes");
	}
	if (!isRecord(vars) || !isRecord(vars["data"])) {
		throw damaged("The variables in the file are not what notGT writes");
	}
	const selection: VariableSelection = {};
	if (isRecord(vars["selection"])) {
		for (const [path, index] of Object.entries(vars["selection"])) {
			if (typeof index === "number" && Number.isInteger(index) && index >= 0) selection[path] = index;
		}
	}
	const info = json.get("INFO");
	return {
		info: isRecord(info) ? (info as unknown as NgtInfo) : undefined,
		titles: titles as TitleTemplate[],
		outs: outs as Out[],
		data: vars["data"] as TitleData,
		selection,
	};
}

/**
 * Reads a `.ngt` file and checks every chunk against its CRC before anything
 * is taken from it. The media stays where it is in the file, found by its
 * offset: `copyNgtMedia` writes one out.
 */
export async function readNgt(file: string): Promise<{ project: NgtProject; media: NgtMediaEntry[] }> {
	const handle = await fs.promises.open(file, "r");
	try {
		const { size } = await handle.stat();
		const read = async (position: number, length: number): Promise<Buffer> => {
			const bytes = Buffer.alloc(length);
			const { bytesRead } = await handle.read(bytes, 0, length, position);
			if (bytesRead !== length) throw new NgtError("truncated", "The file ends too early");
			return bytes;
		};

		if (size < HEADER_BYTES) throw new NgtError("not_ngt", "This is not a notGT project file");
		const header = await read(0, HEADER_BYTES);
		if (!header.subarray(0, NGT_MAGIC.length).equals(NGT_MAGIC)) {
			throw new NgtError("not_ngt", "This is not a notGT project file");
		}
		const version = header.readUInt32LE(NGT_MAGIC.length);
		if (version > NGT_VERSION) {
			throw new NgtError("newer", `The file is of format version ${version}; this notGT reads up to ${NGT_VERSION}`);
		}

		const json = new Map<string, unknown>();
		const media: NgtMediaEntry[] = [];
		let position = HEADER_BYTES;
		for (;;) {
			if (position + CHUNK_HEAD_BYTES > size) throw new NgtError("truncated", "The file ends too early");
			const head = await read(position, CHUNK_HEAD_BYTES);
			const type = head.toString("latin1", 0, 4);
			const length = Number(head.readBigUInt64LE(4));
			const start = position + CHUNK_HEAD_BYTES;
			const end = start + length;
			if (!Number.isSafeInteger(end) || end + CRC_BYTES > size) {
				throw new NgtError("truncated", `The ${type} chunk runs past the end of the file`);
			}
			const stored = (await read(end, CRC_BYTES)).readUInt32LE(0);
			const typeCrc = crc32(head.subarray(0, 4));
			const checked = (crc: number): void => {
				if (crc >>> 0 !== stored) throw damaged(`The ${type} chunk does not match its checksum`);
			};

			if (JSON_CHUNKS.has(type)) {
				if (length > MAX_JSON_BYTES) throw damaged(`The ${type} chunk is too large`);
				const payload = await read(start, length);
				checked(crc32(payload, typeCrc));
				try {
					json.set(type, JSON.parse(zlib.inflateRawSync(payload, { maxOutputLength: MAX_JSON_BYTES }).toString("utf8")));
				} catch {
					throw damaged(`The ${type} chunk cannot be read`);
				}
			} else if (type === "MDIA") {
				if (length < 2) throw damaged("A media chunk is too short");
				const nameLength = (await read(start, 2)).readUInt16LE(0);
				if (2 + nameLength > length) throw damaged("A media chunk is too short");
				const prefix = await read(start, 2 + nameLength);
				let crc = crc32(prefix, typeCrc);
				const hash = crypto.createHash("sha256");
				const offset = start + prefix.length;
				for (let at = offset; at < end; ) {
					const piece = await read(at, Math.min(PIECE_BYTES, end - at));
					crc = crc32(piece, crc);
					hash.update(piece);
					at += piece.length;
				}
				checked(crc);
				media.push({
					name: prefix.toString("utf8", 2),
					offset,
					bytes: end - offset,
					sha256: hash.digest("hex"),
				});
			} else if (type === "DONE") {
				checked(typeCrc);
				break;
			}
			// Any other type is from a later notGT: skipped.
			position = end + CRC_BYTES;
		}
		return { project: projectOf(json), media };
	} finally {
		await handle.close();
	}
}

/** Writes one media file out of a `.ngt` file. */
export async function copyNgtMedia(file: string, entry: NgtMediaEntry, target: string): Promise<void> {
	if (entry.bytes === 0) {
		await fs.promises.writeFile(target, Buffer.alloc(0));
		return;
	}
	await pipeline(
		fs.createReadStream(file, { start: entry.offset, end: entry.offset + entry.bytes - 1 }),
		fs.createWriteStream(target),
	);
}

/** SHA-256 of a file, hex. */
export async function hashFile(file: string): Promise<string> {
	const hash = crypto.createHash("sha256");
	for await (const piece of fs.createReadStream(file)) hash.update(piece as Buffer);
	return hash.digest("hex");
}
