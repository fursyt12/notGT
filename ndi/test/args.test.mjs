import assert from "node:assert/strict";
import { test } from "node:test";
import { electronArgs, looksLikeUrl, windowsAccepts } from "../src/args.mjs";

const APP = "C:\\Users\\someone\\notGT\\ndi";

/** main.mjs's reading of its arguments, as it is there. */
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
		const next = argv[i + 1];
		if (inline !== undefined) args[key] = inline;
		else if (next !== undefined && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else args[key] = true;
	}
	return args;
}

test("what looks like a URL to Electron", () => {
	for (const arg of ["http://127.0.0.1:9090", "about:blank", "file:///x", "notgt:x"])
		assert.ok(looksLikeUrl(arg), arg);
	for (const arg of [APP, "C:", "auto", "cpu", "1920x1080", "--server=http://x", "-x", "a b:c"])
		assert.ok(!looksLikeUrl(arg), arg);
});

test("0.14.0's command line is one Electron on Windows refuses", () => {
	assert.equal(
		windowsAccepts([APP, "--server", "http://127.0.0.1:9090", "--render", "auto"]),
		false,
	);
	assert.equal(
		windowsAccepts([APP, "--url", "about:blank", "--render", "cpu"]),
		false,
	);
});

test("every command line the sender is started with is one Electron takes", () => {
	const lines = [
		// The launcher, the benchmark, by hand.
		["--server", "http://127.0.0.1:9090", "--render", "auto"],
		["--server", "http://127.0.0.1:52011", "--id", "bench", "--poll", "1000", "--render", "gpu"],
		["--url", "about:blank", "--render", "cpu", "--enable-logging=stderr", "--v=0"],
		["--url", "https://example.com/out.html?out=a", "--name", "Lower third", "--opaque", "--render", "auto"],
		["--server=http://10.0.0.2:9090", "--token", "abc:def", "--render", "auto"],
	];
	for (const user of lines) {
		const command = [APP, ...electronArgs(user)];
		assert.ok(windowsAccepts(command), command.join(" "));
	}
});

test("main.mjs reads the joined arguments as it read the original", () => {
	const lines = [
		["--server", "http://127.0.0.1:9090", "--render", "auto"],
		["--url", "about:blank", "--size", "1280x720", "--opaque", "--fps", "50", "--render", "cpu"],
		["--gpu", "--groups", "Studio A", "--scale", "0.5"],
		["--token=x", "--render", "auto", "--no-sandbox"],
	];
	for (const user of lines)
		assert.deepEqual(parseArgs(electronArgs(user)), parseArgs(user), user.join(" "));
});

test("arguments that are not switches go last, and -- keeps what follows", () => {
	assert.deepEqual(electronArgs(["--opaque", "--x", "1", "--", "--y", "z"]), [
		"--opaque",
		"--x=1",
		"--",
		"--y",
		"z",
	]);
});
