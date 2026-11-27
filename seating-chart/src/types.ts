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
  /** Other spellings of this guest's name in other lists (e.g. 陳大文 / David Chen / "Chen Da Wen"). */
  aliases?: string[];
  /** Events this guest is attending, from the import (e.g. "Rehearsal Dinner"). */
  events?: string[];
  /** What each imported list said about this guest, keyed by the list's label. */
  sources?: Record<string, SourceInfo>;
}

export interface SourceInfo {
  rsvp?: Rsvp;
  meal?: string;
  dietary?: string;
}

/** One imported list (the guest list itself, or an RSVP / meal crosscheck). */
export interface ImportRecord {
  id: Id;
  label: string;
  kind: 'guests' | 'crosscheck';
  at: string;
  rows: number;
  /** Names in that list that matched no guest. */
  unmatched: string[];
  /** Guest ids this list covered, so "missing from list" can be computed later. */
  covered: Id[];
  /** Discrepancies the couple marked as fine: `${guestId}:${field}:${label}` */
  dismissed?: string[];
}

/** Who two guests are to each other. Where they work / how they met goes in `contexts`. */
export type Bond = 'partner' | 'family' | 'friend' | 'coworker' | 'acquaintance' | 'tension';
/** @deprecated use Bond */
export type RelationKind = Bond;
/** An explicit seating instruction that overrides what the relationship alone implies. */
export type SeatRule = 'beside' | 'together' | 'apart';

export interface Relation {
  id: Id;
  a: Id;
  b: Id;
  kind: Bond;
  /** Optional override: seat next to / same table / never same table. Partners default to next to. */
  seat?: SeatRule;
  /** How they know each other, e.g. "Fire Island", "the city", "Google". Also added to both guests' tags. */
  contexts?: string[];
}

export type TableShape = 'round' | 'rect' | 'square' | 'oval' | 'head';

export interface Table {
  id: Id;
  shape: TableShape;
  /** Number/label used by venue staff, e.g. "Table 7". */
  label: string;
  /** Chinese display name, e.g. "牡丹". */
  nameZh?: string;
  /** English display name, e.g. "Peony". */
  nameEn?: string;
  /** Legacy combined name ("牡丹 Peony"); split into nameZh/nameEn on load. */
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
  /** Table tags: groups this table is for, comma-separated ("Groom, Wedding Party"). Guests with any of them are preferred here. */
  reservedFor: string;
  /** Seating area this table belongs to, e.g. "Top room". Groups can be assigned to an area. */
  area?: string;
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
  /** Custom colours per tag (lower-case tag → hex). */
  tagColors?: Record<string, string>;
  /** Which table names to show: Chinese, English, or both. */
  tableLang?: TableLang;
  /** Where groups should sit: each group is pulled to its tables / area by auto-seat. */
  placements?: Placement[];
}

export interface Placement {
  id: Id;
  /** A tag, a partner's side ("partner1"/"partner2"), or "kids" */
  group: string;
  /** "area:<name>" or "table:<id>" */
  target: string;
}

export type TableLang = 'zh' | 'en' | 'both';

/** A venue floor plan (image or PDF page) shown under the layout for tracing and checking. */
export interface RefLayer {
  id: Id;
  name: string;
  /** Image URL: "/_blob/<asset id>" when stored with the artifact, or a data: URL locally */
  src: string;
  imgW: number;
  imgH: number;
  /** World position (ft) of the image's top-left corner */
  x: number;
  y: number;
  /** Feet per image pixel */
  scale: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
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
  imports?: ImportRecord[];
  refs?: RefLayer[];
  /** Named copies of the room and tables ("Brickyard Wedding") that can be loaded back. */
  layouts?: SavedLayout[];
}

export interface SavedLayout {
  id: Id;
  name: string;
  savedAt: string;
  tables: Table[];
  elements: RoomElement[];
}

export type Selection =
  | { type: 'table'; ids: Id[] }
  | { type: 'element'; ids: Id[] }
  | { type: 'guest'; ids: Id[] }
  | { type: 'ref'; ids: Id[] }
  | null;

export type Tool = 'select' | 'pan' | 'wall' | 'column' | 'door' | 'window' | 'refScale' | 'refAlign';

export interface SeatRef {
  tableId: Id;
  seat: number;
}
