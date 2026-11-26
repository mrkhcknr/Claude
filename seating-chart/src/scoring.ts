import type { Guest, Id, Project, RelationKind, Table } from './types';
import { clearanceIssues, nearestDoorDist } from './geometry';
import { likelySame } from './util';

export const REL_WEIGHT: Record<RelationKind, number> = {
  together: 12,
  prefer: 4,
  avoid: -6,
  apart: -80,
};

export const REL_LABEL: Record<RelationKind, string> = {
  together: 'Must sit together',
  prefer: 'Prefer together',
  avoid: 'Prefer apart',
  apart: 'Never same table',
};

export const REL_SHORT: Record<RelationKind, string> = {
  together: 'Together',
  prefer: 'Prefer',
  avoid: 'Avoid',
  apart: 'Never',
};

export const GROUP_WEIGHT = 2.5;
export const PARTY_WEIGHT = 12;
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
  const rel = new Map<string, RelationKind>();
  for (const r of p.relations) rel.set(key(r.a, r.b), r.kind);
  const byId = new Map(p.guests.map((g) => [g.id, g]));
  const tags = new Map(p.guests.map((g) => [g.id, groupTags(g)]));
  // smaller, more specific groups count for more than big catch-all ones
  const tagSize = new Map<string, number>();
  for (const t of tags.values()) for (const x of t) tagSize.set(x, (tagSize.get(x) ?? 0) + 1);
  const tagW = (t: string) => GROUP_WEIGHT * (0.6 + 0.8 * Math.min(1, 10 / (tagSize.get(t) ?? 1)));
  function weight(a: Id, b: Id) {
    const ga = byId.get(a),
      gb = byId.get(b);
    if (!ga || !gb) return 0;
    let w = 0;
    const r = rel.get(key(a, b));
    if (r) w += REL_WEIGHT[r];
    if (ga.party && ga.party === gb.party) w += PARTY_WEIGHT;
    const ta = tags.get(a)!,
      tb = tags.get(b)!;
    let tw = 0;
    for (const t of ta) if (tb.includes(t)) tw += tagW(t);
    w += Math.min(tw, GROUP_WEIGHT * 2.4);
    if (ga.side && ga.side === gb.side) w += SIDE_WEIGHT;
    if (ga.child && gb.child) w += KIDS_WEIGHT;
    return w;
  }
  return { weight, relation: (a: Id, b: Id) => rel.get(key(a, b)) };
}

/** Bonus/penalty for a guest sitting at a given table regardless of who else is there. */
export function tableFit(g: Guest, t: Table, p: Project) {
  let w = 0;
  const res = t.reservedFor.trim().toLowerCase();
  if (res) {
    const tags = groupTags(g);
    const matches = tags.includes(res) || (g.child && /kid|child/.test(res)) || g.side === res || (res === 'family' && tags.some((x) => x.includes('family')));
    w += matches ? 6 : -10;
  }
  if (g.accessible) {
    const d = nearestDoorDist(p, t);
    if (Number.isFinite(d)) w += Math.max(-4, 4 - d / 6);
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

  const reports = new Map<Id, TableReport>();
  for (const t of p.tables) {
    const guests = (p.seating[t.id] ?? []).filter((g): g is Id => !!g).map((g) => byId.get(g)!).filter(Boolean);
    const isolated: Guest[] = [];
    const conflicts: TableReport['conflicts'] = [];
    for (let i = 0; i < guests.length; i++) {
      let pos = false;
      for (let j = 0; j < guests.length; j++) {
        if (i === j) continue;
        if (weight(guests[i].id, guests[j].id) >= 1.4) pos = true;
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
        text: `${c.a.name} & ${c.b.name} are both at ${r.table.label} (${c.kind === 'apart' ? 'never same table' : 'prefer apart'})`,
        tableId: r.table.id,
        guestIds: [c.a.id, c.b.id],
      });
    for (const g of r.isolated) issues.push({ level: 'info', text: `${g.name} has no ties at ${r.table.label}`, tableId: r.table.id, guestIds: [g.id] });
    const res = r.table.reservedFor.trim();
    if (res) {
      const off = r.guests.filter((g) => tableFit(g, r.table, { ...p, elements: [] }) < 0);
      if (off.length) issues.push({ level: 'warn', text: `${off.length} guest(s) at ${r.table.label} aren't in "${res}"`, tableId: r.table.id, guestIds: off.map((g) => g.id) });
    }
    for (const g of r.guests) {
      if (!g.accessible) continue;
      const d = nearestDoorDist(p, r.table);
      if (!Number.isFinite(d)) issues.push({ level: 'info', text: `${g.name} needs an accessible seat — add doors to the plan so it can be checked`, guestIds: [g.id], tableId: r.table.id });
      else if (d > 25) issues.push({ level: 'warn', text: `${g.name} needs an accessible seat but ${r.table.label} is ${Math.round(d)} ft from the nearest door`, guestIds: [g.id], tableId: r.table.id });
    }
  }

  // split parties
  const parties = new Map<string, Guest[]>();
  for (const g of attending) if (g.party) parties.set(g.party, [...(parties.get(g.party) ?? []), g]);
  for (const members of parties.values()) {
    const tabs = new Set(members.map((g) => tableOf.get(g.id)).filter(Boolean));
    if (tabs.size > 1) issues.push({ level: 'warn', text: `Household split across tables: ${members.map((m) => m.name).join(', ')}`, guestIds: members.map((g) => g.id) });
  }
  // together relations split
  for (const r of p.relations) {
    if (r.kind !== 'together') continue;
    const ta = tableOf.get(r.a),
      tb = tableOf.get(r.b);
    if (ta && tb && ta !== tb) {
      const a = byId.get(r.a)!,
        b = byId.get(r.b)!;
      issues.push({ level: 'warn', text: `${a.name} & ${b.name} should sit together but are apart`, guestIds: [a.id, b.id] });
    }
  }
  for (const g of declinedSeated) issues.push({ level: 'warn', text: `${g.name} declined but still has a seat`, guestIds: [g.id], tableId: tableOf.get(g.id) });

  // clearance
  const clr = clearanceIssues(p);
  const tName = new Map(p.tables.map((t) => [t.id, t.label]));
  for (const c of clr) {
    const other = c.otherKind === 'table' ? tName.get(c.otherId) : (p.elements.find((e) => e.id === c.otherId)?.kind ?? 'obstacle');
    issues.push({
      level: c.gap === 0 ? 'error' : 'warn',
      text: c.gap === 0 ? `${tName.get(c.tableId)} overlaps ${other}` : `${tName.get(c.tableId)} is only ${c.gap.toFixed(1)} ft from ${other}`,
      tableId: c.tableId,
    });
  }

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
