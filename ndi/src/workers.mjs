/**
 * One out, in an Electron of its own — what bin/notgt-ndi.mjs runs for each
 * out it follows (src/supervisor.mjs).
 *
 * Why a process each: every out in one Electron shares one Chromium GPU
 * process, which turns the drawing of all their pages into GL on one thread.
 * One out of heavy code titles at 1080p60 took a whole core there; four of
 * them in one Electron got 13–20 new frames a second each, on a machine with
 * twelve cores idle. An Electron each gives each out its GPU process — and
 * an out that crashes takes only itself down.
 *
 * The worker is main.mjs with `--worker`: its config on the command line,
 * its status back over IPC every second. Nothing here touches Electron or NDI.
 */

/** main.mjs's EXIT_USE_CPU: the GPU is not worth it here — start again on the CPU. */
export const EXIT_USE_CPU = 75;
/** Waits before starting a worker again that keeps ending. */
const RESTART_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Up this long, a worker has its restart count forgotten. */
const HEALTHY_MS = 60_000;
/** How long a worker has to stop before it is killed. */
const STOP_MS = 5000;

export class WorkerOutput {
	/**
	 * @param {object} o
	 * @param {import("./controller.mjs").OutputConfig} o.config
	 * @param {string} o.render how it draws: "auto", "gpu" or "cpu"
	 * @param {(config: object, render: string) => Promise<import("node:child_process").ChildProcess>} o.spawn
	 *   starts a worker with an IPC channel and piped output
	 * @param {(line: string) => void} o.log
	 * @param {(line: string) => void} [o.output] where the worker's own lines go
	 * @param {number[]} [o.restartMs]
	 */
	constructor({ config, render, spawn, log, output = log, restartMs = RESTART_MS }) {
		this.config = config;
		this.render = render;
		this.spawnWorker = spawn;
		this.log = log;
		this.output = output;
		this.restartMs = restartMs;
		this.child = undefined;
		this.last = undefined;
		this.ndiVersion = "";
		this.error = undefined;
		this.restarts = 0;
		this.stopped = false;
		/** Its last lines, to say why it ended. */
		this.tail = [];
	}

	start() {
		this.launch();
	}

	async launch() {
		if (this.stopped) return;
		let child;
		try {
			child = await this.spawnWorker(this.config, this.render);
		} catch (error) {
			this.ended(`its process could not be started: ${error.message}`);
			return;
		}
		if (this.stopped) {
			child.kill();
			return;
		}
		this.child = child;
		this.startedAt = Date.now();
		child.on("message", (message) => {
			if (message?.type !== "status") return;
			this.last = message.out;
			if (message.ndi) this.ndiVersion = message.ndi;
			this.error = undefined;
		});
		for (const stream of [child.stdout, child.stderr]) {
			if (!stream) continue;
			stream.setEncoding("utf8");
			let partial = "";
			stream.on("data", (chunk) => {
				const lines = (partial + chunk).split(/\r?\n/);
				partial = lines.pop();
				for (const line of lines) {
					if (!line) continue;
					this.tail.push(line);
					if (this.tail.length > 20) this.tail.shift();
					this.output(line);
				}
			});
		}
		child.on("error", (error) => this.log(`“${this.config.ndiName}”: ${error.message}`));
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			if (this.stopped) return;
			if (code === EXIT_USE_CPU && this.render !== "cpu") {
				this.log(`“${this.config.ndiName}”: its GPU is not worth it here; starting it again on the CPU`);
				this.render = "cpu";
				this.launch();
				return;
			}
			const last = this.tail.filter((l) => !/^\s*$/.test(l)).at(-1);
			this.ended(
				`its process ended (${signal ?? `code ${code}`})${last ? `: ${last.replace(/^\[notgt-ndi\]\s*/, "")}` : ""}`,
			);
		});
	}

	/** It ended without being asked: say why, and start it again a little later. */
	ended(why) {
		if (this.startedAt && Date.now() - this.startedAt > HEALTHY_MS) this.restarts = 0;
		const wait = this.restartMs[Math.min(this.restarts, this.restartMs.length - 1)];
		this.restarts++;
		this.error = `${why}; starting it again in ${Math.round(wait / 1000)} s`;
		this.log(`“${this.config.ndiName}”: ${this.error}`);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.launch(), wait);
	}

	status() {
		const base = this.last ?? {
			id: this.config.id,
			...(this.config.kind ? { kind: this.config.kind } : {}),
			ndiName: this.config.ndiName,
			state: "loading",
			connections: 0,
			fps: 0,
			width: this.config.width,
			height: this.config.height,
		};
		if (!this.error) return base;
		return { ...base, state: "error", connections: 0, fps: 0, error: this.error };
	}

	/** Takes the out down; resolves once its process has ended. */
	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		const child = this.child;
		if (!child || child.exitCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				child.send({ type: "stop" });
			} catch {
				child.kill();
			}
		});
	}
}
