// Stands in for an Electron worker (main.mjs --worker) in test/workers.test.mjs:
// FAKE=ok reports a status, FAKE=crash ends with code 1 after a line,
// FAKE=gpu ends with EXIT_USE_CPU unless told to draw on the CPU.
const render = process.argv[2];
const mode = process.env.FAKE;
console.log(`[notgt-ndi] fake worker drawing on ${render}`);
if (mode === "crash") {
	console.log("[notgt-ndi] the page could not be drawn");
	process.exit(1);
}
if (mode === "gpu" && render !== "cpu") process.exit(75);
const report = () =>
	process.send({ type: "status", out: { id: "a", ndiName: "A", state: "sending", connections: 1, fps: 60, render }, ndi: "6.3" });
report();
const timer = setInterval(report, 50);
process.on("message", (m) => {
	if (m?.type === "stop") {
		clearInterval(timer);
		process.exit(0);
	}
});
