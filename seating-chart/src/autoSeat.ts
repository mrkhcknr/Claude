import type { Guest, Id, Project } from './types';
import { buildAffinity, tableFit } from './scoring';
import { joinedGroups, packSlots, pairCapacity, slotsOf } from './geometry';

export interface AutoSeatOptions {
  /** keep: leave everyone already seated where they are; reseat: move anyone who isn't pinned */
  mode: 'keep' | 'reseat';
  includePending: boolean;
  /** Restrict to these tables (default: all unlocked). */
  tableIds?: Id[];
  effort?: number;
}

export interface AutoSeatResult {
  seating: Project['seating'];
  placed: number;
  unplaced: Guest[];
  warnings: string[];
  before: number;
  after: number;
}

/**
 * Seats guests by treating households and "must sit together" links as atomic units,
 * greedy-placing them, then improving with simulated annealing over moves and swaps.
 */
export function autoSeat(p: Project, opt: AutoSeatOptions): AutoSeatResult {
  const { weight, relation, rules: R } = buildAffinity(p);
  const warnings: string[] = [];
  const guests = p.guests.filter((g) => g.rsvp === 'yes' || (opt.includePending && g.rsvp === 'pending'));
  const gIndex = new Map(guests.map((g, i) => [g.id, i]));
  const N = guests.length;

  const allowed = new Set(opt.tableIds ?? p.tables.map((t) => t.id));
  // tables pushed together end to end are seated as one long table
  const groupsV = joinedGroups(p.tables.filter((t) => allowed.has(t.id) && !t.locked && t.seats > 0));
  const T = groupsV.length;
  const tIndex = new Map(groupsV.flatMap((g, i) => g.map((t) => [t.id, i] as [Id, number])));

  // fixed guests: seated at a locked/excluded table, pinned, or (keep mode) anyone seated
  const fixedAt = new Int32Array(N).fill(-1); // table index for fixed guests on a managed table
  const fixedElsewhere = new Uint8Array(N);
  for (const [tid, arr] of Object.entries(p.seating)) {
    for (const gid of arr) {
      if (!gid || !gIndex.has(gid)) continue;
      const i = gIndex.get(gid)!;
      const ti = tIndex.get(tid);
      if (ti === undefined) fixedElsewhere[i] = 1;
      else if (opt.mode === 'keep' || guests[i].pinned) fixedAt[i] = ti;
    }
  }

  // pairwise weights (dense; fine for a few hundred guests)
  const W = new Float32Array(N * N);
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++) {
      const w = weight(guests[i].id, guests[j].id);
      W[i * N + j] = w;
      W[j * N + i] = w;
    }
  const fit = new Float32Array(N * Math.max(1, T));
  const current = new Map<Id, Id>();
  for (const [tid, arr] of Object.entries(p.seating)) for (const g of arr) if (g) current.set(g, tid);
  for (let i = 0; i < N; i++)
    for (let t = 0; t < T; t++) {
      const g = groupsV[t];
      fit[i * T + t] = g.reduce((s, tb) => s + tableFit(guests[i], tb, p), 0) / g.length;
      if (R.stability && g.some((tb) => current.get(guests[i].id) === tb.id)) fit[i * T + t] += R.stability;
    }

  // ---- units: union-find on strong positive ties among movable guests
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const movable = (i: number) => fixedAt[i] < 0 && !fixedElsewhere[i];
  // households (unless soft) and "next to" pairs move as one unit so they stay side by side
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++) {
      if (!movable(i) || !movable(j)) continue;
      const sameParty = R.household !== 'soft' && guests[i].party && guests[i].party === guests[j].party;
      const beside = R.beside >= 10 && relation(guests[i].id, guests[j].id) === 'beside';
      if (sameParty || beside) parent[find(i)] = find(j);
    }

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

  // ---- state
  const cap = groupSeats;
  const members: number[][] = groupsV.map(() => []);
  for (let i = 0; i < N; i++) if (fixedAt[i] >= 0) members[fixedAt[i]].push(i);
  const fixedCount = members.map((m) => m.length);
  const unitTable = new Int32Array(units.length).fill(-1);

  const totalToSeat = units.reduce((s, u) => s + u.length, 0) + fixedCount.reduce((a, b) => a + b, 0);
  // "spread evenly" compares how full each table is, so long joined rows and small tables are treated fairly
  const fillRatio = totalToSeat / Math.max(1, groupSeats.reduce((a, b) => a + b, 0));

  // how many two-person pairs each table can seat side by side (a 3-chair side holds one pair)
  const pairSlots = groupsV.map((g) => pairCapacity(g));
  const unitOf = new Int32Array(N).fill(-1);
  units.forEach((u, k) => u.forEach((i) => (unitOf[i] = k)));
  const tied = new Uint8Array(64);
  function tableScore(t: number, mem: number[]) {
    let s = 0;
    const n = mem.length;
    if (R.loner && n > 1) tied.fill(0, 0, n);
    for (let a = 0; a < n; a++) {
      s += fit[mem[a] * T + t];
      for (let b = a + 1; b < n; b++) {
        const w = W[mem[a] * N + mem[b]];
        s += w;
        if (w >= 1 && n <= 64) tied[a] = tied[b] = 1;
      }
    }
    if (R.loner && n > 1 && n <= 64) for (let a = 0; a < n; a++) if (!tied[a]) s -= R.loner;
    if (R.couplesSideBySide) {
      // count pairs needed by linked units at this table; penalise more than the table can seat side by side
      const seen = new Set<number>();
      let pairs = 0;
      for (const i of mem) {
        const u = unitOf[i];
        if (u < 0 || seen.has(u)) continue;
        seen.add(u);
        pairs += Math.floor(units[u].length / 2);
      }
      if (pairs > pairSlots[t]) s -= 150 * (pairs - pairSlots[t]);
    }
    if (R.balance === 'even') {
      const dev = n - fillRatio * cap[t];
      s -= R.balanceStrength * dev * dev;
    }
    else if (n > 0) s -= R.balanceStrength * (12 + 0.8 * (cap[t] - n));
    return s;
  }

  const score = groupsV.map((_, t) => tableScore(t, members[t]));
  const total = () => score.reduce((a, b) => a + b, 0);

  // ---- greedy: biggest / most-connected units first
  const deg = new Float32Array(N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) deg[i] += Math.max(0, W[i * N + j]);
  const unitDegree = units.map((u) => u.reduce((s, i) => s + deg[i], 0));
  const order = units.map((_, k) => k).sort((a, b) => units[b].length - units[a].length || unitDegree[b] - unitDegree[a]);
  for (const k of order) {
    const u = units[k];
    let best = -1,
      bestGain = -Infinity;
    for (let t = 0; t < T; t++) {
      if (members[t].length + u.length > cap[t]) continue;
      const after = tableScore(t, [...members[t], ...u]);
      const gain = after - score[t];
      if (gain > bestGain) {
        bestGain = gain;
        best = t;
      }
    }
    if (best >= 0) {
      members[best].push(...u);
      score[best] = tableScore(best, members[best]);
      unitTable[k] = best;
    }
  }
  const before = total();

  // ---- simulated annealing
  const placedUnits = units.map((_, k) => k).filter((k) => unitTable[k] >= 0);
  const iters = Math.min(120000, Math.max(8000, placedUnits.length * 600)) * (opt.effort ?? 1);
  let temp = 6;
  const cool = Math.pow(0.02 / temp, 1 / iters);
  const without = (arr: number[], rm: number[]) => arr.filter((x) => !rm.includes(x));
  for (let it = 0; it < iters && T > 1 && placedUnits.length; it++, temp *= cool) {
    const k = placedUnits[(Math.random() * placedUnits.length) | 0];
    const from = unitTable[k];
    const to = (Math.random() * T) | 0;
    if (to === from) continue;
    const u = units[k];
    if (members[to].length + u.length <= cap[to] && Math.random() < 0.5) {
      // move
      const mf = without(members[from], u),
        mt = [...members[to], ...u];
      const sf = tableScore(from, mf),
        st = tableScore(to, mt);
      const d = sf + st - score[from] - score[to];
      if (d >= 0 || Math.random() < Math.exp(d / temp)) {
        members[from] = mf;
        members[to] = mt;
        score[from] = sf;
        score[to] = st;
        unitTable[k] = to;
      }
    } else {
      // swap with one or more units at `to` (e.g. a couple for two singles) so table sizes still fit
      const cands = placedUnits.filter((q) => unitTable[q] === to);
      if (!cands.length) continue;
      const pick: number[] = [];
      let size = 0;
      for (let tries = 0; tries < 6 && size < u.length; tries++) {
        const q = cands[(Math.random() * cands.length) | 0];
        if (pick.includes(q) || size + units[q].length > Math.max(u.length, units[q].length)) continue;
        pick.push(q);
        size += units[q].length;
      }
      if (!pick.length) continue;
      const v = pick.flatMap((q) => units[q]);
      if (members[from].length - u.length + v.length > cap[from] || members[to].length - v.length + u.length > cap[to]) continue;
      const mf = [...without(members[from], u), ...v],
        mt = [...without(members[to], v), ...u];
      const sf = tableScore(from, mf),
        st = tableScore(to, mt);
      const d = sf + st - score[from] - score[to];
      if (d >= 0 || Math.random() < Math.exp(d / temp)) {
        members[from] = mf;
        members[to] = mt;
        score[from] = sf;
        score[to] = st;
        unitTable[k] = to;
        for (const q of pick) unitTable[q] = from;
      }
    }
  }

  // ---- seat order within each table
  const seating: Project['seating'] = structuredClone(p.seating);
  for (const t of p.tables) if (!seating[t.id]) seating[t.id] = Array(t.seats).fill(null);
  // clear non-fixed guests from managed tables
  for (let t = 0; t < T; t++)
    for (const tb of groupsV[t]) seating[tb.id] = seating[tb.id].map((g) => (g && gIndex.has(g) && fixedAt[gIndex.get(g)!] === t ? g : null));
  // remove moved guests from wherever they were (e.g. declined guests stay out)
  const placedSet = new Set<Id>();
  for (let t = 0; t < T; t++) {
    const slots = slotsOf(groupsV[t]);
    const arr = slots.map((sl) => seating[sl.t][sl.s]);
    const newcomers = units
      .map((u, k) => ({ u, k }))
      .filter(({ k }) => unitTable[k] === t)
      .map(({ u }) => u);
    const ordered = R.neighbours ? orderUnits(newcomers.map((u) => orderWithin(u, W, N)), arr, W, N, gIndex) : newcomers;
    // couples and other linked units go in first so each lands in one side-by-side stretch; singles fill around them
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
  // guests not eligible (declined) on managed tables were already cleared above

  const unplaced = units.filter((_, k) => unitTable[k] < 0).flat().map((i) => guests[i]);
  if (unplaced.length) warnings.push(`${unplaced.length} guest(s) didn't fit — add tables or seats.`);

  return { seating, placed: placedSet.size, unplaced, warnings, before, after: total() };
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
