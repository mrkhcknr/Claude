/**
 * Live comparison between the chart and every list that was imported. A discrepancy stays visible
 * until the couple either takes the list's value or marks it as fine.
 */
import type { Guest, Id, ImportRecord, Project, Rsvp } from './types';
import { update } from './store';
import { knownAs, normName, uid } from './util';

export type DiscKind = 'rsvp' | 'meal' | 'dietary' | 'missing' | 'unmatched';

export interface Discrepancy {
  key: string;
  kind: DiscKind;
  label: string;
  importId: Id;
  guestId?: Id;
  /** For unmatched rows: the name as written in the list */
  name?: string;
  /** For field disagreements: chart value and list value */
  chart?: string;
  list?: string;
  text: string;
}

const word = (r?: Rsvp) => (r === 'yes' ? 'Coming' : r === 'no' ? 'Declined' : r === 'pending' ? 'Pending' : '—');

export function findDiscrepancies(p: Project): Discrepancy[] {
  const out: Discrepancy[] = [];
  const imports = p.imports ?? [];
  const byLabel = new Map(imports.map((i) => [i.label, i]));
  const dismissed = new Set(imports.flatMap((i) => i.dismissed ?? []));
  const push = (d: Omit<Discrepancy, 'key'> & { key?: string }) => {
    const key = d.key ?? `${d.guestId ?? d.name}:${d.kind}:${d.label}`;
    if (!dismissed.has(key)) out.push({ ...d, key });
  };
  for (const g of p.guests) {
    for (const [label, s] of Object.entries(g.sources ?? {})) {
      const imp = byLabel.get(label);
      if (!imp) continue;
      if (s.rsvp && s.rsvp !== g.rsvp)
        push({ kind: 'rsvp', label, importId: imp.id, guestId: g.id, chart: word(g.rsvp), list: word(s.rsvp), text: `${g.name}: ${label} says ${word(s.rsvp)}, the chart says ${word(g.rsvp)}` });
      if (s.meal && normName(s.meal) !== normName(g.meal))
        push({ kind: 'meal', label, importId: imp.id, guestId: g.id, chart: g.meal || '—', list: s.meal, text: `${g.name}: meal is "${s.meal}" in ${label}, "${g.meal || 'not set'}" in the chart` });
      if (s.dietary && normName(s.dietary) !== normName(g.dietary))
        push({ kind: 'dietary', label, importId: imp.id, guestId: g.id, chart: g.dietary || '—', list: s.dietary, text: `${g.name}: dietary note "${s.dietary}" in ${label} differs from the chart` });
    }
  }
  for (const imp of imports) {
    if (imp.kind === 'crosscheck') {
      const covered = new Set(imp.covered);
      for (const g of p.guests)
        if (g.rsvp !== 'no' && !covered.has(g.id))
          push({ kind: 'missing', label: imp.label, importId: imp.id, guestId: g.id, text: `${g.name} is coming but isn't in ${imp.label}` });
    }
    for (const n of imp.unmatched) push({ kind: 'unmatched', label: imp.label, importId: imp.id, name: n, text: `${n} is in ${imp.label} but not in the guest list` });
  }
  return out;
}

export function byGuest(ds: Discrepancy[]) {
  const m = new Map<Id, Discrepancy[]>();
  for (const d of ds) if (d.guestId) m.set(d.guestId, [...(m.get(d.guestId) ?? []), d]);
  return m;
}

/** Mark a discrepancy as fine. */
export function dismiss(d: Discrepancy) {
  update((p) => {
    const imp = p.imports?.find((i) => i.id === d.importId);
    if (imp) imp.dismissed = [...new Set([...(imp.dismissed ?? []), d.key])];
  });
}

/** Take the list's value into the chart. */
export function useListValue(d: Discrepancy) {
  update((p) => {
    const g = p.guests.find((x) => x.id === d.guestId);
    const s = g?.sources?.[d.label];
    if (!g || !s) return;
    if (d.kind === 'rsvp' && s.rsvp) g.rsvp = s.rsvp;
    if (d.kind === 'meal' && s.meal) g.meal = s.meal;
    if (d.kind === 'dietary' && s.dietary) g.dietary = s.dietary;
  });
}

/** Add an unmatched name from a list as a new guest. */
export function addUnmatched(d: Discrepancy) {
  if (!d.name) return;
  update((p) => {
    const g: Guest = { id: uid(), name: d.name!, party: '', group: '', side: '', rsvp: 'yes', meal: '', dietary: '', child: false, accessible: false, notes: `Added from ${d.label}`, pinned: false };
    p.guests.push(g);
    const imp = p.imports?.find((i) => i.id === d.importId);
    if (imp) {
      imp.unmatched = imp.unmatched.filter((n) => n !== d.name);
      imp.covered = [...imp.covered, g.id];
    }
  });
}

/** Link an unmatched name to an existing guest (a spelling difference). */
export function linkUnmatched(d: Discrepancy, guestId: Id) {
  update((p) => {
    const imp = p.imports?.find((i) => i.id === d.importId);
    if (!imp) return;
    imp.unmatched = imp.unmatched.filter((n) => n !== d.name);
    imp.covered = [...new Set([...imp.covered, guestId])];
    const g = p.guests.find((x) => x.id === guestId);
    if (g && d.name && !knownAs(g, d.name)) g.aliases = [...(g.aliases ?? []), d.name];
  });
}

export const discLabel: Record<DiscKind, string> = { rsvp: 'RSVP', meal: 'Meal', dietary: 'Dietary', missing: 'Missing', unmatched: 'Not on guest list' };
export type { ImportRecord };
