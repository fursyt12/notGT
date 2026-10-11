/**
 * notGT dashboard — the colour theme.
 *
 * Both themes come from the brandbook (media/brand): dark has Studio as the
 * ground and Cream as the type, light is the other way round. Their colours
 * are the tokens in `dashboard/ui.css`; this module only decides which theme
 * applies and puts it on `<html data-theme>`.
 */
import { useSyncExternalStore } from "react";

import { N_, type Phrase } from "./i18n";

export type Theme = "dark" | "light";
/** What the operator picked; "system" follows the OS setting. */
export type ThemeChoice = Theme | "system";

export const THEMES: Array<{ id: ThemeChoice; label: Phrase }> = [
	{ id: "dark", label: N_("Dark") },
	{ id: "light", label: N_("Light") },
	{ id: "system", label: N_("As in the system") },
];

const STORAGE_KEY = "notgt.theme";

function isChoice(value: unknown): value is ThemeChoice {
	return THEMES.some((theme) => theme.id === value);
}

/** `?theme=` (for links and tests), then the saved choice, then dark. */
function detect(): ThemeChoice {
	const fromUrl = new URLSearchParams(window.location.search).get("theme");
	if (isChoice(fromUrl)) return fromUrl;
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (isChoice(stored)) return stored;
	} catch {
		// No storage (private mode): fall through to the default.
	}
	return "dark";
}

const systemLight = window.matchMedia("(prefers-color-scheme: light)");

let current: ThemeChoice = detect();
const listeners = new Set<() => void>();

export function getTheme(): Theme {
	if (current === "system") return systemLight.matches ? "light" : "dark";
	return current;
}

function paint(): void {
	document.documentElement.dataset.theme = getTheme();
	for (const listener of listeners) listener();
}

paint();

// The panels are separate frames of one origin, inside the shell, which is one
// more. The choice is saved in localStorage, and the `storage` event carries it
// to the others, so switching in one panel switches everything.
window.addEventListener("storage", (event) => {
	if (event.key === STORAGE_KEY && isChoice(event.newValue) && event.newValue !== current) {
		current = event.newValue;
		paint();
	}
});

systemLight.addEventListener("change", () => {
	if (current === "system") paint();
});

export function getThemeChoice(): ThemeChoice {
	return current;
}

export function setThemeChoice(choice: ThemeChoice): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, choice);
	} catch {
		// The choice still holds for this page.
	}
	current = choice;
	paint();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The operator's choice, as state. */
export function useThemeChoice(): ThemeChoice {
	return useSyncExternalStore(subscribe, getThemeChoice);
}

/** The theme on screen, as state. */
export function useTheme(): Theme {
	return useSyncExternalStore(subscribe, getTheme);
}
