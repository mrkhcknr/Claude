/**
 * PDF exports, made entirely in the browser.
 *
 * Each page is drawn on a canvas at print resolution and stored in the PDF as an image. That keeps
 * Chinese flower names and guest names exact (the browser's own fonts draw them) without shipping
 * a multi-megabyte CJK font, and the result opens and prints the same everywhere.
 *
 *  - seatingChartPdf: the venue layout on a landscape page, then every table as a card
 *    (Chinese name, English name, table number, guests by seat with meals).
 *  - guestListPdf: the guest list as a table (name, table, seat, meal, dietary, RSVP),
 *    with a repeated header row and page numbers.
 */
import type { Guest, Project, Table } from './types';
import { byLast, planSvg, rsvpLabel, seatIndex, sideLabel, sortTables, tableFootprint } from './exporters';
import { projectBounds } from './geometry';
import { hasTableName, tableTitle } from './store';

export type Paper = 'letter' | 'a4' | 'tabloid';
/** Page sizes in points (1/72 in), portrait. */
const PAPER: Record<Paper, [number, number]> = { letter: [612, 792], a4: [595.28, 841.89], tabloid: [792, 1224] };
export const PAPER_LABEL: Record<Paper, string> = { letter: 'US Letter (8.5 × 11 in)', a4: 'A4', tabloid: 'Tabloid (11 × 17 in)' };

const DPI = 220;
const K = DPI / 72;
const SERIF = `Georgia, 'Times New Roman', 'Songti TC', 'Noto Serif TC', 'Noto Serif CJK TC', 'PMingLiU', serif`;
const SANS = `-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans TC', 'Noto Sans CJK TC', sans-serif`;
const INK = '#1f2a26',
  MUTED = '#6b7a74',
  LINE = '#d9e0dc',
  SOFT = '#f4f6f5',
  ACCENT = '#3d6b5c';
const M = 40; // page margin, pt

// ---------- a canvas page, drawn in points ----------
interface Page {
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
function newPage(w: number, h: number): Page {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * K);
  canvas.height = Math.round(h * K);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(K, K);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'alphabetic';
  return { w, h, canvas, ctx };
}
const font = (ctx: CanvasRenderingContext2D, size: number, opts: { serif?: boolean; bold?: boolean; italic?: boolean } = {}) =>
  (ctx.font = `${opts.italic ? 'italic ' : ''}${opts.bold ? '600 ' : ''}${size}px ${opts.serif ? SERIF : SANS}`);
/** Text cut to fit a width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, s: string, w: number) {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= w) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + '…';
}
function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, maxW?: number, align: CanvasTextAlign = 'left') {
  ctx.textAlign = align;
  ctx.fillText(maxW ? fit(ctx, s, maxW) : s, x, y);
  ctx.textAlign = 'left';
}
function footer(pg: Page, left: string, n: number, total: number) {
  const { ctx } = pg;
  ctx.fillStyle = MUTED;
  font(ctx, 8);
  text(ctx, left, M, pg.h - 22, pg.w / 2);
  text(ctx, `Page ${n} of ${total}`, pg.w - M, pg.h - 22, undefined, 'right');
}
const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

// ---------- seating chart ----------
async function svgImage(svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Could not draw the floor plan'));
      img.src = url;
    });
    return img;
  } finally {
    // the image is decoded by now; the URL can go
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

interface Card {
  t: Table;
  rows: { seat: number; g: Guest }[];
  h: number;
}

export async function seatingChartPdf(p: Project, paper: Paper = 'letter', opts: { names?: boolean } = {}) {
  const [pw, ph] = PAPER[paper];
  const pages: Page[] = [];
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const seated = Object.values(p.seating).flat().filter(Boolean).length;

  // 1. the whole venue; 2. the seating area enlarged, so names are readable in print
  pages.push(await planPage(p, pw, ph, { names: opts.names, title: p.name || 'Seating chart', sub: `Seating chart · ${seated} guests at ${p.tables.length} tables · ${today()}` }));
  if (p.tables.length) {
    const pts = p.tables.flatMap((t) => tableFootprint(t));
    const pad = 5;
    const bounds = { x0: Math.min(...pts.map((q) => q.x)) - pad, y0: Math.min(...pts.map((q) => q.y)) - pad, x1: Math.max(...pts.map((q) => q.x)) + pad, y1: Math.max(...pts.map((q) => q.y)) + pad };
    const all = projectBounds(p);
    // only worth a page when the tables take up clearly less of the room than the whole plan
    if ((bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0) < 0.6 * (all.x1 - all.x0) * (all.y1 - all.y0))
      pages.push(await planPage(p, pw, ph, { names: opts.names, title: 'Seating area', sub: 'Enlarged so every name can be read', bounds }));
  }

  // 2. table cards, two columns, flowing onto as many portrait pages as needed
  const cards: Card[] = sortTables(p.tables)
    .map((t) => {
      const rows = (p.seating[t.id] ?? []).map((gid, i) => ({ seat: i + 1, g: gid ? byId.get(gid) : undefined })).filter((r): r is { seat: number; g: Guest } => !!r.g);
      const en = tableTitle(t).sub;
      const head = 22 + (en ? 14 : 0) + 12;
      return { t, rows, h: head + Math.max(1, rows.length) * 15 + 14 };
    })
    .filter((c) => c.rows.length || p.tables.length <= 40);
  const colGap = 16,
    colW = (pw - 2 * M - colGap) / 2,
    top = M + 40,
    bottom = ph - 44;
  let pg: Page | null = null;
  const cols = [0, 0];
  const startPage = () => {
    pg = newPage(pw, ph);
    const { ctx } = pg;
    ctx.fillStyle = INK;
    font(ctx, 16, { serif: true });
    text(ctx, 'Tables', M, M + 12);
    ctx.fillStyle = MUTED;
    font(ctx, 9);
    text(ctx, p.name, pw - M, M + 11, pw / 2, 'right');
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(M, M + 22);
    ctx.lineTo(pw - M, M + 22);
    ctx.stroke();
    cols[0] = cols[1] = top;
    pages.push(pg);
  };
  startPage();
  for (const c of cards) {
    // shortest column first; new page when it doesn't fit
    let col = cols[0] <= cols[1] ? 0 : 1;
    if (cols[col] + c.h > bottom) {
      const other = 1 - col;
      if (cols[other] + c.h <= bottom) col = other;
      else {
        startPage();
        col = 0;
      }
    }
    drawCard(pg!, c, M + col * (colW + colGap), cols[col], colW);
    cols[col] += c.h + 12;
  }

  const total = pages.length;
  pages.forEach((x, i) => footer(x, `${p.name} · seating chart`, i + 1, total));
  return toPdf(pages);
}

function drawCard(pg: Page, c: Card, x: number, y: number, w: number) {
  const { ctx } = pg;
  const { main, sub } = tableTitle(c.t);
  // card
  ctx.fillStyle = SOFT;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.roundRect(x, y, w, c.h, 6);
  ctx.fill();
  ctx.stroke();
  const pad = 12;
  // title: Chinese, English beneath; table number and count on the right
  const right = `${hasTableName(c.t) ? c.t.label.toUpperCase() + '  ·  ' : ''}${c.rows.length}/${c.t.seats}`;
  font(ctx, 8.5, { bold: true });
  const rw = ctx.measureText(right).width;
  ctx.fillStyle = MUTED;
  text(ctx, right, x + w - pad, y + 20, undefined, 'right');
  ctx.fillStyle = INK;
  font(ctx, 15, { serif: true });
  text(ctx, main, x + pad, y + 22, w - 2 * pad - rw - 8);
  let yy = y + 22;
  if (sub) {
    font(ctx, 10, { serif: true, italic: true });
    ctx.fillStyle = '#3d4a45';
    text(ctx, sub, x + pad, yy + 14, w - 2 * pad);
    yy += 14;
  }
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(x + pad, yy + 8);
  ctx.lineTo(x + w - pad, yy + 8);
  ctx.stroke();
  yy += 8;
  // guests by seat
  if (!c.rows.length) {
    ctx.fillStyle = MUTED;
    font(ctx, 9, { italic: true });
    text(ctx, 'No one seated yet', x + pad, yy + 15);
    return;
  }
  for (const r of c.rows) {
    yy += 15;
    ctx.fillStyle = MUTED;
    font(ctx, 8);
    text(ctx, String(r.seat), x + pad + 10, yy, undefined, 'right');
    const meal = [r.g.meal, r.g.dietary.trim()].filter(Boolean).join(' · ');
    font(ctx, 8);
    const mealW = meal ? Math.min(ctx.measureText(meal).width, w * 0.42) : 0;
    if (meal) text(ctx, meal, x + w - pad, yy, w * 0.42, 'right');
    ctx.fillStyle = INK;
    font(ctx, 9.5);
    text(ctx, r.g.name, x + pad + 18, yy, w - 2 * pad - 18 - mealW - 8);
  }
}

// ---------- guest list ----------
export type GuestWho = 'attending' | 'invited' | 'all';
export type GuestSort = 'name' | 'table';

export async function guestListPdf(p: Project, paper: Paper = 'letter', opts: { who?: GuestWho; sort?: GuestSort } = {}) {
  const who = opts.who ?? 'attending';
  const [pw, ph] = PAPER[paper];
  const idx = seatIndex(p);
  let guests = p.guests.filter((g) => (who === 'attending' ? g.rsvp === 'yes' : who === 'invited' ? g.rsvp !== 'no' : true));
  const tableOrder = new Map(sortTables(p.tables).map((t, i) => [t.id, i]));
  guests = [...guests].sort(byLast);
  if (opts.sort === 'table')
    guests.sort((a, b) => {
      const sa = idx.get(a.id),
        sb = idx.get(b.id);
      const ta = sa ? tableOrder.get(sa.t.id)! : 1e9,
        tb = sb ? tableOrder.get(sb.t.id)! : 1e9;
      return ta - tb || (sa?.seat ?? 0) - (sb?.seat ?? 0) || byLast(a, b);
    });
  const showRsvp = who !== 'attending';
  // only columns with something in them
  const showSide = guests.some((g) => sideLabel(p, g));
  const showDiet = guests.some((g) => g.dietary.trim());

  // columns (fractions of the usable width)
  type Col = { key: string; label: string; w: number; align?: CanvasTextAlign };
  const cols: Col[] = [
    { key: 'n', label: '#', w: 0.045, align: 'right' },
    { key: 'name', label: 'Guest', w: 0.25 },
    { key: 'table', label: 'Table', w: 0.26 },
    { key: 'seat', label: 'Seat', w: 0.065, align: 'right' },
    { key: 'meal', label: 'Meal', w: 0.14 },
    ...(showDiet ? [{ key: 'diet', label: 'Dietary', w: 0.14 }] : []),
    ...(showSide ? [{ key: 'side', label: 'Side', w: 0.1 }] : []),
    ...(showRsvp ? [{ key: 'rsvp', label: 'RSVP', w: 0.1 }] : []),
  ];
  const sum = cols.reduce((s, c) => s + c.w, 0);
  const usable = pw - 2 * M;
  const colX: number[] = [];
  let cx = M;
  for (const c of cols) {
    c.w = (c.w / sum) * usable;
    colX.push(cx);
    cx += c.w;
  }

  const rowH = 26,
    headH = 22;
  const pages: Page[] = [];
  let pg: Page | null = null;
  let y = 0;
  const startPage = (first: boolean) => {
    pg = newPage(pw, ph);
    const { ctx } = pg;
    y = M;
    if (first) {
      ctx.fillStyle = INK;
      font(ctx, 22, { serif: true });
      text(ctx, 'Guest list', M, y + 18);
      ctx.fillStyle = MUTED;
      font(ctx, 9.5);
      const whoLabel = who === 'attending' ? 'attending' : who === 'invited' ? 'attending or pending' : 'invited';
      text(ctx, `${p.name} · ${guests.length} ${whoLabel} · ${opts.sort === 'table' ? 'by table' : 'A–Z by last name'} · ${today()}`, M, y + 34, usable);
      y += 48;
    }
    // header row
    ctx.fillStyle = ACCENT;
    ctx.fillRect(M, y, usable, headH);
    ctx.fillStyle = '#fff';
    font(ctx, 8.5, { bold: true });
    cols.forEach((c, i) => text(ctx, c.label.toUpperCase(), c.align === 'right' ? colX[i] + c.w - 6 : colX[i] + 6, y + 14.5, c.w - 10, c.align));
    y += headH;
    pages.push(pg);
  };
  startPage(true);
  guests.forEach((g, n) => {
    if (y + rowH > ph - 44) startPage(false);
    const { ctx } = pg!;
    if (n % 2) {
      ctx.fillStyle = SOFT;
      ctx.fillRect(M, y, usable, rowH);
    }
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(M, y + rowH);
    ctx.lineTo(M + usable, y + rowH);
    ctx.stroke();
    const s = idx.get(g.id);
    const title = s ? tableTitle(s.t) : null;
    const base = y + 11.5,
      second = y + 21.5;
    cols.forEach((c, i) => {
      const x = c.align === 'right' ? colX[i] + c.w - 6 : colX[i] + 6;
      const w = c.w - 10;
      ctx.fillStyle = INK;
      switch (c.key) {
        case 'n':
          font(ctx, 8);
          ctx.fillStyle = MUTED;
          text(ctx, String(n + 1), x, base + 4, w, 'right');
          break;
        case 'name': {
          const alias = (g.aliases ?? []).join(', ');
          font(ctx, 10, { bold: true });
          text(ctx, g.name, x, alias ? base : base + 4, w);
          if (alias) {
            font(ctx, 8);
            ctx.fillStyle = MUTED;
            text(ctx, alias, x, second, w);
          }
          break;
        }
        case 'table':
          if (!title) {
            font(ctx, 9, { italic: true });
            ctx.fillStyle = MUTED;
            text(ctx, g.rsvp === 'no' ? '—' : 'Not seated yet', x, base + 4, w);
          } else {
            font(ctx, 10, { serif: true });
            text(ctx, title.main, x, title.sub || hasTableName(s!.t) ? base : base + 4, w);
            font(ctx, 8, { italic: !!title.sub });
            ctx.fillStyle = MUTED;
            const line2 = [title.sub, hasTableName(s!.t) ? s!.t.label : ''].filter(Boolean).join(' · ');
            if (line2) text(ctx, line2, x, second, w);
          }
          break;
        case 'seat':
          font(ctx, 9.5);
          text(ctx, s ? String(s.seat) : '', x, base + 4, w, 'right');
          break;
        case 'meal':
          font(ctx, 9.5);
          text(ctx, g.meal || '—', x, base + 4, w);
          break;
        case 'diet':
          font(ctx, 9);
          text(ctx, g.dietary.trim(), x, base + 4, w);
          break;
        case 'side':
          font(ctx, 8.5);
          ctx.fillStyle = MUTED;
          text(ctx, sideLabel(p, g), x, base + 4, w);
          break;
        case 'rsvp':
          font(ctx, 8.5, { bold: true });
          ctx.fillStyle = g.rsvp === 'yes' ? '#2f7a55' : g.rsvp === 'no' ? '#b54848' : '#a7741c';
          text(ctx, g.rsvp === 'yes' ? 'Coming' : rsvpLabel(g), x, base + 4, w);
          break;
      }
    });
    y += rowH;
  });
  if (!guests.length) {
    const { ctx } = pg!;
    ctx.fillStyle = MUTED;
    font(ctx, 10, { italic: true });
    text(ctx, 'No guests to list.', M + 6, y + 18);
  }
  const total = pages.length;
  pages.forEach((x, i) => footer(x, `${p.name} · guest list`, i + 1, total));
  return toPdf(pages);
}

// ---------- a minimal PDF writer: one JPEG per page ----------
async function jpeg(c: HTMLCanvasElement) {
  const b = await new Promise<Blob>((res, rej) => c.toBlob((x) => (x ? res(x) : rej(new Error('Could not render the page'))), 'image/jpeg', 0.9));
  return new Uint8Array(await b.arrayBuffer());
}

async function toPdf(pages: Page[]): Promise<Blob> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (x: string | Uint8Array) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  // objects: 1 catalog, 2 pages, then per page: page, contents, image
  const n = pages.length;
  const pageObj = (i: number) => 3 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  for (let i = 0; i < n; i++) {
    const pg = pages[i];
    const img = await jpeg(pg.canvas);
    const w = pg.w.toFixed(2),
      h = pg.h.toFixed(2);
    obj(pageObj(i), () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageObj(i) + 2} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`));
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(pageObj(i) + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(pageObj(i) + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${pg.canvas.width} /Height ${pg.canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push('\nendstream');
    });
    // let the page render before the next one (keeps the UI responsive on big lists)
    await new Promise((r) => setTimeout(r, 0));
  }
  const xref = pos;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

/** One floor-plan page: header, the plan as large as the page allows (turned to suit its shape), side legend. */
async function planPage(p: Project, pw: number, ph: number, o: { names?: boolean; title: string; sub: string; bounds?: { x0: number; y0: number; x1: number; y1: number } }) {
  const svg = planSvg(p, { names: o.names !== false, title: false, scale: 40, bounds: o.bounds });
  const img = await svgImage(svg);
  const landscape = img.width >= img.height * 0.9;
  const pg = landscape ? newPage(ph, pw) : newPage(pw, ph);
  const { ctx } = pg;
  font(ctx, 9.5);
  const subW = ctx.measureText(o.sub).width;
  ctx.fillStyle = MUTED;
  text(ctx, o.sub, pg.w - M, M + 14, undefined, 'right');
  ctx.fillStyle = INK;
  font(ctx, 22, { serif: true });
  text(ctx, o.title, M, M + 16, pg.w - 2 * M - subW - 16);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(M, M + 28);
  ctx.lineTo(pg.w - M, M + 28);
  ctx.stroke();
  // legend above the footer: whose side each guest is on (chair colours)
  const legend: [string, string][] = [
    [p.settings.partner1 || 'Partner 1', '#8a7fd0'],
    [p.settings.partner2 || 'Partner 2', '#d47a86'],
    ['Both', '#5fae9c'],
  ];
  const ly = pg.h - 42;
  let lx = M;
  font(ctx, 8.5);
  for (const [label, color] of legend) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx + 4, ly - 3, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = MUTED;
    text(ctx, label, lx + 11, ly);
    lx += 18 + ctx.measureText(label).width + 10;
  }
  const boxX = M,
    boxY = M + 38,
    boxW = pg.w - 2 * M,
    boxH = ly - 16 - boxY;
  const s = Math.min(boxW / img.width, boxH / img.height);
  const dw = img.width * s,
    dh = img.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
  return pg;
}
