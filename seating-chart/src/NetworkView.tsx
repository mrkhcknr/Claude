import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Bond, Guest, Id, SeatRule } from './types';
import { makeParty, relateAll, seatAtTable, setRelation, setSelection, tableName, toast, update, updateGuests, useStore } from './store';
import { activeCount, allTags, clearFilters, guestMatcher, setFilters, useFilters } from './filters';
import { groupTags, type Analysis } from './scoring';
import { BONDS, BOND_HELP, BOND_LABEL, SEAT_LABEL, SEAT_RULES, describeTie, effectiveSeat, isPositive } from './relations';
import { clamp, firstName, hueColor } from './util';
import { suggestIntroductions } from './introductions';
import { Icon } from './ui';
import { tagColor as tagColorFor } from './tags';
import { SearchBox, FilterSheet } from './GuestPanel';

type Brush = 'move' | Bond | 'erase' | 'lasso';
type EdgeColor = 'relationship' | 'context';
type ColorBy = 'group' | 'table' | 'side';

interface N extends SimulationNodeDatum {
  id: string;
  hub?: string; // tag key for invisible hub nodes
  guest?: Guest;
}
interface L extends SimulationLinkDatum<N> {
  kind: Bond | 'party' | 'hub' | 'hub2';
  seat?: SeatRule;
  rid?: string;
}

const LINK_DIST: Record<L['kind'], number> = { hub2: 140, hub: 46, party: 22, partner: 20, family: 30, friend: 36, introduce: 60, tension: 200 };
const LINK_STR: Record<L['kind'], number> = { hub2: 0.02, hub: 0.25, party: 1, partner: 1, family: 0.9, friend: 0.8, introduce: 0.4, tension: 0.12 };

/**
 * Each guest's home group, so bubbles never overlap: the most specific (smallest) tag they have,
 * skipping catch-alls like "Friends" unless that's their only tag. Tags with exactly the same
 * members share one bubble ("NYC Friends · NYC Gays").
 */
export function homeGroups(guests: Guest[], labels: Map<string, string>) {
  const members = new Map<string, Id[]>();
  for (const g of guests) for (const t of groupTags(g)) members.set(t, [...(members.get(t) ?? []), g.id]);
  // merge tags with identical members
  const bySig = new Map<string, string[]>();
  for (const [t, m] of members) {
    const sig = [...m].sort().join();
    bySig.set(sig, [...(bySig.get(sig) ?? []), t]);
  }
  const keyOf = new Map<string, string>();
  const clusters = new Map<string, { label: string; tags: string[]; members: Id[] }>();
  for (const tags of bySig.values()) {
    tags.sort();
    const key = tags[0];
    for (const t of tags) keyOf.set(t, key);
    clusters.set(key, { label: tags.map((t) => labels.get(t) ?? t).join(' · '), tags, members: members.get(key)! });
  }
  const big = Math.max(40, guests.length * 0.4);
  // a one-word tag that shows up inside other tags' names ("family" in "Hickner Family") is a catch-all
  const all = [...members.keys()];
  const generic = (k: string) => clusters.get(k)!.tags.every((t) => !t.includes(' ') && all.some((o) => o !== t && new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(o)));
  const home = new Map<Id, string>();
  for (const g of guests) {
    const cs = [...new Set(groupTags(g).map((t) => keyOf.get(t)!))].map((k) => ({ k, n: clusters.get(k)!.members.length }));
    if (!cs.length) continue;
    const specific = cs.filter((c) => c.n <= big && !generic(c.k));
    const pick = (specific.length ? specific : cs).sort((a, b) => a.n - b.n || a.k.localeCompare(b.k))[0];
    home.set(g.id, pick.k);
  }
  // a household lives in one bubble (the most specific one among its members), so couples aren't stretched across two
  const byParty = new Map<string, Guest[]>();
  for (const g of guests) if (g.party) byParty.set(g.party, [...(byParty.get(g.party) ?? []), g]);
  for (const m of byParty.values()) {
    if (m.length < 2) continue;
    const ks = m.map((g) => home.get(g.id)).filter((k): k is string => !!k);
    if (!ks.length) continue;
    const best = ks.sort((a, b) => clusters.get(a)!.members.length - clusters.get(b)!.members.length)[0];
    for (const g of m) {
      home.set(g.id, best);
      const c = clusters.get(best)!;
      if (!c.members.includes(g.id)) c.members = [...c.members, g.id];
    }
  }
  // drop bubbles nobody calls home (they still pull weakly through their members)
  for (const k of [...clusters.keys()]) if (![...home.values()].includes(k) && clusters.get(k)!.members.length > big) clusters.delete(k);
  return { home, clusters };
}

/**
 * Keep home-group bubbles apart: guests are pushed out of other groups' bubbles and whole groups push
 * each other away. Groups are disjoint, and each nudge is capped, so the layout can't run away.
 */
function forceGroups(nodes: Map<string, N>, home: Map<Id, string>) {
  const PAD = 46,
    CAP = 4;
  const byGroup = new Map<string, N[]>();
  const guestNodes: N[] = [];
  for (const n of nodes.values()) {
    if (!n.guest) continue;
    guestNodes.push(n);
    const h = home.get(n.id);
    if (h) byGroup.set(h, [...(byGroup.get(h) ?? []), n]);
  }
  const push = (n: N, dx: number, dy: number) => {
    const m = Math.hypot(dx, dy);
    const s = m > CAP ? CAP / m : 1;
    n.vx! += dx * s;
    n.vy! += dy * s;
  };
  return Object.assign(
    (alpha: number) => {
      const circles = [...byGroup.entries()]
        .filter(([, m]) => m.length > 1)
        .map(([t, m]) => {
          let x = 0,
            y = 0;
          for (const n of m) (x += n.x!), (y += n.y!);
          x /= m.length;
          y /= m.length;
          // radius from the typical spread, so one stray member doesn't inflate the bubble
          const ds = m.map((n) => Math.hypot(n.x! - x, n.y! - y)).sort((a, b) => a - b);
          // full extent of the group, so long thin bubbles don't poke into their neighbours
          return { t, m, x, y, r: ds[ds.length - 1] + PAD };
        });
      const k = 0.4 * alpha;
      for (const c of circles)
        for (const n of guestNodes) {
          if (home.get(n.id) === c.t) continue;
          const dx = n.x! - c.x,
            dy = n.y! - c.y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < c.r + 8) push(n, (dx / d) * (c.r + 8 - d) * k, (dy / d) * (c.r + 8 - d) * k);
        }
      for (let i = 0; i < circles.length; i++)
        for (let j = i + 1; j < circles.length; j++) {
          const a = circles[i],
            b = circles[j];
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const over = a.r + b.r - d;
          if (over <= 0) continue;
          const f = over * k * 0.15;
          for (const n of a.m) push(n, (-dx / d) * f, (-dy / d) * f);
          for (const n of b.m) push(n, (dx / d) * f, (dy / d) * f);
        }
    },
    { initialize: () => {} },
  );
}

/** Put each group label just above (or else just below) its bubble, avoiding other labels and guests. */
function placeLabels(items: { tag: string; x: number; top: number; bottom: number; w: number; h: number }[], obstacles: { x: number; y: number }[]) {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const out = new Map<string, number>();
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < (p.h + h) / 2 + 2) &&
    !obstacles.some((o) => Math.abs(o.x - x) < w / 2 + 8 && o.y > y - h - 8 && o.y < y + 22);
  for (const it of [...items].sort((a, b) => a.top - b.top)) {
    const cands = [it.top, it.bottom, it.top - it.h, it.bottom + it.h, it.top - 2 * it.h, it.bottom + 2 * it.h];
    const y = cands.find((c) => free(it.x, c, it.w, it.h)) ?? it.top;
    placed.push({ x: it.x, y, w: it.w, h: it.h });
    out.set(it.tag, y);
  }
  return out;
}

/** Room a guest needs: their dot plus the first name written under it (about 6.5px per letter). */
const labelRadius = (d: N) => Math.max(18, (firstName(d.guest?.name ?? '').length * 6.5) / 2 + 8);

// positions survive view switches
const memo = new Map<string, { x: number; y: number }>();

export function NetworkView({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const filters = useFilters();
  const [brush, setBrush] = useState<Brush>('friend');
  const [brushSeat, setBrushSeat] = useState<SeatRule | ''>('');
  const [brushCtx, setBrushCtx] = useState('');
  const [edgeColor, setEdgeColor] = useState<EdgeColor>('relationship');
  const [colorBy, setColorBy] = useState<ColorBy>('group');
  const [includeDeclined, setIncludeDeclined] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // phones/tablets: the groups & filters panel opens as a sheet
  const [sideOpen, setSideOpen] = useState(false);
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  /** Once the person pans or zooms, stop re-fitting the view for them. */
  const userMoved = useRef(false);
  const [, setTick] = useState(0);
  const [rubber, setRubber] = useState<{ from: N; to: { x: number; y: number }; over?: string } | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ guestId: Id; tag: string; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const sim = useRef<Simulation<N, L> | null>(null);
  const nodesRef = useRef<Map<string, N>>(new Map());
  const size = useRef({ w: 800, h: 600 });
  const selected = new Set(selection?.type === 'guest' ? selection.ids : []);
  const shownLabels = new Map<string, { text: string; fs: number }>();

  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf, analysis.discByGuest), [project, filters, analysis.tableOf]);
  const guests = useMemo(() => project.guests.filter((g) => (includeDeclined || g.rsvp !== 'no') && (!filters.hide || !matcher || matcher(g))), [project.guests, includeDeclined, filters.hide, matcher]);
  const tagList = useMemo(() => allTags(project), [project]);
  const tagColor = useMemo(() => new Map(tagList.map((t, i) => [t.label.toLowerCase(), tagColorFor(project, t.label, i)])), [tagList, project]);
  const homes = useMemo(() => homeGroups(guests, new Map(tagList.map((t) => [t.label.toLowerCase(), t.label]))), [guests, tagList]);
  const tableIndex = useMemo(() => new Map(project.tables.map((t, i) => [t.id, i])), [project.tables]);

  // degree for "no ties" highlighting
  const tied = useMemo(() => {
    const s = new Set<Id>();
    for (const r of project.relations) if (isPositive(r)) (s.add(r.a), s.add(r.b));
    const pc = new Map<string, number>();
    for (const g of project.guests) if (g.party) pc.set(g.party, (pc.get(g.party) ?? 0) + 1);
    for (const g of project.guests) if (g.party && pc.get(g.party)! > 1) s.add(g.id);
    return s;
  }, [project.relations, project.guests]);

  // ---------- simulation ----------
  const graphKey = useMemo(() => guests.map((g) => g.id + g.group + g.party).join() + '|' + project.relations.map((r) => r.id + r.kind + (effectiveSeat(r) ?? '')).join(), [guests, project.relations]);
  useEffect(() => {
    const ids = new Set(guests.map((g) => g.id));
    const old = nodesRef.current;
    const nodes = new Map<string, N>();
    const W = size.current.w,
      H = size.current.h;
    guests.forEach((g, i) => {
      const prev = old.get(g.id) ?? memo.get(g.id);
      const a = i * 2.39996,
        r = 12 * Math.sqrt(i + 1);
      const x = prev?.x ?? W / 2 + r * Math.cos(a),
        y = prev?.y ?? H / 2 + r * Math.sin(a);
      // guests in a group the user moved stay where they were put
      const keep = pinned.current.has(g.id);
      nodes.set(g.id, { id: g.id, guest: g, x, y, vx: 0, vy: 0, fx: keep ? x : undefined, fy: keep ? y : undefined });
    });
    const links: L[] = [];
    // one hub per home group pulls its members together; other (specific) tags pull weakly, so related bubbles sit near each other
    for (const [key, c] of homes.clusters) {
      const hid = 'hub:' + key;
      const prev = old.get(hid);
      nodes.set(hid, { id: hid, hub: key, x: prev?.x ?? W / 2 + (Math.random() - 0.5) * 300, y: prev?.y ?? H / 2 + (Math.random() - 0.5) * 300 });
      for (const m of c.members) if (ids.has(m)) links.push({ source: m, target: hid, kind: homes.home.get(m) === key ? 'hub' : 'hub2' });
    }
    const parties = new Map<string, string[]>();
    for (const g of guests) if (g.party) parties.set(g.party, [...(parties.get(g.party) ?? []), g.id]);
    for (const mem of parties.values()) for (let i = 1; i < mem.length; i++) links.push({ source: mem[0], target: mem[i], kind: 'party' });
    for (const r of project.relations) if (ids.has(r.a) && ids.has(r.b)) links.push({ source: r.a, target: r.b, kind: r.kind, seat: effectiveSeat(r), rid: r.id });
    nodesRef.current = nodes;

    // a group's members sit further from its centre the bigger it is, so large groups aren't squeezed
    const hubDist = new Map<string, number>();
    for (const [key, c] of homes.clusters) hubDist.set('hub:' + key, 24 + 11 * Math.sqrt(c.members.filter((m) => homes.home.get(m) === key).length));
    const linkForce = forceLink<N, L>(links)
      .id((d) => d.id)
      .distance((l) => (l.kind === 'hub' ? hubDist.get((l.target as N).id ?? String(l.target)) ?? 46 : l.seat === 'apart' ? 260 : l.seat === 'beside' ? 20 : LINK_DIST[l.kind]))
      .strength((l) => (l.seat === 'apart' ? 0.25 : l.seat === 'beside' ? 1 : LINK_STR[l.kind]));
    sim.current?.stop();
    const s = forceSimulation<N, L>([...nodes.values()])
      .force('link', linkForce)
      .force('charge', forceManyBody<N>().strength((d) => (d.hub ? -10 : -110)).distanceMax(480))
      // each guest keeps room for their dot and the first name under it
      .force('collide', forceCollide<N>((d) => (d.hub ? 0 : labelRadius(d))).strength(0.9).iterations(2))
      .force('groups', forceGroups(nodes, homes.home))
      .force('center', forceCenter(W / 2, H / 2).strength(0.04))
      .force('x', forceX<N>(W / 2).strength(0.025))
      .force('y', forceY<N>(H / 2).strength(0.025))
      .alpha(old.size ? 0.5 : 1)
      .alphaDecay(0.03);
    let raf = 0;
    s.on('tick', () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setTick((t) => t + 1);
        });
    });
    s.on('end', () => {
      for (const n of nodes.values()) if (!n.hub) memo.set(n.id, { x: n.x!, y: n.y! });
      if (!userMoved.current) fitView();
    });
    sim.current = s;
    return () => {
      s.stop();
      cancelAnimationFrame(raf);
      for (const n of nodes.values()) if (!n.hub) memo.set(n.id, { x: n.x!, y: n.y! });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => (size.current = { w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Fit every guest into the part of the canvas not covered by the toolbars and side panel. */
  function fitView() {
    const pts = [...nodesRef.current.values()].filter((n) => n.guest);
    if (!pts.length) return;
    const xs = pts.map((n) => n.x!),
      ys = pts.map((n) => n.y!);
    const pad = 60;
    const x0 = Math.min(...xs) - pad,
      x1 = Math.max(...xs) + pad,
      y0 = Math.min(...ys) - pad - 20,
      y1 = Math.max(...ys) + pad;
    const { w, h } = size.current;
    const side = w > 700 ? 240 : 0;
    const top = 110,
      bottom = 60;
    const aw = w - side - 24,
      ah = h - top - bottom;
    const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.15, 1.4);
    setCam({ k, x: 12 + (aw - (x1 - x0) * k) / 2 - x0 * k, y: top + (ah - (y1 - y0) * k) / 2 - y0 * k });
  }

  // keyboard brushes
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select') || e.metaKey || e.ctrlKey) return;
      const m: Record<string, Brush> = { m: 'move', e: 'erase', l: 'lasso' };
      BONDS.forEach((b, i) => (m[String(i + 1)] = b));
      if (m[e.key]) setBrush(m[e.key]);
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left,
        py = e.clientY - r.top;
      userMoved.current = true;
      setCam((c) => {
        const k = clamp(c.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0.15, 4);
        return { k, x: px - ((px - c.x) * k) / c.k, y: py - ((py - c.y) * k) / c.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // two-finger pinch to zoom (and pan) on touch screens
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ptrs = new Map<number, { x: number; y: number }>();
    let start: { d: number; c: { x: number; y: number }; cam: { x: number; y: number; k: number } } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const g = gest.current;
        if (g?.t === 'node') {
          g.n.fx = null;
          g.n.fy = null;
        }
        gest.current = null;
        setRubber(null);
        setLasso(null);
        userMoved.current = true;
        start = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: camRef.current };
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const move = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!start || ptrs.size < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const [a, b] = [...ptrs.values()];
      const r = el.getBoundingClientRect();
      const st = start;
      const k = clamp(st.cam.k * (Math.hypot(a.x - b.x, a.y - b.y) / st.d), 0.15, 4);
      const c = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const s0 = { x: st.c.x - r.left, y: st.c.y - r.top };
      // keep the graph point under the fingers' midpoint fixed
      const gx = (s0.x - st.cam.x) / st.cam.k,
        gy = (s0.y - st.cam.y) / st.cam.k;
      setCam({ k, x: c.x - gx * k, y: c.y - gy * k });
    };
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size < 2) start = null;
    };
    el.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, { capture: true });
    window.addEventListener('pointercancel', up, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      window.removeEventListener('pointercancel', up, { capture: true });
    };
  }, []);

  const toGraph = (cx: number, cy: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (cx - r.left - cam.x) / cam.k, y: (cy - r.top - cam.y) / cam.k };
  };

  const nodes = [...nodesRef.current.values()];
  const gnodes = nodes.filter((n) => n.guest);
  const byId = nodesRef.current;

  // hulls per tag
  const hulls = useMemo(() => {
    const out: { tag: string; label: string; addAs: string; pts: { x: number; y: number }[]; color: string }[] = [];
    for (const [key, c] of homes.clusters) {
      const pts = gnodes.filter((n) => homes.home.get(n.id) === key).map((n) => ({ x: n.x!, y: n.y! }));
      if (pts.length) out.push({ tag: key, label: c.label, addAs: tagList.find((t) => t.label.toLowerCase() === key)?.label ?? key, pts: hull(pts), color: tagColor.get(key) ?? 'var(--none)' });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homes, tagList, tagColor, gnodes.map((n) => `${n.x?.toFixed(0)},${n.y?.toFixed(0)}`).join()]);

  // labels stay readable when zoomed out
  const labelFs = Math.max(17, 12 / cam.k);
  const labelY = placeLabels(
    hulls
      .filter((h) => h.pts.length > 1)
      .map((h) => ({
        tag: h.tag,
        x: h.pts.reduce((a, p) => a + p.x, 0) / h.pts.length,
        top: Math.min(...h.pts.map((p) => p.y)) - 24,
        bottom: Math.max(...h.pts.map((p) => p.y)) + 24 + labelFs + 14,
        w: h.label.length * labelFs * 0.5,
        h: labelFs + 4,
      })),
    gnodes.map((n) => ({ x: n.x!, y: n.y! })),
  );

  function colorOf(g: Guest) {
    if (colorBy === 'side') return g.side === 'partner1' ? 'var(--p1)' : g.side === 'partner2' ? 'var(--p2)' : g.side === 'both' ? 'var(--both)' : 'var(--none)';
    if (colorBy === 'table') {
      const t = analysis.tableOf.get(g.id);
      return t ? hueColor(tableIndex.get(t) ?? 0, 0.66, 0.14) : 'var(--none)';
    }
    const t = homes.home.get(g.id);
    return t ? tagColor.get(t) ?? 'var(--none)' : 'var(--none)';
  }

  // ---------- pointer interactions ----------
  const gest = useRef<{ t: 'pan'; sx: number; sy: number; c: typeof cam } | { t: 'node'; n: N; sx: number; sy: number; moved: boolean; shift: boolean } | { t: 'lasso' } | { t: 'group'; nodes: N[]; start: { x: number; y: number }[]; sx: number; sy: number; moved: boolean; key?: string } | null>(null);

  function nodeAt(cx: number, cy: number): N | undefined {
    const el = document.elementFromPoint(cx, cy)?.closest('[data-node]') as SVGElement | null;
    return el ? byId.get(el.dataset.node!) : undefined;
  }

  /** Guests the user has dragged as a group; they stay put until "shake" releases them. */
  const pinned = useRef(new Set<string>());
  function startGroupDrag(nodes: N[], e: React.PointerEvent, key?: string) {
    if (!nodes.length) return;
    gest.current = { t: 'group', nodes, start: nodes.map((n) => ({ x: n.x!, y: n.y! })), sx: e.clientX, sy: e.clientY, moved: false, key };
    for (const n of nodes) {
      n.fx = n.x;
      n.fy = n.y;
    }
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    setOffer(null);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const nEl = (e.target as Element).closest('[data-node]') as SVGElement | null;
    const eEl = (e.target as Element).closest('[data-edge]') as SVGElement | null;
    const p = toGraph(e.clientX, e.clientY);
    if (brush === 'lasso' && e.button === 0) {
      gest.current = { t: 'lasso' };
      setLasso([p]);
      return;
    }
    // drag a whole group: its bubble (hand tool) or its name (any tool)
    const hullEl = (e.target as Element).closest('[data-hull]') as SVGElement | null;
    const labelEl = (e.target as Element).closest('[data-hull-label]') as SVGElement | null;
    const groupKey = labelEl?.dataset.hullLabel ?? (brush === 'move' && !nEl ? hullEl?.dataset.hull : undefined);
    if (groupKey && e.button === 0) {
      const members = gnodes.filter((n) => homes.home.get(n.id) === groupKey);
      const hub = byId.get('hub:' + groupKey);
      startGroupDrag([...members, ...(hub ? [hub] : [])], e, groupKey);
      return;
    }
    if (eEl && !nEl) {
      const [a, b] = eEl.dataset.edge!.split('|');
      if (brush === 'erase') setRelation(a, b, null);
      else if (brush !== 'move') paint(a, b);
      else setSelection({ type: 'guest', ids: [a, b] });
      return;
    }
    if (nEl && e.button === 0) {
      const n = byId.get(nEl.dataset.node!)!;
      // hand tool on a guest who's part of a multi-selection: move the whole selection
      if (brush === 'move' && selected.size > 1 && selected.has(n.id) && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
        startGroupDrag(gnodes.filter((x) => selected.has(x.id)), e);
        return;
      }
      gest.current = { t: 'node', n, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey || e.metaKey || e.ctrlKey };
      if (brush === 'move') {
        n.fx = n.x;
        n.fy = n.y;
        sim.current?.alphaTarget(0.25).restart();
      }
      return;
    }
    gest.current = { t: 'pan', sx: e.clientX, sy: e.clientY, c: cam };
  }

  function onMove(e: React.PointerEvent) {
    const g = gest.current;
    if (!g) return;
    const p = toGraph(e.clientX, e.clientY);
    if (g.t === 'pan') (userMoved.current = true), setCam({ ...g.c, x: g.c.x + e.clientX - g.sx, y: g.c.y + e.clientY - g.sy });
    else if (g.t === 'lasso') setLasso((l) => (l ? [...l, p] : l));
    else if (g.t === 'group') {
      if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
      g.moved = true;
      const dx = (e.clientX - g.sx) / cam.k,
        dy = (e.clientY - g.sy) / cam.k;
      g.nodes.forEach((n, i) => {
        n.fx = g.start[i].x + dx;
        n.fy = g.start[i].y + dy;
      });
      sim.current?.alphaTarget(0.15).restart();
    }
    else if (g.t === 'node') {
      if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
      g.moved = true;
      if (brush === 'move') {
        g.n.fx = p.x;
        g.n.fy = p.y;
        // highlight a group under the pointer (sidebar list)
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop="group"]') as HTMLElement | null;
        setDropGroup(el?.dataset.group ?? null);
      } else if (brush !== 'erase') {
        const over = nodeAt(e.clientX, e.clientY);
        setRubber({ from: g.n, to: p, over: over && over.id !== g.n.id ? over.id : undefined });
      }
    }
  }

  function onUp(e: React.PointerEvent) {
    const g = gest.current;
    gest.current = null;
    if (!g) return;
    if (g.t === 'group') {
      sim.current?.alphaTarget(0);
      if (!g.moved) {
        // a tap on a group's bubble or name selects everyone in it
        for (const n of g.nodes) if (n.hub) (n.fx = null), (n.fy = null);
        const ids = g.nodes.filter((n) => n.guest).map((n) => n.id);
        if (ids.length) setSelection({ type: 'guest', ids });
        return;
      }
      // moved groups stay where they were dropped (the shake button releases them)
      for (const n of g.nodes) {
        pinned.current.add(n.id);
        if (n.guest) memo.set(n.id, { x: n.fx!, y: n.fy! });
      }
      return;
    }
    if (g.t === 'lasso') {
      const poly = lasso ?? [];
      setLasso(null);
      if (poly.length > 3) {
        const ids = gnodes.filter((n) => inPoly({ x: n.x!, y: n.y! }, poly)).map((n) => n.id);
        setSelection(ids.length ? { type: 'guest', ids: e.shiftKey && selection?.type === 'guest' ? [...new Set([...selection.ids, ...ids])] : ids } : null);
      }
      return;
    }
    if (g.t !== 'node') return;
    const n = g.n;
    if (!g.moved) {
      const id = n.id;
      if (g.shift) {
        const ids = selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id];
        setSelection(ids.length ? { type: 'guest', ids } : null);
      } else setSelection({ type: 'guest', ids: [id] });
      if (brush === 'move') {
        n.fx = null;
        n.fy = null;
        sim.current?.alphaTarget(0);
      }
      return;
    }
    if (brush === 'move') {
      sim.current?.alphaTarget(0);
      n.fx = null;
      n.fy = null;
      const tag = dropGroup;
      setDropGroup(null);
      if (tag) addTag(n.id, tag);
      else {
        // dropped inside another group's bubble? offer to add them
        const p = { x: n.x!, y: n.y! };
        const mine = groupTags(n.guest!);
        const h = hulls.find((h) => !mine.includes(h.tag) && h.pts.length > 2 && inPoly(p, padPoly(h.pts, 18)));
        if (h) setOffer({ guestId: n.id, tag: h.addAs, x: e.clientX, y: e.clientY });
      }
      return;
    }
    if (rubber) {
      const target = rubber.over;
      setRubber(null);
      if (target && brush !== 'erase' && brush !== 'lasso') {
        paint(n.id, target);
      }
    }
  }

  /** Apply the current brush (relationship + optional seating rule + context) to a pair; repeat to remove. */
  function paint(a: Id, b: Id) {
    const kind = brush as Bond;
    const existing = project.relations.find((r) => (r.a === a && r.b === b) || (r.b === a && r.a === b));
    const ctx = brushCtx.trim();
    const hasCtx = !ctx || (existing?.contexts ?? []).some((c) => c.toLowerCase() === ctx.toLowerCase());
    if (existing && existing.kind === kind && (!brushSeat || existing.seat === brushSeat) && hasCtx) {
      setRelation(a, b, null);
      toast('Tie removed', true);
      return;
    }
    const contexts = ctx && !hasCtx ? [...(existing?.contexts ?? []), ctx] : undefined;
    setRelation(a, b, { kind, ...(brushSeat ? { seat: brushSeat } : {}), ...(contexts ? { contexts } : {}) });
    const na = byId.get(a)?.guest?.name,
      nb = byId.get(b)?.guest?.name;
    toast(`${firstName(na ?? '')} & ${firstName(nb ?? '')}: ${describeTie({ kind, seat: brushSeat || existing?.seat, contexts: contexts ?? existing?.contexts })}`, true);
  }

  function addTag(guestId: Id, tag: string) {
    const g = project.guests.find((x) => x.id === guestId);
    if (!g) return;
    const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
    if (cur.some((x) => x.toLowerCase() === tag.toLowerCase())) return;
    updateGuests([guestId], { group: [...cur, tag].join(', ') });
    toast(`Added ${firstName(g.name)} to ${tag}`, true);
  }

  // ---------- render ----------
  const dimEdges = !!matcher && !filters.hide;
  const isolatedCount = gnodes.filter((n) => !tied.has(n.id) && !groupTags(n.guest!).length).length;
  const nf = activeCount(filters);
  const selGuests = project.guests.filter((g) => selected.has(g.id));

  return (
    <div className="stage net" ref={wrap}>
      <svg ref={svg} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} style={{ cursor: brush === 'lasso' ? 'crosshair' : 'default' }} role="application" aria-label="Social graph">
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
          {hulls.map((h) => (
            <g key={h.tag} className={`hull ${dropGroup && dropGroup.toLowerCase() === h.tag ? 'drop' : ''}`}>
              <path d={hullPath(h.pts)} fill={h.color} stroke={h.color} strokeWidth={44} data-hull={h.tag} style={{ cursor: brush === 'move' ? 'grab' : undefined }} />
            </g>
          ))}
          {hulls.map((h) =>
            h.pts.length > 1 ? (
              <text key={h.tag} className="hull-label" data-hull-label={h.tag} style={{ fontSize: labelFs }} x={h.pts.reduce((a, p) => a + p.x, 0) / h.pts.length} y={labelY.get(h.tag)} textAnchor="middle">
                {h.label}
              </text>
            ) : null,
          )}
          {/* edges */}
          {project.relations.map((r) => {
            const a = byId.get(r.a),
              b = byId.get(r.b);
            if (!a || !b) return null;
            const ctxMatch = !filters.tags.length || (r.contexts ?? []).some((c) => filters.tags.includes(c.toLowerCase()));
            const dim = (dimEdges && !(matcher!(a.guest!) || matcher!(b.guest!))) || (filters.tags.length > 0 && !ctxMatch);
            const seat = effectiveSeat(r);
            const ctxColor = edgeColor === 'context' ? (r.contexts?.[0] ? tagColor.get(r.contexts[0].toLowerCase()) ?? 'var(--ink-3)' : 'var(--line-2)') : undefined;
            return (
              <g key={r.id} data-edge={`${r.a}|${r.b}`}>
                <line className="edge-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <line className={`edge b-${r.kind} ${seat ? 's-' + seat : ''} ${dim ? 'dim' : ''}`} style={ctxColor ? { stroke: ctxColor } : undefined} x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                  <title>
                    {a.guest!.name} & {b.guest!.name}: {describeTie(r)}
                  </title>
                </line>
              </g>
            );
          })}
          {gnodes.map((n) => {
            const g = n.guest!;
            if (!g.party) return null;
            const mates = gnodes.filter((m) => m !== n && m.guest!.party === g.party && m.id > n.id);
            return mates.map((m) => <line key={n.id + m.id} className="edge e-party" x1={n.x} y1={n.y} x2={m.x} y2={m.y} pointerEvents="none" />);
          })}
          {rubber && <line className="rubber" x1={rubber.from.x} y1={rubber.from.y} x2={rubber.over ? byId.get(rubber.over)!.x : rubber.to.x} y2={rubber.over ? byId.get(rubber.over)!.y : rubber.to.y} />}
          {/* nodes */}
          {(() => {
            // names: readable size at any zoom; when zoomed out, show only names that fit without overlapping
            const fs = Math.max(11, 9 / cam.k);
            const label = (n: N) => (selected.has(n.id) || cam.k > 1.4 ? n.guest!.name : firstName(n.guest!.name));
            const order = [...gnodes].sort(
              (a, b) =>
                Number(selected.has(b.id)) - Number(selected.has(a.id)) ||
                Number(!matcher || matcher(b.guest!)) - Number(!matcher || matcher(a.guest!)) ||
                Number(tied.has(b.id)) - Number(tied.has(a.id)),
            );
            const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
            const dots = gnodes.map((n) => ({ x: n.x!, y: n.y!, id: n.id }));
            shownLabels.clear();
            for (const n of order) {
              // generous estimate of the text's box (letters + outline + line height)
              const w = label(n).length * fs * 0.64 + 6,
                r = selected.has(n.id) ? 10 : 8;
              const box = { x0: n.x! - w / 2, x1: n.x! + w / 2, y0: n.y! + r, y1: n.y! + r + 6 + fs * 1.3 };
              const hit =
                boxes.some((b) => box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1) ||
                dots.some((d) => d.id !== n.id && d.x > box.x0 - 12 && d.x < box.x1 + 12 && d.y > box.y0 - 12 && d.y < box.y1 + 12);
              if (hit && !selected.has(n.id)) continue;
              boxes.push(box);
              shownLabels.set(n.id, { text: label(n), fs });
            }
            return null;
          })()}
          {gnodes.map((n) => {
            const g = n.guest!;
            const match = matcher ? matcher(g) : true;
            const iso = !tied.has(g.id) && !groupTags(g).length;
            const sel = selected.has(g.id);
            const r = sel ? 10 : 8;
            return (
              <g key={n.id} className={`node ${sel ? 'sel' : ''} ${iso ? 'isolated' : ''} ${!match ? 'dim' : ''} ${rubber?.over === n.id ? 'link-target' : ''}`} data-node={n.id} transform={`translate(${n.x} ${n.y})`}>
                <circle r={r} fill={colorOf(g)} style={{ cursor: brush === 'move' ? 'grab' : brush === 'lasso' ? 'crosshair' : 'pointer' }} />
                {shownLabels.has(n.id) && (
                  <text y={r + 2 + shownLabels.get(n.id)!.fs * 0.9} textAnchor="middle" style={{ fontSize: shownLabels.get(n.id)!.fs }}>
                    {shownLabels.get(n.id)!.text}
                  </text>
                )}
                <title>
                  {g.name}
                  {g.group ? ` · ${g.group}` : ''}
                  {analysis.tableOf.get(g.id) ? ` · ${tableName(project.tables.find((t) => t.id === analysis.tableOf.get(g.id))!)}` : ''}
                </title>
              </g>
            );
          })}
          {lasso && <path className="lasso" d={`M ${lasso.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`} strokeWidth={1.5 / cam.k} />}
        </g>
      </svg>

      <div className="palette tools" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn" aria-pressed={brush === 'move'} title="Move guests, drop them on a group (M)" onClick={() => setBrush('move')}>
          <Icon name="hand" />
        </button>
        <span className="sep" />
        {BONDS.map((k, i) => (
          <button key={k} className={`brush b-${k}`} aria-pressed={brush === k} title={`Drag from one guest to another: ${BOND_HELP[k]} (${i + 1})`} onClick={() => setBrush(k)}>
            <span className="sw" />
            {BOND_LABEL[k]}
          </button>
        ))}
        <span className="sep" />
        <button className="icon-btn" aria-pressed={brush === 'erase'} title="Click a tie to remove it (E)" onClick={() => setBrush('erase')}>
          <Icon name="eraser" />
        </button>
        <button className="icon-btn" aria-pressed={brush === 'lasso'} title="Lasso several guests (L)" onClick={() => setBrush('lasso')}>
          <Icon name="lasso" />
        </button>
      </div>

      {BONDS.includes(brush as Bond) && (
        <div className="palette brush-opts" onPointerDown={(e) => e.stopPropagation()}>
          <input className="input" value={brushCtx} list="net-contexts" placeholder="How they know each other (optional)" onChange={(e) => setBrushCtx(e.target.value)} aria-label="Context for new ties" />
          <datalist id="net-contexts">
            {tagList.map((t) => (
              <option key={t.label} value={t.label} />
            ))}
          </datalist>
          <select className="input" value={brushSeat} onChange={(e) => setBrushSeat(e.target.value as SeatRule | '')} aria-label="Seating rule for new ties">
            <option value="">{brush === 'partner' ? 'Seat next to (partner)' : 'No seating rule'}</option>
            {SEAT_RULES.map((k) => (
              <option key={k} value={k}>
                {SEAT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="net-side" data-open={sideOpen} onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn ghost sm show-md" style={{ justifySelf: 'end' }} onClick={() => setSideOpen(false)}>
          Done
        </button>
        <SearchBox open={showFilters} setOpen={setShowFilters} placeholder="Find a guest…" />
        {showFilters && <FilterSheet project={project} analysis={analysis} />}
        {nf > 0 && (
          <button className="btn ghost sm" onClick={clearFilters}>
            Clear filters
          </button>
        )}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">Colour by</span>
          <select className="input" style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="group">Group</option>
            <option value="table">Table</option>
            <option value="side">Side</option>
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">Lines by</span>
          <select className="input" style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} value={edgeColor} onChange={(e) => setEdgeColor(e.target.value as EdgeColor)}>
            <option value="relationship">Relationship</option>
            <option value="context">How they know each other</option>
          </select>
        </div>
        <button className="tag-drop" aria-pressed={filters.flags.includes('noTies')} onClick={() => setFilters({ flags: filters.flags.includes('noTies') ? filters.flags.filter((f) => f !== 'noTies') : [...filters.flags, 'noTies'] })}>
          <span className="dot" style={{ background: 'var(--bloom)' }} />
          <span className="n">No ties or groups yet</span>
          <span className="muted num">{isolatedCount}</span>
        </button>
        <label className="check" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={includeDeclined} onChange={(e) => setIncludeDeclined(e.target.checked)} /> Include declined
        </label>
        <IntroSuggestions />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">Groups · drag a guest here</span>
          <button className="btn ghost sm" onClick={() => window.dispatchEvent(new Event('app:tags'))}>
            Manage
          </button>
        </div>
        <div className="tags">
          {tagList.map((t) => (
            <button
              key={t.label}
              className="tag-drop"
              data-drop="group"
              data-group={t.label}
              data-over={dropGroup === t.label}
              aria-pressed={filters.tags.includes(t.label.toLowerCase())}
              onClick={() => {
                const k = t.label.toLowerCase();
                setFilters({ tags: filters.tags.includes(k) ? filters.tags.filter((x) => x !== k) : [...filters.tags, k] });
              }}
            >
              <span className="dot" style={{ background: tagColor.get(t.label.toLowerCase()) }} />
              <span className="n">{t.label}</span>
              <span className="muted num">{t.count}</span>
            </button>
          ))}
          {!tagList.length && <span className="muted" style={{ fontSize: 12 }}>Lasso a cluster of guests to make your first group.</span>}
        </div>
      </div>

      <div className="palette zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn ghost sm show-md" onClick={() => setSideOpen(true)}>
          <Icon name="filter" size="sm" /> Groups
        </button>
        <button className="icon-btn" title="Zoom out" onClick={() => (userMoved.current = true) && setCam((c) => ({ ...c, k: clamp(c.k / 1.25, 0.25, 4) }))}>
          <Icon name="zoomOut" />
        </button>
        <button
          className="zoom-label"
          onClick={() => {
            userMoved.current = false;
            fitView();
          }}
          title="Fit everyone in view"
        >
          {Math.round(cam.k * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={() => (userMoved.current = true) && setCam((c) => ({ ...c, k: clamp(c.k * 1.25, 0.25, 4) }))}>
          <Icon name="zoomIn" />
        </button>
        <button
          className="icon-btn"
          title="Shake the layout (also releases groups you've moved)"
          onClick={() => {
            for (const id of pinned.current) {
              const n = nodesRef.current.get(id);
              if (n) (n.fx = null), (n.fy = null);
            }
            pinned.current.clear();
            sim.current?.alpha(0.8).restart();
          }}
        >
          <Icon name="sparkle" />
        </button>
      </div>

      <div className="palette legend" onPointerDown={(e) => e.stopPropagation()}>
        <span className="muted">
          {gnodes.length} guests · {project.relations.length} relationships · drag between guests to connect them
        </span>
      </div>

      {offer && (
        <div className="ctx-bar" style={{ left: offer.x - (wrap.current?.getBoundingClientRect().left ?? 0), top: offer.y - (wrap.current?.getBoundingClientRect().top ?? 0), padding: '4px 4px 4px 12px', gap: 6 }}>
          <span style={{ fontSize: 12.5 }}>Add to {offer.tag}?</span>
          <button
            className="btn primary sm"
            onClick={() => {
              addTag(offer.guestId, offer.tag);
              setOffer(null);
            }}
          >
            Add
          </button>
          <button className="btn ghost sm" onClick={() => setOffer(null)}>
            No
          </button>
        </div>
      )}

      {selGuests.length > 1 && <SelectionBar guests={selGuests} />}
    </div>
  );
}

function SelectionBar({ guests }: { guests: Guest[] }) {
  const ids = guests.map((g) => g.id);
  const project = useStore((s) => s.project);
  const [name, setName] = useState('');
  const makeGroup = () => {
    const t = name.trim();
    if (!t) return;
    update((d) => {
      for (const g of d.guests) {
        if (!ids.includes(g.id)) continue;
        const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
        if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) g.group = [...cur, t].join(', ');
      }
    });
    toast(`Made group "${t}" with ${ids.length} guests`, true);
    setName('');
  };
  return (
    <div className="sel-bar" onPointerDown={(e) => e.stopPropagation()}>
      <b className="num">{guests.length} selected</b>
      <input value={name} placeholder="Group name…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && makeGroup()} aria-label="New group name" />
      <button className="btn sm" onClick={makeGroup} disabled={!name.trim()}>
        Make group
      </button>
      <button className="btn sm" onClick={() => makeParty(ids)}>
        Household
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, { kind: 'friend' })}>
        Friends
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, { kind: 'introduce' })} title="They haven't met, but you'd like them to">
        Introduce
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, { seat: 'beside' })}>
        Next to each other
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, { kind: 'tension', seat: 'apart' })}>
        Keep apart
      </button>
      <select
        className="btn sm"
        value=""
        onChange={(e) => e.target.value && seatAtTable(ids, e.target.value)}
        aria-label="Seat at table"
        style={{ appearance: 'auto' }}
      >
        <option value="">Seat at…</option>
        {project.tables.map((t) => (
          <option key={t.id} value={t.id}>
            {tableName(t)}
          </option>
        ))}
      </select>
      <button className="btn sm" onClick={() => setSelection(null)} aria-label="Clear selection">
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}

// ---------- geometry helpers ----------
function hull(pts: { x: number; y: number }[]) {
  if (pts.length < 3) return pts;
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: typeof p[0], a: typeof p[0], b: typeof p[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: typeof p = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: typeof p = [];
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
const hullPath = (pts: { x: number; y: number }[]) => (pts.length === 1 ? `M ${pts[0].x} ${pts[0].y} l 0.01 0` : `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`);
function inPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function padPoly(pts: { x: number; y: number }[], pad: number) {
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length,
    cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return pts.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / d) * pad, y: p.y + ((p.y - cy) / d) * pad };
  });
}

/** Friends of friends from different circles, offered as Introduce lines. */
function IntroSuggestions() {
  const project = useStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const list = useMemo(() => (open ? suggestIntroductions(project) : []), [open, project]);
  const name = (id: string) => project.guests.find((g) => g.id === id)?.name ?? '';
  return (
    <div className="intro-box">
      <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="sparkle" size="sm" /> Suggest introductions
      </button>
      {open && (
        <div className="intro-list">
          {list.length ? (
            list.map((x) => (
              <div key={x.a + x.b} className="intro-row">
                <span>
                  <b>{firstName(name(x.a))}</b> & <b>{firstName(name(x.b))}</b>
                  <span className="muted"> · both know {x.via.map((v) => firstName(name(v))).join(', ')}</span>
                </span>
                <button className="btn sm" onClick={() => setRelation(x.a, x.b, { kind: 'introduce' })}>
                  Introduce
                </button>
              </div>
            ))
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              No suggestions yet. Draw Friend or Family lines: people two steps apart from different circles show up here.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
