import type { Guest, Id, Project } from './types';
import { groupTags, inGroup } from './scoring';
import { joinedGroups, packSlots, pairCapacity, slotsOf } from './geometry';
import { effectiveSeat } from './relations';
import { rulesOf } from './rules';
import { tableTags } from './util';
import { happinessContext, happinessOf } from './happiness';
import { improveSeating } from './optimize';

export interface AutoSeatOptions {
  /**
   * keep: leave everyone already seated where they are, seat the rest;
   * improve: seat the rest, then fine-tune everyone's seats by swapping (starting from the current seating);
   * reseat: start over for anyone who isn't pinned
   */
  mode: 'keep' | 'improve' | 'reseat';
  includePending: boolean;
  /** Restrict to these tables (default: all unlocked). */
  tableIds?: Id[];
  /** Then swap guests around to maximise happiness points (default on) */
  optimize?: boolean;
  effort?: number;
}

export interface AutoSeatResult {
  seating: Project['seating'];
  placed: number;
  unplaced: Guest[];
  warnings: string[];
  /** Guests seated at a table tagged for them / guests who have a tagged table */
  tagMatched: number;
  tagWanted: number;
  /** Total happiness points before (the current seating in "improve" mode) and after */
  before: number;
  after: number;
  /** Guests whose seat changed: from/to table ids (from is empty for newly seated guests) */
  moves: { guestId: Id; from?: Id; to: Id; sameTable: boolean }[];
}

/**
 * Two plain steps, in order:
 *   1. Table tags: everyone whose tags match a table's tags starts there (households stay together).
 *      This only orients the layout; step 3 may move them if that makes guests happier.
 *      Scarce tags go first; if a tag has more guests than seats, the rest fall through to step 2.
 *   2. Connections: everyone else goes, household by household, to the table where they have the
 *      most relationships or household members; failing that, next to people who share a tag;
 *      failing that, any free seat.
 * Hard rules throughout: "never same table", pinned guests and locked tables stay put, and
 * households / "next to" pairs / couples get side-by-side chairs.
 */
export function autoSeat(p: Project, opt: AutoSeatOptions): AutoSeatResult {
  const R = rulesOf(p.settings);
  const warnings: string[] = [];
  const guests = p.guests.filter((g) => g.rsvp === 'yes' || (opt.includePending && g.rsvp === 'pending'));
  const gIndex = new Map(guests.map((g, i) => [g.id, i]));
  const N = guests.length;

  const allowed = new Set(opt.tableIds ?? p.tables.map((t) => t.id));
  // tables pushed together end to end are one long table, unless they're tagged for different groups
  const groupsV = joinedGroups(p.tables.filter((t) => allowed.has(t.id) && !t.locked && t.seats > 0), { splitByTags: true });
  const T = groupsV.length;
  const tIndex = new Map(groupsV.flatMap((g, i) => g.map((t) => [t.id, i] as [Id, number])));

  // fixed guests: seated at a locked/excluded table, pinned, or (keep mode) anyone seated
  const fixedAt = new Int32Array(N).fill(-1);
  // pinning anyone keeps their whole household in place, so a pinned partner never ends up apart from theirs
  const pinnedParty = new Set(guests.filter((g) => g.pinned && g.party).map((g) => g.party));
  const isPinned = (g: (typeof guests)[number]) => g.pinned || (!!g.party && pinnedParty.has(g.party));
  const fixedElsewhere = new Uint8Array(N);
  for (const [tid, arr] of Object.entries(p.seating)) {
    for (const gid of arr) {
      if (!gid || !gIndex.has(gid)) continue;
      const i = gIndex.get(gid)!;
      const ti = tIndex.get(tid);
      if (ti === undefined) fixedElsewhere[i] = 1;
      else if (opt.mode !== 'reseat' || isPinned(guests[i])) fixedAt[i] = ti;
    }
  }
  const movable = (i: number) => fixedAt[i] < 0 && !fixedElsewhere[i];

  // ---- connections: households and drawn relationships (W is only used for counting and chair order)
  const W = new Float32Array(N * N);
  const apart = new Set<string>();
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const link = (a: number, b: number) => movable(a) && movable(b) && (parent[find(a)] = find(b));
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      if (guests[i].party && guests[i].party === guests[j].party) {
        W[i * N + j] = W[j * N + i] = 3;
        link(i, j);
      }
  for (const r of p.relations) {
    const a = gIndex.get(r.a),
      b = gIndex.get(r.b);
    if (a === undefined || b === undefined) continue;
    const seat = effectiveSeat(r);
    if (seat === 'apart' && R.apartHard) {
      apart.add(String(key(a, b)));
      continue;
    }
    const w = r.kind === 'tension' ? -2 : seat === 'beside' ? 4 : seat === 'together' ? 3 : r.kind === 'introduce' ? 2 : 2;
    W[a * N + b] = W[b * N + a] = Math.max(W[a * N + b], w);
    if (seat === 'beside') link(a, b);
  }

  // ---- tags: what each table is for, and each guest's tags
  const tagsOfTable = groupsV.map((g) => {
    const s = new Set<string>();
    for (const t of g) for (const x of tableTags(t)) s.add(x.toLowerCase());
    return s;
  });
  const matchesTable = (i: number, t: number) => {
    const g = guests[i];
    for (const x of tagsOfTable[t]) if (inGroup(g, x) || (x === 'kids' && g.child) || g.side === x) return true;
    return false;
  };

  const groupSeats = groupsV.map((g) => g.reduce((s, t) => s + t.seats, 0));
  const maxCap = Math.max(0, ...groupSeats);
  const unitMap = new Map<number, number[]>();
  for (let i = 0; i < N; i++) if (movable(i)) unitMap.set(find(i), [...(unitMap.get(find(i)) ?? []), i]);
  const units: number[][] = [];
  for (const u of unitMap.values()) {
    if (u.length > maxCap) {
      warnings.push(`A linked group of ${u.length} (${u.slice(0, 3).map((i) => guests[i].name).join(', ')}…) is bigger than the largest table, so it was split.`);
      for (let k = 0; k < u.length; k += maxCap || 1) units.push(u.slice(k, k + (maxCap || 1)));
    } else units.push(u);
  }

  const members: number[][] = groupsV.map(() => []);
  for (let i = 0; i < N; i++) if (fixedAt[i] >= 0) members[fixedAt[i]].push(i);
  const unitTable = new Int32Array(units.length).fill(-1);
  const free = (t: number) => groupSeats[t] - members[t].length;
  // side-by-side chairs: a 3-chair side holds one couple, so don't send more couples than a table can seat together
  const pairSlots = groupsV.map((g) => pairCapacity(g));
  const pairsAt = groupsV.map(() => 0);
  // a household of 3 fills one 3-chair side, the same space one couple takes
  const pairsOf = (u: number[]) => (u.length < 2 ? 0 : u.length === 3 ? 1 : Math.ceil(u.length / 2));
  // couples and households already sitting at a table use its side-by-side spots too
  for (let t = 0; t < T; t++) {
    const parties = new Map<string, number>();
    for (const i of members[t]) if (guests[i].party) parties.set(guests[i].party, (parties.get(guests[i].party) ?? 0) + 1);
    for (const [k, n] of parties) {
      void k;
      pairsAt[t] += n < 2 ? 0 : n === 3 ? 1 : Math.ceil(n / 2);
    }
  }
  const allowedAt = (u: number[], t: number) =>
    free(t) >= u.length && (!R.couplesSideBySide || pairsAt[t] + pairsOf(u) <= pairSlots[t]) && !u.some((i) => members[t].some((j) => apart.has(String(key(i, j)))));
  const ties = (u: number[], t: number) => u.reduce((s, i) => s + members[t].reduce((q, j) => q + W[i * N + j], 0), 0);
  const sharedTag = (u: number[], t: number) => {
    const mine = new Set(u.flatMap((i) => groupTags(guests[i])));
    return members[t].filter((j) => groupTags(guests[j]).some((x) => mine.has(x))).length;
  };
  const place = (k: number, t: number) => {
    members[t].push(...units[k]);
    pairsAt[t] += pairsOf(units[k]);
    unitTable[k] = t;
  };
  /** Tables a unit can go to. Couples always sit together, so a table without a free side-by-side spot never qualifies. */
  const candidates = (u: number[], tables: number[]) => tables.filter((t) => allowedAt(u, t));

  // ---- step 1: table tags (scarcest first, so e.g. a 12-seat groomsmen table fills before a big catch-all tag)
  const homes = units.map((u) => groupsV.map((_, t) => t).filter((t) => u.some((i) => matchesTable(i, t))));
  // most specific first: a tag only 2 people have (Groom) is seated before one 7 people have (groomsmen)
  const tagCount = new Map<string, number>();
  for (const g of guests) for (const x of groupTags(g)) tagCount.set(x, (tagCount.get(x) ?? 0) + 1);
  const specificity = units.map((u, k) => {
    let best = Infinity;
    for (const t of homes[k]) for (const x of tagsOfTable[t]) if (u.some((i) => groupTags(guests[i]).includes(x))) best = Math.min(best, tagCount.get(x) ?? Infinity);
    return best;
  });
  const step1 = units
    .map((_, k) => k)
    .filter((k) => homes[k].length)
    .sort((a, b) => specificity[a] - specificity[b] || units[b].length - units[a].length);
  for (const k of step1) {
    const u = units[k];
    const ok = candidates(u, homes[k]);
    if (!ok.length) continue;
    // among matching tables: join people they're connected to, then people who share a tag, then the emptiest
    ok.sort((a, b) => ties(u, b) - ties(u, a) || sharedTag(u, b) - sharedTag(u, a) || free(b) - free(a));
    place(k, ok[0]);
  }
  const tagWanted = step1.reduce((s, k) => s + units[k].length, 0);
  const tagMatched = step1.filter((k) => unitTable[k] >= 0).reduce((s, k) => s + units[k].length, 0);
  if (tagMatched < tagWanted) warnings.push(`${tagWanted - tagMatched} guest(s) didn't fit at a table tagged for them (not enough seats, or no side-by-side chairs left for a couple), so they were seated by their connections.`);

  // ---- step 2: everyone else, by connections (most connected first)
  const conn = units.map((u) => u.reduce((s, i) => s + W.subarray(i * N, i * N + N).reduce((a, b) => a + Math.max(0, b), 0), 0));
  const step2 = units
    .map((_, k) => k)
    .filter((k) => unitTable[k] < 0)
    .sort((a, b) => conn[b] - conn[a] || units[b].length - units[a].length);
  for (const k of step2) {
    const u = units[k];
    const ok = candidates(u, groupsV.map((_, t) => t));
    if (!ok.length) continue;
    // prefer: relationships at the table > people sharing a tag > tables not tagged for someone else > most free seats
    const untagged = (t: number) => (tagsOfTable[t].size ? 0 : 1);
    ok.sort((a, b) => ties(u, b) - ties(u, a) || sharedTag(u, b) - sharedTag(u, a) || untagged(b) - untagged(a) || free(b) - free(a));
    place(k, ok[0]);
  }

  // ---- seat order within each table
  const seating: Project['seating'] = structuredClone(p.seating);
  for (const t of p.tables) if (!seating[t.id]) seating[t.id] = Array(t.seats).fill(null);
  for (let t = 0; t < T; t++)
    for (const tb of groupsV[t]) seating[tb.id] = seating[tb.id].map((g) => (g && gIndex.has(g) && fixedAt[gIndex.get(g)!] === t ? g : null));
  const placedSet = new Set<Id>();
  for (let t = 0; t < T; t++) {
    const slots = slotsOf(groupsV[t]);
    const arr = slots.map((sl) => seating[sl.t][sl.s]);
    const newcomers = units.filter((_, k) => unitTable[k] === t);
    const ordered = orderUnits(newcomers.map((u) => orderWithin(u, W, N)), arr, W, N, gIndex);
    // households and "next to" pairs go in first so each lands in one side-by-side stretch
    const groups = R.couplesSideBySide ? [...ordered.filter((u) => u.length > 1), ...ordered.filter((u) => u.length === 1)] : ordered.flat().map((g) => [g]);
    const seatsFor = packSlots(slots, arr.map(Boolean), groups.map((u) => u.length));
    groups.forEach((u, k) =>
      u.forEach((gi, j) => {
        const s = seatsFor[k][j];
        if (s === undefined) return;
        seating[slots[s].t][slots[s].s] = guests[gi].id;
        placedSet.add(guests[gi].id);
      }),
    );
  }

  const crowded = groupsV.map((g, t) => (pairsAt[t] > pairSlots[t] ? g.map((x) => x.label).join(' + ') : '')).filter(Boolean);
  if (crowded.length && R.couplesSideBySide)
    warnings.push(`Not every couple could sit side by side at ${crowded.join(', ')}: those tables have more couples than side-by-side chairs (a 3-chair side fits one couple). Add seats, change a table's tags, or move a couple by hand.`);
  const unplaced = units.filter((_, k) => unitTable[k] < 0).flat().map((i) => guests[i]);
  if (unplaced.length) warnings.push(`${unplaced.length} guest(s) didn't fit — add tables or seats.`);

  // ---- step 3: swap guests between chairs to raise total happiness, within the same hard rules.
  // Table tags are only a nudge here (a few points for sitting at a matching table), never a requirement.
  let finalSeating = seating;
  const before = happinessOf(p, seating).total;
  let after = before;
  if (opt.optimize !== false) {
    const managed = groupsV.flat();
    // in "improve" mode everyone already seated may move too (except pinned guests and locked tables)
    const fixed = new Set<Id>();
    for (let i = 0; i < N; i++) if (opt.mode === 'improve' ? isPinned(guests[i]) || fixedElsewhere[i] : !movable(i)) fixed.add(guests[i].id);
    const apartIds = new Set<string>();
    for (let a = 0; a < N; a++)
      for (let b = a + 1; b < N; b++)
        if (apart.has(String(key(a, b)))) {
          const x = guests[a].id,
            y = guests[b].id;
          apartIds.add(x < y ? x + '|' + y : y + '|' + x);
        }
    const ctx = happinessContext(p, managed, guests);
    finalSeating = improveSeating(p, seating, ctx, { tables: managed, fixed, apart: apartIds, ...(opt.mode === 'improve' ? { moveCost: { table: 2, seat: 0.5 } } : {}) }).seating;
    after = happinessOf(p, finalSeating).total;
  }
  // who moved, compared with the seating before this run
  const where = (seat: Project['seating']) => {
    const m = new Map<Id, { t: Id; s: number }>();
    for (const [t, arr] of Object.entries(seat)) arr.forEach((g, s) => g && m.set(g, { t, s }));
    return m;
  };
  const was = where(p.seating),
    now = where(finalSeating);
  const moves: AutoSeatResult['moves'] = [];
  for (const [g, to] of now) {
    const from = was.get(g);
    if (!from || from.t !== to.t || from.s !== to.s) moves.push({ guestId: g, from: from?.t, to: to.t, sameTable: from?.t === to.t });
  }
  // table-tag coverage over the whole result: of guests who have a table tagged for them, how many sit at one
  let tagWantedAll = 0,
    tagMatchedAll = 0;
  {
    const tIdx = new Map<Id, number>();
    groupsV.forEach((g, t) => g.forEach((x) => tIdx.set(x.id, t)));
    for (let i = 0; i < N; i++) {
      if (!groupsV.some((_, t) => tagsOfTable[t].size && matchesTable(i, t))) continue;
      tagWantedAll++;
      const at = now.get(guests[i].id);
      const t = at ? tIdx.get(at.t) : undefined;
      if (t !== undefined && tagsOfTable[t].size && matchesTable(i, t)) tagMatchedAll++;
    }
  }
  // everyone counted as placed is seated in the final result
  const placed = guests.filter((g) => now.has(g.id)).length;
  void tagMatched;
  void tagWanted;
  return { seating: finalSeating, placed, unplaced, warnings, tagMatched: tagMatchedAll, tagWanted: tagWantedAll, before: Math.round(opt.mode === 'improve' ? happinessOf(p).total : before), after: Math.round(after), moves };
}

/** Order a unit's members so the strongest pairs (e.g. "next to") are adjacent. */
function orderWithin(u: number[], W: Float32Array, N: number) {
  if (u.length < 3) return u;
  const left = [...u];
  // start from the member with the weakest ties so the chain ends are natural
  left.sort((a, b) => left.reduce((s, x) => s + W[a * N + x], 0) - left.reduce((s, x) => s + W[b * N + x], 0));
  const seq = [left.shift()!];
  while (left.length) {
    const last = seq[seq.length - 1];
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (W[last * N + left[i]] > W[last * N + left[bi]]) bi = i;
    seq.push(left.splice(bi, 1)[0]);
  }
  return seq;
}

/** Chain units so strongly connected units sit next to each other. */
function orderUnits(units: number[][], arr: (Id | null)[], W: Float32Array, N: number, gIndex: Map<Id, number>) {
  if (!units.length) return [];
  const anchor = arr.filter(Boolean).map((g) => gIndex.get(g!)).filter((x): x is number => x !== undefined);
  const aff = (a: number[], b: number[]) => a.reduce((s, i) => s + b.reduce((q, j) => q + W[i * N + j], 0), 0);
  // neighbours touch at the chain ends, so weigh the last member of one unit against the first of the next
  const join = (a: number[], b: number[]) => W[a[a.length - 1] * N + b[0]] * 2 + aff(a, b) * 0.25;
  const left = [...units];
  const seq: number[][] = [];
  // start with the unit most tied to existing occupants, else the biggest
  left.sort((a, b) => aff(b, anchor) - aff(a, anchor) || b.length - a.length);
  let cur = left.shift()!;
  seq.push(cur);
  while (left.length) {
    let bi = 0,
      bs = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = join(cur, left[i]);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    cur = left.splice(bi, 1)[0];
    seq.push(cur);
  }
  return seq;
}
