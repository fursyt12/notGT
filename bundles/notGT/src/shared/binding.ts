/**
 * Variable binding helpers, shared by extension / dashboard / graphics.
 *
 * Binding syntax inside templates:
 *   {{speaker.name}}                 -> value at path `speaker.name`
 *   {{speaker.role ?? Guest}}        -> fallback after `??` when the value is empty
 *
 * Paths are dot separated and may contain array indexes: `panel.items[0].title`.
 */
import type { TitleData, TitleTemplate, VariableSelection } from "./types";

export function parsePath(path: string): Array<string | number> {
	const out: Array<string | number> = [];
	const re = /[^.[\]]+|\[(\d+)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(path)) !== null) {
		if (m[1] !== undefined) out.push(Number(m[1]));
		else out.push(m[0]);
	}
	return out;
}

/**
 * Resolves `path` against `data`.
 *
 * Arrays are "pick one" collections: when the walk lands on an array and the
 * next token is not an explicit numeric index, the element chosen in
 * `selection` (default 0) is used. So with
 * `{ speakers: [{name:"A"},{name:"B"}] }` and `selection.speakers = 1`, both
 * `speakers.name` and `speakers` resolve to `B`. An explicit index
 * (`speakers[0].name`) always wins.
 */
export function getByPath(
	data: unknown,
	path: string,
	selection: VariableSelection = {},
): unknown {
	const segments = parsePath(path);
	let cur: unknown = data;
	let key = "";
	let i = 0;

	while (i < segments.length) {
		if (Array.isArray(cur)) {
			const seg = segments[i]!;
			let index: number;
			if (typeof seg === "number") {
				index = seg;
				i++;
			} else {
				index = selection[key] ?? 0;
			}
			key = `${key}[${index}]`;
			cur = cur[index];
			continue; // the element itself may be an array again
		}
		if (typeof segments[i] === "number") return undefined; // index on a non-array
		if (cur === null || cur === undefined || typeof cur !== "object") {
			return undefined;
		}
		const seg = String(segments[i]!);
		i++;
		key = key ? `${key}.${seg}` : seg;
		cur = (cur as Record<string, unknown>)[seg];
	}

	// A path may end exactly on an array: yield the selected element.
	while (Array.isArray(cur)) {
		const index = selection[key] ?? 0;
		key = `${key}[${index}]`;
		cur = cur[index];
	}
	return cur;
}

export function setByPath<T extends Record<string, unknown>>(
	target: T,
	path: string,
	value: unknown,
): T {
	const segments = parsePath(path);
	if (segments.length === 0) return target;
	let cur: Record<string | number, unknown> = target;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i]!;
		const nextSeg = segments[i + 1]!;
		let next = cur[seg as never];
		if (next === null || typeof next !== "object") {
			next = typeof nextSeg === "number" ? [] : {};
			cur[seg as never] = next;
		}
		cur = next as Record<string | number, unknown>;
	}
	cur[segments[segments.length - 1]! as never] = value;
	return target;
}

export function deleteByPath<T extends Record<string, unknown>>(
	target: T,
	path: string,
): T {
	const segments = parsePath(path);
	if (segments.length === 0) return target;
	let cur: Record<string | number, unknown> = target;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i]!;
		const next = cur[seg as never];
		if (next === null || typeof next !== "object") return target;
		cur = next as Record<string | number, unknown>;
	}
	delete cur[segments[segments.length - 1]! as never];
	return target;
}

function stringify(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Like `getByPath`, but never auto-indexes arrays: returns the container
 * exactly as stored. Use this when you need to manipulate a collection.
 */
export function getByPathRaw(data: unknown, path: string): unknown {
	let cur: unknown = data;
	for (const seg of parsePath(path)) {
		if (cur === null || cur === undefined) return undefined;
		if (typeof cur !== "object") return undefined;
		cur = (cur as Record<string | number, unknown>)[seg as never];
	}
	return cur;
}

/** Replaces every `{{path}}` / `{{path ?? fallback}}` token in `input`. */
export function interpolate(
	input: string,
	data: TitleData,
	selection: VariableSelection = {},
): string {
	if (!input) return "";
	return input.replace(TOKEN, (_full, expr: string) => {
		const [rawPath, ...fallbackParts] = expr.split("??");
		const path = (rawPath ?? "").trim();
		const fallback = fallbackParts.join("??").trim();
		const value = getByPath(data, path, selection);
		const str = stringify(value);
		if (str === "" && fallback) return fallback;
		return str;
	});
}

/** Extracts every binding path referenced in a string. */
export function bindingPathsIn(input: string | undefined): string[] {
	if (!input) return [];
	const found: string[] = [];
	for (const m of input.matchAll(TOKEN)) {
		const [rawPath] = (m[1] ?? "").split("??");
		const path = (rawPath ?? "").trim();
		if (path) found.push(path);
	}
	return found;
}

/** Every binding path referenced by a template (layers + code). */
export function collectBindingPaths(template: TitleTemplate): string[] {
	const paths = new Set<string>();
	for (const layer of template.layers ?? []) {
		if (layer.binding) paths.add(layer.binding);
		for (const p of bindingPathsIn(layer.text)) paths.add(p);
	}
	if (template.code) {
		for (const p of bindingPathsIn(template.code.html)) paths.add(p);
		for (const p of bindingPathsIn(template.code.css)) paths.add(p);
		for (const p of bindingPathsIn(template.code.js)) paths.add(p);
	}
	return [...paths].sort();
}

/**
 * Returns a copy of `data` where every array is replaced by its selected
 * element, recursively. Used for code-authored animations, whose iframe should
 * see "the current speaker" directly rather than the whole collection.
 * Selection keys follow the same convention as `getByPath`.
 */
export function materializeSelection(
	value: unknown,
	selection: VariableSelection,
	prefix = "",
): unknown {
	if (Array.isArray(value)) {
		const index = selection[prefix] ?? 0;
		return materializeSelection(value[index], selection, `${prefix}[${index}]`);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = materializeSelection(
				child,
				selection,
				prefix ? `${prefix}.${key}` : key,
			);
		}
		return out;
	}
	return value;
}

/** Flattens a data object into `{ path, value }` rows for form UIs. */
export function flattenData(
	data: TitleData,
	prefix = "",
): Array<{ path: string; value: unknown }> {
	const rows: Array<{ path: string; value: unknown }> = [];
	for (const [key, value] of Object.entries(data ?? {})) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			rows.push(...flattenData(value as TitleData, path));
		} else {
			rows.push({ path, value });
		}
	}
	return rows;
}

/** Coerces a form string into a sensible scalar. */
export function coerce(value: string): unknown {
	if (value === "") return "";
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
	return value;
}

export function clone<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(value);
		} catch {
			// NodeCG wraps server-side Replicant values in a Proxy, which the
			// structured clone algorithm rejects. Fall through to JSON.
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
