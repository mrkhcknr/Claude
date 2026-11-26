import type { Guest, Id, Project, RelationKind, Table } from './types';
import { clearanceIssues, joinedGroups, nearestDoorDist, slotsAdjacent } from './geometry';
import { likelySame } from './util';
import { tableName } from './store';
import { rulesOf } from './rules';
import { byGuest, findDiscrepancies } from './discrepancies';

export const REL_WEIGHT: Record<RelationKind, number> = {
  beside: 14,
  together: 12,
  prefer: 4,
  avoid: -6,
  apart: -80,
};

export const REL_LABEL: Record<RelationKind, string> = {
  beside: 'Seat next to each other',
  together: 'Same table',
  prefer: 'Prefer together',
  avoid: 'Prefer apart',
  apart: 'Never same table',
};

export const REL_SHORT: Record<RelationKind, string> = {
  beside: 'Next to',
  together: 'Same table',
  prefer: 'Prefer',
  avoid: 'Avoid',
  apart: 'Never',
};

export const GROUP_WEIGHT = 2.5;
export const PARTY_WEIGHT = 30;
export const SIDE_WEIGHT = 0.3;
export const KIDS_WEIGHT = 1;

const key = (a: Id, b: Id) => (a < b ? a + '|' + b : b + '|' + a);

/** Splits a group field "College, Soccer" into tags. */
export const groupTags = (g: Guest) =>
  g.group
    .split(/[,;/|]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function buildAffinity(p: Project) {
  const R = rulesOf(p.settings);
  const relW: Record<RelationKind, number> = { beside: R.beside, together: R.together, prefer: R.prefer, avoid: R.avoid, apart: R.apartHard ? -1000 : R.apart };
  const rel = new Map<string, RelationKind>();
  for (const r of p.relations) rel.set(key(r.a, r.b), r.kind);
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const tags = new Map(p.guests.map((g) => [g.id, groupTags(g)]));
  // smaller, more specific groups count for more than big catch-all ones
  const tagSize = new Map<string, number>();
  for (const t of tags.values()) for (const x of t) tagSize.set(x, (tagSize.get(x) ?? 0) + 1);
  const tagW = (t: string) => (R.specificGroups ? R.group * (0.6 + 0.8 * Math.min(1, 10 / (tagSize.get(t) ?? 1))) : R.group);
  function weight(a: Id, b: Id) {
    const ga = byId.get(a),
      gb = byId.get(b);
    if (!ga || !gb) return 0;
    let w = 0;
    const r = rel.get(key(a, b));
    if (r) w += relW[r];
    if (ga.party && ga.party === gb.party) w += R.household === 'soft' ? 10 : PARTY_WEIGHT;
    const ta = tags.get(a)!,
      tb = tags.get(b)!;
    let tw = 0;
    for (const t of ta) if (tb.includes(t)) tw += tagW(t);
    w += Math.min(tw, R.group * 2.4);
    if (ga.side && gb.side && ga.side !== 'both' && gb.side !== 'both') w += ga.side === gb.side ? R.side : -R.side * 0.5;
    if (ga.child && gb.child) w += R.kids;
    return w;
  }
  return { weight, relation: (a: Id, b: Id) => rel.get(key(a, b)), rules: R };
}

/** Bonus/penalty for a guest sitting at a given table regardless of who else is there. */
export function tableFit(g: Guest, t: Table, p: Project) {
  const R = rulesOf(p.settings);
  let w = 0;
  const res = t.reservedFor.trim().toLowerCase();
  if (res) {
    const tags = groupTags(g);
    const matches = tags.includes(res) || (g.child && /kid|child/.test(res)) || g.side === res || (res === 'family' && tags.some((x) => x.includes('family')));
    w += matches ? R.reserved * 0.75 : -R.reserved * 1.25;
  }
  if (g.accessible && R.accessible) {
    const d = nearestDoorDist(p, t);
    if (Number.isFinite(d)) w += R.accessible * Math.max(-1, 1 - d / 24);
  }
  return w;
}

export interface TableReport {
  table: Table;
  guests: Guest[];
  /** 0–100: share of seated guests with at least one positive tie at their table */
  happiness: number;
  isolated: Guest[];
  conflicts: { a: Guest; b: Guest; kind: RelationKind }[];
  meals: Record<string, number>;
  dietary: Guest[];
}

export interface Issue {
  level: 'error' | 'warn' | 'info';
  text: string;
  tableId?: Id;
  guestIds?: Id[];
  elementId?: Id;
}

export function analyse(p: Project) {
  const { weight, relation } = buildAffinity(p);
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const tableOf = new Map<Id, Id>();
  for (const [t, arr] of Object.entries(p.seating)) for (const g of arr) if (g) tableOf.set(g, t);

  // tables pushed together count as one long table
  const rowOf = new Map<Id, number>();
  joinedGroups(p.tables).forEach((g, i) => g.forEach((t) => rowOf.set(t.id, i)));
  const reports = new Map<Id, TableReport>();
  for (const t of p.tables) {
    const guests = (p.seating[t.id] ?? []).filter((g): g is Id => !!g).map((g) => byId.get(g)!).filter(Boolean);
    const isolated: Guest[] = [];
    const conflicts: TableReport['conflicts'] = [];
    for (let i = 0; i < guests.length; i++) {
      let pos = false;
      for (let j = 0; j < guests.length; j++) {
        if (i === j) continue;
        if (weight(guests[i].id, guests[j].id) >= 1) pos = true;
        if (j > i) {
          const r = relation(guests[i].id, guests[j].id);
          if (r === 'apart' || r === 'avoid') conflicts.push({ a: guests[i], b: guests[j], kind: r });
        }
      }
      if (!pos && guests.length > 1) isolated.push(guests[i]);
    }
    const meals: Record<string, number> = {};
    for (const g of guests) {
      const m = g.meal || 'Unspecified';
      meals[m] = (meals[m] ?? 0) + 1;
    }
    reports.set(t.id, {
      table: t,
      guests,
      happiness: guests.length ? Math.round((100 * (guests.length - isolated.length)) / guests.length) : 100,
      isolated,
      conflicts,
      meals,
      dietary: guests.filter((g) => g.dietary.trim()),
    });
  }

  const issues: Issue[] = [];
  const attending = p.guests.filter((g) => g.rsvp !== 'no');
  const unseated = attending.filter((g) => !tableOf.has(g.id));
  const declinedSeated = p.guests.filter((g) => g.rsvp === 'no' && tableOf.has(g.id));
  const capacity = p.tables.reduce((s, t) => s + t.seats, 0);

  if (capacity < attending.length) issues.push({ level: 'error', text: `Only ${capacity} seats for ${attending.length} attending/pending guests — add ${attending.length - capacity} seats.` });

  for (const r of reports.values()) {
    for (const c of r.conflicts)
      issues.push({
        level: c.kind === 'apart' ? 'error' : 'warn',
        text: `${c.a.name} & ${c.b.name} are both at ${tableName(r.table)} (${c.kind === 'apart' ? 'never same table' : 'prefer apart'})`,
        tableId: r.table.id,
        guestIds: [c.a.id, c.b.id],
      });
    for (const g of r.isolated) issues.push({ level: 'info', text: `${g.name} has no ties at ${tableName(r.table)}`, tableId: r.table.id, guestIds: [g.id] });
    const res = r.table.reservedFor.trim();
    if (res) {
      const off = r.guests.filter((g) => tableFit(g, r.table, { ...p, elements: [] }) < 0);
      if (off.length) issues.push({ level: 'warn', text: `${off.length} guest(s) at ${tableName(r.table)} aren't in "${res}"`, tableId: r.table.id, guestIds: off.map((g) => g.id) });
    }
    for (const g of r.guests) {
      if (!g.accessible) continue;
      const d = nearestDoorDist(p, r.table);
      if (!Number.isFinite(d)) issues.push({ level: 'info', text: `${g.name} needs an accessible seat — add doors to the plan so it can be checked`, guestIds: [g.id], tableId: r.table.id });
      else if (d > 25) issues.push({ level: 'warn', text: `${g.name} needs an accessible seat but ${tableName(r.table)} is ${Math.round(d)} ft from the nearest door`, guestIds: [g.id], tableId: r.table.id });
    }
  }

  // split parties
  const parties = new Map<string, Guest[]>();
  for (const g of attending) if (g.party) parties.set(g.party, [...(parties.get(g.party) ?? []), g]);
  for (const members of parties.values()) {
    const tabs = new Set(members.map((g) => tableOf.get(g.id)).filter(Boolean).map((t) => rowOf.get(t!)));
    if (tabs.size > 1) issues.push({ level: 'warn', text: `Household split across tables: ${members.map((m) => m.name).join(', ')}`, guestIds: members.map((g) => g.id) });
  }
  // couples (households of two) in the same table or row but not in side-by-side chairs
  if (rulesOf(p.settings).couplesSideBySide) {
    const seatAt = new Map<Id, number>();
    for (const arr of Object.values(p.seating)) arr.forEach((g, i) => g && seatAt.set(g, i));
    const pairsByParty = new Map<string, Guest[]>();
    for (const g of attending) if (g.party) pairsByParty.set(g.party, [...(pairsByParty.get(g.party) ?? []), g]);
    for (const m of pairsByParty.values()) {
      if (m.length !== 2) continue;
      const ta = tableOf.get(m[0].id),
        tb = tableOf.get(m[1].id);
      if (!ta || !tb || rowOf.get(ta) !== rowOf.get(tb)) continue;
      const t = p.tables.find((x) => x.id === ta)!;
      if (!slotsAdjacent(p.tables, { t: ta, s: seatAt.get(m[0].id)! }, { t: tb, s: seatAt.get(m[1].id)! }))
        issues.push({ level: 'warn', text: `${m[0].name} & ${m[1].name} are at ${tableName(t)} but not side by side`, guestIds: [m[0].id, m[1].id], tableId: t.id });
    }
  }

  // "same table" / "next to" relations that aren't honoured
  const seatOf = new Map<Id, number>();
  for (const arr of Object.values(p.seating)) arr.forEach((g, i) => g && seatOf.set(g, i));
  for (const r of p.relations) {
    if (r.kind !== 'together' && r.kind !== 'beside') continue;
    const ta = tableOf.get(r.a),
      tb = tableOf.get(r.b);
    if (!ta || !tb) continue;
    const a = byId.get(r.a)!,
      b = byId.get(r.b)!;
    if (rowOf.get(ta) !== rowOf.get(tb)) issues.push({ level: 'warn', text: `${a.name} & ${b.name} should ${r.kind === 'beside' ? 'sit next to each other' : 'share a table'} but are at different tables`, guestIds: [a.id, b.id] });
    else if (r.kind === 'beside') {
      const t = p.tables.find((x) => x.id === ta);
      if (t && !slotsAdjacent(p.tables, { t: ta, s: seatOf.get(r.a)! }, { t: tb, s: seatOf.get(r.b)! }))
        issues.push({ level: 'warn', text: `${a.name} & ${b.name} are at ${tableName(t)} but not next to each other`, guestIds: [a.id, b.id], tableId: t.id });
    }
  }
  for (const g of declinedSeated) issues.push({ level: 'warn', text: `${g.name} declined but still has a seat`, guestIds: [g.id], tableId: tableOf.get(g.id) });

  // clearance
  const clr = clearanceIssues(p);
  const tName = new Map(p.tables.map((t) => [t.id, tableName(t)]));
  for (const c of clr) {
    const other = c.otherKind === 'table' ? tName.get(c.otherId) : (p.elements.find((e) => e.id === c.otherId)?.kind ?? 'obstacle');
    issues.push({
      level: c.gap === 0 ? 'error' : 'warn',
      text: c.gap === 0 ? `${tName.get(c.tableId)} overlaps ${other}` : `${tName.get(c.tableId)} is only ${c.gap.toFixed(1)} ft from ${other}`,
      tableId: c.tableId,
    });
  }

  // crosscheck discrepancies between imported lists and the chart
  const discrepancies = findDiscrepancies(p);
  for (const d of discrepancies.slice(0, 80)) issues.push({ level: d.kind === 'rsvp' || d.kind === 'unmatched' ? 'warn' : 'info', text: d.text, guestIds: d.guestId ? [d.guestId] : undefined });

  // likely duplicates
  const dupes: [Guest, Guest][] = [];
  if (p.guests.length < 1500) {
    for (let i = 0; i < p.guests.length; i++)
      for (let j = i + 1; j < p.guests.length; j++) if (likelySame(p.guests[i].name, p.guests[j].name)) dupes.push([p.guests[i], p.guests[j]]);
  }
  for (const [a, b] of dupes.slice(0, 20)) issues.push({ level: 'info', text: `Possible duplicate: "${a.name}" and "${b.name}"`, guestIds: [a.id, b.id] });

  const meals: Record<string, number> = {};
  for (const g of attending) {
    const m = g.meal || 'Unspecified';
    meals[m] = (meals[m] ?? 0) + 1;
  }
  const seatedReports = [...reports.values()].filter((r) => r.guests.length);
  const happiness = seatedReports.length
    ? Math.round(seatedReports.reduce((s, r) => s + r.happiness * r.guests.length, 0) / seatedReports.reduce((s, r) => s + r.guests.length, 0))
    : 0;

  return {
    reports,
    issues,
    discrepancies,
    discByGuest: byGuest(discrepancies),
    tableOf,
    clearance: clr,
    stats: {
      total: p.guests.length,
      attending: attending.length,
      declined: p.guests.length - attending.length,
      pending: p.guests.filter((g) => g.rsvp === 'pending').length,
      seated: attending.length - unseated.length,
      unseated: unseated.length,
      capacity,
      tables: p.tables.length,
      meals,
      happiness,
      children: attending.filter((g) => g.child).length,
    },
  };
}

export type Analysis = ReturnType<typeof analyse>;
