/**
 * A small .xlsx reader: enough to pull a guest list out of an Excel or Google Sheets export.
 * An .xlsx file is a zip of XML parts; the browser unzips (DecompressionStream) and parses
 * (DOMParser), so no spreadsheet library is bundled. Legacy .xls (binary) files aren't supported.
 */

export interface Sheet {
  name: string;
  rows: string[][];
}

const td = new TextDecoder();

/** Read the zip's central directory and return a lazy reader for each entry by path. */
function unzip(buf: ArrayBuffer) {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // end of central directory record: last 22+ bytes, signature 0x06054b50
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not-zip');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true),
      extraLen = v.getUint16(p + 30, true),
      commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, size, offset: local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (path: string): Promise<string | null> => {
    const e = entries.get(path.replace(/^\//, ''));
    if (!e) return null;
    const lp = e.offset;
    const data = u8.subarray(lp + 30 + v.getUint16(lp + 26, true) + v.getUint16(lp + 28, true), lp + 30 + v.getUint16(lp + 26, true) + v.getUint16(lp + 28, true) + e.size);
    if (e.method === 0) return td.decode(data);
    if (e.method !== 8) throw new Error('unsupported-compression');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return td.decode(await new Response(stream).arrayBuffer());
  };
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
/** Elements by local name, ignoring namespace prefixes. */
const all = (root: Document | Element, tag: string) => Array.from(root.getElementsByTagNameNS('*', tag));
const textOf = (el: Element) => all(el, 't').map((t) => t.textContent ?? '').join('');

/** "AB12" → column index 27 */
function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date → yyyy-mm-dd */
function serialDate(n: number) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 10);
}

export async function readXlsx(file: Blob): Promise<Sheet[]> {
  const get = unzip(await file.arrayBuffer());
  const wbXml = await get('xl/workbook.xml');
  if (!wbXml) throw new Error('not-xlsx');
  const wb = xml(wbXml);
  const rels = xml((await get('xl/_rels/workbook.xml.rels')) ?? '<Relationships/>');
  const target = new Map(all(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target') ?? '']));
  const ssXml = await get('xl/sharedStrings.xml');
  const shared = ssXml ? all(xml(ssXml), 'si').map(textOf) : [];

  // which cell styles are dates (so birthdays/RSVP dates don't come through as 45123)
  const dateStyles = new Set<number>();
  const stXml = await get('xl/styles.xml');
  if (stXml) {
    const st = xml(stXml);
    const custom = new Map(all(st, 'numFmt').map((f) => [+(f.getAttribute('numFmtId') ?? 0), f.getAttribute('formatCode') ?? '']));
    const xfs = all(st, 'cellXfs')[0];
    if (xfs)
      Array.from(xfs.children).forEach((xf, i) => {
        const id = +(xf.getAttribute('numFmtId') ?? 0);
        const code = custom.get(id) ?? '';
        if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (/[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%]+$/.test(code))) dateStyles.add(i);
      });
  }

  const sheets: Sheet[] = [];
  for (const s of all(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id');
    let path = target.get(rid) ?? '';
    if (!path) continue;
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
    const body = await get(path);
    if (!body) continue;
    const rows: string[][] = [];
    for (const r of all(xml(body), 'row')) {
      const ri = +(r.getAttribute('r') ?? rows.length + 1) - 1;
      const row: string[] = [];
      let ci = 0;
      for (const c of all(r, 'c')) {
        const ref = c.getAttribute('r');
        if (ref) ci = colIndex(ref);
        const t = c.getAttribute('t');
        const vEl = all(c, 'v')[0];
        const raw = vEl?.textContent ?? '';
        let val = '';
        if (t === 's') val = shared[+raw] ?? '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'e') val = '';
        else if (t === 'str') val = raw;
        else if (raw !== '' && dateStyles.has(+(c.getAttribute('s') ?? -1)) && Number.isFinite(+raw)) val = serialDate(+raw);
        else val = raw;
        row[ci] = val;
        ci++;
      }
      rows[ri] = Array.from(row, (x) => x ?? '');
    }
    sheets.push({ name: s.getAttribute('name') ?? `Sheet ${sheets.length + 1}`, rows: Array.from(rows, (x) => x ?? []) });
  }
  return sheets;
}

/** Rows → CSV text, so spreadsheets go through exactly the same import (and contact-detail stripping) as CSV files. */
export function toCsvText(rows: string[][]) {
  // drop leading empty rows so the header is found
  const start = rows.findIndex((r) => r.some((c) => c.trim()));
  return rows
    .slice(Math.max(0, start))
    .map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n');
}

export const isSpreadsheet = (f: File) => /\.(xlsx|xlsm)$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const isLegacyXls = (f: File) => /\.xls$/i.test(f.name);
