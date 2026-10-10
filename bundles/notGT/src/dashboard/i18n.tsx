/**
 * notGT dashboard — languages.
 *
 * English is the source language and lives in the code: `t("Save")`. Every
 * other language is one JSON file in `locales/` that maps those English
 * phrases to its own (`"Save": "Сохранить"`). To add a language, copy
 * `locales/ru.json`, translate the values and list it in `LANGS` and `DICTS`.
 *
 * `Phrase` is the set of keys of the Russian file, so a `t("…")` whose phrase
 * has no translation is a type error: the typecheck is the completeness check.
 */
import { Fragment, useSyncExternalStore, type ReactNode } from "react";

import ru from "./locales/ru.json";

export type Lang = "en" | "ru";

/** A phrase the dashboard shows, written in English. */
export type Phrase = keyof typeof ru;

export const LANGS: Array<{ id: Lang; label: string }> = [
	{ id: "en", label: "English" },
	{ id: "ru", label: "Русский" },
];

const DICTS: Record<Lang, Record<string, string> | null> = {
	en: null,
	ru,
};

const STORAGE_KEY = "notgt.lang";

function isLang(value: unknown): value is Lang {
	return LANGS.some((lang) => lang.id === value);
}

/** `?lang=` (for links and tests), then the saved choice, then the browser. */
function detect(): Lang {
	const fromUrl = new URLSearchParams(window.location.search).get("lang");
	if (isLang(fromUrl)) return fromUrl;
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (isLang(stored)) return stored;
	} catch {
		// No storage (private mode): fall through to the browser language.
	}
	return (window.navigator.language ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

let current: Lang = detect();
const listeners = new Set<() => void>();

function apply(lang: Lang): void {
	current = lang;
	document.documentElement.lang = lang;
	for (const listener of listeners) listener();
}

document.documentElement.lang = current;

// Control, Titles & Outs and Editor are separate frames of one origin. The
// choice is saved in localStorage, and the `storage` event carries it to the
// other frames, so switching in one panel switches all three.
window.addEventListener("storage", (event) => {
	if (event.key === STORAGE_KEY && isLang(event.newValue) && event.newValue !== current) {
		apply(event.newValue);
	}
});

export function getLang(): Lang {
	return current;
}

export function setLang(lang: Lang): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, lang);
	} catch {
		// The choice still holds for this page.
	}
	apply(lang);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * The current language, as state. A panel calls it once at its root: a change
 * re-renders the tree, and every `t()` below picks the new language up.
 */
export function useLang(): Lang {
	return useSyncExternalStore(subscribe, getLang);
}

const SLOT = /\{(\w+)\}/g;

/** Translates a phrase; `{name}` slots are filled from `params`. */
export function t(phrase: Phrase, params?: Record<string, string | number>): string {
	const text = DICTS[current]?.[phrase] ?? phrase;
	if (!params) return text;
	return text.replace(SLOT, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/**
 * `t()` for a sentence with elements inside it: `{name}` slots are filled with
 * React nodes, so a translation is free to move them within the sentence.
 */
export function tr(phrase: Phrase, slots: Record<string, ReactNode>): ReactNode {
	const text = DICTS[current]?.[phrase] ?? phrase;
	return text.split(SLOT).map((part, index) =>
		// `split` with one capture group alternates text and slot names.
		index % 2 === 0 ? part : <Fragment key={index}>{slots[part] ?? `{${part}}`}</Fragment>,
	);
}

/** A number written with a dot, with the decimal mark the language uses. */
export function localNumber(text: string): string {
	return current === "ru" ? text.replace(".", ",") : text;
}

/**
 * Marks a phrase that is stored in a constant and translated where it is
 * shown: `label: N_("Text")` … `t(option.label)`. It returns its argument; it
 * exists so the phrase is type-checked like any other.
 */
export function N_<P extends Phrase>(phrase: P): P {
	return phrase;
}
