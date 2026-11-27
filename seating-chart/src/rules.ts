/**
 * The heuristics auto-seat optimises for. Every number is a weight: positive pulls people together
 * (or rewards a placement), negative pushes apart. They live in project settings, so everyone
 * sharing the chart tunes the same rules — by hand or by asking Claude.
 */
export interface SeatingRules {
  /** adjacent: households always side by side; table: same table; soft: just a strong preference */
  household: 'adjacent' | 'table' | 'soft';
  /** Relationship weights */
  family: number;
  friend: number;
  coworker: number;
  acquaintance: number;
  tension: number;
  /** Seating-instruction weights (added on top of the relationship) */
  beside: number;
  together: number;
  /** "Never same table" is a hard rule unless turned off */
  apartHard: boolean;
  apart: number;
  /** Sharing a group/tag */
  group: number;
  /** Smaller, more specific groups count for more than big catch-alls */
  specificGroups: boolean;
  /** Same partner's side (negative mixes the families) */
  side: number;
  /** Children with children */
  kids: number;
  /** Penalty per guest who has no tie at their table */
  loner: number;
  /** How tables fill up */
  balance: 'even' | 'full';
  balanceStrength: number;
  /** Respect "reserved for" on tables */
  reserved: number;
  /** Pull groups to the tables / areas they're assigned to */
  placement: number;
  /** When re-seating everyone, reward staying at the current table */
  stability: number;
  /** Order chairs so the most connected people sit side by side */
  neighbours: boolean;
  /** Couples (households of two and "Next to" pairs) take two chairs on the same side, next to each other */
  couplesSideBySide: boolean;
}

export const DEFAULT_RULES: SeatingRules = {
  household: 'adjacent',
  family: 7,
  friend: 6,
  coworker: 3,
  acquaintance: 1.5,
  tension: -6,
  beside: 14,
  together: 12,
  apartHard: true,
  apart: -80,
  group: 2.5,
  specificGroups: true,
  side: 0.3,
  kids: 1,
  loner: 3,
  balance: 'even',
  balanceStrength: 0.6,
  reserved: 8,
  placement: 12,
  stability: 0,
  neighbours: true,
  couplesSideBySide: true,
};

export function rulesOf(s: { rules?: Partial<SeatingRules> }): SeatingRules {
  const r = { ...DEFAULT_RULES, ...(s.rules ?? {}) } as SeatingRules & { prefer?: number; avoid?: number };
  // rules saved before relationships replaced "prefer together" / "prefer apart"
  if (s.rules && s.rules.friend === undefined && typeof r.prefer === 'number') r.friend = r.prefer + 2;
  if (s.rules && s.rules.tension === undefined && typeof r.avoid === 'number') r.tension = r.avoid;
  delete r.prefer;
  delete r.avoid;
  return r;
}

export interface RuleSlider {
  key: keyof SeatingRules;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  /** words for the low and high ends */
  ends: [string, string];
}

export const SLIDERS: { section: string; items: RuleSlider[] }[] = [
  {
    section: 'Relationships',
    items: [
      { key: 'family', label: 'Family', help: 'How strongly relatives are seated together.', min: 0, max: 20, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'friend', label: 'Friends', help: 'How strongly friends are seated together.', min: 0, max: 20, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'coworker', label: 'Coworkers', help: 'How strongly people who work together are seated together.', min: 0, max: 20, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'acquaintance', label: 'Acquaintances', help: 'A light pull for people who know each other a little.', min: 0, max: 10, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'tension', label: 'Tension', help: 'How hard to keep people with tension at different tables.', min: -30, max: 0, step: 0.5, ends: ['Strong', 'Ignore'] },
    ],
  },
  {
    section: 'Seating instructions',
    items: [
      { key: 'beside', label: 'Seat next to', help: 'Partners and ties marked "Seat next to" get adjacent chairs.', min: 0, max: 30, step: 1, ends: ['Ignore', 'Always'] },
      { key: 'together', label: 'Same table', help: 'Ties marked "Same table".', min: 0, max: 30, step: 1, ends: ['Ignore', 'Always'] },
    ],
  },
  {
    section: 'Who people are',
    items: [
      { key: 'group', label: 'Shared groups', help: 'Guests who share a tag (e.g. "College", "Work") sit together.', min: 0, max: 10, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'side', label: 'Same side of the family', help: 'Positive keeps each partner\'s guests together; negative mixes the two sides at each table.', min: -5, max: 5, step: 0.1, ends: ['Mix sides', 'Keep sides'] },
      { key: 'kids', label: 'Children together', help: 'Seat children with other children.', min: -5, max: 10, step: 0.5, ends: ['Spread out', 'Together'] },
    ],
  },
  {
    section: 'Table quality',
    items: [
      { key: 'loner', label: 'Nobody sits alone', help: 'Penalty for anyone who has no tie at their table.', min: 0, max: 15, step: 0.5, ends: ['Ignore', 'Strong'] },
      { key: 'balanceStrength', label: 'Table fill strength', help: 'How strongly to spread guests evenly (or fill tables completely).', min: 0, max: 3, step: 0.1, ends: ['Loose', 'Strict'] },
      { key: 'placement', label: 'Group placements', help: 'How strongly groups sit at the tables or areas you assigned them to.', min: 0, max: 30, step: 1, ends: ['Ignore', 'Always'] },
      { key: 'reserved', label: 'Reserved tables', help: 'How strictly tables "reserved for" a group take only that group.', min: 0, max: 20, step: 1, ends: ['Ignore', 'Strict'] },
      { key: 'stability', label: 'Keep changes small', help: 'When re-seating everyone, prefer each guest\'s current table.', min: 0, max: 10, step: 0.5, ends: ['Free', 'Minimal'] },
    ],
  },
];

export const PRESETS: { name: string; help: string; rules: Partial<SeatingRules> }[] = [
  { name: 'Balanced', help: 'The defaults: relationships first, then groups.', rules: DEFAULT_RULES },
  { name: 'Friends first', help: 'Lean hard on groups and ties; tables can be uneven.', rules: { ...DEFAULT_RULES, group: 5, friend: 9, coworker: 5, loner: 6, balanceStrength: 0.3 } },
  { name: 'Mix the families', help: 'Blend both sides at every table, keeping friend groups intact.', rules: { ...DEFAULT_RULES, side: -2.5, group: 3, loner: 4 } },
  { name: 'Keep sides apart', help: 'Each partner\'s guests mostly sit with their own side.', rules: { ...DEFAULT_RULES, side: 3 } },
  { name: 'Minimal changes', help: 'Re-run after RSVP changes without reshuffling everyone.', rules: { ...DEFAULT_RULES, stability: 8 } },
];
