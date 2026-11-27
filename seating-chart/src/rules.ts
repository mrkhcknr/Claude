/**
 * Auto-seat settings. Table tags and relationships do most of the work; these are the only knobs:
 * two hard rules, the happiness points table and how much a matching table tag is worth. Saved with the chart, so everyone sharing it uses the same ones.
 */
export interface SeatingRules {
  /** Couples and households always get side-by-side chairs */
  couplesSideBySide: boolean;
  /** "Never same table" ties are absolute */
  apartHard: boolean;
  /** Happiness points by relationship and distance (missing rows use the defaults) */
  points?: Partial<Record<PointKind, PointRow>>;
  /** Points a guest earns for sitting at a table tagged for them. A nudge, not a rule: 0 = tags only set the starting layout. */
  tablePoints?: number;
}

export const DEFAULT_RULES: SeatingRules = {
  couplesSideBySide: true,
  apartHard: true,
};
export const DEFAULT_TABLE_POINTS = 5;

/** Older charts stored extra weights here; they're ignored. */
export const rulesOf = (s: { rules?: Partial<SeatingRules> }): SeatingRules => {
  const r = s.rules ?? {};
  return { couplesSideBySide: r.couplesSideBySide ?? true, apartHard: r.apartHard ?? true, points: r.points, tablePoints: r.tablePoints };
};

export type PointKind = 'partner' | 'family' | 'friend' | 'introduce' | 'tag' | 'tension';
export interface PointRow {
  next: number;
  across: number;
  same: number;
  /** at the next table in a pushed-together row */
  row: number;
}
export const POINT_KINDS: PointKind[] = ['partner', 'family', 'friend', 'introduce', 'tag', 'tension'];
export const POINT_LABEL: Record<PointKind, string> = {
  partner: 'Partner',
  family: 'Family',
  friend: 'Friend',
  introduce: 'Introduce',
  tag: 'Shared social group (tag)',
  tension: 'Tension',
};
export const DEFAULT_POINTS: Record<PointKind, PointRow> = {
  partner: { next: 50, across: 10, same: 5, row: 0 },
  family: { next: 10, across: 8, same: 6, row: 2 },
  friend: { next: 10, across: 8, same: 6, row: 2 },
  introduce: { next: 12, across: 10, same: 6, row: 0 },
  tag: { next: 3, across: 2, same: 1, row: 0 },
  tension: { next: -10, across: -10, same: -10, row: -2 },
};
export const pointsOf = (R: Pick<SeatingRules, 'points'>): Record<PointKind, PointRow> =>
  Object.fromEntries(POINT_KINDS.map((k) => [k, { ...DEFAULT_POINTS[k], ...(R.points?.[k] ?? {}) }])) as Record<PointKind, PointRow>;
