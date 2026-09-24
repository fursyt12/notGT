import type NodeCGTypes from "nodecg/types";

/**
 * Thin, dependency-free helpers around the NodeCG browser API that
 * `/api.js` installs as `globalThis.nodecg`.
 */
export type ClientReplicant<T> = NodeCGTypes.ClientReplicant<T>;

export function getNodecg(): NodeCGTypes.ClientAPI {
	const api = (globalThis as unknown as { nodecg?: NodeCGTypes.ClientAPI }).nodecg;
	if (!api) {
		throw new Error(
			"NodeCG API is not available. This page must be loaded through NodeCG.",
		);
	}
	return api;
}

/** Resolves as soon as the Replicant has received its value from the server. */
export function whenReady(rep: { status?: string; once(ev: string, cb: () => void): void }): Promise<void> {
	if (rep.status === "declared") return Promise.resolve();
	return new Promise((resolve) => {
		rep.once("change", () => resolve());
	});
}

export async function waitForReplicants(
	...reps: Array<{ status?: string; once(ev: string, cb: () => void): void }>
): Promise<void> {
	await Promise.all(reps.map((rep) => whenReady(rep)));
}
