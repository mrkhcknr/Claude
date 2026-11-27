import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Guest, Id, Project, Relation, RoomElement, Selection, Table, TableLang, TableShape, Tool, ZoneKind } from './types';
import { splitFlowerName, uid } from './util';
import { packSeats } from './geometry';
import { migrateRelation } from './relations';
import { ask } from './ui';

export const STORAGE_KEY = 'wedding-seating:project:v1';

export const defaultSettings = (): Project['settings'] => ({
  units: 'ft',
  gridSize: 1,
  snap: true,
  clearance: 4,
  partner1: 'Partner 1',
  partner2: 'Partner 2',
  showSeatNames: true,
  colorBy: 'side',
  tableLang: 'both',
});

export const emptyProject = (): Project => ({
  version: 1,
  name: 'Our Wedding',
  guests: [],
  relations: [],
  tables: [],
  elements: [],
  seating: {},
  settings: defaultSettings(),
});

export type View = 'plan' | 'guests' | 'network' | 'lists';

export interface Camera {
  /** world (ft) coordinate at the canvas origin */
  x: number;
  y: number;
  /** pixels per foot */
  scale: number;
}

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  selection: Selection;
  tool: Tool;
  view: View;
  camera: Camera;
  toast: { id: number; text: string; undo?: boolean } | null;
  /** Guest id to pulse/flash on the plan (e.g. after "show on map"). */
  focusGuest: Id | null;
}

const HISTORY = 200;

function loadInitial(): Project {
  // inside claude.ai the shared database is the source of truth; don't flash this browser's copy
  if (typeof window !== 'undefined' && (window as { claude?: unknown }).claude) return emptyProject();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not load the saved seating chart', e);
  }
  return emptyProject();
}

export function migrate(p: Partial<Project>): Project {
  const base = emptyProject();
  const out: Project = {
    ...base,
    ...p,
    settings: { ...base.settings, ...(p.settings ?? {}) },
    guests: (p.guests ?? []).map((g) => ({ ...blankGuest(), ...g })),
    relations: (p.relations ?? []).map(migrateRelation),
    tables: (p.tables ?? []).map((t) => splitTableName({ ...tableDefaults(), ...t })),
    elements: p.elements ?? [],
    refs: p.refs ?? [],
    layouts: p.layouts ?? [],
    seating: p.seating ?? {},
    version: 1,
  };
  return normalizeSeating(out);
}

/** Ensure each table has a seat array of the right length and every guest is seated at most once. */
export function normalizeSeating(p: Project): Project {
  const seen = new Set<Id>();
  const ids = new Set(p.guests.map((g) => g.id));
  const seating: Project['seating'] = {};
  for (const t of p.tables) {
    const arr = (p.seating[t.id] ?? []).slice(0, t.seats);
    while (arr.length < t.seats) arr.push(null);
    seating[t.id] = arr.map((g) => {
      if (!g || !ids.has(g) || seen.has(g)) return null;
      seen.add(g);
      return g;
    });
  }
  return { ...p, seating };
}

export const useStore = create<State>(() => ({
  project: loadInitial(),
  past: [],
  future: [],
  selection: null,
  tool: 'select',
  view: 'plan',
  camera: { x: -5, y: -5, scale: 12 },
  toast: null,
  focusGuest: null,
}));

const get = useStore.getState;
const set = useStore.setState;

// ---------- core update + history ----------
export function update(recipe: (d: Draft<Project>) => void, opts: { history?: boolean } = {}) {
  const { project, past } = get();
  const next = produce(project, recipe);
  if (next === project) return;
  if (opts.history === false) set({ project: next });
  else set({ project: next, past: [...past.slice(-HISTORY + 1), project], future: [] });
}

/** Push the current state to history without changing it (start of a drag). */
export function checkpoint() {
  const { project, past } = get();
  set({ past: [...past.slice(-HISTORY + 1), project], future: [] });
}

export function undo() {
  const { past, project, future } = get();
  if (!past.length) return;
  set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
}

export function redo() {
  const { past, project, future } = get();
  if (!future.length) return;
  set({ project: future[0], future: future.slice(1), past: [...past, project] });
}

export function loadProject(p: Project) {
  const { project, past } = get();
  // saved floor plans survive opening a backup; ones in the file are added alongside
  const mine = project.layouts ?? [];
  const theirs = (p.layouts ?? []).filter((l) => !mine.some((m) => m.id === l.id));
  set({ project: migrate({ ...p, layouts: [...mine, ...theirs] }), past: [...past, project], future: [], selection: null });
}

let toastN = 0;
export function toast(text: string, undoable = false) {
  const id = ++toastN;
  set({ toast: { id, text, undo: undoable } });
  setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, 4500);
}

export const setSelection = (selection: Selection) => set({ selection });
export const setTool = (tool: Tool) => set({ tool });
export const setView = (view: View) => {
  const go = () => set({ view });
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (d.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) d.startViewTransition(go);
  else go();
};
export const setCamera = (camera: Camera) => set({ camera });
export const focusGuest = (id: Id | null) => {
  set({ focusGuest: id });
  if (id) setTimeout(() => get().focusGuest === id && set({ focusGuest: null }), 2500);
};

// ---------- defaults & presets ----------
// function declarations are hoisted: loadInitial() needs these before this line runs
export function blankGuest(): Guest {
  return {
  id: uid(),
  name: '',
  party: '',
  group: '',
  side: '',
  rsvp: 'yes',
  meal: '',
  dietary: '',
  child: false,
  accessible: false,
  notes: '',
  pinned: false,
  };
}

// function declarations are hoisted: loadInitial() needs these before this line runs
export function tableDefaults(): Table {
  return {
  id: uid(),
  shape: 'round',
  label: '',
  x: 0,
  y: 0,
  rotation: 0,
  w: 5,
  h: 5,
  seats: 8,
  ends: false,
  locked: false,
  reservedFor: '',
  color: '',
  };
}

export interface TablePreset {
  key: string;
  name: string;
  shape: TableShape;
  w: number;
  h: number;
  seats: number;
  ends?: boolean;
  label?: string;
}

export const TABLE_PRESETS: TablePreset[] = [
  { key: 'r60', name: 'Round 60″ · 8', shape: 'round', w: 5, h: 5, seats: 8 },
  { key: 'r72', name: 'Round 72″ · 10', shape: 'round', w: 6, h: 6, seats: 10 },
  { key: 'r48', name: 'Round 48″ · 6', shape: 'round', w: 4, h: 4, seats: 6 },
  { key: 'b6', name: 'Banquet 6′ · 6', shape: 'rect', w: 6, h: 2.5, seats: 6 },
  { key: 'b8', name: 'Banquet 8′ · 10', shape: 'rect', w: 8, h: 3, seats: 10, ends: true },
  { key: 'farm', name: 'Farm table 16′ · 18', shape: 'rect', w: 16, h: 3.5, seats: 18, ends: true },
  { key: 'sq', name: 'Square 4′ · 4', shape: 'square', w: 4, h: 4, seats: 4 },
  { key: 'sq5', name: 'Square 5′ · 8', shape: 'square', w: 5, h: 5, seats: 8 },
  { key: 'oval', name: 'Oval 8′ · 10', shape: 'oval', w: 8, h: 4.5, seats: 10 },
  { key: 'head', name: 'Head table 16′ · 8', shape: 'head', w: 16, h: 2.5, seats: 8, label: 'Head Table' },
  { key: 'sweet', name: 'Sweetheart · 2', shape: 'head', w: 4, h: 2.5, seats: 2, label: 'Sweetheart' },
];

export const ZONE_PRESETS: { zone: ZoneKind; label: string; w: number; h: number }[] = [
  { zone: 'dance', label: 'Dance floor', w: 18, h: 18 },
  { zone: 'stage', label: 'Stage / Band', w: 16, h: 8 },
  { zone: 'dj', label: 'DJ', w: 6, h: 3 },
  { zone: 'bar', label: 'Bar', w: 10, h: 3 },
  { zone: 'buffet', label: 'Buffet', w: 12, h: 3 },
  { zone: 'cake', label: 'Cake', w: 3, h: 3 },
  { zone: 'gifts', label: 'Gifts & cards', w: 5, h: 2.5 },
  { zone: 'photo', label: 'Photo booth', w: 8, h: 8 },
  { zone: 'restroom', label: 'Restrooms', w: 10, h: 8 },
  { zone: 'kitchen', label: 'Kitchen', w: 12, h: 10 },
  { zone: 'custom', label: 'Area', w: 8, h: 6 },
];

// ---------- guest actions ----------
export function addGuests(gs: Partial<Guest>[]) {
  const made = gs.map((g) => ({ ...blankGuest(), ...g, id: g.id ?? uid() }));
  update((d) => {
    d.guests.push(...made);
  });
  return made;
}

export function updateGuests(ids: Id[], patch: Partial<Guest>) {
  const s = new Set(ids);
  update((d) => {
    for (const g of d.guests) if (s.has(g.id)) Object.assign(g, patch);
  });
}

export function deleteGuests(ids: Id[]) {
  const s = new Set(ids);
  update((d) => {
    d.guests = d.guests.filter((g) => !s.has(g.id));
    d.relations = d.relations.filter((r) => !s.has(r.a) && !s.has(r.b));
    for (const k in d.seating) d.seating[k] = d.seating[k].map((g) => (g && s.has(g) ? null : g));
  });
  set({ selection: null });
}

/** Link guests into one household / party. */
export function makeParty(ids: Id[]) {
  const s = new Set(ids);
  const { project } = get();
  const existing = project.guests.find((g) => s.has(g.id) && g.party)?.party;
  const key = existing || uid();
  update((d) => {
    for (const g of d.guests) if (s.has(g.id)) g.party = key;
  });
}

// ---------- relations ----------
export type TiePatch = Partial<Pick<Relation, 'kind' | 'seat' | 'contexts'>>;

const pairKey = (a: Id, b: Id) => (a < b ? a + '|' + b : b + '|' + a);

/** Contexts on a tie ("Fire Island", "Google") also become tags on both guests. */
function tagBoth(d: Draft<Project>, ids: Id[], contexts: string[] | undefined) {
  if (!contexts?.length) return;
  for (const g of d.guests) {
    if (!ids.includes(g.id)) continue;
    const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
    const add = contexts.filter((c) => c.trim() && !cur.some((x) => x.toLowerCase() === c.trim().toLowerCase()));
    if (add.length) g.group = [...cur, ...add.map((c) => c.trim())].join(', ');
  }
}

function applyTie(d: Draft<Project>, a: Id, b: Id, patch: TiePatch | null) {
  const i = d.relations.findIndex((r) => pairKey(r.a, r.b) === pairKey(a, b));
  if (!patch) {
    if (i >= 0) d.relations.splice(i, 1);
    return;
  }
  const r: Relation = i >= 0 ? d.relations[i] : { id: uid(), a, b, kind: patch.kind ?? 'friend' };
  if (patch.kind) r.kind = patch.kind;
  if ('seat' in patch) {
    if (patch.seat) r.seat = patch.seat;
    else delete r.seat;
  }
  if ('contexts' in patch) {
    const cs = [...new Map((patch.contexts ?? []).map((c) => c.trim()).filter(Boolean).map((c) => [c.toLowerCase(), c])).values()];
    if (cs.length) r.contexts = cs;
    else delete r.contexts;
  }
  if (i < 0) d.relations.push(r);
  tagBoth(d, [a, b], r.contexts);
}

/** Create, change or (with null) remove the tie between two guests. Unspecified fields are kept. */
export function setRelation(a: Id, b: Id, patch: TiePatch | null) {
  if (a === b) return;
  update((d) => applyTie(d, a, b, patch));
}

/** Add a context ("Fire Island") to the tie between two guests, creating a friend tie if needed. */
export function addTieContext(a: Id, b: Id, context: string) {
  const c = context.trim();
  if (!c || a === b) return;
  update((d) => {
    const r = d.relations.find((x) => pairKey(x.a, x.b) === pairKey(a, b));
    const cur = r?.contexts ?? [];
    applyTie(d, a, b, { contexts: cur.some((x) => x.toLowerCase() === c.toLowerCase()) ? cur : [...cur, c] });
  });
}

/** Apply a tie between every pair in ids (null removes them). Contexts are added to existing ones. */
export function relateAll(ids: Id[], patch: TiePatch | null) {
  if (ids.length < 2) return;
  update((d) => {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        if (patch?.contexts) {
          const r = d.relations.find((x) => pairKey(x.a, x.b) === pairKey(ids[i], ids[j]));
          const cur = r?.contexts ?? [];
          const merged = [...cur, ...patch.contexts.filter((c) => !cur.some((x) => x.toLowerCase() === c.trim().toLowerCase()))];
          applyTie(d, ids[i], ids[j], { ...patch, contexts: merged });
        } else applyTie(d, ids[i], ids[j], patch);
      }
  });
}

// ---------- seating ----------
export function locate(p: Project) {
  const m = new Map<Id, { tableId: Id; seat: number }>();
  for (const [tableId, arr] of Object.entries(p.seating)) arr.forEach((g, seat) => g && m.set(g, { tableId, seat }));
  return m;
}

function removeEverywhere(d: Draft<Project>, ids: Set<Id>) {
  for (const k in d.seating) d.seating[k] = d.seating[k].map((g) => (g && ids.has(g) ? null : g));
}

/** Put a guest in a specific seat; if occupied, swap with the occupant. */
export function seatGuest(guestId: Id, tableId: Id, seat: number) {
  update((d) => {
    const arr = d.seating[tableId];
    if (!arr || seat < 0 || seat >= arr.length) return;
    let from: { t: Id; s: number } | null = null;
    for (const [t, a] of Object.entries(d.seating)) {
      const i = a.indexOf(guestId);
      if (i >= 0) from = { t, s: i };
    }
    if (from && from.t === tableId && from.s === seat) return;
    const occupant = arr[seat];
    // swap: the occupant takes the mover's old seat, or the nearest empty chair at this table
    if (from) d.seating[from.t][from.s] = occupant ?? null;
    else if (occupant) {
      const free = arr.map((g, i) => (g ? -1 : i)).filter((i) => i >= 0).sort((a, b) => Math.abs(a - seat) - Math.abs(b - seat))[0];
      if (free !== undefined) arr[free] = occupant;
    }
    arr[seat] = guestId;
  });
}

/** Seat several guests at a table in side-by-side chairs where possible, starting near `startSeat`. Returns number seated. */
export function seatAtTable(guestIds: Id[], tableId: Id, startSeat?: number): number {
  const { project } = get();
  const arr = project.seating[tableId];
  const table = project.tables.find((t) => t.id === tableId);
  if (!arr || !table) return 0;
  const moving = new Set(guestIds);
  const occupied = arr.map((g) => !!g && !moving.has(g));
  const free = occupied.filter((o) => !o).length;
  if (!free) return 0;
  const n = Math.min(free, guestIds.length);
  const [seats] = packSeats(table, occupied, [n], startSeat !== undefined && !occupied[startSeat] ? startSeat : undefined);
  const placed = guestIds.slice(0, seats.length);
  update((d) => {
    removeEverywhere(d, new Set(placed));
    placed.forEach((g, k) => (d.seating[tableId][seats[k]] = g));
  });
  return placed.length;
}

/** Exchange two guests' seats (either may be unseated). */
export function swapGuests(a: Id, b: Id) {
  update((d) => {
    let pa: [Id, number] | null = null,
      pb: [Id, number] | null = null;
    for (const [t, arr] of Object.entries(d.seating)) {
      const i = arr.indexOf(a),
        j = arr.indexOf(b);
      if (i >= 0) pa = [t, i];
      if (j >= 0) pb = [t, j];
    }
    if (pa) d.seating[pa[0]][pa[1]] = b;
    if (pb) d.seating[pb[0]][pb[1]] = a;
    if (pa && !pb) d.seating[pa[0]][pa[1]] = b;
    if (pb && !pa) d.seating[pb[0]][pb[1]] = a;
  });
}

export function unseat(ids: Id[]) {
  update((d) => removeEverywhere(d, new Set(ids)));
}

export function clearTables(tableIds: Id[]) {
  update((d) => {
    for (const t of tableIds) if (d.seating[t]) d.seating[t] = d.seating[t].map(() => null);
  });
}

// ---------- tables ----------
export function addTable(preset: TablePreset, at: { x: number; y: number }, label?: string): Table {
  const t: Table = {
    ...tableDefaults(),
    shape: preset.shape,
    w: preset.w,
    h: preset.h,
    seats: preset.seats,
    ends: !!preset.ends,
    x: at.x,
    y: at.y,
    label: label ?? preset.label ?? nextTableLabel(get().project),
  };
  update((d) => {
    d.tables.push(t);
    d.seating[t.id] = Array(t.seats).fill(null);
  });
  return t;
}

export function nextTableLabel(p: Project, offset = 0) {
  let max = 0;
  for (const t of p.tables) {
    const m = /^(?:Table\s*)?(\d+)$/i.exec(t.label.trim());
    if (m) max = Math.max(max, +m[1]);
  }
  return `Table ${max + 1 + offset}`;
}

/** Move a legacy combined name ("火鶴 Anthurium") into separate Chinese and English fields. */
export function splitTableName<T extends Pick<Table, 'name' | 'nameZh' | 'nameEn'>>(t: T): T {
  if (t.name === undefined) return t;
  const { name, ...rest } = t;
  if (rest.nameZh !== undefined || rest.nameEn !== undefined || !name?.trim()) return rest as T;
  const [a, b] = splitFlowerName(name);
  const zh = /[\u3400-\u9fff]/.test(a) ? a : '';
  return { ...rest, nameZh: zh, nameEn: zh ? b : name.trim() } as T;
}

type Named = Pick<Table, 'label' | 'nameZh' | 'nameEn'>;
const curLang = (): TableLang => get().project.settings.tableLang ?? 'both';

/** A table's name in the chosen language (falling back to the other one, then the number). */
export function tableName(t: Named, lang: TableLang = curLang()) {
  const zh = t.nameZh?.trim() ?? '',
    en = t.nameEn?.trim() ?? '';
  if (lang === 'zh') return zh || en || t.label;
  if (lang === 'en') return en || zh || t.label;
  return [zh, en].filter(Boolean).join(' ') || t.label;
}

export const hasTableName = (t: Named) => !!(t.nameZh?.trim() || t.nameEn?.trim());

export function setTableLang(lang: TableLang) {
  update((d) => {
    d.settings.tableLang = lang;
  });
}

import venueFlowers from './venueFlowers.json';

export const FLOWERS = [
  ...(venueFlowers as string[]),
  'Peony', 'Ranunculus', 'Dahlia', 'Garden Rose', 'Anemone', 'Hydrangea', 'Magnolia', 'Camellia',
  'Gardenia', 'Lilac', 'Sweet Pea', 'Tulip', 'Freesia', 'Lisianthus', 'Orchid', 'Iris', 'Jasmine',
  'Lavender', 'Poppy', 'Wisteria', 'Zinnia', 'Cosmos', 'Hellebore', 'Delphinium', 'Snapdragon',
  'Calla Lily', 'Marigold', 'Protea', 'Gerbera', 'Foxglove', 'Larkspur', 'Stock', 'Scabiosa', 'Clematis',
];

/** Give every table (or just the selected ones) a flower name, in table-number order. */
export function nameTablesAfterFlowers(ids?: Id[]) {
  const { project } = get();
  const num = (t: Table) => +(/\d+/.exec(t.label)?.[0] ?? 999);
  const targets = project.tables.filter((t) => !ids || ids.includes(t.id)).sort((a, b) => num(a) - num(b));
  const used = new Set(project.tables.filter((t) => !targets.includes(t)).map((t) => tableName(t, 'both')));
  const pool = FLOWERS.filter((f) => !used.has(f));
  update((d) => {
    targets.forEach((t, i) => {
      const dt = d.tables.find((x) => x.id === t.id);
      if (!dt) return;
      const n = splitTableName<Pick<Table, 'name' | 'nameZh' | 'nameEn'>>({ name: pool[i % pool.length] });
      const suffix = i >= pool.length ? ` ${Math.floor(i / pool.length) + 1}` : '';
      dt.nameZh = n.nameZh ? n.nameZh + suffix : '';
      dt.nameEn = n.nameEn ? n.nameEn + suffix : '';
      delete dt.name;
    });
  });
  toast(`Named ${targets.length} tables after flowers`, true);
}

export function addTableGrid(preset: TablePreset, count: number, perRow: number, origin: { x: number; y: number }) {
  const { project } = get();
  const fx = preset.w + 2 * 1.9 + project.settings.clearance + 0.5;
  const fy = (preset.shape === 'round' ? preset.w : preset.h) + 2 * 1.9 + project.settings.clearance + 0.5;
  const made: Table[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / perRow),
      c = i % perRow;
    made.push({
      ...tableDefaults(),
      shape: preset.shape,
      w: preset.w,
      h: preset.h,
      seats: preset.seats,
      ends: !!preset.ends,
      x: origin.x + c * fx,
      y: origin.y + r * fy,
      label: preset.label && count === 1 ? preset.label : nextTableLabel(project, i),
    });
  }
  update((d) => {
    for (const t of made) {
      d.tables.push(t);
      d.seating[t.id] = Array(t.seats).fill(null);
    }
  });
  set({ selection: { type: 'table', ids: made.map((t) => t.id) } });
  return made;
}

export function updateTables(ids: Id[], patch: Partial<Table> | ((t: Draft<Table>) => void), history = true) {
  const s = new Set(ids);
  update(
    (d) => {
      for (const t of d.tables) {
        if (!s.has(t.id)) continue;
        if (typeof patch === 'function') patch(t);
        else Object.assign(t, patch);
        if (t.shape === 'square') t.h = t.w;
        if (t.shape === 'round') t.h = t.w;
        t.seats = Math.max(0, Math.min(40, Math.round(t.seats)));
        const arr = d.seating[t.id] ?? [];
        if (arr.length !== t.seats) {
          // keep seated guests when shrinking: compact them first
          const people = arr.filter(Boolean);
          const next: (Id | null)[] = arr.length > t.seats ? [] : [...arr];
          if (arr.length > t.seats) {
            for (const g of people.slice(0, t.seats)) next.push(g);
          }
          while (next.length < t.seats) next.push(null);
          d.seating[t.id] = next;
        }
      }
    },
    { history },
  );
}

export function deleteTables(ids: Id[]) {
  const s = new Set(ids);
  update((d) => {
    d.tables = d.tables.filter((t) => !s.has(t.id));
    for (const id of ids) delete d.seating[id];
  });
  set({ selection: null });
}

export function duplicateSelection() {
  const { selection, project } = get();
  if (!selection) return;
  if (selection.type === 'table') {
    const src = project.tables.filter((t) => selection.ids.includes(t.id));
    const made = src.map((t, i) => ({ ...t, id: uid(), x: t.x + 3, y: t.y + 3, locked: false, label: /^(Table\s*)?\d+$/i.test(t.label) ? nextTableLabel(project, i) : t.label + ' copy' }));
    update((d) => {
      for (const t of made) {
        d.tables.push(t);
        d.seating[t.id] = Array(t.seats).fill(null);
      }
    });
    set({ selection: { type: 'table', ids: made.map((t) => t.id) } });
  } else if (selection.type === 'element') {
    const src = project.elements.filter((e) => selection.ids.includes(e.id));
    const made = src.map((e) => {
      const c = { ...e, id: uid() } as RoomElement;
      if (c.kind === 'wall') Object.assign(c, { x1: c.x1 + 2, y1: c.y1 + 2, x2: c.x2 + 2, y2: c.y2 + 2 });
      else Object.assign(c, { x: c.x + 2, y: c.y + 2 });
      return c;
    });
    update((d) => {
      d.elements.push(...made);
    });
    set({ selection: { type: 'element', ids: made.map((e) => e.id) } });
  }
}

/** Renumber "Table N" tables front-to-back, left-to-right. */
export function renumberTables() {
  const { project } = get();
  const isHead = (t: Table) => t.shape === 'head' || /^head/i.test(t.label.trim());
  const heads = project.tables.filter(isHead).sort((a, b) => a.y - b.y || a.x - b.x);
  const numbered = project.tables.filter((t) => !isHead(t) && (/^(Table\s*)?\d+$/i.test(t.label.trim()) || !t.label.trim()));
  const sorted = [...numbered].sort((a, b) => a.y - b.y);
  const rows: Table[][] = [];
  for (const t of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - t.y) < 4);
    if (row) row.push(t);
    else rows.push([t]);
  }
  const order = rows.flatMap((r) => r.sort((a, b) => a.x - b.x)).map((t) => t.id);
  // head tables take the first numbers
  update((d) => {
    for (const t of d.tables) {
      const h = heads.findIndex((x) => x.id === t.id);
      if (h >= 0) t.label = `Head Table ${h + 1}`;
      const i = order.indexOf(t.id);
      if (i >= 0) t.label = `Table ${heads.length + i + 1}`;
    }
  });
  toast(`Renumbered ${heads.length + order.length} tables, head tables first`, true);
}

// ---------- elements ----------
export function addElement(e: RoomElement) {
  update((d) => {
    d.elements.push(e);
  });
  return e;
}

export function updateElements(ids: Id[], fn: (e: Draft<RoomElement>) => void, history = true) {
  const s = new Set(ids);
  update(
    (d) => {
      for (const e of d.elements) if (s.has(e.id)) fn(e);
    },
    { history },
  );
}

export function deleteElements(ids: Id[]) {
  const s = new Set(ids);
  update((d) => {
    d.elements = d.elements.filter((e) => !s.has(e.id));
  });
  set({ selection: null });
}

/** Scale the room (walls, columns, doors, areas, table positions and plan overlays) about a point. Table sizes stay real. */
export function scaleRoom(k: number, o: { x: number; y: number }) {
  if (!(k > 0) || k === 1) return;
  const sx = (v: number) => o.x + (v - o.x) * k,
    sy = (v: number) => o.y + (v - o.y) * k;
  update((d) => {
    for (const e of d.elements) {
      if (e.kind === 'wall') Object.assign(e, { x1: sx(e.x1), y1: sy(e.y1), x2: sx(e.x2), y2: sy(e.y2) });
      else {
        e.x = sx(e.x);
        e.y = sy(e.y);
        if (e.kind === 'zone') Object.assign(e, { w: e.w * k, h: e.h * k });
      }
    }
    for (const t of d.tables) Object.assign(t, { x: sx(t.x), y: sy(t.y) });
    for (const r of d.refs ?? []) Object.assign(r, { x: sx(r.x), y: sy(r.y), scale: r.scale * k });
  });
  toast(`Room rescaled ×${k.toFixed(3)}`, true);
}

export function makeRectRoom(w: number, h: number, thickness = 0.75) {
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const walls: RoomElement[] = pts.map(([x1, y1], i) => {
    const [x2, y2] = pts[(i + 1) % 4];
    return { id: uid(), kind: 'wall', x1, y1, x2, y2, thickness };
  });
  update((d) => {
    d.elements.push(...walls);
  });
}

export function deleteSelection() {
  const { selection } = get();
  if (!selection) return;
  if (selection.type === 'table') deleteTables(selection.ids);
  else if (selection.type === 'element') deleteElements(selection.ids);
  else if (selection.type === 'ref') {
    const ids = selection.ids;
    void ask('Remove this floor plan?', { detail: 'Only the reference image is removed; your layout stays. You can undo this.', ok: 'Remove', danger: true }).then((ok) => {
      if (!ok) return;
      update((d) => void (d.refs = (d.refs ?? []).filter((r) => !ids.includes(r.id))));
      set({ selection: null });
    });
  }
  else if (selection.type === 'guest') {
    void ask(`Delete ${selection.ids.length === 1 ? 'this guest' : `${selection.ids.length} guests`}?`, {
      detail: 'They are removed from the guest list, their seats and the social graph. You can undo this.',
      ok: 'Delete',
      danger: true,
    }).then((ok) => ok && deleteGuests(selection.ids));
  }
}

// ---------- alignment ----------
type AlignMode = 'left' | 'cx' | 'right' | 'top' | 'cy' | 'bottom' | 'dh' | 'dv';
export function alignTables(ids: Id[], mode: AlignMode) {
  const ts = get().project.tables.filter((t) => ids.includes(t.id));
  if (ts.length < 2) return;
  const xs = ts.map((t) => t.x),
    ys = ts.map((t) => t.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const pos = new Map<Id, { x?: number; y?: number }>();
  if (mode === 'dh' || mode === 'dv') {
    const key = mode === 'dh' ? 'x' : 'y';
    const sorted = [...ts].sort((a, b) => a[key] - b[key]);
    const lo = sorted[0][key],
      hi = sorted[sorted.length - 1][key];
    sorted.forEach((t, i) => pos.set(t.id, { [key]: lo + ((hi - lo) * i) / (sorted.length - 1) }));
  } else {
    for (const t of ts) {
      if (mode === 'left') pos.set(t.id, { x: minX });
      if (mode === 'right') pos.set(t.id, { x: maxX });
      if (mode === 'cx') pos.set(t.id, { x: (minX + maxX) / 2 });
      if (mode === 'top') pos.set(t.id, { y: minY });
      if (mode === 'bottom') pos.set(t.id, { y: maxY });
      if (mode === 'cy') pos.set(t.id, { y: (minY + maxY) / 2 });
    }
  }
  update((d) => {
    for (const t of d.tables) {
      const p = pos.get(t.id);
      if (p) Object.assign(t, p);
    }
  });
}

export { get as getState };

// ---------- saved floor plans ----------
const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Save the current room and tables under a name (or overwrite an existing saved plan). */
export function saveLayout(name: string, overwriteId?: Id) {
  const { project } = get();
  const savedAt = new Date().toISOString();
  const snap = { tables: plain(project.tables), elements: plain(project.elements) };
  update((d) => {
    d.layouts ??= [];
    const ex = overwriteId ? d.layouts.find((l) => l.id === overwriteId) : undefined;
    if (ex) Object.assign(ex, { name, savedAt, ...snap });
    else d.layouts.push({ id: uid(), name, savedAt, ...snap });
  });
  toast(`Saved floor plan "${name}"`, true);
}

/** Replace the room and tables with a saved plan. Guests stay; seats are kept at tables that still exist. */
export async function loadLayout(id: Id) {
  const { project } = get();
  const l = project.layouts?.find((x) => x.id === id);
  if (!l) return;
  const keepIds = new Set(l.tables.map((t) => t.id));
  const lost = project.tables.filter((t) => !keepIds.has(t.id)).reduce((n, t) => n + (project.seating[t.id] ?? []).filter(Boolean).length, 0);
  const ok = await ask(`Load "${l.name}"?`, {
    detail: `This replaces the room and tables on the plan with the saved ones (${l.tables.length} tables). Guests aren't changed${lost ? `; ${lost} seated guest${lost === 1 ? '' : 's'} at tables not in this plan will be unseated` : ''}. Undo is available.`,
    ok: 'Load floor plan',
  });
  if (!ok) return;
  update((d) => {
    d.tables = plain(l.tables);
    d.elements = plain(l.elements);
    const seating: Project['seating'] = {};
    for (const t of d.tables) {
      const arr = (d.seating[t.id] ?? []).slice(0, t.seats);
      while (arr.length < t.seats) arr.push(null);
      seating[t.id] = arr;
    }
    d.seating = seating;
  });
  setSelection(null);
  toast(`Loaded "${l.name}"`, true);
}

export async function deleteLayout(id: Id) {
  const l = get().project.layouts?.find((x) => x.id === id);
  if (!l || !(await ask(`Delete the saved floor plan "${l.name}"?`, { detail: 'The plan on screen is not affected. Undo is available.', ok: 'Delete', danger: true }))) return;
  update((d) => void (d.layouts = (d.layouts ?? []).filter((x) => x.id !== id)));
}
