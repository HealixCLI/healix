import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import iconv from 'iconv-lite';
import { extractSheets, MAX_FILE_SIZE_BYTES, MAX_ROWS, previewSheets } from './spreadsheet.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'healix-spreadsheet-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function writeWorkbook(
  fileName: string,
  sheets: Record<string, unknown[][]>,
  bookType: XLSX.BookType = 'xlsx',
): string {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const filePath = join(dir, fileName);
  XLSX.writeFile(wb, filePath, { bookType });
  return filePath;
}

describe('previewSheets', () => {
  it('lists every non-empty sheet with header + row count', async () => {
    const filePath = writeWorkbook('multi.xlsx', {
      Login: [
        ['username', 'password', 'expected'],
        ['alice', 'pw1', 'success'],
        ['bob', 'pw2', 'failure'],
      ],
      Signup: [
        ['email', 'name'],
        ['a@x.com', 'Alice'],
      ],
    });

    const previews = await previewSheets(filePath);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({
      name: 'Login',
      rowCount: 2,
      headers: ['username', 'password', 'expected'],
    });
    expect(previews[1]).toMatchObject({ name: 'Signup', rowCount: 1, headers: ['email', 'name'] });
  });

  it('omits empty sheets entirely rather than emitting an empty stub', async () => {
    const filePath = writeWorkbook('with-blank.xlsx', {
      Data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      Blank: [],
    });

    const previews = await previewSheets(filePath);
    expect(previews.map((p) => p.name)).toEqual(['Data']);
  });

  it('returns an empty array when every sheet is empty', async () => {
    const filePath = writeWorkbook('all-blank.xlsx', { Sheet1: [], Sheet2: [] });
    const previews = await previewSheets(filePath);
    expect(previews).toEqual([]);
  });

  it('truncates a wide header preview to 8 columns with an ellipsis marker', async () => {
    const header = Array.from({ length: 12 }, (_, i) => `col${i + 1}`);
    const filePath = writeWorkbook('wide.xlsx', { Sheet1: [header, header.map((_, i) => String(i))] });
    const previews = await previewSheets(filePath);
    expect(previews[0].headers).toHaveLength(9);
    expect(previews[0].headers[8]).toBe('…');
  });

  it('reads legacy .xls workbooks', async () => {
    const filePath = writeWorkbook(
      'legacy.xls',
      {
        Sheet1: [
          ['a', 'b'],
          ['1', '2'],
        ],
      },
      'biff8',
    );
    const previews = await previewSheets(filePath);
    expect(previews).toEqual([{ name: 'Sheet1', rowCount: 1, headers: ['a', 'b'] }]);
  });

  it('rejects a file over the size cap before attempting to parse it', async () => {
    const filePath = join(dir, 'huge.xlsx');
    await writeFile(filePath, Buffer.alloc(MAX_FILE_SIZE_BYTES + 1));
    await expect(previewSheets(filePath)).rejects.toThrow(/too large/i);
  });

  it('surfaces a corrupt file as a clean error instead of a raw parser exception', async () => {
    // SheetJS is lenient with plain buffers (it'll happily read arbitrary text
    // as a one-cell CSV), so a genuinely corrupt .xlsx needs to at least look
    // like a truncated zip container to actually fail to parse.
    const filePath = join(dir, 'corrupt.xlsx');
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('not a real zip'.repeat(20))]),
    );
    await expect(previewSheets(filePath)).rejects.toThrow(/could not read spreadsheet/i);
  });

  it('decodes a non-UTF8 CSV without mojibake', async () => {
    const filePath = join(dir, 'windows1252.csv');
    const csvText = 'name,note\nJosé,café\n';
    await writeFile(filePath, iconv.encode(csvText, 'windows-1252'));

    const previews = await previewSheets(filePath);
    expect(previews[0].headers).toEqual(['name', 'note']);
    const { sheets } = await extractSheets(filePath, [previews[0].name]);
    expect(sheets[0].content).toContain('José');
    expect(sheets[0].content).toContain('café');
  });
});

describe('extractSheets — banner-row workbooks', () => {
  it('does not truncate every data row to one column when a title/metadata banner precedes the real header', async () => {
    // Mirrors a real test-case manual export: a merged title cell, a
    // metadata line, a notes line — each with only ONE populated cell — then
    // the actual multi-column header. Naive "row 0 is the header" logic
    // would clip every row below to 1 column, dropping everything but the
    // Test Case ID.
    const filePath = writeWorkbook('banner.xlsx', {
      Sheet1: [
        ['UI Test Case Manual'],
        ['App URL: http://localhost/   |   Tester: Jane'],
        ['Test Case ID', 'Test Scenario', 'Expected Result'],
        ['TC-01', 'Homepage loads', 'Welcome heading renders'],
        ['TC-02', 'Login succeeds', 'Redirected to dashboard'],
      ],
    });

    const { sheets, warnings } = await extractSheets(filePath, ['Sheet1']);
    expect(warnings).toEqual([]);
    expect(sheets[0].content).toContain('UI Test Case Manual');
    expect(sheets[0].content).toContain('App URL: http://localhost/   |   Tester: Jane');
    expect(sheets[0].content).toContain('| Test Case ID | Test Scenario | Expected Result |');
    expect(sheets[0].content).toContain('| TC-01 | Homepage loads | Welcome heading renders |');
    expect(sheets[0].content).toContain('| TC-02 | Login succeeds | Redirected to dashboard |');
  });

  it('previewSheets reports the real header/row count, not the banner row', async () => {
    const filePath = writeWorkbook('banner.xlsx', {
      Sheet1: [
        ['UI Test Case Manual'],
        ['Test Case ID', 'Test Scenario', 'Expected Result'],
        ['TC-01', 'Homepage loads', 'Welcome heading renders'],
        ['TC-02', 'Login succeeds', 'Redirected to dashboard'],
      ],
    });

    const previews = await previewSheets(filePath);
    expect(previews).toEqual([
      { name: 'Sheet1', rowCount: 2, headers: ['Test Case ID', 'Test Scenario', 'Expected Result'] },
    ]);
  });
});

describe('extractSheets', () => {
  it('renders selected sheets as labeled markdown tables', async () => {
    const filePath = writeWorkbook('multi.xlsx', {
      Login: [
        ['username', 'password'],
        ['alice', 'pw1'],
      ],
      Signup: [['email'], ['a@x.com']],
    });

    const { sheets, warnings } = await extractSheets(filePath, ['Login']);
    expect(warnings).toEqual([]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Login');
    expect(sheets[0].content).toBe('| username | password |\n| --- | --- |\n| alice | pw1 |');
  });

  it('caps rows at MAX_ROWS and emits an explicit truncation warning, never silently', async () => {
    const header = ['id'];
    const rows = [header, ...Array.from({ length: MAX_ROWS + 50 }, (_, i) => [String(i)])];
    const filePath = writeWorkbook('big.xlsx', { Sheet1: rows });

    const { sheets, warnings } = await extractSheets(filePath, ['Sheet1']);
    expect(warnings).toEqual([
      `Sheet "Sheet1" was truncated — showing first ${MAX_ROWS} of ${MAX_ROWS + 50} rows.`,
    ]);
    expect(sheets[0].content).toContain(`(truncated — showing first ${MAX_ROWS} of ${MAX_ROWS + 50} rows)`);
    // header + separator + MAX_ROWS data rows + blank line + truncation note
    expect(sheets[0].content.split('\n')).toHaveLength(MAX_ROWS + 2 + 2);
  });
});
