/**
 * The command line Electron is started with.
 *
 * Electron on Windows refuses a command line in which a switch comes after an
 * argument that looks like a URL — `http://127.0.0.1:9090`, `about:blank` —
 * and exits at once with -1, saying nothing: a guard against links that
 * smuggle switches in (Electron's shell/app/command_line_args.cc, Windows
 * only). `--server http://… --render auto` is such a command line. So every
 * `--name value` goes to Electron as `--name=value`, which is a switch and
 * never looks like a URL, and arguments that are not switches go last.
 *
 * Imported by bin/notgt-ndi.mjs; no Electron here.
 */

/**
 * `argv` with every `--name value` joined into `--name=value`, the switches
 * first. A value is what follows a switch and does not start with `--`, as
 * main.mjs reads it.
 */
export function electronArgs(argv) {
	const switches = [];
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			rest.push(...argv.slice(i));
			break;
		}
		if (arg.startsWith("--") && !arg.includes("=")) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				switches.push(`${arg}=${next}`);
				i++;
				continue;
			}
		}
		if (arg.startsWith("-")) switches.push(arg);
		else rest.push(arg);
	}
	return [...switches, ...rest];
}

/** Electron's own test of an argument: does it start with a URL scheme? */
export function looksLikeUrl(arg) {
	if (!/^[a-z]/i.test(arg)) return false;
	for (let i = 1; i < arg.length; i++) {
		const c = arg[i];
		// A colon right after one letter is a drive: C:\…
		if (c === ":") return i > 1;
		if (/\s/.test(c)) return false;
	}
	return false;
}

/** Whether Electron on Windows takes this command line (its own rule). */
export function windowsAccepts(argv) {
	let afterUrl = false;
	for (const arg of argv) {
		if (arg === "--") return true;
		if (afterUrl) return false;
		if (looksLikeUrl(arg)) afterUrl = true;
	}
	return true;
}
