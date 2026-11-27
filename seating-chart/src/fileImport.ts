/** Turn a dropped/chosen file (CSV, TSV or Excel) into parsed rows, or a list of sheets to choose from. */
import { parseCsv, type Parsed } from './importer';
import { isLegacyXls, isSpreadsheet, readXlsx, toCsvText, type Sheet } from './xlsx';

export type Loaded = { parsed: Parsed; sheet?: string } | { sheets: Sheet[] } | { error: string };

/** Sheets with a header and at least one row of data. */
const usable = (s: Sheet) => s.rows.filter((r) => r.some((c) => c.trim())).length >= 2;

export const sheetToParsed = (s: Sheet) => parseCsv(toCsvText(s.rows));

export async function loadTable(f: File): Promise<Loaded> {
  if (isLegacyXls(f)) return { error: 'That\u2019s an old-style .xls file. In Excel, use File \u2192 Save As \u2192 Excel Workbook (.xlsx) or CSV, then import that.' };
  if (isSpreadsheet(f)) {
    try {
      const sheets = (await readXlsx(f)).filter(usable);
      if (!sheets.length) return { error: 'That workbook has no sheet with a header row and guests under it.' };
      if (sheets.length === 1) return { parsed: sheetToParsed(sheets[0]), sheet: sheets[0].name };
      return { sheets };
    } catch {
      return { error: 'That Excel file couldn\u2019t be read. Try saving it again as .xlsx or CSV.' };
    }
  }
  const text = await f.text();
  return { parsed: parseCsv(text, /\.tsv$/i.test(f.name) || (!/,/.test(text.split('\n')[0]) && /\t/.test(text.split('\n')[0])) ? '\t' : undefined) };
}

export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
