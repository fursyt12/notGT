#!/usr/bin/env node
/**
 * notGT end-to-end test of Excel data sources.
 *
 * Load mode needs nothing but a running server: a workbook is built here,
 * posted to the server, edited through the variable store and downloaded back.
 *
 * Track mode needs a directory both this script and the server can write to.
 * Name it with NOTGT_TRACK_DIR (as this script sees it) and, if the server sees
 * it under another path — a Docker volume — NOTGT_TRACK_SERVER_DIR. Without
 * them the track checks are skipped.
 *
 * Usage (server must already be running on 127.0.0.1:9090):
 *   node scripts/e2e-excel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const SOURCES = `${BASE}/bundles/notGT/sources`;
const TRACK_DIR = process.env.NOTGT_TRACK_DIR;
const TRACK_SERVER_DIR = process.env.NOTGT_TRACK_SERVER_DIR ?? TRACK_DIR;

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

async function call(method, url, body, headers) {
	const response = await fetch(url, {
		method,
		headers: headers ?? (body ? { "content-type": "application/json" } : undefined),
		body: body && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, json };
}

const data = async () => (await call("GET", `${BASE}/api/data`)).json.data ?? {};

/** Guests with a styled header, and Scores with a formula column. */
function fixture() {
	const workbook = new ExcelJS.Workbook();
	const guests = workbook.addWorksheet("E2E Guests");
	guests.addRow(["Name", "Role"]);
	guests.addRow(["Anna Reed", "Expert"]);
	guests.addRow(["Peter Holt", "Studio guest"]);
	guests.addRow(["Maria Kim", "Analyst"]);
	guests.getRow(1).font = { bold: true };
	guests.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF5A8C" } };
	guests.getColumn(1).width = 28;

	const scores = workbook.addWorksheet("E2E Scores");
	scores.addRow(["Team", "First", "Second", "Total"]);
	scores.addRow(["North", 2, 1, { formula: "B2+C2", result: 3 }]);
	scores.addRow(["South", 0, 1, { formula: "B3+C3", result: 1 }]);

	// A sheet with nothing in it is not a table.
	workbook.addWorksheet("Empty");
	return workbook;
}

async function bytes(workbook) {
	return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function upload(name, workbook, query = "") {
	return call(
		"POST",
		`${SOURCES}/upload?name=${encodeURIComponent(name)}${query}`,
		await bytes(workbook),
		{ "content-type": "application/octet-stream" },
	);
}

async function download(id) {
	const response = await fetch(`${SOURCES}/${id}/download`);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
	return workbook;
}

async function cleanup() {
	const listed = (await call("GET", `${SOURCES}/`)).json.sources ?? [];
	for (const source of listed.filter((entry) => entry.name.startsWith("e2e-"))) {
		await call("DELETE", `${SOURCES}/${source.id}`);
	}
	for (const variable of ["E2E_Guests", "E2E_Scores", "e2e-single"]) {
		await call("DELETE", `${BASE}/api/data/${encodeURIComponent(variable)}`);
	}
}

async function main() {
	await cleanup();

	// ------------------------------------------------------------- load
	const first = await upload("e2e-book.xlsx", fixture());
	const source = first.json.source;
	check(
		"a dropped workbook becomes a source: one list per sheet that has a header",
		first.status === 200 &&
			source?.mode === "load" &&
			JSON.stringify(source.sheets) ===
				JSON.stringify([
					{ sheet: "E2E Guests", variable: "E2E_Guests" },
					{ sheet: "E2E Scores", variable: "E2E_Scores" },
				]),
		JSON.stringify(first.json).slice(0, 240),
	);

	let store = await data();
	check(
		"the rows of a sheet are the rows of the list, keyed by the header",
		JSON.stringify(store.E2E_Guests) ===
			JSON.stringify([
				{ Name: "Anna Reed", Role: "Expert" },
				{ Name: "Peter Holt", Role: "Studio guest" },
				{ Name: "Maria Kim", Role: "Analyst" },
			]),
		JSON.stringify(store.E2E_Guests),
	);
	check(
		"a formula cell gives its calculated value",
		store.E2E_Scores?.[0]?.Total === 3 && store.E2E_Scores?.[1]?.Total === 1,
		JSON.stringify(store.E2E_Scores),
	);

	// Edit like the dashboard does: replace a value, add a row, add a field.
	await call("POST", `${BASE}/api/data?mode=merge`, {
		E2E_Guests: [
			{ Name: "Anna Reed", Role: "Expert", City: "Oslo" },
			{ Name: "Peter Holt", Role: "Host", City: "" },
			{ Name: "Maria Kim", Role: "Analyst", City: "" },
			{ Name: "Ivan Petrov", Role: "Reporter", City: "Riga" },
		],
	});
	await sleep(1800);
	let book = await download(source.id);
	let sheet = book.getWorksheet("E2E Guests");
	check(
		"a replaced value is written into its cell",
		sheet.getCell("B3").value === "Host",
		String(sheet.getCell("B3").value),
	);
	check(
		"an added row is written under the last one",
		sheet.getCell("A5").value === "Ivan Petrov" && sheet.getCell("B5").value === "Reporter",
		`${sheet.getCell("A5").value} / ${sheet.getCell("B5").value}`,
	);
	check(
		"an added field becomes a new column with its header",
		sheet.getCell("C1").value === "City" &&
			sheet.getCell("C2").value === "Oslo" &&
			sheet.getCell("C5").value === "Riga",
		`${sheet.getCell("C1").value} / ${sheet.getCell("C2").value} / ${sheet.getCell("C5").value}`,
	);
	check(
		"formatting survives the write: bold header, fill, column width",
		sheet.getCell("A1").font?.bold === true &&
			sheet.getCell("A1").fill?.fgColor?.argb === "FFFF5A8C" &&
			sheet.getColumn(1).width === 28,
		JSON.stringify({ font: sheet.getCell("A1").font, width: sheet.getColumn(1).width }),
	);
	check(
		"a sheet that was not edited keeps its formulas",
		book.getWorksheet("E2E Scores").getCell("D2").value?.formula === "B2+C2",
		JSON.stringify(book.getWorksheet("E2E Scores").getCell("D2").value),
	);

	// Remove a row and a field.
	await call("POST", `${BASE}/api/data?mode=merge`, {
		E2E_Guests: [
			{ Name: "Anna Reed", Role: "Expert" },
			{ Name: "Peter Holt", Role: "Host" },
		],
	});
	await sleep(1800);
	book = await download(source.id);
	sheet = book.getWorksheet("E2E Guests");
	check(
		"removed rows and a removed field are emptied in the sheet",
		sheet.getCell("A4").value === null &&
			sheet.getCell("A5").value === null &&
			sheet.getCell("C1").value === null &&
			sheet.getCell("C2").value === null &&
			sheet.getCell("B3").value === "Host",
		JSON.stringify(["A4", "A5", "C1", "C2", "B3"].map((ref) => sheet.getCell(ref).value)),
	);

	// The same file again replaces the copy and resets the lists to it.
	const again = await upload("e2e-book.xlsx", fixture());
	store = await data();
	check(
		"loading the same file again replaces it without asking",
		again.status === 200 &&
			again.json.source?.id === source.id &&
			store.E2E_Guests?.length === 3 &&
			store.E2E_Guests[1].Role === "Studio guest",
		JSON.stringify(again.json).slice(0, 160),
	);

	// Another file that wants the same variables asks first.
	const clash = await upload("e2e-other.xlsx", fixture());
	check(
		"another workbook that would replace existing variables is refused, with their names",
		clash.status === 409 &&
			JSON.stringify(clash.json.conflicts) === JSON.stringify(["E2E_Guests", "E2E_Scores"]),
		JSON.stringify(clash.json),
	);
	const forced = await upload("e2e-other.xlsx", fixture(), "&replace=1");
	let listed = (await call("GET", `${SOURCES}/`)).json.sources ?? [];
	check(
		"with the operator's go-ahead it takes the variables over",
		forced.status === 200 &&
			listed.filter((entry) => entry.name.startsWith("e2e-")).length === 1 &&
			listed.some((entry) => entry.name === "e2e-other.xlsx"),
		JSON.stringify(listed.map((entry) => entry.name)),
	);

	// A "Sheet1" says nothing, so the file names the variable.
	const single = new ExcelJS.Workbook();
	single.addWorksheet("Sheet1").addRows([["Caption"], ["One"], ["Two"]]);
	const named = await upload("e2e-single.xlsx", single);
	check(
		"a workbook with one default-named sheet is named after the file",
		named.status === 200 && named.json.source?.sheets?.[0]?.variable === "e2e-single",
		JSON.stringify(named.json.source?.sheets),
	);

	// Deleting a list lets go of its sheet; disconnecting keeps the lists.
	await call("DELETE", `${BASE}/api/data/E2E_Scores`);
	await sleep(400);
	listed = (await call("GET", `${SOURCES}/`)).json.sources ?? [];
	const other = listed.find((entry) => entry.name === "e2e-other.xlsx");
	check(
		"deleting a list lets go of its sheet",
		JSON.stringify(other?.sheets) === JSON.stringify([{ sheet: "E2E Guests", variable: "E2E_Guests" }]),
		JSON.stringify(other?.sheets),
	);
	await call("DELETE", `${SOURCES}/${other.id}`);
	store = await data();
	listed = (await call("GET", `${SOURCES}/`)).json.sources ?? [];
	check(
		"disconnecting a workbook leaves its list in place",
		!listed.some((entry) => entry.id === other.id) && Array.isArray(store.E2E_Guests),
		JSON.stringify(Object.keys(store)),
	);

	const notExcel = await call("POST", `${SOURCES}/upload?name=e2e-notes.txt`, new Uint8Array([1, 2, 3]), {
		"content-type": "application/octet-stream",
	});
	const garbage = await call("POST", `${SOURCES}/upload?name=e2e-bad.xlsx`, new Uint8Array([1, 2, 3]), {
		"content-type": "application/octet-stream",
	});
	check(
		"a file that is not a workbook is refused",
		notExcel.status === 400 && notExcel.json.error === "not_xlsx" && garbage.status === 400,
		JSON.stringify([notExcel.json, garbage.json]).slice(0, 200),
	);

	// ------------------------------------------------------------ track
	if (!TRACK_DIR) {
		console.log("SKIP  track mode: set NOTGT_TRACK_DIR to a directory the server can write to");
	} else {
		await cleanup();
		fs.mkdirSync(TRACK_DIR, { recursive: true });
		const local = path.join(TRACK_DIR, "e2e-tracked.xlsx");
		const remote = `${TRACK_SERVER_DIR.replace(/[\\/]$/, "")}/e2e-tracked.xlsx`;
		await fixture().xlsx.writeFile(local);

		const missing = await call("POST", `${SOURCES}/track`, { path: `${remote}.nope.xlsx` });
		check("tracking a path with no file there is refused", missing.status === 404, JSON.stringify(missing.json));

		const tracked = await call("POST", `${SOURCES}/track`, { path: remote });
		store = await data();
		check(
			"a workbook on the server is tracked by its path",
			tracked.status === 200 &&
				tracked.json.source?.mode === "track" &&
				store.E2E_Guests?.[0]?.Name === "Anna Reed",
			JSON.stringify(tracked.json).slice(0, 200),
		);

		// Someone saves the file in a spreadsheet.
		const edited = new ExcelJS.Workbook();
		await edited.xlsx.readFile(local);
		edited.getWorksheet("E2E Guests").getCell("A2").value = "Anna Smirnova";
		edited.getWorksheet("E2E Guests").addRow(["Olga Berg", "Producer"]);
		await edited.xlsx.writeFile(local);
		await sleep(3200);
		store = await data();
		check(
			"a change of the tracked file reaches the list by itself",
			store.E2E_Guests?.[0]?.Name === "Anna Smirnova" && store.E2E_Guests?.[3]?.Name === "Olga Berg",
			JSON.stringify(store.E2E_Guests),
		);

		// And an edit in the dashboard reaches the file.
		const rows = store.E2E_Guests.map((row) => ({ ...row }));
		rows[1].Role = "Co-host";
		await call("POST", `${BASE}/api/data?mode=merge`, { E2E_Guests: rows });
		await sleep(2200);
		const onDisk = new ExcelJS.Workbook();
		await onDisk.xlsx.readFile(local);
		check(
			"an edit of the list is written into the tracked file",
			onDisk.getWorksheet("E2E Guests").getCell("B3").value === "Co-host" &&
				onDisk.getWorksheet("E2E Guests").getCell("A2").value === "Anna Smirnova",
			String(onDisk.getWorksheet("E2E Guests").getCell("B3").value),
		);
		await sleep(2200);
		store = await data();
		listed = (await call("GET", `${SOURCES}/`)).json.sources ?? [];
		check(
			"notGT's own write is not read back as a change, and the source is in step",
			store.E2E_Guests?.[1]?.Role === "Co-host" &&
				listed.find((entry) => entry.name === "e2e-tracked.xlsx")?.state === "ok",
			JSON.stringify(listed.find((entry) => entry.name === "e2e-tracked.xlsx")),
		);

		await cleanup();
		fs.rmSync(local, { force: true });
	}

	await cleanup();
	console.log(
		`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`,
	);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("E2E ERROR:", error);
	process.exit(2);
});
