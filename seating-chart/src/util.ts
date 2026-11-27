import type { Settings } from './types';

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const snapTo = (v: number, step: number) => Math.round(v / step) * step;

/** Lower-case, accent-free, punctuation-free name. Keeps letters from every script (e.g. 陳, Ελένη). */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** normName without titles and suffixes, for matching people across lists. */
export const matchKey = (s: string) =>
  normName(s)
    .split(' ')
    .filter((w) => !/^(mr|mrs|ms|mx|dr|jr|sr|ii|iii|iv|esq|phd|md)$/.test(w))
    .join(' ');

/** Han, kana and hangul: scripts that write names without spaces, family name first. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
export const hasCJK = (s: string) => CJK.test(s);

/**
 * Build a display name from first/last columns. Chinese (and Japanese/Korean) names are written
 * family name first with no space — 陳 + 大文 → 陳大文 — whichever column order the file used.
 */
export function joinName(first: string, last: string) {
  const f = first.trim(),
    l = last.trim();
  if (!f || !l) return f || l;
  if (hasCJK(f) && hasCJK(l) && !/[A-Za-z]/.test(f + l)) return (l + f).replace(/\s+/g, '');
  return `${f} ${l}`;
}

const COMPOUND_SURNAMES = /^(歐陽|欧阳|司馬|司马|諸葛|诸葛|上官|司徒|東方|东方|皇甫|令狐|夏侯|慕容|尉遲|尉迟|公孫|公孙|長孫|长孙|宇文|軒轅|轩辕|端木|西門|西门|澹臺|澹台|鍾離|钟离)/;

/** Family name: the last word of a Latin name, the leading character(s) of a CJK one. */
export function familyName(name: string) {
  const n = normName(name);
  const cjk = n.split(' ').filter(hasCJK);
  if (cjk.length) {
    // "大文 陳" (split, given name first) keeps the single-character word as the family name
    if (cjk.length > 1) return cjk.find((w) => w.length === 1 || COMPOUND_SURNAMES.test(w) && w.length === 2) ?? cjk[0];
    const w = cjk[0];
    const m = COMPOUND_SURNAMES.exec(w);
    return m && w.length > 2 ? m[1] : w.length > 1 ? w[0] : w;
  }
  return lastName(n);
}

/**
 * Keys a name can be matched by. `exact` keys keep the written order; `loose` keys allow the
 * parts in either order. CJK parts are joined without spaces, so 陳大文, "陳 大文" and
 * "大文 陳" all meet, and a mixed name like "David Chen 陳大文" matches either half on its own.
 */
export function nameKeys(name: string): { exact: string[]; loose: string[] } {
  const k = matchKey(name.replace(/\(([^)]*)\)/g, ' $1 '));
  if (!k) return { exact: [], loose: [] };
  const words = k.split(' ');
  const cjk = words.filter(hasCJK),
    lat = words.filter((w) => !hasCJK(w));
  const exact = new Set<string>([k]);
  const loose = new Set<string>();
  if (cjk.length) {
    exact.add(cjk.join(''));
    loose.add([...cjk].reverse().join(''));
  }
  if (lat.length && cjk.length) exact.add(lat.join(' '));
  if (lat.length === 2) loose.add(`${lat[1]} ${lat[0]}`);
  for (const e of exact) loose.delete(e);
  return { exact: [...exact], loose: [...loose] };
}

/** All keys for a guest: their name plus any other spellings saved as aliases. */
export function guestKeys(g: { name: string; aliases?: string[] }) {
  const exact = new Set<string>(),
    loose = new Set<string>();
  for (const n of [g.name, ...(g.aliases ?? [])]) {
    const k = nameKeys(n);
    k.exact.forEach((x) => exact.add(x));
    k.loose.forEach((x) => loose.add(x));
  }
  return { exact, loose };
}

/** True when `name` already matches the guest exactly (so it isn't worth saving as an alias). */
export const knownAs = (g: { name: string; aliases?: string[] }, name: string) => {
  const ks = guestKeys(g).exact;
  return nameKeys(name).exact.some((k) => ks.has(k));
};

/** "火鶴 Anthurium" → ["火鶴", "Anthurium"]; names without a Latin part come back whole. */
export function splitFlowerName(name: string): [string, string] {
  const m = /^([^A-Za-z]*[\u3400-\u9fff][^A-Za-z]*?)\s*([A-Za-z'].*)$/.exec(name.trim());
  return m ? [m[1].trim(), m[2].trim()] : [name.trim(), ''];
}

/** First two words of a Latin name, for tight labels. */
export const shortLatin = (s: string) => s.replace(/\(.*?\)/g, '').split(/[\s，,]+/).filter(Boolean).slice(0, 2).join(' ');

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
  const ka = nameKeys(a),
    kb = nameKeys(b);
  const sa = new Set([...ka.exact, ...ka.loose]);
  if ([...kb.exact, ...kb.loose].some((k) => sa.has(k))) return true;
  if (hasCJK(na) || hasCJK(nb)) return false;
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
