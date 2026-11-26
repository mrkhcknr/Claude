/**
 * Keeps the project in sync with the claude.ai artifact database when the page runs there,
 * and falls back to this browser's storage everywhere else.
 *
 * Layout in the store (one document per entity so two people editing different things never collide):
 *   meta/project        { name, settings }
 *   guests/{id}         Guest (no contact details are ever stored)
 *   relations/{id}      Relation
 *   tables/{id}         Table + { seats: (guestId|null)[] }
 *   elements/{id}       RoomElement
 */
import { create } from 'zustand';
import type { Guest, Project, Relation, RoomElement, Table } from './types';
import { STORAGE_KEY, emptyProject, migrate, normalizeSeating, useStore } from './store';

type Unsub = () => void;
interface DocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata: { fromCache: boolean; hasPendingWrites: boolean };
}
interface QuerySnap {
  docs: DocSnap[];
  metadata: { fromCache: boolean };
}
interface DocRef {
  set(d: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}
interface DB {
  doc(path: string): DocRef;
  collection(path: string): { onSnapshot(next: (s: QuerySnap) => void, err?: (e: { code: string; message: string }) => void): Unsub };
}
interface UserNs {
  can(name: string): Promise<boolean | null>;
  isOwner(): Promise<boolean>;
}
interface DownloadsNs {
  save(r: { filename: string; data: string | Blob }): Promise<{ status: string }>;
}
declare global {
  interface Window {
    claude?: { use(name: string): Promise<unknown> };
  }
}

export type SyncMode = 'connecting' | 'shared' | 'local' | 'offline' | 'readonly';
export const useSync = create<{ mode: SyncMode; pending: number; error: string; canWrite: boolean }>(() => ({
  mode: window.claude ? 'connecting' : 'local',
  pending: 0,
  error: '',
  canWrite: true,
}));

let downloadsNs: DownloadsNs | null = null;
export const getDownloads = () => downloadsNs;

const COLLECTIONS = ['guests', 'relations', 'tables', 'elements', 'meta'] as const;
type Coll = (typeof COLLECTIONS)[number];

/** JSON of what the server last told us (or what we last wrote), per doc path. */
const known = new Map<string, string>();
let applyingRemote = false;
let db: DB | null = null;

export async function startSync() {
  const claude = window.claude;
  if (!claude) return startLocal();
  const [dbNs, userNs, dl] = await Promise.all([claude.use('db'), claude.use('user'), claude.use('downloads')]);
  downloadsNs = (dl as DownloadsNs) ?? null;
  if (!dbNs) return startLocal();
  db = dbNs as DB;
  const user = userNs as UserNs | null;
  user?.can('data.write').then((ok) => {
    if (ok === false) useSync.setState({ mode: 'readonly', canWrite: false });
  });

  const docs: Record<Coll, Map<string, Record<string, unknown>>> = {
    guests: new Map(),
    relations: new Map(),
    tables: new Map(),
    elements: new Map(),
    meta: new Map(),
  };
  const loaded = new Set<Coll>();
  const timer = setTimeout(() => {
    if (useSync.getState().mode === 'connecting') useSync.setState({ mode: 'offline', error: "Can't reach the shared seating data yet. Changes will appear once it connects." });
  }, 10000);

  for (const c of COLLECTIONS) {
    db.collection(c).onSnapshot(
      (snap) => {
        const m = docs[c];
        m.clear();
        for (const d of snap.docs) {
          const body = d.data();
          if (!body) continue;
          m.set(d.id, body);
          known.set(`${c}/${d.id}`, JSON.stringify(body));
        }
        if (!snap.metadata.fromCache) loaded.add(c);
        if (loaded.size === COLLECTIONS.length || snap.metadata.fromCache === false) {
          applyRemote(docs);
        }
        if (loaded.size === COLLECTIONS.length) {
          clearTimeout(timer);
          const s = useSync.getState();
          if (s.mode === 'connecting' || s.mode === 'offline') useSync.setState({ mode: s.canWrite ? 'shared' : 'readonly', error: '' });
        }
      },
      (e) => {
        clearTimeout(timer);
        useSync.setState({ mode: 'offline', error: e.code === 'revoked' ? 'Access to the shared data ended.' : `Shared data stopped updating (${e.code}). Reload to reconnect.` });
      },
    );
  }

  useStore.subscribe((s, prev) => {
    if (applyingRemote || s.project === prev.project) return;
    if (!useSync.getState().canWrite) return;
    diffAndQueue(prev.project, s.project);
  });
}

function startLocal() {
  useSync.setState({ mode: 'local' });
  let t: ReturnType<typeof setTimeout> | undefined;
  useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s.project));
      } catch {
        /* storage unavailable: the user can still save a backup file */
      }
    }, 300);
  });
}

/** Build a Project from the remote documents, keeping local objects where nothing changed (cheap re-render). */
function applyRemote(docs: Record<Coll, Map<string, Record<string, unknown>>>) {
  const cur = useStore.getState().project;
  const keep = <T extends { id: string }>(list: T[], m: Map<string, Record<string, unknown>>, coll: Coll, strip?: (b: Record<string, unknown>) => T): T[] => {
    const byId = new Map(list.map((x) => [x.id, x]));
    const out: T[] = [];
    for (const [id, body] of m) {
      const path = `${coll}/${id}`;
      if (pendingPaths.has(path)) {
        const local = byId.get(id);
        if (local) out.push(local);
        continue;
      }
      const next = strip ? strip({ ...body, id }) : ({ ...body, id } as unknown as T);
      const local = byId.get(id);
      out.push(local && JSON.stringify(local) === JSON.stringify(next) ? local : next);
    }
    // keep locally-created items whose first write is still in flight
    for (const x of list) if (!m.has(x.id) && pendingPaths.has(`${coll}/${x.id}`)) out.push(x);
    return out;
  };
  const seating: Project['seating'] = {};
  const tables = keep<Table>(cur.tables, docs.tables, 'tables', (b) => {
    const { seats, ...t } = b as unknown as Table & { seats?: (string | null)[] };
    seating[t.id] = seats ?? [];
    return t as Table;
  });
  for (const t of tables) if (!seating[t.id]) seating[t.id] = cur.seating[t.id] ?? [];
  const meta = docs.meta.get('project') as Partial<Pick<Project, 'name' | 'settings'>> | undefined;
  const next = normalizeSeating(
    migrate({
      ...cur,
      name: meta?.name ?? cur.name,
      settings: { ...cur.settings, ...(meta?.settings ?? {}) },
      guests: keep<Guest>(cur.guests, docs.guests, 'guests'),
      relations: keep<Relation>(cur.relations, docs.relations, 'relations'),
      elements: keep<RoomElement>(cur.elements, docs.elements, 'elements'),
      tables,
      seating,
    }),
  );
  applyingRemote = true;
  useStore.setState({ project: next });
  applyingRemote = false;
}

// ---------- outgoing writes: one in flight per document, coalesced ----------
const latest = new Map<string, Record<string, unknown> | null>(); // null = delete
const inflight = new Set<string>();
const pendingPaths = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_PARALLEL = 6;

function queue(path: string, body: Record<string, unknown> | null) {
  const json = body ? JSON.stringify(body) : null;
  if (json !== null && known.get(path) === json && !inflight.has(path)) {
    latest.delete(path);
    pendingPaths.delete(path);
    return;
  }
  latest.set(path, body);
  pendingPaths.add(path);
  useSync.setState({ pending: pendingPaths.size });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(pump, 250);
}

async function pump() {
  if (!db) return;
  for (const [path, body] of latest) {
    if (inflight.size >= MAX_PARALLEL) break;
    if (inflight.has(path)) continue;
    latest.delete(path);
    inflight.add(path);
    const ref = db.doc(path);
    const p = body ? ref.set(body) : ref.delete();
    p.then(
      () => {
        if (body) known.set(path, JSON.stringify(body));
        else known.delete(path);
      },
      (e: { code?: string; message?: string }) => {
        if (e?.code === 'unavailable') latest.has(path) || latest.set(path, body);
        else if (e?.code === 'invalid_argument') useSync.setState({ mode: 'readonly', canWrite: false, error: 'You can view this seating chart but not change it.' });
        else if (e?.code === 'quota_exceeded') useSync.setState({ error: 'The shared store is full. Delete unused guests or tables.' });
        else useSync.setState({ error: `Couldn't save a change (${e?.code ?? 'error'}).` });
      },
    ).finally(() => {
      inflight.delete(path);
      if (!latest.has(path)) pendingPaths.delete(path);
      useSync.setState({ pending: pendingPaths.size });
      if (latest.size) setTimeout(pump, 30);
    });
  }
}

function diffList<T extends { id: string }>(coll: Coll, a: T[], b: T[], body: (x: T) => Record<string, unknown>) {
  if (a === b) return;
  const before = new Map(a.map((x) => [x.id, x]));
  for (const x of b) {
    if (before.get(x.id) !== x) queue(`${coll}/${x.id}`, body(x));
    before.delete(x.id);
  }
  for (const id of before.keys()) queue(`${coll}/${id}`, null);
}

const strip = <T extends { id: string }>(x: T) => {
  const { id: _id, ...rest } = x;
  void _id;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
};

function diffAndQueue(a: Project, b: Project) {
  diffList('guests', a.guests, b.guests, strip);
  diffList('relations', a.relations, b.relations, strip);
  diffList('elements', a.elements, b.elements, strip);
  // a table doc also carries its seats, so seat changes rewrite that table
  if (a.tables !== b.tables || a.seating !== b.seating) {
    const before = new Map(a.tables.map((t) => [t.id, t]));
    for (const t of b.tables) {
      if (before.get(t.id) !== t || a.seating[t.id] !== b.seating[t.id]) queue(`tables/${t.id}`, { ...strip(t), seats: b.seating[t.id] ?? [] });
      before.delete(t.id);
    }
    for (const id of before.keys()) queue(`tables/${id}`, null);
  }
  if (a.name !== b.name || a.settings !== b.settings) queue('meta/project', { name: b.name, settings: b.settings });
}

/** Replace everything (used by "Open backup file" and "Start over"). */
export function replaceAll(p: Project) {
  useStore.setState({ project: migrate(p) });
}

export const freshProject = emptyProject;
