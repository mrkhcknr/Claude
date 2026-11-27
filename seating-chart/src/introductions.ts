/** Friend-of-friend pairs from different circles who haven't been connected yet. */
import type { Id, Project } from './types';
import { groupTags } from './scoring';

export interface Intro {
  a: Id;
  b: Id;
  via: Id[];
}

export function suggestIntroductions(p: Project, limit = 12): Intro[] {
  const coming = new Set(p.guests.filter((g) => g.rsvp !== 'no').map((g) => g.id));
  const adj = new Map<Id, Set<Id>>();
  const link = (a: Id, b: Id) => {
    if (!coming.has(a) || !coming.has(b)) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  const related = new Set<string>();
  const k = (a: Id, b: Id) => (a < b ? a + '|' + b : b + '|' + a);
  for (const r of p.relations) {
    related.add(k(r.a, r.b));
    if (r.kind === 'friend' || r.kind === 'family' || r.kind === 'partner') link(r.a, r.b);
  }
  const party = new Map<string, Id[]>();
  for (const g of p.guests) if (g.party) party.set(g.party, [...(party.get(g.party) ?? []), g.id]);
  const sameHouse = new Map(p.guests.map((g) => [g.id, g.party]));
  const tags = new Map(p.guests.map((g) => [g.id, groupTags(g)]));
  const out: Intro[] = [];
  const seen = new Set<string>();
  for (const [mid, ns] of adj) {
    const list = [...ns];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j],
          key = k(a, b);
        if (seen.has(key) || related.has(key)) continue;
        if (sameHouse.get(a) && sameHouse.get(a) === sameHouse.get(b)) continue;
        // only people from different circles: they're unlikely to have met
        if ((tags.get(a) ?? []).some((t) => (tags.get(b) ?? []).includes(t))) continue;
        seen.add(key);
        const via = [...(adj.get(a) ?? [])].filter((x) => adj.get(b)?.has(x));
        out.push({ a, b, via });
      }
    void mid;
  }
  return out.sort((x, y) => y.via.length - x.via.length).slice(0, limit);
}
