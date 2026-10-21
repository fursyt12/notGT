/**
 * notGT dashboard — the show as one file.
 *
 * “Save project” gives a `.ngt` file with every animation, out and variable,
 * and the media the animations use; “Open project…” sends one to the server,
 * where it takes the place of all of that (`src/extension/project.ts`).
 */
import { useRef, useState, type ReactNode } from "react";

import { BUNDLE_NAME } from "../shared/types";
import { t } from "./i18n";
import type { MenuItem } from "./ui";

const PROJECT_BASE = `/bundles/${BUNDLE_NAME}/project`;

interface Failure {
	error?: string;
	message?: string;
}

/** What the server says it did; see `Opened` in `src/extension/project.ts`. */
interface Opened {
	titles: number;
	outs: number;
	variables: number;
	media: { added: number; reused: number; renamed: Array<[string, string]> };
	kept: string[];
}

export interface ProjectNote {
	text: string;
	error: boolean;
}

/** What the server refused with, in the operator's words. */
function explain(failure: Failure): string {
	switch (failure.error) {
		case "not_ngt":
			return t("This is not a notGT project file.");
		case "newer":
			return t("The project was saved by a newer notGT. Update notGT to open it.");
		case "damaged":
		case "truncated":
			return t("The project file is damaged and cannot be opened.");
		case "too_large":
			return t("The project file is larger than 16 GB.");
		case "forbidden":
			return t("Only an administrator saves and opens projects.");
		default:
			return t("Could not open the project: {error}", {
				error: failure.message ?? failure.error ?? "?",
			});
	}
}

function notSaved(error: string): string {
	return t("Could not save the project: {error}", { error });
}

/** `notGT-2026-10-21-1530.ngt`, in the operator's own time. */
function suggestedName(date = new Date()): string {
	const two = (n: number): string => String(n).padStart(2, "0");
	return `notGT-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}.ngt`;
}

interface SaveFilePicker {
	(options: {
		suggestedName: string;
		types: Array<{ description: string; accept: Record<string, string[]> }>;
	}): Promise<{ name: string; createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

/**
 * Where the browser can ask where to save (Chromium, on localhost or HTTPS),
 * the file is streamed straight there; anywhere else it is downloaded.
 */
async function saveProject(): Promise<ProjectNote | null> {
	const name = suggestedName();
	const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
	if (typeof picker === "function") {
		let handle: Awaited<ReturnType<SaveFilePicker>> | null = null;
		try {
			handle = await picker({
				suggestedName: name,
				types: [{ description: t("notGT project"), accept: { "application/x-notgt": [".ngt"] } }],
			});
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") return null;
			// Not allowed here: the download below still works.
		}
		if (handle) {
			const response = await fetch(`${PROJECT_BASE}/save`);
			if (!response.ok || !response.body) {
				const body = (await response.json().catch(() => ({}))) as Failure;
				if (body.error === "forbidden") return { error: true, text: explain(body) };
				return { error: true, text: notSaved(body.message ?? `HTTP ${response.status}`) };
			}
			await response.body.pipeTo(await handle.createWritable());
			return { error: false, text: t("Saved: {name}", { name: handle.name }) };
		}
	}
	const link = document.createElement("a");
	link.href = `${PROJECT_BASE}/save?name=${encodeURIComponent(name)}`;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	return { error: false, text: t("The project is being downloaded: {name}", { name }) };
}

async function openProject(file: File): Promise<ProjectNote | null> {
	if (!/\.ngt$/i.test(file.name)) return { error: true, text: explain({ error: "not_ngt" }) };
	const go = window.confirm(
		t(
			"Open “{name}”? It replaces every animation, out and variable here and takes everything off air.",
			{ name: file.name },
		),
	);
	if (!go) return null;
	const response = await fetch(`${PROJECT_BASE}/open`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: file,
	});
	const body = (await response.json().catch(() => ({}))) as Failure & Partial<Opened>;
	if (!response.ok) return { error: true, text: explain(body) };
	const opened = body as Opened;
	const parts = [
		t("Opened {name}: animations {titles}, outs {outs}, variables {variables}.", {
			name: file.name,
			titles: opened.titles,
			outs: opened.outs,
			variables: opened.variables,
		}),
	];
	if (opened.media.renamed.length > 0) {
		parts.push(
			t("Media files with names already taken here were saved as: {list}.", {
				list: opened.media.renamed.map(([from, to]) => `${from} → ${to}`).join(", "),
			}),
		);
	}
	if (opened.kept.length > 0) {
		parts.push(
			t("These lists follow a connected workbook and were kept: {list}.", { list: opened.kept.join(", ") }),
		);
	}
	return { error: false, text: parts.join(" ") };
}

/**
 * The project menu of a panel: its items, the hidden file input they open,
 * and the note about how the last save or open went.
 */
export function useProjectFile(): {
	items: MenuItem[];
	input: ReactNode;
	busy: boolean;
	note: ProjectNote | null;
} {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<ProjectNote | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);

	// Called straight from the click, so the browser lets the save dialog open.
	const run = (job: () => Promise<ProjectNote | null>, failed: (error: string) => string): void => {
		setBusy(true);
		setNote(null);
		job()
			.then(setNote, (error: unknown) =>
				setNote({ error: true, text: failed(String((error as Error)?.message ?? error)) }),
			)
			.finally(() => setBusy(false));
	};

	const items: MenuItem[] = [
		{
			label: t("Save project"),
			hint: t("Animations, outs, variables and their media in one .ngt file"),
			icon: "download",
			disabled: busy,
			onSelect: () => run(saveProject, notSaved),
		},
		{
			label: t("Open project…"),
			hint: t("Replaces every animation, out and variable here"),
			icon: "upload",
			disabled: busy,
			onSelect: () => fileRef.current?.click(),
		},
	];

	const input = (
		<input
			ref={fileRef}
			type="file"
			accept=".ngt"
			hidden
			data-project-file
			onChange={(event) => {
				const file = event.target.files?.[0];
				event.target.value = "";
				if (file) run(() => openProject(file), (error) => explain({ message: error }));
			}}
		/>
	);

	return { items, input, busy, note };
}
