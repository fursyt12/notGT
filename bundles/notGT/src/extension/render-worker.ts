/**
 * Turns a captured frame (PNG) into a DXV3 packet, off the main thread: the
 * server that renders is the one that runs the show, and a frame takes
 * tens to hundreds of milliseconds to encode. Built to
 * `extension/render-worker.js`, started by extension/render.ts.
 */
import { parentPort } from "node:worker_threads";

import { encodeDxvFrame } from "./dxv";
import { decodePng } from "./png";

interface Job {
	id: number;
	png: Uint8Array;
	width: number;
	height: number;
}

parentPort?.on("message", (job: Job) => {
	try {
		const frame = decodePng(job.png);
		if (frame.width !== job.width || frame.height !== job.height) {
			throw new Error(`frame is ${frame.width}×${frame.height}, expected ${job.width}×${job.height}`);
		}
		const packet = encodeDxvFrame(frame);
		parentPort!.postMessage({ id: job.id, packet }, [packet.buffer as ArrayBuffer]);
	} catch (error) {
		parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
	}
});
