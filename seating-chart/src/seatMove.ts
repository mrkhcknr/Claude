/**
 * Moving a group of seated guests together: drag one of them to a chair and the rest keep their
 * places relative to it (same shape, same direction). Guests already in those chairs slide into
 * the chairs the group left, keeping their order, so "shift these four down two seats" just works.
 */
import { create } from 'zustand';
import type { Id, Project } from './types';
import { slotsOf, type Slot } from './geometry';
import { update } from './store';

/** "Select several" mode on the floor plan: each tap on a seated guest adds or removes them. */
export const usePick = create<{ on: boolean }>(() => ({ on: false }));
export const setPickMode = (on: boolean) => usePick.setState({ on });

export type SeatRef = { t: Id; s: number };
export interface BlockPlan {
  /** Where each moved guest ends up */
  to: Map<Id, SeatRef>;
  /** Guests who were in the way, and the chair each slides into */
  displaced: Map<Id, SeatRef>;
}

const k = (t: Id, s: number) => t + ':' + s;

/**
 * Plan a group move: `anchor` (one of `ids`) lands in `target`; everyone else in `ids` keeps the same
 * offset from it. Returns null when it can't apply (someone isn't seated, or nothing would change).
 */
export function planBlockMove(p: Project, ids: Id[], anchor: Id, target: SeatRef): BlockPlan | null {
  const slots = slotsOf(p.tables);
  const byKey = new Map<string, Slot>(slots.map((x) => [k(x.t, x.s), x]));
  const seatOf = new Map<Id, Slot>();
  const occupant = new Map<string, Id>();
  for (const [t, arr] of Object.entries(p.seating))
    arr.forEach((g, s) => {
      const sl = byKey.get(k(t, s));
      if (!g || !sl) return;
      seatOf.set(g, sl);
      occupant.set(k(t, s), g);
    });
  if (!ids.includes(anchor) || ids.some((g) => !seatOf.has(g))) return null;
  const a = seatOf.get(anchor)!;
  const tgt = byKey.get(k(target.t, target.s));
  if (!tgt || (tgt.t === a.t && tgt.s === a.s)) return null;
  const dx = tgt.x - a.x,
    dy = tgt.y - a.y;

  // each mover goes to the free chair nearest to where the same shift would put them; the anchor first,
  // then outward from it, so the group keeps its shape around the chair you dropped on
  const order = [...ids].sort((x, y) => {
    const px = seatOf.get(x)!,
      py = seatOf.get(y)!;
    return Math.hypot(px.x - a.x, px.y - a.y) - Math.hypot(py.x - a.x, py.y - a.y);
  });
  const taken = new Set<string>();
  const to = new Map<Id, SeatRef>();
  for (const g of order) {
    const from = seatOf.get(g)!;
    let best: Slot | null = null,
      bd = Infinity;
    if (g === anchor) best = tgt;
    else {
      const wx = from.x + dx,
        wy = from.y + dy;
      for (const sl of slots) {
        if (taken.has(k(sl.t, sl.s))) continue;
        const d = Math.hypot(sl.x - wx, sl.y - wy);
        if (d < bd) {
          bd = d;
          best = sl;
        }
      }
    }
    if (!best) return null;
    taken.add(k(best.t, best.s));
    to.set(g, { t: best.t, s: best.s });
  }

  // the people in the way slide back into the chairs the group left, in the same order along the shift
  const moving = new Set(ids);
  const proj = (sl: Slot) => sl.x * dx + sl.y * dy;
  const inWay = [...to.values()]
    .map((r) => occupant.get(k(r.t, r.s)))
    .filter((g): g is Id => !!g && !moving.has(g))
    .sort((x, y) => proj(seatOf.get(x)!) - proj(seatOf.get(y)!));
  const vacated = ids
    .map((g) => seatOf.get(g)!)
    .filter((sl) => !taken.has(k(sl.t, sl.s)))
    .sort((x, y) => proj(x) - proj(y));
  if (inWay.length > vacated.length) return null;
  const displaced = new Map<Id, SeatRef>();
  inWay.forEach((g, i) => {
    const sl = vacated[i];
    if (sl) displaced.set(g, { t: sl.t, s: sl.s });
  });
  return { to, displaced };
}

/** Apply a planned group move. Returns how many guests changed seats. */
export function applyBlockMove(plan: BlockPlan) {
  const all = new Map([...plan.to, ...plan.displaced]);
  update((d) => {
    for (const t of Object.keys(d.seating)) d.seating[t] = d.seating[t].map((g) => (g && all.has(g) ? null : g));
    for (const [g, r] of all) if (d.seating[r.t] && r.s < d.seating[r.t].length) d.seating[r.t][r.s] = g;
  });
  return all.size;
}
