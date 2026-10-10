import {
	type TitleTemplate,
	defaultPlayback,
	defaultTransition,
} from "../types";
import { clockExample } from "./clock";
import { countdownExample } from "./countdown";
import { externalDataExample } from "./external-data";
import type { ExampleCode } from "./types";

export type { ExampleCode } from "./types";

/** Every built-in example, in the order they appear in the dashboard. */
export const EXAMPLES: ExampleCode[] = [
	countdownExample,
	clockExample,
	externalDataExample,
];

/**
 * Built-in example animations, shipped inside the bundle the same way
 * `Code sample (ticker)` is: a `kind: "code"` template whose HTML/CSS/JS live in
 * the template itself, so the Editor shows the code and can edit it, and the
 * live preview renders it.
 *
 * These three are the source of their gallery entries (`gallery.ts`), which is
 * where they are named and localized.
 */
export function createExampleTemplates(): TitleTemplate[] {
	const now = Date.now();
	return EXAMPLES.map((example) => ({
		id: example.id,
		name: example.name,
		kind: "code",
		width: 1920,
		height: 1080,
		layers: [],
		code: { html: example.html, css: example.css, js: example.js, exitMs: example.exitMs },
		inTransition: defaultTransition(),
		outTransition: { type: "fade", durationMs: 300 },
		playback: { ...defaultPlayback(), mode: "loop", intervalMs: 30_000, holdMs: 20_000, autoStart: false },
		createdAt: now,
		updatedAt: now,
	}));
}
