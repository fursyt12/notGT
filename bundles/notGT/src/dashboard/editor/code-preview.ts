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
import { useEffect, useState } from "react";

import {
	buildCodeDocument,
	buildSourcedDocument,
	codeSource,
} from "../../graphics/code-runtime";
import type { TitleData, TitleTemplate } from "../../shared/types";

export function useCodeDocument(
	template: TitleTemplate | undefined,
	data: TitleData,
	/** Bump to rebuild the document from scratch (the "restart" button). */
	restartToken = 0,
): string {
	const [doc, setDoc] = useState("");

	useEffect(() => {
		if (!template) {
			setDoc("");
			return;
		}
		let cancelled = false;
		const src = template.code?.src;
		const inline = () => {
			if (!cancelled) setDoc(buildCodeDocument(template, data));
		};

		if (codeSource(template) === "file" && src) {
			buildSourcedDocument(src, data)
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
	}, [template, data, restartToken]);

	return doc;
}
