import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import * as XLSX from 'xlsx';
import chardet from 'chardet';
import iconv from 'iconv-lite';

/** Header-only preview of one worksheet, cheap enough to compute for every sheet in a workbook. */
export interface SheetPreview {
  name: string;
  rowCount: number;
  /** First ~8 column headers, truncated with an ellipsis marker if the sheet is wider. */
  headers: string[];
}

/** Full parse result for the caller-selected sheets. */
export interface ExtractedSheets {
  sheets: { name: string; content: string }[];
  warnings: string[];
}

/**
 * Hard cap on the source file size, checked BEFORE any parse is attempted.
 * XLSX.read() synchronously decompresses+parses the whole file on the
 * Electron main process — a large or zip-bomb-shaped .xlsx would block the
 * app during that single call, before any row-count cap downstream could
 * help. The row cap (MAX_ROWS) only bounds rendered *output*, not parse cost.
 */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

/** Max data rows rendered per sheet; excess rows are dropped with an explicit warning, never silently. */
export const MAX_ROWS = 2000;

const PREVIEW_ROW_LIMIT = 50; // enough rows to get an accurate rowCount cheaply without reading a huge sheet fully
const PREVIEW_HEADER_COLS = 8;
// How many leading rows to scan when looking for the real header row (see detectHeaderRowIndex).
const HEADER_SCAN_WINDOW = 10;

function nonEmptyCellCount(row: unknown[] | undefined): number {
  if (!row) return 0;
  return row.filter((c) => c != null && String(c).trim() !== '').length;
}

/**
 * Real-world test-case spreadsheets often prepend 1-3 banner rows before the
 * actual column headers — a merged title cell ("UI Test Case Manual..."), a
 * metadata line ("App URL: ... | Environment: ..."), a notes line — each of
 * which XLSX reads back as a row with only ONE populated cell. Naively
 * treating row 0 as the header (and clipping every other row to that row's
 * width) silently truncates every data row down to a single column, dropping
 * the bulk of the sheet's content (Test Scenario, Steps, Expected Result,
 * etc. all vanish) — exactly the "never truncate silently" failure this
 * module exists to prevent. Instead, scan the first few rows and treat
 * whichever has the most populated cells as the header; earlier rows are
 * kept as preamble text rather than folded into the table.
 */
function detectHeaderRowIndex(rows: unknown[][]): number {
  const scanEnd = Math.min(rows.length, HEADER_SCAN_WINDOW);
  let bestIndex = 0;
  let bestCount = nonEmptyCellCount(rows[0]);
  for (let i = 1; i < scanEnd; i++) {
    const count = nonEmptyCellCount(rows[i]);
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Renders a preamble (banner/title/metadata) row as one plain text line. */
function rowToPlainLine(row: unknown[]): string {
  return row
    .filter((c) => c != null && String(c).trim() !== '')
    .map((c) => String(c).trim())
    .join(' ');
}

async function assertFileSizeOk(filePath: string): Promise<void> {
  const { size } = await stat(filePath);
  if (size > MAX_FILE_SIZE_BYTES) {
    const mb = (MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`File is too large (max ${mb}MB): ${filePath}`);
  }
}

/**
 * Read a workbook from disk. Size-checked first (see MAX_FILE_SIZE_BYTES);
 * corrupt/malformed input (including a malformed zip container) is caught
 * and rethrown as a clean, user-facing error rather than a raw parser
 * exception.
 */
async function readWorkbook(filePath: string): Promise<XLSX.WorkBook> {
  await assertFileSizeOk(filePath);
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.csv') {
      const buf = await readFile(filePath);
      const encoding = chardet.detect(buf) || 'UTF-8';
      const text = /^utf-?8$/i.test(encoding) ? buf.toString('utf8') : iconv.decode(buf, encoding);
      return XLSX.read(text, { type: 'string', raw: false });
    }
    const buf = await readFile(filePath);
    return XLSX.read(buf, { type: 'buffer' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read spreadsheet: ${detail}`);
  }
}

/** Cheap header-only parse of every sheet in the workbook; empty sheets are omitted entirely. */
export async function previewSheets(filePath: string): Promise<SheetPreview[]> {
  const wb = await readWorkbook(filePath);
  const previews: SheetPreview[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      range: `A1:ZZ${PREVIEW_ROW_LIMIT}`,
    });
    if (rows.length === 0) continue;

    // rowCount needs the true total, not just the bounded preview slice.
    const fullRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    const headerIdx = detectHeaderRowIndex(rows);
    const headerRow = (rows[headerIdx] ?? []).map((c) => (c == null ? '' : String(c)));
    const headers = headerRow.slice(0, PREVIEW_HEADER_COLS);
    if (headerRow.length > PREVIEW_HEADER_COLS) headers.push('…');

    previews.push({ name, rowCount: Math.max(fullRows.length - headerIdx - 1, 0), headers });
  }
  return previews;
}

/**
 * Renders `tableRows` (header row first, data rows after) as a markdown
 * table, padding every row out to the WIDEST row in the set — not just the
 * header's width — so an irregular sheet never silently drops a data row's
 * trailing columns just because some other row happened to be narrower.
 * `preambleLines` (banner/title/metadata rows found before the detected
 * header — see detectHeaderRowIndex) are rendered as plain text above the
 * table so that context isn't lost either.
 */
function toMarkdownTable(tableRows: unknown[][], preambleLines: string[] = []): string {
  if (tableRows.length === 0) return preambleLines.length > 0 ? preambleLines.join('\n') : '_(empty sheet)_';
  const width = tableRows.reduce((max, r) => Math.max(max, r.length), 0);
  const escape = (v: unknown): string =>
    v == null ? '' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const renderRow = (row: unknown[]): string =>
    `| ${Array.from({ length: width }, (_, i) => escape(row[i])).join(' | ')} |`;

  const header = tableRows[0];
  const body = tableRows.slice(1);
  const tableLines = [
    renderRow(header),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(renderRow),
  ];

  return preambleLines.length > 0 ? [...preambleLines, '', ...tableLines].join('\n') : tableLines.join('\n');
}

/** Full parse of only the caller-selected sheets, rendered as labeled markdown tables. */
export async function extractSheets(
  filePath: string,
  selectedSheetNames: string[],
): Promise<ExtractedSheets> {
  const wb = await readWorkbook(filePath);
  const sheets: { name: string; content: string }[] = [];
  const warnings: string[] = [];

  for (const name of selectedSheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const allRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    const headerIdx = detectHeaderRowIndex(allRows);
    const preambleLines = allRows
      .slice(0, headerIdx)
      .map(rowToPlainLine)
      .filter((line) => line.length > 0);
    const tableRows = allRows.slice(headerIdx); // [header, ...dataRows]

    const totalDataRows = Math.max(tableRows.length - 1, 0);
    const truncated = totalDataRows > MAX_ROWS;
    const boundedTableRows = truncated ? [tableRows[0], ...tableRows.slice(1, MAX_ROWS + 1)] : tableRows;

    let content = toMarkdownTable(boundedTableRows, preambleLines);
    if (truncated) {
      const note = `_(truncated — showing first ${MAX_ROWS} of ${totalDataRows} rows)_`;
      content += `\n\n${note}`;
      warnings.push(`Sheet "${name}" was truncated — showing first ${MAX_ROWS} of ${totalDataRows} rows.`);
    }
    sheets.push({ name, content });
  }

  return { sheets, warnings };
}
