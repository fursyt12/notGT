import type { ServerAPI, Store } from "./store";

interface Timers {
	interval?: ReturnType<typeof setInterval>;
	hold?: ReturnType<typeof setTimeout>;
}

/**
 * Owns every playback timer.
 *
 * The extension — not the browser source — decides what is on screen, so that
 * `GET /api/state` is authoritative and all outs stay in sync. Graphics pages
 * only render the derived state they receive through the `runtime` Replicant
 * plus one-shot `trigger` messages (used to restart entrance animations).
 */
export class Scheduler {
	private readonly timers = new Map<string, Timers>();

	constructor(
		private readonly nodecg: ServerAPI,
		private readonly store: Store,
	) {
		store.outs.on("change", () => this.sync());
		store.templates.on("change", () => this.sync());
		this.sync();
	}

	/** Reconciles running timers with the current `outs` configuration. */
	sync(): void {
		const desired = new Set<string>();

		for (const out of this.store.listOuts()) {
			for (const item of out.items) {
				const template = this.store.getTemplate(item.templateId);
				if (!template) continue;
				const key = this.key(out.id, item.id);

				// "Show it and keep it": the operator toggled this placement on,
				// so it stays on air regardless of once/loop and of `enabled`.
				if (item.held) {
					desired.add(key);
					this.hold(out.id, item.id);
					continue;
				}

				if (!item.enabled) continue;
				const playback = item.playback ?? template.playback;
				if (playback.mode !== "loop" || !playback.autoStart) continue;

				desired.add(key);
				if (!this.timers.has(key)) this.startLoop(out.id, item.id);
			}
		}

		for (const key of [...this.timers.keys()]) {
			if (!desired.has(key)) this.stop(key);
		}
	}

	/** Plays a single animation once, holding for `holdMs`. */
	trigger(outId: string, itemId: string, holdMs?: number): boolean {
		const found = this.store.getItem(outId, itemId);
		if (!found) return false;
		const duration = clampDuration(holdMs ?? found.item.playback.holdMs ?? 4000);
		this.play(outId, itemId, duration);
		return true;
	}

	/**
	 * Plays whichever animation on `outId` references `templateId`.
	 * Returns the number of animations that were triggered.
	 */
	triggerTemplate(templateId: string, outId?: string | null, holdMs?: number): number {
		let count = 0;
		for (const out of this.store.listOuts()) {
			if (outId && out.id !== outId) continue;
			for (const item of out.items) {
				if (item.templateId !== templateId || !item.enabled) continue;
				this.trigger(out.id, item.id, holdMs);
				count++;
			}
		}
		return count;
	}

	/** Stops every animation on an out (or all outs). */
	stopOut(outId?: string | null): void {
		for (const out of this.store.listOuts()) {
			if (outId && out.id !== outId) continue;
			for (const item of out.items) {
				this.store.removePlaying(out.id, item.id);
			}
		}
	}

	dispose(): void {
		for (const key of [...this.timers.keys()]) this.stop(key);
	}

	private key(outId: string, itemId: string): string {
		return `${outId}::${itemId}`;
	}

	private startLoop(outId: string, itemId: string): void {
		const key = this.key(outId, itemId);
		const entry: Timers = {};
		this.timers.set(key, entry);

		const tick = (): void => {
			const found = this.store.getItem(outId, itemId);
			if (!found) {
				this.stop(key);
				return;
			}
			const playback = found.item.playback;
			this.play(outId, itemId, clampDuration(playback.holdMs));
		};

		tick();
		const found = this.store.getItem(outId, itemId);
		const interval = clampInterval(found?.item.playback.intervalMs ?? 10_000);
		entry.interval = setInterval(tick, interval);
	}

	/**
	 * Puts a placement on air and leaves it there: no hold timer, no interval.
	 * Used for `held` placements, the operator's show/keep toggle.
	 */
	private hold(outId: string, itemId: string): void {
		const key = this.key(outId, itemId);
		const entry = this.timers.get(key) ?? {};
		if (entry.interval) {
			clearInterval(entry.interval);
			entry.interval = undefined;
		}
		if (entry.hold) {
			clearTimeout(entry.hold);
			entry.hold = undefined;
		}
		this.timers.set(key, entry);

		// Only the first transition onto air replays the entrance animation;
		// staying held must not restart it on every sync().
		if (!this.store.isPlaying(outId, itemId)) {
			this.store.addPlaying(outId, itemId);
			this.store.markTrigger(outId, itemId);
		}
	}

	private play(outId: string, itemId: string, holdMs: number): void {
		this.store.addPlaying(outId, itemId);

		// A held placement never times out.
		if (this.store.getItem(outId, itemId)?.item.held) return;

		// Bump the play counter. Graphics watch it and (re)start the entrance
		// animation. This deliberately does NOT use a socket message: a
		// `sendMessage` would loop back into this extension's own `listenFor`
		// handler and recurse forever.
		this.store.markTrigger(outId, itemId);

		const key = this.key(outId, itemId);
		const entry = this.timers.get(key) ?? {};
		this.timers.set(key, entry);
		if (entry.hold) clearTimeout(entry.hold);
		entry.hold = setTimeout(() => {
			this.store.removePlaying(outId, itemId);
			entry.hold = undefined;
		}, holdMs);
	}

	private stop(key: string): void {
		const entry = this.timers.get(key);
		if (entry) {
			if (entry.interval) clearInterval(entry.interval);
			if (entry.hold) clearTimeout(entry.hold);
			this.timers.delete(key);
		}

		const [outId, itemId] = key.split("::");
		if (outId && itemId) this.store.removePlaying(outId, itemId);
	}
}

function clampDuration(value: number | undefined): number {
	if (!Number.isFinite(value) || (value as number) < 0) return 4000;
	return Math.min(value as number, 24 * 60 * 60 * 1000);
}

function clampInterval(value: number | undefined): number {
	if (!Number.isFinite(value) || (value as number) < 250) return 250;
	return Math.min(value as number, 24 * 60 * 60 * 1000);
}
