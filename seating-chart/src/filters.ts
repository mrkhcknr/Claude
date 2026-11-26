import { create } from 'zustand';
import type { Guest, Id, Project } from './types';
import { groupTags } from './scoring';
import { normName } from './util';

export interface Filters {
  q: string;
  rsvp: '' | 'yes' | 'pending' | 'no' | 'attending';
  side: '' | 'partner1' | 'partner2' | 'both' | 'none';
  seated: '' | 'seated' | 'unseated';
  tags: string[];
  tableId: Id | '';
  meal: string;
  flags: ('dietary' | 'child' | 'accessible' | 'noTies' | 'plusOne' | 'pinned' | 'discrepancy' | 'noMeal')[];
  /** In the plan and graph: hide non-matching guests instead of dimming them. */
  hide: boolean;
}

export const emptyFilters = (): Filters => ({ q: '', rsvp: '', side: '', seated: '', tags: [], tableId: '', meal: '', flags: [], hide: false });

export const useFilters = create<Filters>(() => emptyFilters());
export const setFilters = (f: Partial<Filters>) => useFilters.setState(f);
export const clearFilters = () => useFilters.setState({ ...emptyFilters(), hide: useFilters.getState().hide });

export function activeCount(f: Filters) {
  return [f.q.trim(), f.rsvp, f.side, f.seated, f.tableId, f.meal].filter(Boolean).length + f.tags.length + f.flags.length;
}

/** Returns a predicate for guests, or null when no filter is active. */
export function guestMatcher(p: Project, f: Filters, tableOf: Map<Id, Id>, disc?: Map<Id, unknown[]>): ((g: Guest) => boolean) | null {
  if (!activeCount(f)) return null;
  const q = normName(f.q);
  const tagSet = f.tags.map((t) => t.toLowerCase());
  let tied: Set<Id> | null = null;
  if (f.flags.includes('noTies')) {
    tied = new Set();
    for (const r of p.relations) if (r.kind === 'beside' || r.kind === 'together' || r.kind === 'prefer') (tied.add(r.a), tied.add(r.b));
    const partyCount = new Map<string, number>();
    for (const g of p.guests) if (g.party) partyCount.set(g.party, (partyCount.get(g.party) ?? 0) + 1);
    for (const g of p.guests) if (g.party && (partyCount.get(g.party) ?? 0) > 1) tied.add(g.id);
  }
  return (g) => {
    if (q) {
      const hay = normName(`${g.name} ${g.group} ${g.meal} ${g.dietary} ${g.notes}`);
      if (!q.split(' ').every((w) => hay.includes(w))) return false;
    }
    if (f.rsvp === 'attending' ? g.rsvp === 'no' : f.rsvp && g.rsvp !== f.rsvp) return false;
    if (f.side === 'none' ? g.side !== '' : f.side && g.side !== f.side) return false;
    const t = tableOf.get(g.id);
    if (f.seated === 'seated' && !t) return false;
    if (f.seated === 'unseated' && t) return false;
    if (f.tableId && t !== f.tableId) return false;
    if (f.meal && (g.meal || 'Unspecified') !== f.meal) return false;
    if (tagSet.length) {
      const gt = groupTags(g);
      if (!tagSet.every((x) => gt.includes(x))) return false;
    }
    for (const fl of f.flags) {
      if (fl === 'dietary' && !g.dietary.trim()) return false;
      if (fl === 'child' && !g.child) return false;
      if (fl === 'accessible' && !g.accessible) return false;
      if (fl === 'pinned' && !g.pinned) return false;
      if (fl === 'plusOne' && !/plus-one|^guest of /i.test(`${g.notes} ${g.name}`)) return false;
      if (fl === 'noTies' && tied?.has(g.id)) return false;
      if (fl === 'discrepancy' && !disc?.has(g.id)) return false;
      if (fl === 'noMeal' && (g.meal || g.rsvp === 'no')) return false;
    }
    return true;
  };
}

/** All tags in use, with counts, sorted by size. */
export function allTags(p: Project) {
  const m = new Map<string, { label: string; count: number }>();
  for (const g of p.guests) {
    for (const raw of g.group.split(/[,;/|]/).map((s) => s.trim()).filter(Boolean)) {
      const k = raw.toLowerCase();
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { label: raw, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function allMeals(p: Project) {
  return [...new Set(p.guests.map((g) => g.meal || 'Unspecified'))].sort();
}
