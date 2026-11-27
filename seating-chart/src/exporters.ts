import type { Guest, Project, Table } from './types';
import { CHAIR_R, projectBounds, seatLocal, tableFootprint, toWorld } from './geometry';
import { hasTableName, tableName, tableTitle, toast } from './store';
import { getDownloads } from './sync';
import { download, firstName, initials, lastName, slug } from './util';
import { groupTags } from './scoring';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Save a file through the claude.ai downloads capability when present, else a normal browser download. */
export async function saveFile(filename: string, data: string | Blob, type = 'text/plain') {
  const dl = getDownloads();
  try {
    if (dl) {
      await dl.save({ filename, data });
      toast(`Saved ${filename}`);
      return;
    }
    download(filename, data, type);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'declined') return;
    toast(code ? `Couldn't save the file (${code})` : "Couldn't save the file");
  }
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

function seatIndex(p: Project) {
  const m = new Map<string, { t: Table; seat: number }>();
  for (const t of p.tables) (p.seating[t.id] ?? []).forEach((g, i) => g && m.set(g, { t, seat: i + 1 }));
  return m;
}
const byLast = (a: Guest, b: Guest) => (lastName(a.name) || a.name).localeCompare(lastName(b.name) || b.name) || a.name.localeCompare(b.name);
const sideLabel = (p: Project, g: Guest) => (g.side === 'partner1' ? p.settings.partner1 : g.side === 'partner2' ? p.settings.partner2 : g.side === 'both' ? 'Both' : '');
const rsvpLabel = (g: Guest) => (g.rsvp === 'yes' ? 'Attending' : g.rsvp === 'no' ? 'Declined' : 'Pending');

export function guestListCsv(p: Project) {
  const idx = seatIndex(p);
  const rows: unknown[][] = [['Guest', 'Also known as', 'Table (中文)', 'Table (English)', 'Table number', 'Seat', 'Meal', 'Dietary / allergies', 'RSVP', 'Side', 'Groups', 'Household', 'Child', 'Notes']];
  const party = new Map<string, string[]>();
  for (const g of p.guests) if (g.party) party.set(g.party, [...(party.get(g.party) ?? []), g.name]);
  for (const g of [...p.guests].sort(byLast)) {
    const s = idx.get(g.id);
    rows.push([g.name, (g.aliases ?? []).join('; '), s?.t.nameZh ?? '', s?.t.nameEn ?? '', s?.t.label ?? '', s?.seat ?? '', g.meal, g.dietary, rsvpLabel(g), sideLabel(p, g), groupTags(g).join('; '), (party.get(g.party) ?? []).filter((n) => n !== g.name).join('; '), g.child ? 'Yes' : '', g.notes]);
  }
  return toCsv(rows);
}

const sortTables = (ts: Table[]) => [...ts].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

export function tablesCsv(p: Project) {
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const rows: unknown[][] = [['Table number', 'Table (中文)', 'Table (English)', 'Seat', 'Guest', 'Meal', 'Dietary / allergies']];
  for (const t of sortTables(p.tables)) (p.seating[t.id] ?? []).forEach((gid, i) => {
    const g = gid ? byId.get(gid) : undefined;
    rows.push([t.label, t.nameZh ?? '', t.nameEn ?? '', i + 1, g?.name ?? '(empty)', g?.meal ?? '', g?.dietary ?? '']);
  });
  return toCsv(rows);
}

export function mealSummary(p: Project) {
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const meals = [...new Set(p.guests.filter((g) => g.rsvp !== 'no').map((g) => g.meal || 'Not chosen'))].sort();
  const rows = sortTables(p.tables).map((t) => {
    const gs = (p.seating[t.id] ?? []).map((x) => (x ? byId.get(x) : undefined)).filter((g): g is Guest => !!g);
    const counts = meals.map((m) => gs.filter((g) => (g.meal || 'Not chosen') === m).length);
    return { t, gs, counts, dietary: gs.filter((g) => g.dietary.trim()).map((g) => `${g.name}: ${g.dietary}`) };
  });
  const totals = meals.map((_, i) => rows.reduce((a, r) => a + r.counts[i], 0));
  return { meals, rows, totals };
}

export function catererCsv(p: Project) {
  const { meals, rows, totals } = mealSummary(p);
  const out: unknown[][] = [['Table number', 'Table (中文)', 'Table (English)', 'Guests', ...meals, 'Dietary notes']];
  for (const r of rows) out.push([r.t.label, r.t.nameZh ?? '', r.t.nameEn ?? '', r.gs.length, ...r.counts, r.dietary.join(' | ')]);
  out.push(['Total', '', '', rows.reduce((a, r) => a + r.gs.length, 0), ...totals, '']);
  return toCsv(out);
}

// ---------- floor plan as standalone SVG (fixed light palette, print-friendly) ----------
const C = {
  bg: '#ffffff',
  grid: '#eef2f6',
  wall: '#2f3b37',
  zone: '#f1f4f8',
  zoneLine: '#9fb0c2',
  dance: '#e2eef8',
  table: '#ffffff',
  tableLine: '#3c4a45',
  ink: '#1f2a26',
  muted: '#6b7a74',
  seat: '#ffffff',
  p1: '#8a7fd0',
  p2: '#d47a86',
  both: '#5fae9c',
  none: '#a9b5b0',
  door: '#6b7a74',
};

export function planSvg(p: Project, opts: { names?: boolean; scale?: number } = {}) {
  const b = projectBounds(p);
  const pad = 4;
  const x0 = b.x0 - pad,
    y0 = b.y0 - pad - 3,
    w = b.x1 - b.x0 + pad * 2,
    h = b.y1 - b.y0 + pad * 2 + 3;
  const S = opts.scale ?? 14; // px per ft
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const parts: string[] = [];
  parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${C.bg}"/>`);
  parts.push(`<text x="${x0 + 1.5}" y="${y0 + 2.4}" font-family="Georgia, serif" font-size="2" fill="${C.ink}">${esc(p.name)}</text>`);
  for (const e of p.elements) {
    if (e.kind === 'zone') {
      parts.push(`<g transform="translate(${e.x} ${e.y}) rotate(${e.rotation})"><rect x="${-e.w / 2}" y="${-e.h / 2}" width="${e.w}" height="${e.h}" rx="0.4" fill="${e.zone === 'dance' ? C.dance : C.zone}" stroke="${C.zoneLine}" stroke-width="0.08" stroke-dasharray="0.4 0.3"/><text text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="0.9" fill="${C.muted}" transform="rotate(${-e.rotation})">${esc(e.label)}</text></g>`);
    }
  }
  for (const e of p.elements) {
    if (e.kind === 'wall') parts.push(`<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${C.wall}" stroke-width="${e.thickness}" stroke-linecap="square"/>`);
    if (e.kind === 'column') parts.push(e.round ? `<circle cx="${e.x}" cy="${e.y}" r="${e.size / 2}" fill="${C.wall}"/>` : `<rect x="${e.x - e.size / 2}" y="${e.y - e.size / 2}" width="${e.size}" height="${e.size}" fill="${C.wall}"/>`);
    if (e.kind === 'door')
      parts.push(`<g transform="translate(${e.x} ${e.y}) rotate(${e.rotation})"><line x1="${-e.w / 2}" y1="0" x2="${e.w / 2}" y2="0" stroke="${C.bg}" stroke-width="1.2"/><path d="M ${-e.w / 2} 0 L ${-e.w / 2} ${e.w} A ${e.w} ${e.w} 0 0 0 ${e.w / 2} 0" fill="none" stroke="${C.door}" stroke-width="0.08" stroke-dasharray="0.25 0.25"/></g>`);
    if (e.kind === 'window') parts.push(`<g transform="translate(${e.x} ${e.y}) rotate(${e.rotation})"><line x1="${-e.w / 2}" y1="-0.2" x2="${e.w / 2}" y2="-0.2" stroke="#5a86c5" stroke-width="0.12"/><line x1="${-e.w / 2}" y1="0.2" x2="${e.w / 2}" y2="0.2" stroke="#5a86c5" stroke-width="0.12"/></g>`);
  }
  for (const t of p.tables) {
    const shape =
      t.shape === 'round'
        ? `<circle r="${t.w / 2}"`
        : t.shape === 'oval'
          ? `<ellipse rx="${t.w / 2}" ry="${t.h / 2}"`
          : `<rect x="${-t.w / 2}" y="${-t.h / 2}" width="${t.w}" height="${t.h}" rx="0.15"`;
    parts.push(`<g transform="translate(${t.x} ${t.y}) rotate(${t.rotation})">${shape} fill="${C.table}" stroke="${C.tableLine}" stroke-width="0.09"/></g>`);
    const { main: nm, sub: en } = tableTitle(t);
    const sub = hasTableName(t) ? t.label : '';
    const y0 = t.y + (en ? -0.5 : sub ? -0.1 : 0.35);
    parts.push(`<text x="${t.x}" y="${y0}" text-anchor="middle" font-family="Georgia, serif" font-size="1" fill="${C.ink}">${esc(nm)}</text>`);
    if (en) parts.push(`<text x="${t.x}" y="${y0 + 0.8}" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="0.6" fill="${C.ink}">${esc(en)}</text>`);
    if (sub) parts.push(`<text x="${t.x}" y="${(en ? y0 + 0.8 : t.y) + 0.85}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="0.55" letter-spacing="0.05" fill="${C.muted}">${esc(sub.toUpperCase())}</text>`);
    const seats = p.seating[t.id] ?? [];
    seatLocal(t).forEach((lp, i) => {
      const wp = toWorld(t, lp);
      const g = seats[i] ? byId.get(seats[i]!) : undefined;
      const fill = g ? (g.side === 'partner1' ? C.p1 : g.side === 'partner2' ? C.p2 : g.side === 'both' ? C.both : C.none) : C.seat;
      parts.push(`<circle cx="${wp.x}" cy="${wp.y}" r="${CHAIR_R}" fill="${fill}" stroke="${C.tableLine}" stroke-width="0.07"/>`);
      if (g) {
        parts.push(`<text x="${wp.x}" y="${wp.y + 0.2}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="0.55" font-weight="700" fill="#fff">${esc(initials(g.name))}</text>`);
        if (opts.names !== false) {
          const out = { x: wp.x - t.x, y: wp.y - t.y };
          const d = Math.hypot(out.x, out.y) || 1;
          const nx = out.x / d,
            ny = out.y / d;
          const anchor = nx > 0.35 ? 'start' : nx < -0.35 ? 'end' : 'middle';
          parts.push(`<text x="${wp.x + nx * (CHAIR_R + 0.2)}" y="${wp.y + ny * (CHAIR_R + 0.2) + (ny > 0.35 ? 0.5 : ny < -0.35 ? -0.1 : 0.2)}" text-anchor="${anchor}" font-family="Helvetica, Arial, sans-serif" font-size="0.6" fill="${C.ink}">${esc(firstName(g.name))}</text>`);
        }
      }
    });
    void tableFootprint;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${Math.round(w * S)}" height="${Math.round(h * S)}">${parts.join('')}</svg>`;
}

export async function planPng(p: Project): Promise<Blob> {
  const svg = planSvg(p, { scale: 22 });
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('render failed'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A complete, print-ready HTML document: floor plan, table cards, escort list and meal counts. */
export function seatingChartHtml(p: Project) {
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const idx = seatIndex(p);
  const tables = sortTables(p.tables).filter((t) => (p.seating[t.id] ?? []).some(Boolean));
  const { meals, rows, totals } = mealSummary(p);
  const cards = tables
    .map((t) => {
      const gs = (p.seating[t.id] ?? []).map((x) => (x ? byId.get(x) : undefined)).filter((g): g is Guest => !!g);
      return `<section class="card"><h3>${esc(tableTitle(t).main)}</h3>${tableTitle(t).sub ? `<div class="en">${esc(tableTitle(t).sub)}</div>` : ''}${hasTableName(t) ? `<div class="num">${esc(t.label)}</div>` : ''}<ol>${gs.map((g) => `<li>${esc(g.name)}${g.meal ? ` <span class="meal">${esc(g.meal)}</span>` : ''}${g.dietary ? ` <span class="diet">${esc(g.dietary)}</span>` : ''}</li>`).join('')}</ol></section>`;
    })
    .join('');
  const escort = p.guests
    .filter((g) => idx.has(g.id))
    .sort(byLast)
    .map((g) => `<tr><td>${esc(g.name)}</td><td>${esc(tableName(idx.get(g.id)!.t))}</td><td>${esc(g.meal)}</td></tr>`)
    .join('');
  const meal = `<table class="grid"><thead><tr><th>Table</th>${meals.map((m) => `<th>${esc(m)}</th>`).join('')}<th>Dietary notes</th></tr></thead><tbody>${rows
    .filter((r) => r.gs.length)
    .map((r) => `<tr><td>${esc(tableName(r.t))}</td>${r.counts.map((c) => `<td>${c || ''}</td>`).join('')}<td>${esc(r.dietary.join('; '))}</td></tr>`)
    .join('')}<tr class="tot"><td>Total</td>${totals.map((c) => `<td>${c}</td>`).join('')}<td></td></tr></tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} · Seating chart</title>
<style>
body{font:14px/1.45 Helvetica,Arial,sans-serif;color:#1f2a26;margin:0;padding:32px;max-width:1100px;margin-inline:auto}
h1,h2,h3{font-family:Georgia,'Times New Roman',serif;font-weight:400;margin:0}
h1{font-size:40px}h2{font-size:26px;margin:36px 0 12px;break-after:avoid}
.plan svg{width:100%;height:auto;border:1px solid #dfe6e2;border-radius:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.card{border:1px solid #dfe6e2;border-radius:10px;padding:12px 14px;break-inside:avoid}
.card h3{font-size:22px;margin-bottom:0}.en{font-style:italic;font-size:15px;color:#3d4a45;margin:2px 0 4px}.num{color:#6b7a74;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.card ol{margin:8px 0 0;padding-left:20px}.meal{color:#6b7a74;font-size:12px}.diet{color:#a35a1e;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid #e7ece9}th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7a74}
.tot td{font-weight:700}.escort{columns:2;column-gap:28px}.escort table{break-inside:auto}
@media print{body{padding:0}.page{break-before:page}}
</style></head><body>
<h1>${esc(p.name)}</h1><p style="color:#6b7a74">${p.guests.filter((g) => idx.has(g.id)).length} guests at ${tables.length} tables</p>
<div class="plan">${planSvg(p)}</div>
<h2 class="page">Tables</h2><div class="cards">${cards}</div>
<h2 class="page">Guest list by name</h2><table><thead><tr><th>Guest</th><th>Table</th><th>Meal</th></tr></thead><tbody>${escort}</tbody></table>
<h2 class="page">Meals by table</h2>${meal}
</body></html>`;
}

export function backupJson(p: Project) {
  return JSON.stringify({ ...p, exportedAt: new Date().toISOString() }, null, 1);
}

export function layoutJson(p: Project) {
  return JSON.stringify({ version: 1, name: p.name, guests: [], relations: [], tables: p.tables.map((t) => ({ ...t })), elements: p.elements, seating: Object.fromEntries(p.tables.map((t) => [t.id, Array(t.seats).fill(null)])), settings: p.settings }, null, 1);
}

export const fileBase = (p: Project) => slug(p.name);
