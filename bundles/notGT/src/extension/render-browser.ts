import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RENDER_CLOCK_SOURCE } from "./render-clock";

/**
 * The headless browser a render draws its frames in: a Chromium, Chrome or
 * Edge that is already on the machine, driven over the DevTools protocol with
 * Node's own WebSocket — no Puppeteer, nothing downloaded.
 *
 * `NOTGT_BROWSER` names one explicitly. Otherwise the usual places are tried:
 * Edge comes with every Windows 10 and 11, the Docker image carries Chromium.
 */
function candidates(): string[] {
	const named = process.env["NOTGT_BROWSER"]?.trim();
	const list: string[] = named ? [named] : [];
	if (process.platform === "win32") {
		const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]];
		for (const root of roots) {
			if (!root) continue;
			list.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
			list.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
			list.push(path.join(root, "Chromium", "Application", "chrome.exe"));
		}
	} else if (process.platform === "darwin") {
		for (const app of ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"]) {
			for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
				list.push(path.join(root, `${app}.app`, "Contents", "MacOS", app));
			}
		}
	} else {
		const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
		for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"]) {
			for (const dir of dirs) list.push(path.join(dir, name));
		}
	}
	return list;
}

/** The browsers a render can use, the first one first. */
export function findBrowsers(): string[] {
	const found: string[] = [];
	for (const candidate of candidates()) {
		try {
			if (fs.statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate);
		} catch {
			// Not there; the next one.
		}
	}
	return found;
}

type Handler = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

/** A DevTools protocol connection: commands, their answers and events. */
class Cdp {
	private next = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly handlers = new Set<Handler>();
	private failure: Error | null = null;

	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => this.receive(String(event.data)));
		socket.addEventListener("close", () => this.fail(new Error("the browser closed the connection")));
	}

	static connect(url: string): Promise<Cdp> {
		if (typeof WebSocket === "undefined") {
			return Promise.reject(new Error(`rendering needs Node 22 or newer (this is ${process.version})`));
		}
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
			socket.addEventListener("error", () => reject(new Error(`cannot connect to the browser at ${url}`)), {
				once: true,
			});
		});
	}

	send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	on(handler: Handler): void {
		this.handlers.add(handler);
	}

	close(): void {
		this.socket.close();
	}

	private receive(text: string): void {
		const message = JSON.parse(text) as {
			id?: number;
			result?: unknown;
			error?: { message: string };
			method?: string;
			params?: Record<string, unknown>;
			sessionId?: string;
		};
		if (message.id !== undefined) {
			const waiting = this.pending.get(message.id);
			if (!waiting) return;
			this.pending.delete(message.id);
			if (message.error) waiting.reject(new Error(message.error.message));
			else waiting.resolve(message.result);
			return;
		}
		if (message.method) {
			for (const handler of this.handlers) handler(message.method, message.params ?? {}, message.sessionId);
		}
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const waiting of this.pending.values()) waiting.reject(error);
		this.pending.clear();
	}
}

/** One tab of the headless browser, sized like the animation. */
export class RenderPage {
	/** The first errors the page reported, for a failed render's message. */
	readonly errors: string[] = [];

	constructor(
		private readonly cdp: Cdp,
		private readonly sessionId: string,
	) {
		cdp.on((method, params, sessionId) => {
			if (sessionId !== this.sessionId || this.errors.length >= 5) return;
			if (method === "Runtime.exceptionThrown") {
				const details = params["exceptionDetails"] as { text?: string; exception?: { description?: string } };
				this.errors.push(details.exception?.description ?? details.text ?? "exception");
			} else if (method === "Runtime.consoleAPICalled" && params["type"] === "error") {
				const args = (params["args"] as Array<{ value?: unknown; description?: string }>) ?? [];
				this.errors.push(args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" "));
			} else if (method === "Inspector.targetCrashed") {
				this.errors.push("the page crashed");
			}
		});
	}

	call<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
		return this.cdp.send<T>(method, params, this.sessionId);
	}

	/** Runs an expression in the page and returns its value. */
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call<{
			result: { value?: T };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		}>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new Error(details.exception?.description ?? details.text ?? "the page threw");
		}
		return result.result.value as T;
	}

	/** Waits, in real time, until `expression` is true in the page. */
	async waitFor(expression: string, timeoutMs: number, what: string): Promise<void> {
		const until = Date.now() + timeoutMs;
		while (Date.now() < until) {
			if (await this.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const errors = this.errors.length ? `: ${this.errors[0]}` : "";
		throw new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)} s${errors}`);
	}

	/** The page as it is drawn now, with its transparency, as a PNG. */
	async capture(): Promise<Buffer> {
		const { data } = await this.call<{ data: string }>("Page.captureScreenshot", {
			format: "png",
			optimizeForSpeed: true,
			fromSurface: true,
			captureBeyondViewport: false,
		});
		return Buffer.from(data, "base64");
	}
}

export class RenderBrowser {
	private constructor(
		private readonly child: ChildProcess,
		private readonly cdp: Cdp,
		private readonly profile: string,
	) {}

	static async launch(executable: string): Promise<RenderBrowser> {
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-render-"));
		const args = [
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--disable-sync",
			"--hide-scrollbars",
			"--mute-audio",
			"--force-color-profile=srgb",
			"--autoplay-policy=no-user-gesture-required",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			// Animations on the main thread only, so a stepped animation is drawn
			// where it was stepped to and not where the compositor's clock is.
			"--disable-threaded-animation",
			"--disable-threaded-scrolling",
			"--disable-checker-imaging",
			"--disable-dev-shm-usage",
			"--ignore-certificate-errors",
			// Its own log on stderr: on Windows the only word on why it would not start.
			"--enable-logging=stderr",
		];
		// Chromium will not sandbox itself as root, which a Docker container is;
		// unsandboxed it needs no zygote processes either. (Its crash reporter
		// still outlives it: the image's tini reaps that, see the Dockerfile.)
		if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox", "--no-zygote");
		// Last: a switch after an address-like argument is not read on Windows.
		args.push("about:blank");

		const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		try {
			const url = await devToolsUrl(child, profile, () => stderr);
			const cdp = await Cdp.connect(url);
			return new RenderBrowser(child, cdp, profile);
		} catch (error) {
			child.kill("SIGKILL");
			removeProfile(profile);
			throw error;
		}
	}

	/** The first of `executables` that starts; what the others said when none does. */
	static async launchFirst(executables: string[]): Promise<RenderBrowser> {
		const reasons: string[] = [];
		for (const executable of executables) {
			try {
				return await RenderBrowser.launch(executable);
			} catch (error) {
				reasons.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(reasons.length ? reasons.join("; ") : "no browser to start");
	}

	async newPage(width: number, height: number): Promise<RenderPage> {
		const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		const page = new RenderPage(this.cdp, sessionId);
		await page.call("Page.enable");
		await page.call("Runtime.enable");
		await page.call("Inspector.enable").catch(() => {});
		await page.call("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false,
			screenWidth: width,
			screenHeight: height,
		});
		await page.call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
		await page.call("Page.addScriptToEvaluateOnNewDocument", { source: RENDER_CLOCK_SOURCE });
		return page;
	}

	async close(): Promise<void> {
		const exited = new Promise<void>((resolve) => {
			if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
			else this.child.once("exit", () => resolve());
		});
		await this.cdp.send("Browser.close").catch(() => {});
		this.cdp.close();
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(timer);
		removeProfile(this.profile);
	}
}

/**
 * Where the browser's DevTools listen: printed on stderr by Chromium, written
 * to `DevToolsActivePort` in the profile by every Chromium-based browser (Edge
 * on Windows prints nothing a parent can read).
 *
 * The process started may end with code 0 while the browser goes on in a
 * process of its own — Chrome and Edge on Windows hand over like that, to an
 * update that is waiting or from a launcher. The port still turns up in the
 * profile, so a quiet exit is waited past for a while before it counts.
 */
function devToolsUrl(child: ChildProcess, profile: string, stderr: () => string): Promise<string> {
	return new Promise((resolve, reject) => {
		let until = Date.now() + 30_000;
		let quit: number | null | undefined;
		const why = () => {
			const lines = stderr()
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			return lines.length ? `: ${lines.slice(-3).join(" | ")}` : "";
		};
		const exit = (code: number | null) => {
			quit = code;
			if (code === 0) until = Math.min(until, Date.now() + 15_000);
		};
		const timer = setInterval(() => {
			const printed = /DevTools listening on (ws:\/\/\S+)/.exec(stderr());
			if (printed) {
				finish();
				resolve(printed[1]!);
				return;
			}
			try {
				const [port, target] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
				if (port && target) {
					finish();
					resolve(`ws://127.0.0.1:${port.trim()}${target.trim()}`);
					return;
				}
			} catch {
				// Not written yet.
			}
			if (quit !== undefined && quit !== 0) {
				finish();
				reject(new Error(`the browser quit at start (code ${quit})${why()}`));
				return;
			}
			if (Date.now() > until) {
				finish();
				if (quit === undefined) child.kill("SIGKILL");
				reject(
					new Error(
						quit === 0
							? `the browser quit at start (code 0) and did not come back in a process of its own${why()}`
							: `the browser did not start within 30 s${why()}`,
					),
				);
			}
		}, 100);
		const finish = () => {
			clearInterval(timer);
			child.off("exit", exit);
		};
		child.on("exit", exit);
	});
}

function removeProfile(profile: string): void {
	try {
		fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		// A profile left in the temp folder is harmless.
	}
}
