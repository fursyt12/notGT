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
import { GALLERY, type ExampleLang } from "./examples/gallery";
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

/** Read by the file animation that ships in `graphics/animations/`. */
function sponsor(lang: ExampleLang): TitleData {
	return {
		sponsor:
			lang === "ru"
				? { label: "Партнёр", name: "ACME", meta: "Официальный партнёр трансляции", accent: "#ff3b30" }
				: { label: "Partner", name: "ACME", meta: "Official broadcast partner", accent: "#ff3b30" },
	};
}

/**
 * `base` with a sample value for every variable the examples read that it does
 * not have yet. Existing values always win: the operator's data is never
 * replaced.
 */
export function seedVariables(lang: ExampleLang, base: TitleData = {}): TitleData {
	const next = clone(base);
	const samples = [...GALLERY.map((example) => example.data?.(lang) ?? {}), sponsor(lang)];
	for (const sample of samples) {
		for (const row of flattenData(sample)) {
			if (getByPathRaw(next, row.path) === undefined) setByPath(next, row.path, row.value);
		}
	}
	return next;
}
