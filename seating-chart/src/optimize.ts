/**
 * Improve a valid seating by swapping guests (and couples, as a pair) between chairs, keeping every
 * swap that raises total happiness. Hard rules are never broken: couples stay side by side, guests
 * seated by table tags stay at a table tagged for them, "never same table" holds, and fixed guests
 * (pinned, locked tables, or already seated in "only unseated" mode) don't move.
 */
import type { Id, Project, Table } from './types';
import { seatKey } from './geometry';
import { guestHappiness, seatMaps, type HappinessContext } from './happiness';

export interface ImproveOptions {
  tables: Table[];
  fixed: Set<Id>;
  /** Guests who must stay at one of these tables (seated there by table tags) */
  allowed: Map<Id, Set<Id>>;
  /** "never same table" pairs, as "a|b" with a < b */
  apart: Set<string>;
  iterations?: number;
  seed?: number;
}

/** Small deterministic random generator, so the same inputs give the same seating. */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function improveSeating(p: Project, seating: Project['seating'], ctx: HappinessContext, o: ImproveOptions) {
  const out: Project['seating'] = structuredClone(seating);
  const { seatOf, occupant } = seatMaps(out);
  const tableOfSeat = (s: string) => s.slice(0, s.lastIndexOf(':'));
  const seats = o.tables.flatMap((t) => Array.from({ length: t.seats }, (_, i) => seatKey(t.id, i)));
  const seatSet = new Set(seats);
  const next = (s: string) => [...(ctx.prox.get(s) ?? [])].filter(([x, pr]) => pr === 'next' && seatSet.has(x)).map(([x]) => x);

  // households: pairs sitting side by side move together; bigger households stay put
  const byParty = new Map<string, Id[]>();
  for (const g of p.guests) if (g.party && seatOf.has(g.id)) byParty.set(g.party, [...(byParty.get(g.party) ?? []), g.id]);
  const partnerOf = new Map<Id, Id>();
  const frozen = new Set<Id>(o.fixed);
  for (const m of byParty.values()) {
    if (m.length === 2 && next(seatOf.get(m[0])!).includes(seatOf.get(m[1])!)) {
      partnerOf.set(m[0], m[1]);
      partnerOf.set(m[1], m[0]);
    } else if (m.length > 1) m.forEach((g) => frozen.add(g));
  }
  for (const g of seatOf.keys()) if (!seatSet.has(seatOf.get(g)!)) frozen.add(g);
  const movers = [...seatOf.keys()].filter((g) => !frozen.has(g));
  if (!movers.length) return { seating: out, gain: 0 };

  const tableGuests = (t: string) => [...occupant].filter(([s]) => tableOfSeat(s) === t).map(([, g]) => g);
  // guests whose happiness can change when these seats change: everyone at those tables and next to them
  const affected = (changed: string[]) => {
    const set = new Set<Id>();
    for (const s of changed) {
      const g0 = occupant.get(s);
      if (g0) set.add(g0);
      // everyone within reach of this chair: same table, next to it, or the next table in the row
      for (const x of ctx.prox.get(s)?.keys() ?? []) {
        const g = occupant.get(x);
        if (g) set.add(g);
      }
    }
    return set;
  };
  const sumH = (gs: Set<Id>) => {
    let s = 0;
    for (const g of gs) s += guestHappiness(ctx, g, seatOf, occupant).points;
    return s;
  };
  const okAt = (g: Id, seat: string) => {
    const t = tableOfSeat(seat);
    const allow = o.allowed.get(g);
    if (allow && !allow.has(t)) return false;
    for (const other of tableGuests(t)) if (other !== g && o.apart.has(g < other ? g + '|' + other : other + '|' + g)) return false;
    return true;
  };
  /** Apply a seat → guest assignment (null empties the seat); returns the undo list. */
  const apply = (moves: [string, Id | null][]) => {
    const undo: [string, Id | null][] = moves.map(([s]) => [s, occupant.get(s) ?? null]);
    for (const [s] of moves) {
      const g = occupant.get(s);
      if (g) {
        occupant.delete(s);
        if (seatOf.get(g) === s) seatOf.delete(g);
      }
    }
    for (const [s, g] of moves) {
      if (!g) continue;
      occupant.set(s, g);
      seatOf.set(g, s);
    }
    return undo;
  };

  const rnd = mulberry32(o.seed ?? 7);
  const iters = o.iterations ?? Math.min(60000, 400 * movers.length);
  let gain = 0;
  for (let it = 0; it < iters; it++) {
    const a = movers[(rnd() * movers.length) | 0];
    const aSeat = seatOf.get(a)!;
    const partner = partnerOf.get(a);
    let moves: [string, Id | null][] | null = null;
    if (!partner) {
      // swap a single guest with another single, or move them to an empty chair
      const target = seats[(rnd() * seats.length) | 0];
      if (target === aSeat) continue;
      const b = occupant.get(target);
      if (b && (frozen.has(b) || partnerOf.has(b))) continue;
      moves = [
        [target, a],
        [aSeat, b ?? null],
      ];
    } else {
      // move a couple to two side-by-side chairs, swapping with whoever is there (another couple or two singles)
      const pSeat = seatOf.get(partner)!;
      const t1 = seats[(rnd() * seats.length) | 0];
      const ns = next(t1);
      if (!ns.length) continue;
      const t2 = ns[(rnd() * ns.length) | 0];
      const mine = new Set([aSeat, pSeat]);
      if (mine.has(t1) || mine.has(t2)) continue;
      const b1 = occupant.get(t1),
        b2 = occupant.get(t2);
      const movable = (b?: Id) => !b || (!frozen.has(b) && (!partnerOf.has(b) || (partnerOf.get(b) === b1 || partnerOf.get(b) === b2)));
      if (!movable(b1) || !movable(b2)) continue;
      // a couple at the target must be exactly the two chairs, so it lands as a pair in ours
      if ((b1 && partnerOf.has(b1) && partnerOf.get(b1) !== b2) || (b2 && partnerOf.has(b2) && partnerOf.get(b2) !== b1)) continue;
      moves = [
        [t1, a],
        [t2, partner],
        [aSeat, b1 ?? null],
        [pSeat, b2 ?? null],
      ];
    }
    const changed = moves.map(([s]) => s);
    const before = affected(changed);
    const undo = apply(moves);
    if (!moves.every(([s, g]) => !g || okAt(g, s))) {
      apply(undo);
      continue;
    }
    const after = affected(changed);
    for (const g of before) after.add(g);
    // happiness of the union, before and after
    const undo2 = apply(undo);
    const h0u = sumH(after);
    apply(undo2);
    const h1 = sumH(after);
    if (h1 - h0u > 1e-9) gain += h1 - h0u;
    else apply(undo);
  }

  // write back
  for (const t of o.tables) out[t.id] = out[t.id].map((_, i) => occupant.get(seatKey(t.id, i)) ?? null);
  return { seating: out, gain };
}
