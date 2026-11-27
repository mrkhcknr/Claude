/**
 * Happiness points: each guest earns points for the people they care about who sit next to them,
 * across from them, or at the same table. Auto-seat maximises the total.
 */
import type { Guest, Id, Project, Table } from './types';
import { seatKey, seatProximity, type Prox } from './geometry';
import { effectiveSeat } from './relations';
import { pointsOf, rulesOf, type PointKind, type PointRow } from './rules';
import { groupTags } from './scoring';

/** Each further connection counts a little less, so one guest doesn't hoard everyone they know. */
export const DECAY = 0.85;

export interface PairLink {
  kind: PointKind;
  /** Scale for tags: small groups count fully, big catch-all groups less */
  mult: number;
  tag?: string;
}

export interface HappyItem {
  other: Id;
  kind: PointKind;
  prox: Prox;
  pts: number;
  tag?: string;
}
export interface GuestHappy {
  points: number;
  items: HappyItem[];
}

/** Who each pair of guests is to each other: a drawn relationship, then household, then a shared tag. */
export function pairModel(p: Project, guests: Guest[]) {
  const links = new Map<string, PairLink>();
  const k = (a: Id, b: Id) => (a < b ? a + '|' + b : b + '|' + a);
  // shared tags (smallest group wins; big groups count less)
  const size = new Map<string, number>();
  for (const g of guests) for (const t of groupTags(g)) size.set(t, (size.get(t) ?? 0) + 1);
  const tags = new Map(guests.map((g) => [g.id, groupTags(g)]));
  const tagLink = (a: Id, b: Id): PairLink | undefined => {
    const ta = tags.get(a),
      tb = tags.get(b);
    if (!ta || !tb) return;
    let best: string | undefined;
    for (const t of ta) if (tb.includes(t) && (!best || (size.get(t) ?? 0) < (size.get(best) ?? 0))) best = t;
    if (!best) return;
    return { kind: 'tag', tag: best, mult: Math.max(0.25, Math.min(1, 8 / (size.get(best) ?? 8))) };
  };
  // households: two people = partners, larger = family
  const party = new Map<string, Id[]>();
  for (const g of guests) if (g.party) party.set(g.party, [...(party.get(g.party) ?? []), g.id]);
  for (const m of party.values())
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) links.set(k(m[i], m[j]), { kind: m.length === 2 ? 'partner' : 'family', mult: 1 });
  // drawn relationships override
  for (const r of p.relations) {
    const kind: PointKind = r.kind === 'tension' || effectiveSeat(r) === 'apart' ? 'tension' : r.kind;
    links.set(k(r.a, r.b), { kind, mult: 1 });
  }
  return (a: Id, b: Id): PairLink | undefined => links.get(k(a, b)) ?? tagLink(a, b);
}

/** Combine a guest's point items: positives sorted high to low, each worth DECAY× the one before; negatives count in full. */
export function combine(items: { pts: number }[]) {
  const pos = items.filter((x) => x.pts > 0).map((x) => x.pts).sort((a, b) => b - a);
  const neg = items.filter((x) => x.pts < 0).reduce((s, x) => s + x.pts, 0);
  let f = 1,
    s = 0;
  for (const v of pos) {
    s += v * f;
    f *= DECAY;
  }
  return s + neg;
}

export interface HappinessContext {
  prox: Map<string, Map<string, Prox>>;
  pair: (a: Id, b: Id) => PairLink | undefined;
  P: Record<PointKind, PointRow>;
}

export function happinessContext(p: Project, tables: Table[] = p.tables, guests: Guest[] = p.guests.filter((g) => g.rsvp !== 'no')): HappinessContext {
  return { prox: seatProximity(tables), pair: pairModel(p, guests), P: pointsOf(rulesOf(p.settings)) };
}

/** One guest's happiness given who sits where. */
export function guestHappiness(ctx: HappinessContext, gid: Id, seatOf: Map<Id, string>, occupant: Map<string, Id>, detail = false): GuestHappy {
  const seat = seatOf.get(gid);
  if (!seat) return { points: 0, items: [] };
  const items: HappyItem[] = [];
  for (const [s2, pr] of ctx.prox.get(seat) ?? []) {
    const other = occupant.get(s2);
    if (!other) continue;
    const link = ctx.pair(gid, other);
    if (!link) continue;
    const pts = ctx.P[link.kind][pr] * link.mult;
    if (pts) items.push({ other, kind: link.kind, prox: pr, pts, tag: link.tag });
  }
  return { points: combine(items), items: detail ? items.sort((a, b) => b.pts - a.pts) : items };
}

export function seatMaps(seating: Project['seating']) {
  const seatOf = new Map<Id, string>(),
    occupant = new Map<string, Id>();
  for (const [t, arr] of Object.entries(seating))
    arr.forEach((g, s) => {
      if (!g) return;
      seatOf.set(g, seatKey(t, s));
      occupant.set(seatKey(t, s), g);
    });
  return { seatOf, occupant };
}

/** Everyone's happiness for a seating (for display). */
export function happinessOf(p: Project, seating: Project['seating'] = p.seating) {
  const ctx = happinessContext(p);
  const { seatOf, occupant } = seatMaps(seating);
  const byGuest = new Map<Id, GuestHappy>();
  let total = 0;
  for (const g of seatOf.keys()) {
    const h = guestHappiness(ctx, g, seatOf, occupant, true);
    byGuest.set(g, h);
    total += h.points;
  }
  return { total, byGuest };
}
