import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

/**
 * A sheet read as a table: the first filled row names the columns, every row
 * under it is one record. Rows are positional — record `i` is the sheet row
 * `i` rows below the header — so a blank row in the middle is kept as an empty
 * record, and only the blank rows at the end are dropped.
 */
export interface SheetTable {
	sheet: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
}

type Row = Record<string, unknown>;

/** A cell as the plain value the variable store holds. */
function plain(value: ExcelJS.CellValue | undefined): string | number | boolean {
	if (value === null || value === undefined) return "";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (value instanceof Date) {
		// A date-only cell reads as midnight UTC; keep the time only when there is one.
		const iso = value.toISOString();
		return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
	}
	if (typeof value === "object") {
		const cell = value as {
			result?: ExcelJS.CellValue;
			richText?: Array<{ text?: string }>;
			text?: unknown;
			error?: string;
		};
		// A formula shows its last calculated result.
		if ("result" in cell) return plain(cell.result);
		if (Array.isArray(cell.richText)) return cell.richText.map((run) => run.text ?? "").join("");
		if (typeof cell.text === "string") return cell.text;
		if (typeof cell.error === "string") return cell.error;
	}
	return "";
}

function isEmpty(value: unknown): boolean {
	return value === "" || value === null || value === undefined;
}

/** Two values that show the same thing are the same: `2` and `"2"`, `""` and nothing. */
function same(a: unknown, b: unknown): boolean {
	return String(isEmpty(a) ? "" : a) === String(isEmpty(b) ? "" : b);
}

/**
 * A header as a field name. A dot or a bracket would split the binding path
 * (`{{guests.first.name}}`), so they become underscores.
 */
export function fieldName(header: unknown): string {
	return String(header ?? "")
		.replace(/[.[\]]+/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}

/** The first row that has anything in it; 0 when the sheet is empty. */
function headerRowOf(sheet: ExcelJS.Worksheet): number {
	for (let r = 1; r <= sheet.rowCount; r += 1) {
		const row = sheet.getRow(r);
		for (let c = 1; c <= row.cellCount; c += 1) {
			if (!isEmpty(plain(row.getCell(c).value))) return r;
		}
	}
	return 0;
}

/** Field name → column number, for the headers of `headerRow`, left to right. */
function columnsOf(sheet: ExcelJS.Worksheet, headerRow: number): Map<string, number> {
	const columns = new Map<string, number>();
	if (headerRow === 0) return columns;
	const row = sheet.getRow(headerRow);
	for (let c = 1; c <= row.cellCount; c += 1) {
		const name = fieldName(plain(row.getCell(c).value));
		// A second column with the same header would be unreachable: the first wins.
		if (name && !columns.has(name)) columns.set(name, c);
	}
	return columns;
}

/** The last sheet row that has a value in one of the table's columns. */
function lastDataRow(sheet: ExcelJS.Worksheet, headerRow: number, columns: Map<string, number>): number {
	for (let r = sheet.rowCount; r > headerRow; r -= 1) {
		const row = sheet.getRow(r);
		for (const c of columns.values()) {
			if (!isEmpty(plain(row.getCell(c).value))) return r;
		}
	}
	return headerRow;
}

function readSheet(sheet: ExcelJS.Worksheet): SheetTable {
	const headerRow = headerRowOf(sheet);
	const columns = columnsOf(sheet, headerRow);
	const last = lastDataRow(sheet, headerRow, columns);
	const rows: Row[] = [];
	for (let r = headerRow + 1; r <= last; r += 1) {
		const row = sheet.getRow(r);
		const record: Row = {};
		for (const [name, c] of columns) record[name] = plain(row.getCell(c).value);
		rows.push(record);
	}
	return { sheet: sheet.name, columns: [...columns.keys()], rows };
}

async function open(file: string): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(file);
	return workbook;
}

/** Every sheet that has a header row, as a table. */
export async function readWorkbook(file: string): Promise<SheetTable[]> {
	const workbook = await open(file);
	return workbook.worksheets.map(readSheet).filter((table) => table.columns.length > 0);
}

/**
 * Makes the sheets of `file` say what `tables` say, touching only the cells
 * whose value differs — so formats, widths, formulas elsewhere and the other
 * sheets stay as they were — and writes the file only if something did differ.
 *
 *  - a field the sheet has no column for gets a new column after the last one;
 *  - a column no record has any more (it was removed in the dashboard) is emptied;
 *  - sheet rows past the last record are emptied.
 */
export async function writeWorkbook(
	file: string,
	tables: Array<{ sheet: string; rows: Row[] }>,
): Promise<boolean> {
	const workbook = await open(file);
	let changed = false;

	const put = (cell: ExcelJS.Cell, value: unknown): void => {
		if (same(plain(cell.value), value)) return;
		cell.value = isEmpty(value) ? null : (value as ExcelJS.CellValue);
		changed = true;
	};

	for (const table of tables) {
		const sheet = workbook.getWorksheet(table.sheet) ?? workbook.addWorksheet(table.sheet);
		const headerRow = headerRowOf(sheet) || 1;
		const columns = columnsOf(sheet, headerRow);
		const last = lastDataRow(sheet, headerRow, columns);

		const fields: string[] = [];
		for (const record of table.rows) {
			for (const key of Object.keys(record ?? {})) {
				const name = fieldName(key);
				if (name && !fields.includes(name)) fields.push(name);
			}
		}

		let nextColumn = Math.max(0, ...columns.values()) + 1;
		for (const name of fields) {
			if (columns.has(name)) continue;
			put(sheet.getRow(headerRow).getCell(nextColumn), name);
			columns.set(name, nextColumn);
			nextColumn += 1;
		}

		// With no records left there is no telling a removed column from an
		// emptied table, so the headers stay.
		if (table.rows.length > 0) {
			for (const [name, c] of [...columns]) {
				if (fields.includes(name)) continue;
				for (let r = headerRow; r <= last; r += 1) put(sheet.getRow(r).getCell(c), "");
				columns.delete(name);
			}
		}

		const until = Math.max(last, headerRow + table.rows.length);
		for (let r = headerRow + 1; r <= until; r += 1) {
			const record = table.rows[r - headerRow - 1];
			const row = sheet.getRow(r);
			for (const [name, c] of columns) {
				const value = record ? valueOf(record, name) : "";
				put(row.getCell(c), value);
			}
		}
	}

	if (!changed) return false;

	// Formulas elsewhere in the workbook hold results calculated before this
	// change; have the spreadsheet recalculate when it opens the file.
	workbook.calcProperties.fullCalcOnLoad = true;

	// Written next to the file and moved over it, so a reader never sees half
	// a workbook.
	const temp = path.join(path.dirname(file), `.~notgt-${process.pid}-${path.basename(file)}`);
	try {
		await workbook.xlsx.writeFile(temp);
		await fs.promises.rename(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	return true;
}

/** The value of a record's field, whatever spelling of the name the record uses. */
function valueOf(record: Row, name: string): unknown {
	if (name in record) return scalar(record[name]);
	for (const [key, value] of Object.entries(record)) {
		if (fieldName(key) === name) return scalar(value);
	}
	return "";
}

/** A cell holds one value; anything nested is written as its JSON. */
function scalar(value: unknown): unknown {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}
