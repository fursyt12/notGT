import type { TitleData } from "../shared/types";
import type { Scheduler } from "./scheduler";
import type { Store } from "./store";

export interface PlayTemplateOptions {
	outId?: string | null;
	holdMs?: number;
	data?: TitleData;
	label?: string;
}

export interface PlayTemplateResult {
	mode: "items" | "manual";
	triggered: number;
	holdMs?: number;
}

/**
 * Plays a template once.
 *
 * If the template is placed on one or more outs, those placements are
 * triggered. If it is not placed anywhere (the common case right after
 * creating an animation in the editor), it falls back to a timed manual show,
 * so "Preview" in the dashboard always does something visible.
 */
export function playTemplateOnce(
	store: Store,
	scheduler: Scheduler,
	templateId: string,
	options: PlayTemplateOptions = {},
): PlayTemplateResult | undefined {
	const template = store.getTemplate(templateId);
	if (!template) return undefined;

	const triggered = scheduler.triggerTemplate(
		templateId,
		options.outId ?? null,
		options.holdMs,
	);
	if (triggered > 0) return { mode: "items", triggered };

	store.show(templateId, {
		outId: options.outId ?? null,
		data: options.data,
		label: options.label,
	});
	const holdMs = Math.max(
		250,
		options.holdMs ?? scheduler.holdForTemplate(templateId),
	);
	const timer = setTimeout(() => {
		// Only hide if nothing else has taken over the program output meanwhile.
		if (store.activeTitle.value?.templateId === templateId) {
			store.hide({ templateId });
		}
	}, holdMs);
	timer.unref?.();

	return { mode: "manual", triggered: 0, holdMs };
}
