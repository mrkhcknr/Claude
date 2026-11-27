/**
 * Improve a valid seating by swapping guests (and couples, as a pair) between chairs, keeping every
 * swap that raises total happiness. Hard rules are never broken: couples stay side by side,
 * "never same table" holds, and fixed guests
 * (pinned, locked tables, or already seated in "only unseated" mode) don't move.
 */
import type { Id, Project, Table } from './types';
import { seatKey } from './geometry';
import { guestHappiness, seatMaps, type HappinessContext } from './happiness';

export interface ImproveOptions {
  tables: Table[];
  fixed: Set<Id>;
  /** "never same table" pairs, as "a|b" with a < b */
  apart: Set<string>;
  iterations?: number;
  seed?: number;
  /** "Improve current seating": moving someone costs this many points (table change / seat change), so only clearly better swaps happen */
  moveCost?: { table: number; seat: number };
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

/**
 * Run the search a few times from the same start (different random orders) and keep the best result.
 * Each run starts adventurous, sometimes accepting a slightly worse swap to escape dead ends, and
 * ends strict, so the result is a seating no single swap can improve.
 */
export function improveSeating(p: Project, seating: Project['seating'], ctx: HappinessContext, o: ImproveOptions) {
  let best: { seating: Project['seating']; gain: number } | null = null;
  for (const seed of [o.seed ?? 7, 101, 2027]) {
    const r = improveOnce(p, seating, ctx, { ...o, seed });
    if (!best || r.gain > best.gain) best = r;
  }
  return best!;
}

function improveOnce(p: Project, seating: Project['seating'], ctx: HappinessContext, o: ImproveOptions) {
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
    // a couple moves as a pair, so if either partner is pinned, neither moves
    if (m.length === 2 && m.some((g) => o.fixed.has(g))) m.forEach((g) => frozen.add(g));
    else if (m.length === 2 && next(seatOf.get(m[0])!).includes(seatOf.get(m[1])!)) {
      partnerOf.set(m[0], m[1]);
      partnerOf.set(m[1], m[0]);
    } else if (m.length > 1) m.forEach((g) => frozen.add(g));
  }
  for (const g of seatOf.keys()) if (!seatSet.has(seatOf.get(g)!)) frozen.add(g);
  const movers = [...seatOf.keys()].filter((g) => !frozen.has(g));
  if (!movers.length) return { seating: out, gain: 0 };

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
  const origSeat = new Map(seatOf);
  const cost = o.moveCost;
  const sumH = (gs: Set<Id>) => {
    let s = 0;
    for (const g of gs) {
      s += guestHappiness(ctx, g, seatOf, occupant).points;
      if (cost) {
        const was = origSeat.get(g),
          now = seatOf.get(g);
        if (was && now && was !== now) s -= tableOfSeat(was) !== tableOfSeat(now) ? cost.table : cost.seat;
      }
    }
    return s;
  };
  // "never same table" partners of each guest, so a swap is checked without scanning every chair
  const apartOf = new Map<Id, Id[]>();
  for (const k of o.apart) {
    const [x, y] = k.split('|');
    apartOf.set(x, [...(apartOf.get(x) ?? []), y]);
    apartOf.set(y, [...(apartOf.get(y) ?? []), x]);
  }
  const okAt = (g: Id, seat: string) => {
    const t = tableOfSeat(seat);
    for (const other of apartOf.get(g) ?? []) {
      const s2 = seatOf.get(other);
      if (s2 && tableOfSeat(s2) === t) return false;
    }
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
  const iters = o.iterations ?? Math.min(40000, 100 * movers.length);
  let gain = 0,
    bestGain = 0;
  // start from the input arrangement, so a run that finds nothing better changes nothing
  let bestSnap: Map<string, Id> = new Map(occupant);
  // temperature: how willing to accept a worse swap (falls from 2 points to almost 0)
  let temp = 2;
  const cool = Math.pow(0.01 / temp, 1 / iters);
  for (let it = 0; it < iters; it++, temp *= cool) {
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
    const d = h1 - h0u;
    if (d > 1e-9 || (d < 0 && rnd() < Math.exp(d / temp))) {
      gain += d;
      if (gain > bestGain + 1e-9) {
        bestGain = gain;
        bestSnap = new Map(occupant);
      }
    } else apply(undo);
  }
  // keep the best arrangement seen, not wherever the search ended
  occupant.clear();
  for (const [k, v] of bestSnap) occupant.set(k, v);
  gain = bestGain;

  // write back
  for (const t of o.tables) out[t.id] = out[t.id].map((_, i) => occupant.get(seatKey(t.id, i)) ?? null);
  return { seating: out, gain };
}
