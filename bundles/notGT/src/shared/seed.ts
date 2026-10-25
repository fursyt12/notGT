/**
 * What a new installation starts with: the whole examples gallery as its
 * library, and sample values for the variables those examples read.
 *
 * The examples are seeded under their stable gallery ids (`lower-third`,
 * `example-poll`, …), so `POST /api/titles/example-poll/show` works out of the
 * box. They are ordinary operator data from then on: renaming, editing or
 * deleting one is never undone, and the gallery in the dashboard can always add
 * a fresh copy.
 */
import { clone, flattenData, getByPathRaw, setByPath } from "./binding";
import { GALLERY, type ExampleLang, type ExampleTimer } from "./examples/gallery";
import type { TitleData, TitleTemplate } from "./types";

/**
 * The language the library is seeded in: the `language` key of the bundle
 * config, else the locale of the server process, else English. The dashboard
 * itself follows each operator's browser — this is only about seeded content.
 */
export function seedLanguage(configured: unknown, locale = ""): ExampleLang {
	if (configured === "en" || configured === "ru") return configured;
	return locale.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** Every example as a template, under the id of the example. */
export function seedLibrary(lang: ExampleLang): TitleTemplate[] {
	const now = Date.now();
	return GALLERY.map((example) => ({
		...example.template(lang),
		id: example.id,
		name: example.name[lang],
		createdAt: now,
		updatedAt: now,
	}));
}

/** The examples an already populated library does not have yet. */
export function missingLibrary(existing: TitleTemplate[], lang: ExampleLang): TitleTemplate[] {
	const ids = new Set(existing.map((template) => template.id));
	return seedLibrary(lang).filter((template) => !ids.has(template.id));
}

/**
 * The built-in examples of an existing library that the operator never edited
 * (`createdAt === updatedAt`: every save from the dashboard or the API moves
 * `updatedAt`), with the look they have today. Name, playback and timestamps
 * are kept, and so is the language the example was seeded in.
 *
 * An example whose box has changed size since is left alone: its placements
 * were positioned for the old box.
 */
export function redrawnExamples(existing: TitleTemplate[], lang: ExampleLang): TitleTemplate[] {
	return existing
		.filter((template) => template.createdAt === template.updatedAt)
		.flatMap((template) => {
			const example = GALLERY.find((entry) => entry.id === template.id);
			if (!example) return [];
			const captions = [template.code?.html, ...(template.layers ?? []).map((layer) => layer.text)];
			const seededIn: ExampleLang = /[а-яё]/i.test(captions.join(" ")) ? "ru" : lang;
			const fresh = example.template(seededIn);
			if (
				fresh.kind !== template.kind ||
				fresh.width !== template.width ||
				fresh.height !== template.height
			) {
				return [];
			}
			return [
				{
					...template,
					...(fresh.code ? { code: fresh.code } : {}),
					...(fresh.layers ? { layers: fresh.layers } : {}),
				},
			];
		});
}

/** The accent the examples were seeded with before the rebrand, and the one they use now. */
const OLD_ACCENT = "#ff3b30";
const ACCENT = "#ff5a8c";

/**
 * `data` with every `….accent` variable that still holds the old seeded red
 * moved to the brand accent. A colour the operator chose is not touched.
 */
export function rebrandedVariables(data: TitleData): TitleData {
	const next = clone(data);
	for (const row of flattenData(data)) {
		if (/(^|\.)accent$/.test(row.path) && row.value === OLD_ACCENT) setByPath(next, row.path, ACCENT);
	}
	return next;
}

/**
 * The sample values of the file example that used to ship in
 * `graphics/animations/`. Nothing reads them any more.
 */
const RETIRED_SPONSOR = [
	{ label: "Партнёр", name: "ACME", meta: "Официальный партнёр трансляции" },
	{ label: "Partner", name: "ACME", meta: "Official broadcast partner" },
];

/**
 * `data` without the `sponsor` group, if it still holds exactly what was
 * seeded. A group the operator changed or added to is theirs and stays.
 */
export function withoutRetiredSamples(data: TitleData): TitleData {
	const group = data["sponsor"];
	if (!group || typeof group !== "object" || Array.isArray(group)) return data;
	const { accent: _accent, ...texts } = group as Record<string, unknown>;
	const seeded = RETIRED_SPONSOR.some(
		(sample) =>
			Object.keys(texts).length === Object.keys(sample).length &&
			Object.entries(sample).every(([key, value]) => texts[key] === value),
	);
	if (!seeded) return data;
	const { sponsor: _sponsor, ...rest } = data;
	return rest;
}

/**
 * `base` with a sample value for every variable the examples read that it does
 * not have yet. Existing values always win: the operator's data is never
 * replaced.
 */
export function seedVariables(lang: ExampleLang, base: TitleData = {}): TitleData {
	const next = clone(base);
	const samples = GALLERY.map((example) => example.data?.(lang) ?? {});
	for (const sample of samples) {
		for (const row of flattenData(sample)) {
			if (getByPathRaw(next, row.path) === undefined) setByPath(next, row.path, row.value);
		}
	}
	return next;
}

/**
 * The timers the examples in `library` show. Made by the extension when they
 * are missing, on first run and when an example that needs one arrives.
 */
export function seedTimers(lang: ExampleLang, library: TitleTemplate[]): ExampleTimer[] {
	const ids = new Set(library.map((template) => template.id));
	return GALLERY.filter((example) => ids.has(example.id)).flatMap((example) => example.timers?.(lang) ?? []);
}

/** Examples that came after the library was first seeded, by the schema version that added them. */
export const ADDED_IN: Record<string, number> = { "example-timer": 7, "example-karaoke": 8 };
