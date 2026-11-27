/**
 * Ask Claude (via the claude.ai artifact `sample` capability) to turn plain-language seating wishes
 * into rule weights and ties, and to review a finished seating. Claude proposes; the person approves;
 * the optimiser does the actual placement.
 */
import type { Bond, Id, Project, SeatRule } from './types';
import { BONDS, SEAT_RULES } from './relations';
import { POINT_KINDS, POINT_LABEL, pointsOf, rulesOf, type PointKind, type PointRow } from './rules';
import { tableName } from './store';
import { analyse, groupTags } from './scoring';

interface SampleFn {
  (input: string | { role: 'user' | 'assistant'; content: string }[], opts?: Record<string, unknown>): Promise<{ text: string; truncated: boolean }>;
  json<T>(input: string, opts?: Record<string, unknown>): Promise<T>;
}

let samplePromise: Promise<SampleFn | null> | null = null;
export function getSample(): Promise<SampleFn | null> {
  if (!samplePromise) samplePromise = window.claude ? (window.claude.use('sample') as Promise<SampleFn | null>).catch(() => null) : Promise.resolve(null);
  return samplePromise;
}

export const SAMPLE_ERRORS: Record<string, string> = {
  not_granted: 'Claude is turned off for this page. Allow it from the page’s permissions to use this.',
  rate_limited: 'Claude is busy. Wait a moment and try again.',
  invalid_json: 'Claude’s answer couldn’t be read. Try rephrasing or asking for less at once.',
  cancelled: 'Stopped.',
};
export const errText = (e: unknown) => {
  const c = (e as { code?: string })?.code ?? '';
  return SAMPLE_ERRORS[c] ?? `Claude couldn’t answer (${c || 'error'}). Try again.`;
};

/** Compact roster with short ids (g1, g2…) so prompts stay small and answers can be validated. */
function roster(p: Project) {
  const coming = p.guests.filter((g) => g.rsvp !== 'no');
  const gid = new Map<Id, string>();
  const back = new Map<string, Id>();
  coming.forEach((g, i) => {
    gid.set(g.id, 'g' + (i + 1));
    back.set('g' + (i + 1), g.id);
  });
  const tid = new Map<Id, string>();
  const tback = new Map<string, Id>();
  p.tables.forEach((t, i) => {
    tid.set(t.id, 't' + (i + 1));
    tback.set('t' + (i + 1), t.id);
  });
  const tableOf = new Map<Id, Id>();
  for (const [t, arr] of Object.entries(p.seating)) arr.forEach((g) => g && tableOf.set(g, t));
  const s = p.settings;
  const side = (x: string) => (x === 'partner1' ? s.partner1 : x === 'partner2' ? s.partner2 : x === 'both' ? 'both' : '');
  const partyNo = new Map<string, number>();
  const lines = coming.map((g) => {
    let hh = '';
    if (g.party) {
      if (!partyNo.has(g.party)) partyNo.set(g.party, partyNo.size + 1);
      hh = 'h' + partyNo.get(g.party);
    }
    const t = tableOf.get(g.id);
    return [gid.get(g.id), g.name, groupTags(g).join('; '), side(g.side), hh, g.child ? 'child' : '', t ? tid.get(t) : ''].join(' | ');
  });
  const ties = p.relations
    .filter((r) => gid.has(r.a) && gid.has(r.b))
    .map((r) => `${gid.get(r.a)} ${r.kind}${r.seat ? '+' + r.seat : ''}${r.contexts?.length ? ` (${r.contexts.join('; ')})` : ''} ${gid.get(r.b)}`);
  const tables = p.tables.map((t) => `${tid.get(t.id)} | ${tableName(t)} | ${t.seats} seats${t.area ? ` | area: ${t.area}` : ''}${t.reservedFor ? ` | table tags: ${t.reservedFor}` : ''}`);
  return { gid, back, tid, tback, lines, ties, tables };
}

const COLS: (keyof PointRow)[] = ['next', 'across', 'same', 'row'];
const POINTS_DOC = `Happiness points a guest earns for someone near them, by relationship and distance
(next = adjacent chair, across = facing across the table, same = same table, row = the next table in a pushed-together row).
Relationship kinds: ${POINT_KINDS.map((k) => `${k} (${POINT_LABEL[k]})`).join(', ')}. "tag" is two guests sharing a social group.`;

export interface Proposal {
  summary: string;
  /** Changes to the happiness points table */
  points: { kind: PointKind; col: keyof PointRow; from: number; to: number }[];
  ties: { a: Id; b: Id; kind: Bond; seat?: SeatRule; contexts?: string[]; why: string; aName: string; bName: string }[];
  tags: { guest: Id; name: string; add: string }[];
  reserve: { table: Id; name: string; reservedFor: string }[];
  questions: string[];
}


export async function proposeFromIntent(p: Project, intent: string, signal?: AbortSignal, onText?: (t: string) => void): Promise<Proposal> {
  const sample = await getSample();
  if (!sample) throw { code: 'unavailable' };
  const r = roster(p);
  const cur = pointsOf(rulesOf(p.settings));
  const prompt = `You help a couple plan the seating for their wedding reception. A separate optimiser assigns seats; your job is to translate their wishes into its settings. Do not assign seats yourself.

THEIR WISHES:
"""${intent}"""

PARTNERS: ${p.settings.partner1} and ${p.settings.partner2} (the "side" column says whose guest someone is).

GUESTS (id | name | tags | side | household | child | current table):
${r.lines.join('\n')}

TABLES (id | name | seats | area | table tags):
${r.tables.join('\n')}

EXISTING TIES (a relationship[+seating rule] (how they know each other) b): ${r.ties.join(', ') || 'none'}
Relationships: partner (a couple; seated side by side), family, friend, introduce (they haven't met but we want them to), tension (better at different tables).
Optional seating rule on a tie: beside = adjacent chairs; together = same table; apart = never the same table.
Context = how they know each other or where they work (e.g. "Fire Island", "Google"); contexts also become guest tags.

TABLE TAGS (a table is meant for guests with any of these tags; a strong preference, not a rule): ${p.tables.filter((t) => t.reservedFor.trim()).map((t) => `${r.tid.get(t.id)} ${t.reservedFor}`).join('; ') || 'none'}

CURRENT HAPPINESS POINTS: ${JSON.stringify(cur)}
${POINTS_DOC}

Reply with only JSON in exactly this shape (omit nothing; use [] or {} when empty):
{"summary":"2-3 plain sentences on what you changed and why","points":{"friend":{"next":12}} (only the cells you change),"ties":[{"a":"g12","b":"g40","kind":"friend","seat":"beside","context":"Fire Island","why":"short reason"}],"tags":[{"guest":"g7","add":"Tag name"}],"reserve":[{"table":"t3","reservedFor":"Tag A, Tag B"}] (table tags; replaces that table's tags),"questions":["only if something important is ambiguous, e.g. a name that matches two guests"]}
Use only ids listed above. Prefer table tags, guest tags and point changes for broad wishes ("mix the families", "college friends together"); add ties only for specific people they name; \"seat\" and \"context\" are optional. Never invent guests.`;
  const raw = await sample.json<Record<string, unknown>>(prompt, { signal, cache: false, onText: onText ? ({ text }: { text: string }) => onText(text) : undefined });
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const out: Proposal = { summary: String(raw.summary ?? ''), points: [], ties: [], tags: [], reserve: [], questions: [] };
  const raw_points = (raw.points ?? {}) as Record<string, Record<string, unknown>>;
  for (const [k, row] of Object.entries(raw_points)) {
    if (!POINT_KINDS.includes(k as PointKind) || !row || typeof row !== 'object') continue;
    for (const [c, v] of Object.entries(row)) {
      if (!COLS.includes(c as keyof PointRow) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const to = Math.max(-100, Math.min(100, Math.round(v)));
      const from = cur[k as PointKind][c as keyof PointRow];
      if (to !== from) out.points.push({ kind: k as PointKind, col: c as keyof PointRow, from, to });
    }
  }
  for (const t of (raw.ties as { a: string; b: string; kind: string; seat?: string; context?: string; why?: string }[]) ?? []) {
    const a = r.back.get(t.a),
      b = r.back.get(t.b);
    if (!a || !b || a === b || !BONDS.includes(t.kind as Bond)) continue;
    const seat = SEAT_RULES.includes(t.seat as SeatRule) ? (t.seat as SeatRule) : undefined;
    const ctx = typeof t.context === 'string' && t.context.trim() ? [t.context.trim()] : undefined;
    out.ties.push({ a, b, kind: t.kind as Bond, seat, contexts: ctx, why: String(t.why ?? ''), aName: byId.get(a)!.name, bName: byId.get(b)!.name });
  }
  for (const t of (raw.tags as { guest: string; add: string }[]) ?? []) {
    const g = r.back.get(t.guest);
    if (g && t.add?.trim()) out.tags.push({ guest: g, name: byId.get(g)!.name, add: t.add.trim() });
  }
  for (const t of (raw.reserve as { table: string; reservedFor: string }[]) ?? []) {
    const id = r.tback.get(t.table);
    const tb = p.tables.find((x) => x.id === id);
    if (tb && typeof t.reservedFor === 'string') out.reserve.push({ table: tb.id, name: tableName(tb), reservedFor: t.reservedFor.trim() });
  }
  out.questions = ((raw.questions as unknown[]) ?? []).map(String).filter(Boolean).slice(0, 5);
  return out;
}

export interface Suggestion {
  kind: 'swap' | 'move';
  a: Id;
  b?: Id;
  table?: Id;
  why: string;
  text: string;
}

export async function reviewSeating(p: Project, focus: string, signal?: AbortSignal): Promise<{ summary: string; suggestions: Suggestion[] }> {
  const sample = await getSample();
  if (!sample) throw { code: 'unavailable' };
  const r = roster(p);
  const a = analyse(p);
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const tableLines = p.tables.map((t) => {
    const rep = a.reports.get(t.id);
    const names = (p.seating[t.id] ?? []).map((g) => (g ? `${r.gid.get(g) ?? '?'} ${byId.get(g)?.name}` : 'empty')).join(', ');
    return `${r.tid.get(t.id)} ${tableName(t)} (${t.seats} seats, ${rep?.happiness ?? 100}% have a tie): ${names}`;
  });
  const issues = a.issues.filter((i) => i.level !== 'info' || /no ties/.test(i.text)).slice(0, 40).map((i) => '- ' + i.text);
  const prompt = `Review this wedding reception seating chart and suggest at most 8 concrete improvements. Each suggestion must be a swap of two seated guests or a move of one guest to a table with a free seat.
${focus.trim() ? `\nTHE COUPLE'S FOCUS: """${focus}"""\n` : ''}
GUESTS (id | name | tags | side | household | child | current table):
${r.lines.join('\n')}

TIES (a relationship[+seating rule] (context) b): ${r.ties.join(', ') || 'none'}
Households (same h-number) must stay together: never split them; move or swap a whole household only by listing it as separate suggestions.

SEATING:
${tableLines.join('\n')}

CURRENT PROBLEMS:
${issues.join('\n') || 'none listed'}

Reply with only JSON: {"summary":"2-3 sentences on how the seating looks overall","suggestions":[{"kind":"swap","a":"g4","b":"g51","why":"short reason"},{"kind":"move","a":"g9","table":"t12","why":"short reason"}]}
Use only ids listed above. Prefer changes that give isolated guests a tie at their table without breaking other ties.`;
  const raw = await sample.json<{ summary?: string; suggestions?: { kind: string; a: string; b?: string; table?: string; why?: string }[] }>(prompt, { signal, cache: false });
  const sugg: Suggestion[] = [];
  for (const s of raw.suggestions ?? []) {
    const ga = r.back.get(s.a);
    if (!ga) continue;
    if (s.kind === 'swap') {
      const gb = s.b ? r.back.get(s.b) : undefined;
      if (!gb) continue;
      sugg.push({ kind: 'swap', a: ga, b: gb, why: String(s.why ?? ''), text: `Swap ${byId.get(ga)!.name} and ${byId.get(gb)!.name}` });
    } else if (s.kind === 'move') {
      const t = s.table ? r.tback.get(s.table) : undefined;
      const tb = p.tables.find((x) => x.id === t);
      if (!tb) continue;
      sugg.push({ kind: 'move', a: ga, table: tb.id, why: String(s.why ?? ''), text: `Move ${byId.get(ga)!.name} to ${tableName(tb)}` });
    }
  }
  return { summary: String(raw.summary ?? ''), suggestions: sugg };
}
