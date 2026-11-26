import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Guest, Id, RelationKind } from './types';
import { makeParty, relateAll, seatAtTable, setRelation, setSelection, tableName, toast, update, updateGuests, useStore } from './store';
import { activeCount, allTags, clearFilters, guestMatcher, setFilters, useFilters } from './filters';
import { REL_LABEL, REL_SHORT, groupTags, type Analysis } from './scoring';
import { clamp, firstName, hueColor } from './util';
import { Icon } from './ui';
import { SearchBox, FilterSheet } from './GuestPanel';

type Brush = 'move' | RelationKind | 'erase' | 'lasso';
type ColorBy = 'group' | 'table' | 'side';

interface N extends SimulationNodeDatum {
  id: string;
  hub?: string; // tag key for invisible hub nodes
  guest?: Guest;
}
interface L extends SimulationLinkDatum<N> {
  kind: RelationKind | 'party' | 'hub';
  rid?: string;
}

// positions survive view switches
const memo = new Map<string, { x: number; y: number }>();

export function NetworkView({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const filters = useFilters();
  const [brush, setBrush] = useState<Brush>('beside');
  const [colorBy, setColorBy] = useState<ColorBy>('group');
  const [includeDeclined, setIncludeDeclined] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 });
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

  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf, analysis.discByGuest), [project, filters, analysis.tableOf]);
  const guests = useMemo(() => project.guests.filter((g) => (includeDeclined || g.rsvp !== 'no') && (!filters.hide || !matcher || matcher(g))), [project.guests, includeDeclined, filters.hide, matcher]);
  const tagList = useMemo(() => allTags(project), [project]);
  const tagColor = useMemo(() => new Map(tagList.map((t, i) => [t.label.toLowerCase(), hueColor(i)])), [tagList]);
  const tableIndex = useMemo(() => new Map(project.tables.map((t, i) => [t.id, i])), [project.tables]);

  // degree for "no ties" highlighting
  const tied = useMemo(() => {
    const s = new Set<Id>();
    for (const r of project.relations) if (r.kind === 'beside' || r.kind === 'together' || r.kind === 'prefer') (s.add(r.a), s.add(r.b));
    const pc = new Map<string, number>();
    for (const g of project.guests) if (g.party) pc.set(g.party, (pc.get(g.party) ?? 0) + 1);
    for (const g of project.guests) if (g.party && pc.get(g.party)! > 1) s.add(g.id);
    return s;
  }, [project.relations, project.guests]);

  // ---------- simulation ----------
  const graphKey = useMemo(() => guests.map((g) => g.id + g.group + g.party).join() + '|' + project.relations.map((r) => r.id + r.kind).join(), [guests, project.relations]);
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
      nodes.set(g.id, { id: g.id, guest: g, x: prev?.x ?? W / 2 + r * Math.cos(a), y: prev?.y ?? H / 2 + r * Math.sin(a), vx: 0, vy: 0 });
    });
    const links: L[] = [];
    const tagMembers = new Map<string, string[]>();
    for (const g of guests) for (const t of groupTags(g)) tagMembers.set(t, [...(tagMembers.get(t) ?? []), g.id]);
    for (const [t, mem] of tagMembers) {
      if (mem.length < 2) continue;
      const hid = 'hub:' + t;
      const prev = old.get(hid);
      const hub: N = { id: hid, hub: t, x: prev?.x ?? W / 2 + (Math.random() - 0.5) * 300, y: prev?.y ?? H / 2 + (Math.random() - 0.5) * 300 };
      nodes.set(hid, hub);
      for (const m of mem) links.push({ source: m, target: hid, kind: 'hub' });
    }
    const parties = new Map<string, string[]>();
    for (const g of guests) if (g.party) parties.set(g.party, [...(parties.get(g.party) ?? []), g.id]);
    for (const mem of parties.values()) for (let i = 1; i < mem.length; i++) links.push({ source: mem[0], target: mem[i], kind: 'party' });
    for (const r of project.relations) if (ids.has(r.a) && ids.has(r.b)) links.push({ source: r.a, target: r.b, kind: r.kind, rid: r.id });
    nodesRef.current = nodes;

    const linkForce = forceLink<N, L>(links)
      .id((d) => d.id)
      .distance((l) => ({ hub: 46, party: 22, beside: 20, together: 30, prefer: 52, avoid: 190, apart: 260 })[l.kind])
      .strength((l) => ({ hub: 0.22, party: 1, beside: 1, together: 0.9, prefer: 0.5, avoid: 0.12, apart: 0.25 })[l.kind]);
    sim.current?.stop();
    const s = forceSimulation<N, L>([...nodes.values()])
      .force('link', linkForce)
      .force('charge', forceManyBody<N>().strength((d) => (d.hub ? -10 : -70)).distanceMax(420))
      .force('collide', forceCollide<N>((d) => (d.hub ? 0 : 15)))
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

  // keyboard brushes
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select') || e.metaKey || e.ctrlKey) return;
      const m: Record<string, Brush> = { '1': 'beside', '2': 'together', '3': 'prefer', '4': 'avoid', '5': 'apart', m: 'move', e: 'erase', l: 'lasso' };
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
      setCam((c) => {
        const k = clamp(c.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0.25, 4);
        return { k, x: px - ((px - c.x) * k) / c.k, y: py - ((py - c.y) * k) / c.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
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
    const out: { tag: string; label: string; pts: { x: number; y: number }[]; color: string }[] = [];
    for (const t of tagList) {
      const key = t.label.toLowerCase();
      const pts = gnodes.filter((n) => groupTags(n.guest!).includes(key)).map((n) => ({ x: n.x!, y: n.y! }));
      if (pts.length) out.push({ tag: key, label: t.label, pts: hull(pts), color: tagColor.get(key)! });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagList, tagColor, gnodes.map((n) => `${n.x?.toFixed(0)},${n.y?.toFixed(0)}`).join()]);

  function colorOf(g: Guest) {
    if (colorBy === 'side') return g.side === 'partner1' ? 'var(--p1)' : g.side === 'partner2' ? 'var(--p2)' : g.side === 'both' ? 'var(--both)' : 'var(--none)';
    if (colorBy === 'table') {
      const t = analysis.tableOf.get(g.id);
      return t ? hueColor(tableIndex.get(t) ?? 0, 0.66, 0.14) : 'var(--none)';
    }
    const t = groupTags(g)[0];
    return t ? tagColor.get(t)! : 'var(--none)';
  }

  // ---------- pointer interactions ----------
  const gest = useRef<{ t: 'pan'; sx: number; sy: number; c: typeof cam } | { t: 'node'; n: N; sx: number; sy: number; moved: boolean; shift: boolean } | { t: 'lasso' } | null>(null);

  function nodeAt(cx: number, cy: number): N | undefined {
    const el = document.elementFromPoint(cx, cy)?.closest('[data-node]') as SVGElement | null;
    return el ? byId.get(el.dataset.node!) : undefined;
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
    if (eEl && !nEl) {
      const [a, b, kind] = eEl.dataset.edge!.split('|');
      if (brush === 'erase') setRelation(a, b, null);
      else if (brush !== 'move' && kind !== brush) setRelation(a, b, brush as RelationKind);
      else if (brush !== 'move' && kind === brush) setRelation(a, b, null);
      else setSelection({ type: 'guest', ids: [a, b] });
      return;
    }
    if (nEl && e.button === 0) {
      const n = byId.get(nEl.dataset.node!)!;
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
    if (g.t === 'pan') setCam({ ...g.c, x: g.c.x + e.clientX - g.sx, y: g.c.y + e.clientY - g.sy });
    else if (g.t === 'lasso') setLasso((l) => (l ? [...l, p] : l));
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
        if (h) setOffer({ guestId: n.id, tag: h.label, x: e.clientX, y: e.clientY });
      }
      return;
    }
    if (rubber) {
      const target = rubber.over;
      setRubber(null);
      if (target && brush !== 'erase' && brush !== 'lasso') {
        const existing = project.relations.find((r) => (r.a === n.id && r.b === target) || (r.b === n.id && r.a === target));
        const kind = brush as RelationKind;
        if (existing?.kind === kind) {
          setRelation(n.id, target, null);
          toast('Tie removed', true);
        } else {
          setRelation(n.id, target, kind);
          const a = byId.get(n.id)?.guest?.name,
            b = byId.get(target)?.guest?.name;
          toast(`${firstName(a ?? '')} & ${firstName(b ?? '')}: ${REL_LABEL[kind].toLowerCase()}`, true);
        }
      }
    }
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
            <g key={h.tag} className={`hull ${dropGroup === h.label ? 'drop' : ''}`}>
              <path d={hullPath(h.pts)} fill={h.color} stroke={h.color} strokeWidth={44} />
              {h.pts.length > 1 && (
                <text x={h.pts.reduce((a, p) => a + p.x, 0) / h.pts.length} y={Math.min(...h.pts.map((p) => p.y)) - 26} textAnchor="middle">
                  {h.label}
                </text>
              )}
            </g>
          ))}
          {/* edges */}
          {project.relations.map((r) => {
            const a = byId.get(r.a),
              b = byId.get(r.b);
            if (!a || !b) return null;
            const dim = dimEdges && !(matcher!(a.guest!) || matcher!(b.guest!));
            return (
              <g key={r.id} data-edge={`${r.a}|${r.b}|${r.kind}`}>
                <line className="edge-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <line className={`edge e-${r.kind} ${dim ? 'dim' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                  <title>
                    {a.guest!.name} & {b.guest!.name}: {REL_LABEL[r.kind]}
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
          {gnodes.map((n) => {
            const g = n.guest!;
            const match = matcher ? matcher(g) : true;
            const iso = !tied.has(g.id) && !groupTags(g).length;
            const sel = selected.has(g.id);
            const r = sel ? 10 : 8;
            return (
              <g key={n.id} className={`node ${sel ? 'sel' : ''} ${iso ? 'isolated' : ''} ${!match ? 'dim' : ''} ${rubber?.over === n.id ? 'link-target' : ''}`} data-node={n.id} transform={`translate(${n.x} ${n.y})`}>
                <circle r={r} fill={colorOf(g)} style={{ cursor: brush === 'move' ? 'grab' : brush === 'lasso' ? 'crosshair' : 'pointer' }} />
                {(cam.k > 0.7 || sel) && (
                  <text y={r + 12} textAnchor="middle">
                    {sel || cam.k > 1.4 ? g.name : firstName(g.name)}
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
        {(['beside', 'together', 'prefer', 'avoid', 'apart'] as RelationKind[]).map((k, i) => (
          <button key={k} className={`brush k-${k}`} aria-pressed={brush === k} title={`Drag from one guest to another: ${REL_LABEL[k]} (${i + 1})`} onClick={() => setBrush(k)}>
            <span className="sw" />
            {REL_SHORT[k]}
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

      <div className="net-side" onPointerDown={(e) => e.stopPropagation()}>
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
        <button className="tag-drop" aria-pressed={filters.flags.includes('noTies')} onClick={() => setFilters({ flags: filters.flags.includes('noTies') ? filters.flags.filter((f) => f !== 'noTies') : [...filters.flags, 'noTies'] })}>
          <span className="dot" style={{ background: 'var(--bloom)' }} />
          <span className="n">No ties or groups yet</span>
          <span className="muted num">{isolatedCount}</span>
        </button>
        <label className="check" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={includeDeclined} onChange={(e) => setIncludeDeclined(e.target.checked)} /> Include declined
        </label>
        <span className="label">Groups · drag a guest here</span>
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
        <button className="icon-btn" title="Zoom out" onClick={() => setCam((c) => ({ ...c, k: clamp(c.k / 1.25, 0.25, 4) }))}>
          <Icon name="zoomOut" />
        </button>
        <button className="zoom-label" onClick={() => setCam({ x: 0, y: 0, k: 1 })} title="Reset view">
          {Math.round(cam.k * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={() => setCam((c) => ({ ...c, k: clamp(c.k * 1.25, 0.25, 4) }))}>
          <Icon name="zoomIn" />
        </button>
        <button className="icon-btn" title="Shake the layout" onClick={() => sim.current?.alpha(0.8).restart()}>
          <Icon name="sparkle" />
        </button>
      </div>

      <div className="palette legend" onPointerDown={(e) => e.stopPropagation()}>
        <span className="muted">
          {gnodes.length} guests · {project.relations.length} ties · drag between guests to connect them
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
      <button className="btn sm" onClick={() => relateAll(ids, 'beside')}>
        Next to each other
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, 'prefer')}>
        Prefer together
      </button>
      <button className="btn sm" onClick={() => relateAll(ids, 'apart')}>
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
