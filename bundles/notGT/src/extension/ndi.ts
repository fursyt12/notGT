import fs from "node:fs";
import path from "node:path";

import {
	NDI_SENDER_TTL_MS,
	type NdiOutConfig,
	type NdiOutStatus,
	type NdiSenderStatus,
	type NdiState,
	type NdiStatus,
	ndiAlpha,
	ndiFps,
	ndiSize,
	ndiSourceName,
} from "../shared/ndi";
import { BUNDLE_NAME, REPLICANTS } from "../shared/types";
import type { ServerAPI, Store } from "./store";

/**
 * The server's side of the NDI outputs: which outs the senders should send,
 * and what they say back. A sender asks every couple of seconds; one that
 * stops asking is dropped from the status after `NDI_SENDER_TTL_MS`.
 */
export interface NdiHub {
	/** `GET /api/ndi`: the outs with NDI switched on. */
	list(): { outs: NdiOutConfig[] };
	/** `POST /api/ndi/status`. Returns an error message when the report is not one. */
	report(body: unknown): string | undefined;
	dispose(): void;
}

const STATES: NdiState[] = ["loading", "idle", "sending", "error"];
const MAX_SENDERS = 32;
const MAX_OUTS = 64;

const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown): number => {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? Math.min(number, 1e6) : 0;
};

function outStatus(value: unknown): NdiOutStatus | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const input = value as Record<string, unknown>;
	const id = text(input["id"], 120);
	if (!id) return undefined;
	const state = STATES.includes(input["state"] as NdiState) ? (input["state"] as NdiState) : "error";
	const error = text(input["error"], 300);
	return {
		id,
		ndiName: text(input["ndiName"], 120),
		state,
		connections: Math.round(count(input["connections"])),
		fps: Math.round(count(input["fps"]) * 10) / 10,
		width: Math.round(count(input["width"])),
		height: Math.round(count(input["height"])),
		...(error ? { error } : {}),
	};
}

/**
 * Keeps the key a sender needs in a file, for a sender started next to the
 * server that shares the folder — the `ndi` service of docker-compose.yml —
 * so that it finds its way in with nothing copied by hand. Rewritten when the
 * key changes; an empty file means the API asks for no key.
 */
export function keepNdiKeyFile(
	nodecg: ServerAPI,
	file: string,
	key: () => string | undefined,
	onChange: (listener: () => void) => void,
): void {
	let written: string | undefined;
	const write = (): void => {
		let value: string;
		try {
			value = key() ?? "";
		} catch {
			return;
		}
		if (value === written) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
			fs.renameSync(tmp, file);
			if (written === undefined) nodecg.log.info("The NDI senders' key is kept in %s", file);
			written = value;
		} catch (error) {
			nodecg.log.error("The NDI senders' key could not be written to %s: %s", file, (error as Error).message);
		}
	};
	write();
	onChange(write);
}

export function createNdiHub(nodecg: ServerAPI, store: Store): NdiHub {
	const status = nodecg.Replicant<NdiStatus>(REPLICANTS.ndi, BUNDLE_NAME, {
		defaultValue: {},
		persistent: false,
	});
	status.value = {};

	const prune = setInterval(() => {
		const now = Date.now();
		const current = status.value ?? {};
		const fresh = Object.fromEntries(
			Object.entries(current).filter(([, sender]) => now - sender.seenAt < NDI_SENDER_TTL_MS),
		);
		if (Object.keys(fresh).length !== Object.keys(current).length) status.value = fresh;
	}, 2000);

	return {
		list() {
			return {
				outs: store
					.listOuts()
					.filter((out) => out.ndi?.enabled)
					.map((out) => ({
						id: out.id,
						name: out.name,
						ndiName: ndiSourceName(out),
						url: store.outUrl(out.id),
						designWidth: out.width,
						designHeight: out.height,
						...ndiSize(out),
						fps: ndiFps(out),
						alpha: ndiAlpha(out),
						...(out.ndi?.groups ? { groups: out.ndi.groups } : {}),
					})),
			};
		},

		report(body) {
			if (typeof body !== "object" || body === null) return "The report is not a JSON object";
			const input = body as Record<string, unknown>;
			const id = text(input["id"], 120);
			if (!id) return "`id` names the sender";
			const current = status.value ?? {};
			if (!current[id] && Object.keys(current).length >= MAX_SENDERS) return "Too many senders";
			const outs = Array.isArray(input["outs"])
				? input["outs"].slice(0, MAX_OUTS).map(outStatus).filter((out): out is NdiOutStatus => Boolean(out))
				: [];
			const sender: NdiSenderStatus = {
				id,
				host: text(input["host"], 120) || id,
				platform: text(input["platform"], 40),
				version: text(input["version"], 40),
				ndi: text(input["ndi"], 120),
				seenAt: Date.now(),
				outs,
			};
			status.value = { ...current, [id]: sender };
			return undefined;
		},

		dispose() {
			clearInterval(prune);
		},
	};
}
