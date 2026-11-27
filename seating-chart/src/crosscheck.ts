/**
 * Crosscheck a second RSVP / meal-choice list against the guests already in the chart.
 * Nothing is changed here: it produces a reconciliation the person reviews before applying.
 */
import type { Guest, Id, Rsvp } from './types';
import { toRsvp, type Parsed } from './importer';
import { scrubText } from './privacy';
import { familyName, guestKeys, joinName, likelySame, nameKeys, normName } from './util';

export type CField = 'name' | 'first' | 'last' | 'extId' | 'rsvp' | 'meal' | 'dietary' | 'notes';
export const CFIELDS: { f: CField; label: string; re: RegExp }[] = [
  { f: 'first', label: 'First name', re: /^(first|given)[ _-]?name$|^first$/i },
  { f: 'last', label: 'Last name', re: /^(last|family|sur)[ _-]?name$|^last$|^surname$/i },
  { f: 'name', label: 'Full name', re: /^(full[ _-]?)?name$|^guest([ _-]?name)?$|^display[ _-]?name$|^attendee$|^respondent$/i },
  { f: 'extId', label: 'Guest ID (Joy)', re: /^(id|guest[ _-]?id|uuid|joy[ _-]?id)$/i },
  { f: 'rsvp', label: 'RSVP', re: /rsvp|attend|response|status|coming|reception/i },
  { f: 'meal', label: 'Meal choice', re: /meal|entr[eé]e|menu|dinner|food|main/i },
  { f: 'dietary', label: 'Dietary / allergies', re: /diet|allerg|restriction/i },
  { f: 'notes', label: 'Notes', re: /note|comment|message/i },
];

export function detectCrossMapping(p: Parsed): Partial<Record<CField, string>> {
  const m: Partial<Record<CField, string>> = {};
  const used = new Set<string>();
  const clean = (h: string) => h.replace(/\s*\((optional|required)\)\s*/gi, ' ').trim();
  if (p.rsvpColumns.length) {
    m.rsvp = p.rsvpColumns.find((h) => /reception/i.test(h)) ?? p.rsvpColumns.find((h) => /wedding/i.test(h)) ?? p.rsvpColumns[0];
    used.add(m.rsvp);
  }
  for (const { f, re } of CFIELDS) {
    if (m[f]) continue;
    const h = p.headers.find((x) => !used.has(x) && re.test(clean(x)));
    if (h) {
      m[f] = h;
      used.add(h);
    }
  }
  if (m.first && m.name === m.first) delete m.name;
  return m;
}

export type MatchHow = 'id' | 'name' | 'reversed' | 'fuzzy' | 'manual' | 'none';

export interface CrossRow {
  /** Row index in the file */
  i: number;
  fileName: string;
  rsvp: Rsvp | null;
  rawRsvp: string;
  meal: string;
  dietary: string;
  notes: string;
  guestId: Id | null;
  how: MatchHow;
  /** Other guests this row could be (when ambiguous) */
  candidates: Id[];
}

export interface Diff {
  field: 'rsvp' | 'meal' | 'dietary';
  from: string;
  to: string;
}

const rsvpWord = (r: Rsvp) => (r === 'yes' ? 'Coming' : r === 'no' ? 'Declined' : 'Pending');

export function buildRows(parsed: Parsed, m: Partial<Record<CField, string>>): CrossRow[] {
  const get = (r: Record<string, string>, f: CField) => (m[f] ? scrubText((r[m[f]!] ?? '').toString().trim()) : '');
  return parsed.rows
    .map((r, i) => {
      const name = get(r, 'name') || joinName(get(r, 'first'), get(r, 'last'));
      const raw = get(r, 'rsvp');
      return { i, fileName: name, rsvp: m.rsvp ? (raw ? toRsvp(raw) : null) : null, rawRsvp: raw, meal: get(r, 'meal'), dietary: get(r, 'dietary'), notes: get(r, 'notes'), guestId: null, how: 'none' as MatchHow, candidates: [], extId: get(r, 'extId') };
    })
    .filter((r) => r.fileName || r.extId)
    .map(({ extId, ...r }) => ({ ...r, extId }) as CrossRow & { extId: string });
}

/** Match file rows to guests: Joy ID, then exact name, then "Last, First", then a unique close spelling. */
export function matchRows(rows: (CrossRow & { extId?: string })[], guests: Guest[]): CrossRow[] {
  const byExt = new Map(guests.filter((g) => g.extId).map((g) => [g.extId!, g.id]));
  // every spelling a guest is known by (name + aliases), exact order and either order
  const byName = new Map<string, Id[]>();
  const byLoose = new Map<string, Id[]>();
  const add = (m: Map<string, Id[]>, k: string, id: Id) => {
    const cur = m.get(k) ?? [];
    if (!cur.includes(id)) m.set(k, [...cur, id]);
  };
  for (const g of guests) {
    const ks = guestKeys(g);
    ks.exact.forEach((k) => add(byName, k, g.id));
    ks.loose.forEach((k) => add(byLoose, k, g.id));
  }
  const look = (m: Map<string, Id[]>, keys: string[]) => [...new Set(keys.flatMap((k) => m.get(k) ?? []))];
  const taken = new Set<Id>();
  const out: CrossRow[] = [];
  // pass 1: certain matches
  for (const r of rows) {
    let id: Id | undefined;
    let how: MatchHow = 'none';
    if (r.extId && byExt.has(r.extId)) {
      id = byExt.get(r.extId);
      how = 'id';
    } else {
      const k = nameKeys(r.fileName);
      const exact = look(byName, k.exact);
      const commaRev = /,/.test(r.fileName) ? nameKeys(r.fileName.split(',').reverse().join(' ')).exact : [];
      const rev = look(byName, [...k.loose, ...commaRev]).concat(look(byLoose, k.exact)).filter((x, i, a) => a.indexOf(x) === i);
      if (exact.length === 1) {
        id = exact[0];
        how = 'name';
      } else if (rev.length === 1) {
        id = rev[0];
        how = 'reversed';
      } else if (exact.length > 1) out.push({ ...r, candidates: exact });
    }
    if (id && !taken.has(id)) {
      taken.add(id);
      out.push({ ...r, guestId: id, how });
    } else if (!out.some((x) => x.i === r.i)) out.push({ ...r });
  }
  // pass 2: close spellings for the rest, only when exactly one untaken guest fits
  for (const r of out) {
    if (r.guestId || r.candidates.length) continue;
    const cands = guests.filter((g) => !taken.has(g.id) && (likelySame(g.name, r.fileName) || sameInitialAndLast(g.name, r.fileName))).map((g) => g.id);
    if (cands.length === 1) {
      r.guestId = cands[0];
      r.how = 'fuzzy';
      taken.add(cands[0]);
    } else if (cands.length > 1) r.candidates = cands;
  }
  return out;
}

function sameInitialAndLast(a: string, b: string) {
  const la = familyName(a),
    lb = familyName(b);
  if (!la || la !== lb) return false;
  return normName(a)[0] === normName(b)[0];
}

export function diffsFor(r: CrossRow, g: Guest): Diff[] {
  const d: Diff[] = [];
  if (r.rsvp && r.rsvp !== g.rsvp) d.push({ field: 'rsvp', from: rsvpWord(g.rsvp), to: rsvpWord(r.rsvp) });
  if (r.meal && normName(r.meal) !== normName(g.meal)) d.push({ field: 'meal', from: g.meal || '—', to: r.meal });
  if (r.dietary && normName(r.dietary) !== normName(g.dietary)) d.push({ field: 'dietary', from: g.dietary || '—', to: r.dietary });
  return d;
}

export { rsvpWord };
