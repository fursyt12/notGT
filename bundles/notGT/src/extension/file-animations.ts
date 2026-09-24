import fs from "node:fs";
import path from "node:path";

import {
	BUNDLE_NAME,
	type TitleTemplate,
	defaultPlayback,
	defaultTransition,
	slugify,
} from "../shared/types";
import type { Store } from "./store";

const ANIMATIONS_SUBDIR = path.join("graphics", "animations");

function extractName(html: string, fallback: string): string {
	const meta = html.match(
		/<meta[^>]+name=["']notgt:name["'][^>]+content=["']([^"']+)["']/i,
	);
	if (meta?.[1]) return meta[1].trim();
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (title?.[1] && title[1].trim()) return title[1].trim();
	return fallback;
}

/**
 * Registers every `*.html` in `graphics/animations/` as a `kind: "code"`
 * template that points at the file (`code.src`), so an operator can author an
 * animation as a file instead of through the dashboard editor.
 *
 * Existing templates are left alone apart from their file reference; a template
 * whose inline HTML has been filled in through the GUI keeps working, because
 * the graphics runtime prefers inline code over `src` (fork-on-edit).
 */
export function syncFileAnimations(
	store: Store,
	extensionDir: string,
): { added: number; total: number } {
	const dir = path.resolve(extensionDir, "..", ANIMATIONS_SUBDIR);
	let added = 0;
	let total = 0;

	let files: string[] = [];
	try {
		if (!fs.existsSync(dir)) return { added, total };
		files = fs
			.readdirSync(dir)
			.filter((file) => file.toLowerCase().endsWith(".html"))
			.sort();
	} catch (error) {
		store.nodecg.log.warn("Could not scan %s: %s", dir, String(error));
		return { added, total };
	}

	for (const file of files) {
		total++;
		let content = "";
		try {
			content = fs.readFileSync(path.join(dir, file), "utf8");
		} catch (error) {
			store.nodecg.log.warn("Could not read animation file %s: %s", file, String(error));
			continue;
		}

		const id = `file-${slugify(path.basename(file, path.extname(file)), "animation")}`;
		const src = `/bundles/${BUNDLE_NAME}/graphics/animations/${file}`;
		const name = extractName(content, path.basename(file, ".html"));

		const existing = store.getTemplate(id);
		if (existing) {
			// Refresh only the file reference; never clobber operator edits
			// (playback, transitions, an inline fork).
			if (existing.code?.src !== src) {
				store.upsertTemplate({
					...existing,
					code: {
						html: existing.code?.html ?? "",
						css: existing.code?.css ?? "",
						js: existing.code?.js ?? "",
						src,
					},
				});
			}
			continue;
		}

		const template: TitleTemplate = {
			id,
			name,
			kind: "code",
			width: 1920,
			height: 1080,
			layers: [],
			code: { html: "", css: "", js: "", src },
			inTransition: defaultTransition(),
			outTransition: defaultTransition(),
			playback: {
				...defaultPlayback(),
				mode: "loop",
				intervalMs: 30_000,
				holdMs: 20_000,
				autoStart: false,
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		store.upsertTemplate(template);
		added++;
		store.nodecg.log.info("Registered file animation %s (%s)", name, src);
	}

	return { added, total };
}
