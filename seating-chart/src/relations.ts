/**
 * The social graph records relationships (who people are to each other, and how they know each
 * other). Seating weights are derived from those; explicit seating instructions are optional overrides.
 */
import type { Bond, Relation, SeatRule } from './types';

export const BONDS: Bond[] = ['partner', 'family', 'friend', 'introduce', 'tension'];

export const BOND_LABEL: Record<Bond, string> = {
  partner: 'Partner',
  family: 'Family',
  friend: 'Friend',
  introduce: 'Introduce',
  tension: 'Tension',
};

export const BOND_HELP: Record<Bond, string> = {
  partner: 'A couple — seated side by side',
  family: 'Related to each other',
  friend: 'Friends',
  introduce: "Haven't met, but we'd love them to",
  tension: 'Better at different tables',
};

export const SEAT_RULES: SeatRule[] = ['beside', 'together', 'apart'];

export const SEAT_LABEL: Record<SeatRule, string> = {
  beside: 'Seat next to',
  together: 'Same table',
  apart: 'Never same table',
};

/** The seating instruction in force: the override, or "next to" for partners. */
export const effectiveSeat = (r: Pick<Relation, 'kind' | 'seat'>): SeatRule | undefined => r.seat ?? (r.kind === 'partner' ? 'beside' : undefined);

/** What a tie means for seating, for checks that only care about the strongest signal. */
export type Effect = SeatRule | 'tension';
export const effectOf = (r: Pick<Relation, 'kind' | 'seat'>): Effect | undefined => effectiveSeat(r) ?? (r.kind === 'tension' ? 'tension' : undefined);

/** A tie that pulls people together (anything but tension / never same table). */
export const isPositive = (r: Pick<Relation, 'kind' | 'seat'>) => r.kind !== 'tension' && r.seat !== 'apart';

/** "Friend · Fire Island, the city · seat next to" */
export function describeTie(r: Pick<Relation, 'kind' | 'seat' | 'contexts'>) {
  const parts = [BOND_LABEL[r.kind]];
  if (r.contexts?.length) parts.push(r.contexts.join(', '));
  if (r.seat) parts.push(SEAT_LABEL[r.seat].toLowerCase());
  return parts.join(' · ');
}

const LEGACY: Record<string, Pick<Relation, 'kind' | 'seat'>> = {
  coworker: { kind: 'friend' },
  beside: { kind: 'friend', seat: 'beside' },
  together: { kind: 'friend', seat: 'together' },
  prefer: { kind: 'friend' },
  avoid: { kind: 'tension' },
  apart: { kind: 'tension', seat: 'apart' },
};

/** Convert ties saved by the earlier seating-instruction model. */
export function migrateRelation(r: Relation | (Omit<Relation, 'kind'> & { kind: string })): Relation | null {
  if ((BONDS as string[]).includes(r.kind)) return r as Relation;
  // acquaintances are no longer part of the graph
  if (r.kind === 'acquaintance') return null;
  const m = LEGACY[r.kind] ?? { kind: 'friend' as Bond };
  const out: Relation = { ...(r as Relation), kind: m.kind };
  if (m.seat && !out.seat) out.seat = m.seat;
  return out;
}

export const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
