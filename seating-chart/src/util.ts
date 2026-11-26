import type { Settings } from './types';

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const snapTo = (v: number, step: number) => Math.round(v / step) * step;

export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export const FT_PER_M = 3.28084;

export function fmtLen(ft: number, s: Pick<Settings, 'units'>, digits = 1) {
  if (s.units === 'm') return `${(ft / FT_PER_M).toFixed(digits)} m`;
  return `${+ft.toFixed(digits)} ft`;
}

/** Convert a display value (ft or m) to feet. */
export const toFt = (v: number, s: Pick<Settings, 'units'>) => (s.units === 'm' ? v * FT_PER_M : v);
export const fromFt = (v: number, s: Pick<Settings, 'units'>) => (s.units === 'm' ? v / FT_PER_M : v);

export function initials(name: string) {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function lastName(name: string) {
  const p = name.trim().split(/\s+/);
  return p.length > 1 ? p[p.length - 1] : '';
}

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Rough "these might be the same person" check. */
export function likelySame(a: string, b: string) {
  const na = normName(a),
    nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = lastName(na),
    lb = lastName(nb);
  const fa = firstName(na),
    fb = firstName(nb);
  if (la && la === lb && fa && fb && (fa.startsWith(fb) || fb.startsWith(fa))) return true;
  return Math.max(na.length, nb.length) >= 8 && levenshtein(na, nb) <= 2;
}

export function download(filename: string, data: string | Blob, type = 'application/json') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'seating';
}

export const MEAL_COLORS = [
  'oklch(0.68 0.13 25)',
  'oklch(0.7 0.12 145)',
  'oklch(0.7 0.12 250)',
  'oklch(0.75 0.13 85)',
  'oklch(0.65 0.13 310)',
  'oklch(0.7 0.1 200)',
];

/** Distinct hues for tables/groups in the network view. */
export function hueColor(i: number, l = 0.68, c = 0.13) {
  const hue = (i * 137.508 + 20) % 360;
  return `oklch(${l} ${c} ${hue.toFixed(1)})`;
}
