/**
 * The document a `kind: "code"` template previews as, shared by the Editor's
 * side card and by the live overlay on the canvas.
 *
 * One place decides which form the animation is in:
 *   - inline HTML/CSS/JS — the usual case, including the built-in examples —
 *     is assembled synchronously with the same runtime the out page uses;
 *   - a file-authored template (`code.src`, animations dropped into
 *     `graphics/animations/`) is fetched and gets that same runtime injected,
 *     so what the dashboard shows is what goes on air.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
	buildCodeDocument,
	buildSourcedDocument,
	codeSource,
} from "../../graphics/code-runtime";
import { materializeSelection } from "../../shared/binding";
import { templateUsesTimers } from "../../shared/timer";
import { CODE_MESSAGES, type TitleData, type TitleTemplate } from "../../shared/types";
import { useLiveData, useSelection } from "../shared";

export function useCodeDocument(
	template: TitleTemplate | undefined,
	data: TitleData,
	/** Bump to rebuild the document from scratch (the "restart" button). */
	restartToken = 0,
): string {
	const [doc, setDoc] = useState("");
	const selection = useSelection();

	useEffect(() => {
		if (!template) {
			setDoc("");
			return;
		}
		let cancelled = false;
		const src = template.code?.src;
		// A list shows its selected element, as on the out.
		const shown = materializeSelection(data, selection) as TitleData;
		const inline = () => {
			if (!cancelled) setDoc(buildCodeDocument(template, shown));
		};

		if (codeSource(template) === "file" && src) {
			buildSourcedDocument(src, shown)
				.then((text) => {
					if (!cancelled) setDoc(text);
				})
				.catch(inline);
		} else {
			inline();
		}

		return () => {
			cancelled = true;
		};
		// `template` is compared by identity: the editor rebuilds it on every edit.
	}, [template, data, selection, restartToken]);

	return doc;
}

/**
 * Keeps the timers of a code preview ticking. The document is built without
 * them — a document that changed every second would restart the animation
 * every second — and the variables, timers in them, are posted into the
 * frame as the out page does: once it has loaded (the returned callback is
 * its `onLoad`) and whenever what a timer shows changes. Only for an
 * animation that reads a timer.
 */
export function useTimerFeed(
	frame: RefObject<HTMLIFrameElement | null>,
	template: TitleTemplate | undefined,
	data: TitleData,
): () => void {
	const uses = Boolean(template && templateUsesTimers(template));
	const live = useLiveData(data, uses);
	const selection = useSelection();
	const latest = useRef(live);
	latest.current = live;
	const selected = useRef(selection);
	selected.current = selection;
	const post = useCallback(() => {
		if (!uses) return;
		// A plain copy, each list down to its selected element as on the out:
		// the variables are the Replicant's own proxies, which `postMessage`
		// cannot clone.
		const data = materializeSelection(latest.current, selected.current) as TitleData;
		frame.current?.contentWindow?.postMessage({ type: CODE_MESSAGES.data, data }, "*");
	}, [frame, uses]);
	useEffect(post, [live, post]);
	return post;
}
