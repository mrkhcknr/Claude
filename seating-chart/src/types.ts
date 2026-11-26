// All distances are stored in feet. The UI can display metres.

export type Id = string;

export type Side = 'partner1' | 'partner2' | 'both' | '';
export type Rsvp = 'yes' | 'pending' | 'no';

export interface Guest {
  id: Id;
  name: string;
  /** Household / party key. Guests in the same party are always seated together. */
  party: string;
  /** Free-form social group, e.g. "College friends", "Work", "Mom's family". */
  group: string;
  side: Side;
  rsvp: Rsvp;
  meal: string;
  dietary: string;
  child: boolean;
  /** Needs an accessible seat (near an exit, no stairs, room for a wheelchair). */
  accessible: boolean;
  notes: string;
  /** Pinned guests are never moved by auto-seat. */
  pinned: boolean;
  /** ID from the source system (e.g. Joy's guest ID) — used to match on re-import. */
  extId?: string;
  /** Events this guest is attending, from the import (e.g. "Rehearsal Dinner"). */
  events?: string[];
}

export type RelationKind = 'beside' | 'together' | 'prefer' | 'avoid' | 'apart';

export interface Relation {
  id: Id;
  a: Id;
  b: Id;
  kind: RelationKind;
}

export type TableShape = 'round' | 'rect' | 'square' | 'oval' | 'head';

export interface Table {
  id: Id;
  shape: TableShape;
  /** Number/label used by venue staff, e.g. "Table 7". */
  label: string;
  /** Display name, e.g. "Peony". Falls back to label. */
  name?: string;
  x: number;
  y: number;
  rotation: number;
  /** Width (or diameter) in feet. */
  w: number;
  /** Depth in feet (ignored for round). */
  h: number;
  seats: number;
  /** For rectangular tables: put chairs on the short ends too. */
  ends: boolean;
  /** Locked tables are not moved by drag and are skipped by auto-seat. */
  locked: boolean;
  /** Reserved for a category (e.g. "Kids"). Auto-seat prefers matching groups. */
  reservedFor: string;
  color: string;
}

export type ElementKind = 'wall' | 'column' | 'door' | 'window' | 'zone';

export type ZoneKind =
  | 'dance'
  | 'stage'
  | 'bar'
  | 'buffet'
  | 'dj'
  | 'cake'
  | 'gifts'
  | 'photo'
  | 'restroom'
  | 'kitchen'
  | 'custom';

export interface Wall {
  id: Id;
  kind: 'wall';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

export interface Opening {
  id: Id;
  kind: 'door' | 'window';
  x: number;
  y: number;
  rotation: number;
  w: number;
}

export interface Column {
  id: Id;
  kind: 'column';
  x: number;
  y: number;
  size: number;
  round: boolean;
}

export interface Zone {
  id: Id;
  kind: 'zone';
  zone: ZoneKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export type RoomElement = Wall | Opening | Column | Zone;

export interface Settings {
  units: 'ft' | 'm';
  gridSize: number;
  snap: boolean;
  /** Minimum clear aisle between chair backs and obstacles, feet. */
  clearance: number;
  partner1: string;
  partner2: string;
  showSeatNames: boolean;
  /** Auto-seat heuristics (see rules.ts). Missing keys use the defaults. */
  rules?: Partial<import('./rules').SeatingRules>;
  /** What seat colours mean on the plan. */
  colorBy: 'side' | 'meal' | 'group';
}

export interface Project {
  version: 1;
  name: string;
  guests: Guest[];
  relations: Relation[];
  tables: Table[];
  elements: RoomElement[];
  /** tableId -> array of guestIds by seat index (null = empty seat) */
  seating: Record<Id, (Id | null)[]>;
  settings: Settings;
}

export type Selection =
  | { type: 'table'; ids: Id[] }
  | { type: 'element'; ids: Id[] }
  | { type: 'guest'; ids: Id[] }
  | null;

export type Tool = 'select' | 'pan' | 'wall' | 'column' | 'door' | 'window';

export interface SeatRef {
  tableId: Id;
  seat: number;
}
