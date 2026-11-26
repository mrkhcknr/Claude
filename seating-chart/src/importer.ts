import Papa from 'papaparse';
import type { Guest, Rsvp, Side } from './types';
import { lastName, likelySame, normName, uid } from './util';

export type Field =
  | 'name'
  | 'first'
  | 'last'
  | 'party'
  | 'group'
  | 'side'
  | 'rsvp'
  | 'meal'
  | 'dietary'
  | 'child'
  | 'accessible'
  | 'notes'
  | 'table'
  | 'plusOne'
  | 'plusOneOf'
  | 'address'
  | 'suffix'
  | 'extId';

export const FIELD_LABEL: Record<Field, string> = {
  name: 'Full name',
  first: 'First name',
  last: 'Last name',
  party: 'Party / household',
  group: 'Group / tags',
  side: 'Side',
  rsvp: 'RSVP',
  meal: 'Meal choice',
  dietary: 'Dietary / allergies',
  child: 'Child / age',
  accessible: 'Accessibility',
  notes: 'Notes',
  table: 'Table (existing)',
  plusOne: 'Plus-one allowed',
  plusOneOf: 'Plus-one of (host)',
  address: 'Address (to infer households)',
  suffix: 'Name suffix',
  extId: 'Guest ID (for re-import)',
};

/** Header patterns. Covers generic spreadsheets plus common wedding-site exports (Joy, Zola, The Knot…). */
const PATTERNS: [Field, RegExp][] = [
  ['first', /^(first|given)[ _-]?name$|^first$/i],
  ['last', /^(last|family|sur)[ _-]?name$|^last$|^surname$/i],
  ['name', /^(full[ _-]?)?name$|^guest([ _-]?name)?$|^display[ _-]?name$/i],
  ['party', /party|household|family[ _-]?(id|group)|invite(e)?[ _-]?(group|id)?$|^group[ _-]?(name|id)$|rsvp[ _-]?group/i],
  ['group', /^(groups?|tags?|labels?|categor(y|ies)|circle|relationship|lists?)$/i],
  ['extId', /^(id|guest[ _-]?id|uuid|record[ _-]?id)$/i],
  ['suffix', /^suffix$/i],
  ['plusOneOf', /plus[ _-]?one[ _-]?of|^guest[ _-]?of$|^host$/i],
  ['side', /^side$|bride[ _-]?or[ _-]?groom|whose[ _-]?guest|^invited[ _-]?by$/i],
  ['rsvp', /rsvp|attend|response|status/i],
  ['meal', /meal|entr[eé]e|menu|dinner|food[ _-]?choice/i],
  ['dietary', /diet|allerg|restriction/i],
  ['child', /child|kid|^age|minor/i],
  ['accessible', /access|wheelchair|mobility|ada\b/i],
  ['notes', /note|comment/i],
  ['table', /^table([ _-]?(number|no|#|name))?$/i],
  ['plusOne', /plus[ _-]?one|\+ ?1|guest[ _-]?allowed|additional[ _-]?guests?/i],
  ['address', /^(street[ _-]?)?address([ _-]?(line)?[ _-]?1)?$|mailing[ _-]?address/i],
];

export type Mapping = Partial<Record<Field, string>>;

export interface Parsed {
  headers: string[];
  rows: Record<string, string>[];
  /** Header columns that look like RSVP-per-event (e.g. "Reception RSVP", "Welcome Party"). */
  rsvpColumns: string[];
  source: 'joy' | 'generic';
}

/** "Tags (Optional)" → "Tags" */
export const cleanHeader = (h: string) => h.replace(/\s*\((optional|required)\)\s*/gi, ' ').trim();

const RSVP_VALUE = /^(attending|not attending|declined|accepted|yes|no|maybe|no response|awaiting response|pending|invited|regrets?)$/i;

export function parseCsv(text: string): Parsed {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  const headers = (res.meta.fields ?? []).filter(Boolean);
  const rows = res.data.filter((r) => Object.values(r).some((v) => (v ?? '').toString().trim()));
  // An event/RSVP column is one whose filled values all look like RSVP answers (Joy uses one column per event).
  const rsvpColumns = headers.filter((h) => {
    const vals = rows.map((r) => (r[h] ?? '').trim()).filter(Boolean);
    return /rsvp|attend|response/i.test(h) || (vals.length > 0 && vals.every((v) => RSVP_VALUE.test(v)));
  });
  const joyish = headers.some((h) => /name on envelope|plus one of/i.test(h)) || (headers.some((h) => /^party \(optional\)$/i.test(h)) && headers.some((h) => /^first name$/i.test(h)));
  return { headers, rows, rsvpColumns, source: joyish ? 'joy' : 'generic' };
}

export function detectMapping(headers: string[], rsvpColumns: string[] = []): Mapping {
  const m: Mapping = {};
  const used = new Set<string>();
  if (rsvpColumns.length) {
    // prefer the reception/wedding event when several exist (Joy: "Wedding Ceremony & Reception")
    const pick = rsvpColumns.find((h) => /reception/i.test(h)) ?? rsvpColumns.find((h) => /wedding/i.test(h)) ?? rsvpColumns[0];
    m.rsvp = pick;
    rsvpColumns.forEach((h) => used.add(h));
  }
  for (const [field, re] of PATTERNS) {
    if (m[field]) continue;
    const candidates = headers.filter((h) => !used.has(h) && re.test(cleanHeader(h)));
    if (!candidates.length) continue;
    let pick = candidates[0];
    if (field === 'rsvp') pick = candidates.find((h) => /reception|wedding|dinner/i.test(h)) ?? candidates[0];
    if (field === 'meal') pick = candidates.find((h) => /reception|wedding|dinner|meal/i.test(h)) ?? candidates[0];
    m[field] = pick;
    used.add(pick);
  }
  if (m.first && m.name && m.first === m.name) delete m.name;
  return m;
}

export function toRsvp(v: string): Rsvp {
  const s = v.trim().toLowerCase();
  if (!s) return 'pending';
  if (/not attend|declin|regret|^no\b|^n$|can'?t|won'?t|^false$|^0$/.test(s)) return 'no';
  if (/^(y|yes|attending|accepted?|going|confirmed|will attend|joyfully accepts?|true|1)$/.test(s) || /^attend|accept|yes/.test(s)) return 'yes';
  if (/^(n|no|declined?|not attending|regrets?|can'?t|won'?t|false|0)$/.test(s) || /declin|regret|not attend|^no\b/.test(s)) return 'no';
  return 'pending';
}

const truthy = (v: string) => /^(y|yes|true|1|x|✓|child|kid|minor)$/i.test(v.trim()) || (/^\d+$/.test(v.trim()) && +v < 13 && +v > 0);

export interface ImportOptions {
  mapping: Mapping;
  /** All event RSVP columns (stored on the guest as the events they attend). */
  eventColumns?: string[];
  /** How to group people into households when there's no party column. */
  households: 'column' | 'address' | 'lastName' | 'none';
  /** Expand "Jane & John Smith" into two linked guests. */
  splitCouples: boolean;
  /** Create "Guest of X" placeholders for plus-ones. */
  plusOnes: boolean;
  partner1: string;
  partner2: string;
}

export interface ImportRow {
  guest: Guest;
  table?: string;
  /** Raw "plus one of" value: host's name or ID. */
  plusOneOf?: string;
}

export function rowsToGuests(rows: Record<string, string>[], o: ImportOptions): ImportRow[] {
  const get = (r: Record<string, string>, f: Field) => (o.mapping[f] ? (r[o.mapping[f]!] ?? '').toString().trim() : '');
  const out: ImportRow[] = [];
  const partyKeys = new Map<string, string>();
  const keyFor = (k: string) => {
    const n = normName(k);
    if (!n) return '';
    if (!partyKeys.has(n)) partyKeys.set(n, uid());
    return partyKeys.get(n)!;
  };

  for (const r of rows) {
    let name = get(r, 'name');
    const first = get(r, 'first'),
      last = get(r, 'last');
    if (!name) name = [first, last].filter(Boolean).join(' ');
    const suffix = get(r, 'suffix');
    if (name && suffix) name += (/^(jr|sr)\.?$/i.test(suffix) ? ', ' : ' ') + suffix;
    if (!name) continue;

    let partyKey = '';
    if (o.households === 'column') partyKey = keyFor(get(r, 'party'));
    else if (o.households === 'address') partyKey = keyFor(get(r, 'address'));
    else if (o.households === 'lastName') partyKey = keyFor(lastName(name));

    const names = o.splitCouples ? splitCouple(name) : [name];
    if (names.length > 1 && !partyKey) partyKey = uid();

    const base: Omit<Guest, 'id' | 'name'> = {
      party: partyKey,
      group: get(r, 'group')
        .split(/[|;,]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .join(', '),
      side: toSide(get(r, 'side'), o),
      rsvp: o.mapping.rsvp ? toRsvp(get(r, 'rsvp')) : 'yes',
      meal: get(r, 'meal'),
      dietary: get(r, 'dietary'),
      child: truthy(get(r, 'child')),
      accessible: !!get(r, 'accessible') && !/^(n|no|none|false|0)$/i.test(get(r, 'accessible')),
      notes: get(r, 'notes'),
      pinned: false,
      events: (o.eventColumns ?? []).filter((h) => toRsvp(r[h] ?? '') === 'yes'),
    };
    const table = get(r, 'table') || undefined;
    const extId = get(r, 'extId') || undefined;
    for (const n of names) out.push({ guest: { ...base, id: uid(), name: n, extId: names.length === 1 ? extId : undefined }, table, plusOneOf: get(r, 'plusOneOf') || undefined });

    const plus = get(r, 'plusOne');
    if (o.plusOnes && plus && !/^(n|no|none|false|0)$/i.test(plus)) {
      const count = /^\d+$/.test(plus) ? Math.min(5, +plus) : 1;
      const named = !/^(y|yes|true|1|x|\d+)$/i.test(plus) ? plus : '';
      if (!base.party) base.party = uid();
      for (const ex of out.slice(-names.length)) ex.guest.party = base.party;
      for (let k = 0; k < count; k++)
        out.push({ guest: { ...base, id: uid(), name: named && k === 0 ? named : `Guest of ${names[0]}`, meal: '', dietary: '', notes: 'Plus-one' }, table });
    }
  }
  // "Plus One Of" (Joy): attach plus-ones to their host's household
  const byKey = new Map<string, Guest>();
  for (const row of out) {
    if (row.guest.extId) byKey.set(row.guest.extId.toLowerCase(), row.guest);
    byKey.set(normName(row.guest.name), row.guest);
  }
  for (const row of out) {
    if (!row.plusOneOf) continue;
    const host = byKey.get(row.plusOneOf.toLowerCase()) ?? byKey.get(normName(row.plusOneOf));
    if (!host) continue;
    if (!host.party) host.party = uid();
    row.guest.party = host.party;
    if (!row.guest.notes) row.guest.notes = `Plus-one of ${host.name}`;
  }
  return out;
}

function toSide(v: string, o: ImportOptions): Side {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if (/both|mutual|shared/.test(s)) return 'both';
  const p1 = o.partner1.toLowerCase(),
    p2 = o.partner2.toLowerCase();
  if (s === '1' || /bride/.test(s) || (p1 && s.includes(p1.split(' ')[0]))) return 'partner1';
  if (s === '2' || /groom/.test(s) || (p2 && s.includes(p2.split(' ')[0]))) return 'partner2';
  return '';
}

/** "John & Jane Smith" → ["John Smith","Jane Smith"]; "Mr. and Mrs. Lee" → ["Mr. Lee","Mrs. Lee"]; "Sam Diaz +1" → ["Sam Diaz","Guest of Sam Diaz"] */
export function splitCouple(raw: string): string[] {
  let s = raw.replace(/\s+/g, ' ').trim();
  const plus = /\s*(\+\s*1|\+ ?guest|and guest|& guest)$/i.exec(s);
  if (plus) {
    s = s.slice(0, plus.index).trim();
    return [...splitCouple(s), `Guest of ${s}`];
  }
  const m = /^(.+?)\s+(?:&|and|\+)\s+(.+)$/i.exec(s);
  if (!m) return [s];
  const [, a, b] = m;
  const bParts = b.split(' ');
  const aParts = a.split(' ');
  // "John & Jane Smith": a has one word → borrow last name from b
  if (aParts.length === 1 && bParts.length > 1) return [`${a} ${bParts[bParts.length - 1]}`, b];
  if (/^(mr|mrs|ms|mx|dr)\.?$/i.test(a) && bParts.length > 1) return [`${a} ${bParts[bParts.length - 1]}`, b];
  return [a, b];
}

/**
 * Paste format: one name per line. Lines ending with ":" start a group, e.g.
 *   College friends:
 *   Alex & Sam Rivera
 *   Priya Patel +1
 * Tab- or comma-separated text with a header row is treated as CSV.
 */
export function parsePaste(text: string): { csv: Parsed } | { guests: Guest[] } {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? '';
  if (/\t/.test(first) || (/,/.test(first) && /name/i.test(first))) {
    return { csv: parseCsv(text.includes('\t') ? text.replace(/\t/g, ',').replace(/^|$/gm, '') : text) };
  }
  let group = '';
  const guests: Guest[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/:$/.test(l)) {
      group = l.slice(0, -1).trim();
      continue;
    }
    const names = splitCouple(l.replace(/^[-*•\d.)\s]+/, ''));
    const party = names.length > 1 ? uid() : '';
    for (const n of names)
      guests.push({ id: uid(), name: n, party, group, side: '', rsvp: 'yes', meal: '', dietary: '', child: false, accessible: false, notes: /^Guest of /.test(n) ? 'Plus-one' : '', pinned: false });
  }
  return { guests };
}

export interface MergePlan {
  add: ImportRow[];
  update: { existing: Guest; incoming: Guest; table?: string }[];
  possibleDupes: { incoming: Guest; existing: Guest }[];
}

/** Match incoming rows to existing guests by name so re-importing an updated RSVP list keeps seating. */
export function planMerge(existing: Guest[], incoming: ImportRow[]): MergePlan {
  const byName = new Map(existing.map((g) => [normName(g.name), g]));
  const byExt = new Map(existing.filter((g) => g.extId).map((g) => [g.extId!, g]));
  const plan: MergePlan = { add: [], update: [], possibleDupes: [] };
  for (const row of incoming) {
    const hit = (row.guest.extId && byExt.get(row.guest.extId)) || byName.get(normName(row.guest.name));
    if (hit && !/^guest of /i.test(row.guest.name)) {
      plan.update.push({ existing: hit, incoming: row.guest, table: row.table });
      continue;
    }
    plan.add.push(row);
    const near = existing.find((g) => likelySame(g.name, row.guest.name));
    if (near) plan.possibleDupes.push({ incoming: row.guest, existing: near });
  }
  return plan;
}

/** Suggested defaults once a file is parsed. */
export function suggestOptions(parsed: Parsed): Pick<ImportOptions, 'households' | 'splitCouples' | 'plusOnes' | 'eventColumns'> {
  const m = detectMapping(parsed.headers, parsed.rsvpColumns);
  return {
    households: m.party ? 'column' : m.address ? 'address' : 'none',
    // Joy and most sites already have one row per person
    splitCouples: !m.first,
    plusOnes: !!m.plusOne,
    eventColumns: parsed.rsvpColumns,
  };
}
