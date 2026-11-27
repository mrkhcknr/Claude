import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { happinessOf } from './happiness';
import type { Guest, Id, Opening, Project, RefLayer, RoomElement, Table, Wall, Zone } from './types';
import { addReferenceFile, alignTwoPoints, refToWorld, scaleFromLength, updateRef, worldToRef } from './refs';
import { setFixed, toast } from './store';
import {
  addElement,
  addTable,
  addTableGrid,
  checkpoint,
  getState,
  seatAtTable,
  seatGuest,
  makeRectRoom,
  setCamera,
  setSelection,
  setTool,
  TABLE_PRESETS,
  hasTableName,
  tableName,
  update,
  updateTables,
  duplicateSelection,
  deleteSelection,
  useStore,
  ZONE_PRESETS,
  type Camera,
  type TablePreset,
} from './store';
import { CHAIR_R, isCircular, projectBounds, rotate, seatLocal, snapToWall, tableFootprint, toWorld, type Pt } from './geometry';
import { useDrag, startGuestDrag, cancelGuestDrag } from './dnd';
import { planBlockMove, setPickMode, usePick } from './seatMove';
import { onSafariPinch, wheelIntent } from './wheel';
import { useFilters, guestMatcher, allTags } from './filters';
import { tagColor as tagColorFor } from './tags';
import { buildAffinity, groupTags, type Analysis } from './scoring';
import { clamp, firstName, fmtLen, hueColor, initials, shortLatin, snapTo, uid } from './util';
import { Icon, Menu, MenuItem, NumField } from './ui';

/** Loose view over tables and room elements for handle maths. */
type Loose = { kind?: string; shape?: string; x: number; y: number; x1: number; y1: number; x2: number; y2: number; w: number; h: number; size: number; rotation: number };
const kindOf = (i: Table | RoomElement) => ('shape' in i ? 'table' : i.kind);

type Handle = { kind: 'resize'; sx: number; sy: number } | { kind: 'rotate' } | { kind: 'wall'; end: 1 | 2 };

type Gesture =
  | { t: 'pan'; sx: number; sy: number; cam: Camera }
  | { t: 'move'; start: Pt; tables: Map<Id, Pt>; els: Map<Id, RoomElement>; moved: boolean }
  | { t: 'marquee'; start: Pt; cur: Pt; add: boolean }
  | { t: 'handle'; h: Handle; id: Id; isTable: boolean; orig: Table | RoomElement; start: Pt }
  | { t: 'pinch' }
  | { t: 'refMove'; id: Id; start: Pt; orig: Pt; moved: boolean }
  | { t: 'refHandle'; id: Id; kind: 'scale' | 'rotate'; orig: RefLayer };

const MIN_SCALE = 2,
  MAX_SCALE = 80;

export function FloorPlan({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const camera = useStore((s) => s.camera);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const focusGuest = useStore((s) => s.focusGuest);
  const drag = useDrag();
  const filters = useFilters();
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // 0 until measured, so the first fit uses the real screen size (phones are much narrower than 800)
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const g = useRef<Gesture | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [wallDraft, setWallDraft] = useState<Pt[]>([]);
  const [spaceDown, setSpaceDown] = useState(false);
  const [refPts, setRefPts] = useState<Pt[]>([]);
  const [lenInput, setLenInput] = useState('');
  const pointers = useRef(new Map<number, Pt>());
  const pinchRef = useRef<{ d: number; c: Pt; cam: Camera } | null>(null);
  const s = project.settings;
  const k = 1 / camera.scale; // world units per pixel

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // fit once when content first appears
  const fitted = useRef(0);
  useEffect(() => {
    if (size.w < 50 || size.h < 50) return;
    if (!(project.tables.length || project.elements.length)) return;
    // fit on first view, and again after a big size change (rotating a phone, switching panes)
    if (fitted.current && Math.abs(size.w - fitted.current) / fitted.current < 0.3) return;
    fitted.current = size.w;
    fitView(size);
  }, [project.tables.length, project.elements.length, size]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea,select')) {
        setSpaceDown(true);
      }
      if ((e.key === 'Escape' || e.key === 'Enter') && wallDraft.length) {
        setWallDraft([]);
      }
      if (e.key === 'Escape') setRefPts([]);
    };
    const ku = (e: KeyboardEvent) => e.code === 'Space' && setSpaceDown(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [wallDraft.length]);
  useEffect(() => {
    if (tool !== 'wall') setWallDraft([]);
    setRefPts([]);
    setLenInput('');
  }, [tool]);

  const toWorldPt = (cx: number, cy: number): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (cx - r.left) / camera.scale + camera.x, y: (cy - r.top) / camera.scale + camera.y };
  };
  const toScreen = (p: Pt) => ({ x: (p.x - camera.x) * camera.scale, y: (p.y - camera.y) * camera.scale });
  const snap = (v: number, alt = false) => (s.snap && !alt ? snapTo(v, s.gridSize) : Math.round(v * 100) / 100);

  const setG = (v: Gesture | null) => {
    g.current = v;
    setGesture(v);
  };

  // ---------- derived ----------
  const guestById = useMemo(() => new Map(project.guests.map((x) => [x.id, x])), [project.guests]);
  const happy = useMemo(() => happinessOf(project), [project]);
  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf, analysis.discByGuest), [project, filters, analysis.tableOf]);
  const colorOf = useMemo(() => seatColorFn(project), [project]);
  const selIds = new Set(selection?.type === 'table' || selection?.type === 'element' ? selection.ids : []);
  const selGuests = new Set(selection?.type === 'guest' ? selection.ids : []);
  const affinity = useMemo(() => buildAffinity(project), [project]);

  // drop feedback
  const overTable = drag.active && drag.over && (drag.over.kind === 'table' || drag.over.kind === 'seat') ? drag.over.tableId : null;
  const overSeat = drag.active && drag.over?.kind === 'seat' ? drag.over.seat : -1;
  // group drag preview: where each picked-up guest lands, and where the people in the way slide to
  const blockPreview = useMemo(() => {
    if (!drag.active || !drag.anchor || drag.guestIds.length < 2 || drag.over?.kind !== 'seat') return null;
    const plan = planBlockMove(project, drag.guestIds, drag.anchor, { t: drag.over.tableId, s: drag.over.seat });
    if (!plan) return null;
    return { to: new Set([...plan.to.values()].map((r) => r.t + ':' + r.s)), slide: new Set([...plan.displaced.values()].map((r) => r.t + ':' + r.s)) };
  }, [drag.active, drag.anchor, drag.guestIds, drag.over, project]);
  const dropBad = useMemo(() => {
    if (!overTable) return false;
    const seats = project.seating[overTable] ?? [];
    const moving = new Set(drag.guestIds);
    const free = seats.filter((x) => !x || moving.has(x)).length;
    if (overSeat < 0 && free < drag.guestIds.length) return true;
    return seats.some((o) => o && !moving.has(o) && drag.guestIds.some((gid) => affinity.relation(gid, o) === 'apart'));
  }, [overTable, overSeat, drag.guestIds, project.seating, affinity]);

  // ---------- camera ----------
  function fitView(sz = size) {
    const b = projectBounds(getState().project);
    const pad = 40;
    const scale = clamp(Math.min((sz.w - pad * 2) / Math.max(10, b.x1 - b.x0), (sz.h - pad * 2 - 40) / Math.max(10, b.y1 - b.y0)), MIN_SCALE, MAX_SCALE);
    setCamera({ scale, x: (b.x0 + b.x1) / 2 - sz.w / 2 / scale, y: (b.y0 + b.y1) / 2 - (sz.h + 30) / 2 / scale });
  }
  function zoomAt(factor: number, sx = size.w / 2, sy = size.h / 2) {
    const cam = getState().camera;
    const scale = clamp(cam.scale * factor, MIN_SCALE, MAX_SCALE);
    const wx = sx / cam.scale + cam.x,
      wy = sy / cam.scale + cam.y;
    setCamera({ scale, x: wx - sx / scale, y: wy - sy / scale });
  }
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    // trackpad: two-finger swipe pans, pinch zooms; mouse wheel zooms
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const w = wheelIntent(e);
      if (w.kind === 'pan') {
        const cam = getState().camera;
        setCamera({ ...cam, x: cam.x + w.dx / cam.scale, y: cam.y + w.dy / cam.scale });
      } else zoomAt(w.factor, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const offPinch = onSafariPinch(el, (f, cx, cy) => {
      const r = el.getBoundingClientRect();
      zoomAt(f, cx - r.left, cy - r.top);
    });
    return () => {
      el.removeEventListener('wheel', wheel);
      offPinch();
    };
  });
  useEffect(() => {
    const h = () => fitView();
    window.addEventListener('plan:fit', h);
    return () => window.removeEventListener('plan:fit', h);
  });

  // ---------- two-finger pinch & pan ----------
  // Every finger is tracked on the whole canvas (capture phase), so a first finger that lands on a
  // table, chair or guest still counts. A second finger cancels whatever the first one started.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ptrs = pointers.current;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        cancelGuestDrag();
        pinchRef.current = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: getState().camera };
        setG({ t: 'pinch' });
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const move = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const st = pinchRef.current;
      if (!st || ptrs.size < 2 || !svg.current) return;
      e.preventDefault();
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = svg.current.getBoundingClientRect();
      const scale = clamp(st.cam.scale * (d / st.d), MIN_SCALE, MAX_SCALE);
      const wx = (st.c.x - r.left) / st.cam.scale + st.cam.x,
        wy = (st.c.y - r.top) / st.cam.scale + st.cam.y;
      setCamera({ scale, x: wx - (c.x - r.left) / scale, y: wy - (c.y - r.top) / scale });
    };
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size < 2 && pinchRef.current) {
        pinchRef.current = null;
        // lifting one finger ends the pinch; the remaining finger doesn't start anything new
        if (g.current?.t === 'pinch' && ptrs.size === 0) setG(null);
      }
      if (ptrs.size === 0 && g.current?.t === 'pinch') setG(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- pointer handling ----------
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (pinchRef.current) return;
    const target = e.target as Element;
    const p = toWorldPt(e.clientX, e.clientY);
    const alt = e.altKey;
    if (e.button === 1 || tool === 'pan' || spaceDown) {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setG({ t: 'pan', sx: e.clientX, sy: e.clientY, cam: camera });
      return;
    }
    if (e.button !== 0) return;

    // reference-plan tools
    const activeRef = selection?.type === 'ref' ? project.refs?.find((r) => r.id === selection.ids[0]) : undefined;
    if ((tool === 'refScale' || tool === 'refAlign') && activeRef) {
      const onPlanStep = tool === 'refAlign' && refPts.length % 2 === 1;
      let q = p;
      if (onPlanStep) q = snapEndpoint(project, p, 12 * k) ?? snapTableCenter(project, p, 12 * k) ?? p;
      if (tool === 'refScale' && refPts.length >= 2) return;
      const pts = [...refPts, q];
      setRefPts(pts);
      if (tool === 'refAlign' && pts.length === 4) {
        const a = worldToRef(activeRef, pts[0]),
          b = worldToRef(activeRef, pts[2]);
        const patch = alignTwoPoints(a, b, pts[1], pts[3]);
        if (patch) {
          updateRef(activeRef.id, patch);
          toast('Plan aligned. Fine-tune by dragging, or match two other points.', true);
        } else toast('Those points are too close together. Try two points far apart.');
        setRefPts([]);
        setTool('select');
      }
      return;
    }
    const rh = target.closest('[data-ref-handle]') as SVGElement | null;
    if (rh && activeRef) {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      checkpoint();
      setG({ t: 'refHandle', id: activeRef.id, kind: rh.dataset.refHandle as 'scale' | 'rotate', orig: activeRef });
      return;
    }
    const rEl = target.closest('[data-ref-id]') as SVGElement | null;
    if (rEl && activeRef && rEl.dataset.refId === activeRef.id && !activeRef.locked && tool === 'select') {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setG({ t: 'refMove', id: activeRef.id, start: p, orig: { x: activeRef.x, y: activeRef.y }, moved: false });
      return;
    }

    // placement tools
    if (tool === 'wall') {
      let q = { x: snap(p.x, alt), y: snap(p.y, alt) };
      q = snapEndpoint(project, q, 1.2 * Math.max(1, 12 * k)) ?? q;
      if (wallDraft.length && e.shiftKey) q = constrain(wallDraft[wallDraft.length - 1], q);
      if (wallDraft.length) {
        const a = wallDraft[wallDraft.length - 1];
        if (Math.hypot(q.x - a.x, q.y - a.y) < 0.3) {
          setWallDraft([]);
          return;
        }
        addElement({ id: uid(), kind: 'wall', x1: a.x, y1: a.y, x2: q.x, y2: q.y, thickness: 0.75 });
      }
      setWallDraft([...wallDraft, q]);
      return;
    }
    if (tool === 'column') {
      const el = addElement({ id: uid(), kind: 'column', x: snap(p.x, alt), y: snap(p.y, alt), size: 2, round: false });
      setSelection({ type: 'element', ids: [el.id] });
      if (!e.shiftKey) setTool('select');
      return;
    }
    if (tool === 'door' || tool === 'window') {
      const w = snapToWall(project, p);
      const el: Opening = { id: uid(), kind: tool, x: w?.x ?? snap(p.x), y: w?.y ?? snap(p.y), rotation: w?.rotation ?? 0, w: tool === 'door' ? 6 : 5 };
      addElement(el);
      setSelection({ type: 'element', ids: [el.id] });
      if (!e.shiftKey) setTool('select');
      return;
    }

    // handles
    const hEl = target.closest('[data-handle]') as SVGElement | null;
    if (hEl) {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const h = JSON.parse(hEl.dataset.handle!) as Handle;
      const id = hEl.dataset.id!;
      const isTable = hEl.dataset.isTable === '1';
      const orig = isTable ? project.tables.find((t) => t.id === id)! : project.elements.find((x) => x.id === id)!;
      checkpoint();
      setG({ t: 'handle', h, id, isTable, orig, start: p });
      return;
    }

    const tEl = target.closest('[data-table-id]') as SVGElement | null;
    const eEl = target.closest('[data-el-id]') as SVGElement | null;
    if (tEl || eEl) {
      const isTable = !!tEl;
      const id = (tEl ?? eEl)!.dataset[isTable ? 'tableId' : 'elId']!;
      const type = isTable ? 'table' : 'element';
      let ids: Id[];
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const cur = selection?.type === type ? selection.ids : [];
        ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      } else ids = selection?.type === type && selection.ids.includes(id) ? selection.ids : [id];
      setSelection(ids.length ? { type, ids } : null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const tables = new Map<Id, Pt>();
      const els = new Map<Id, RoomElement>();
      if (isTable) for (const t of project.tables) if (ids.includes(t.id) && !t.fixed) tables.set(t.id, { x: t.x, y: t.y });
      if (!isTable) for (const x of project.elements) if (ids.includes(x.id) && !x.fixed) els.set(x.id, x);
      setG({ t: 'move', start: p, tables, els, moved: false });
      return;
    }

    // background
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.shiftKey) setG({ t: 'marquee', start: p, cur: p, add: true });
    else {
      setG({ t: 'pan', sx: e.clientX, sy: e.clientY, cam: camera });
      if (selection && selection.type !== 'guest') setSelection(null);
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = toWorldPt(e.clientX, e.clientY);
    if (tool !== 'select' && tool !== 'pan') setCursor(p);
    const cur = g.current;
    if (!cur) return;
    const alt = e.altKey;
    if (cur.t === 'pinch') return;
    if (cur.t === 'pan') {
      setCamera({ ...cur.cam, x: cur.cam.x - (e.clientX - cur.sx) / cur.cam.scale, y: cur.cam.y - (e.clientY - cur.sy) / cur.cam.scale });
      return;
    }
    if (cur.t === 'marquee') {
      setG({ ...cur, cur: p });
      return;
    }
    if (cur.t === 'move') {
      const dx = p.x - cur.start.x,
        dy = p.y - cur.start.y;
      if (!cur.moved) {
        if (Math.hypot(dx, dy) * camera.scale < 3) return;
        checkpoint();
        g.current = { ...cur, moved: true };
      }
      update(
        (d) => {
          for (const t of d.tables) {
            const o = cur.tables.get(t.id);
            if (o) {
              t.x = snap(o.x + dx, alt);
              t.y = snap(o.y + dy, alt);
            }
          }
          for (const el of d.elements) {
            const o = cur.els.get(el.id);
            if (!o) continue;
            if (el.kind === 'wall' && o.kind === 'wall') {
              const ddx = snap(o.x1 + dx, alt) - o.x1,
                ddy = snap(o.y1 + dy, alt) - o.y1;
              el.x1 = o.x1 + ddx;
              el.y1 = o.y1 + ddy;
              el.x2 = o.x2 + ddx;
              el.y2 = o.y2 + ddy;
            } else if (el.kind !== 'wall' && o.kind !== 'wall') {
              let nx = snap(o.x + dx, alt),
                ny = snap(o.y + dy, alt);
              if ((el.kind === 'door' || el.kind === 'window') && !alt) {
                const w = snapToWall(getState().project, { x: o.x + dx, y: o.y + dy });
                if (w) {
                  nx = w.x;
                  ny = w.y;
                  el.rotation = w.rotation;
                }
              }
              el.x = nx;
              el.y = ny;
            }
          }
        },
        { history: false },
      );
      return;
    }
    if (cur.t === 'handle') applyHandle(cur, p, alt, e.shiftKey);
    if (cur.t === 'refMove') {
      const dx = p.x - cur.start.x,
        dy = p.y - cur.start.y;
      if (!cur.moved) {
        if (Math.hypot(dx, dy) * camera.scale < 3) return;
        checkpoint();
        g.current = { ...cur, moved: true };
      }
      updateRef(cur.id, { x: cur.orig.x + dx, y: cur.orig.y + dy }, false);
    }
    if (cur.t === 'refHandle') {
      const o = cur.orig;
      if (cur.kind === 'scale') {
        const diagImg = Math.hypot(o.imgW, o.imgH);
        const tl = { x: o.x, y: o.y };
        const scale = Math.max(1e-4, Math.hypot(p.x - tl.x, p.y - tl.y) / diagImg);
        updateRef(cur.id, { scale }, false);
      } else {
        const c = refToWorld(o, { x: o.imgW / 2, y: o.imgH / 2 });
        let ang = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
        if (!alt) ang = Math.round(ang * 2) / 2;
        const rot = ((ang % 360) + 360) % 360;
        // rotate about the image centre
        const rr = (rot * Math.PI) / 180;
        const hx = (o.imgW / 2) * o.scale,
          hy = (o.imgH / 2) * o.scale;
        updateRef(cur.id, { rotation: rot, x: c.x - (hx * Math.cos(rr) - hy * Math.sin(rr)), y: c.y - (hx * Math.sin(rr) + hy * Math.cos(rr)) }, false);
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    void e;
    const cur = g.current;
    if (cur?.t === 'pinch') return;
    if (cur?.t === 'marquee') {
      const x0 = Math.min(cur.start.x, cur.cur.x),
        x1 = Math.max(cur.start.x, cur.cur.x),
        y0 = Math.min(cur.start.y, cur.cur.y),
        y1 = Math.max(cur.start.y, cur.cur.y);
      const inBox = (q: Pt) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
      const ids = project.tables.filter((t) => inBox(t)).map((t) => t.id);
      // seated guests whose chairs are in the box: chosen when guests are already selected, "Select several" is on,
      // or the box doesn't take in a whole table
      const guestsIn: Id[] = [];
      for (const t of project.tables) {
        const arr = project.seating[t.id] ?? [];
        seatLocal(t).forEach((lp, i) => arr[i] && inBox(toWorld(t, lp)) && guestsIn.push(arr[i]!));
      }
      const sel0 = getState().selection;
      const wantGuests = guestsIn.length > 0 && (sel0?.type === 'guest' || usePick.getState().on || !ids.length);
      if (wantGuests) setSelection({ type: 'guest', ids: [...new Set([...(sel0?.type === 'guest' ? sel0.ids : []), ...guestsIn])] });
      else if (ids.length) setSelection({ type: 'table', ids });
      else {
        const els = project.elements
          .filter((el) => (el.kind === 'wall' ? Math.min(el.x1, el.x2) >= x0 && Math.max(el.x1, el.x2) <= x1 && Math.min(el.y1, el.y2) >= y0 && Math.max(el.y1, el.y2) <= y1 : el.x >= x0 && el.x <= x1 && el.y >= y0 && el.y <= y1))
          .map((el) => el.id);
        setSelection(els.length ? { type: 'element', ids: els } : null);
      }
    }
    setG(null);
  }

  function applyHandle(cur: Extract<Gesture, { t: 'handle' }>, p: Pt, alt: boolean, shift: boolean) {
    const o = cur.orig as unknown as Loose;
    if (cur.h.kind === 'wall') {
      let q = { x: snap(p.x, alt), y: snap(p.y, alt) };
      q = snapEndpoint(project, q, 12 * k, cur.id) ?? q;
      const other = cur.h.end === 1 ? { x: o.x2, y: o.y2 } : { x: o.x1, y: o.y1 };
      if (shift) q = constrain(other, q);
      const end = cur.h.end;
      update(
        (d) => {
          const w = d.elements.find((x) => x.id === cur.id);
          if (w?.kind !== 'wall') return;
          if (end === 1) Object.assign(w, { x1: q.x, y1: q.y });
          else Object.assign(w, { x2: q.x, y2: q.y });
        },
        { history: false },
      );
      return;
    }
    if (cur.h.kind === 'rotate') {
      let ang = (Math.atan2(p.y - o.y, p.x - o.x) * 180) / Math.PI + 90;
      if (!alt) ang = Math.round(ang / 15) * 15;
      ang = ((ang % 360) + 360) % 360;
      if (cur.isTable) updateTables([cur.id], { rotation: ang }, false);
      else
        update(
          (d) => {
            const el = d.elements.find((x) => x.id === cur.id);
            if (el && 'rotation' in el) el.rotation = ang;
          },
          { history: false },
        );
      return;
    }
    // resize in the item's local frame, anchored at the opposite edge
    const { sx, sy } = cur.h;
    const local = rotate({ x: p.x - o.x, y: p.y - o.y }, -(o.rotation ?? 0));
    const st = s.snap && !alt ? Math.max(0.25, s.gridSize / 2) : 0.05;
    const isCol = kindOf(cur.orig) === 'column';
    const w0 = isCol ? o.size : o.w;
    const h0 = isCol ? o.size : o.h ?? 0;
    let w = w0,
      h = h0,
      cx = 0,
      cy = 0;
    const round = cur.isTable && (o.shape === 'round' || o.shape === 'square');
    if (sx) {
      const anchor = -sx * (w0 / 2);
      w = Math.max(1, snapTo(Math.abs(local.x - anchor), st));
      cx = anchor + (sx * w) / 2;
    }
    if (sy) {
      const anchor = -sy * (h0 / 2);
      h = Math.max(1, snapTo(Math.abs(local.y - anchor), st));
      cy = anchor + (sy * h) / 2;
    }
    if (round || isCol) {
      const m = sx && sy ? Math.max(w, h) : sx ? w : h;
      w = h = m;
      cx = sx ? (-sx * w0) / 2 + (sx * m) / 2 : 0;
      cy = sy ? (-sy * h0) / 2 + (sy * m) / 2 : 0;
      if (o.shape === 'round') {
        cx = 0;
        cy = 0; // circles grow from the centre
      }
    }
    if (shift && !round && !isCol && sx && sy) {
      // keep proportions
      const r = Math.max(w / w0, h / h0);
      w = snapTo(w0 * r, st);
      h = snapTo(h0 * r, st);
      cx = (-sx * w0) / 2 + (sx * w) / 2;
      cy = (-sy * h0) / 2 + (sy * h) / 2;
    }
    const c = toWorld({ x: o.x, y: o.y, rotation: o.rotation ?? 0 }, { x: cx, y: cy });
    if (cur.isTable) updateTables([cur.id], { w, h, x: +c.x.toFixed(2), y: +c.y.toFixed(2) }, false);
    else
      update(
        (d) => {
          const el = d.elements.find((x) => x.id === cur.id);
          if (!el) return;
          if (el.kind === 'column') Object.assign(el, { size: w, x: c.x, y: c.y });
          else if (el.kind === 'zone') Object.assign(el, { w, h, x: c.x, y: c.y });
          else if (el.kind === 'door' || el.kind === 'window') Object.assign(el, { w: Math.max(2, w) });
        },
        { history: false },
      );
  }

  // ---------- render helpers ----------
  const gridStep = s.gridSize * camera.scale >= 7 ? s.gridSize : s.gridSize * 5 * camera.scale >= 7 ? s.gridSize * 5 : 10;
  const major = gridStep < 5 ? 5 : gridStep < 10 ? 10 : 50;
  const view = { x0: camera.x, y0: camera.y, x1: camera.x + size.w * k, y1: camera.y + size.h * k };
  const showNames = s.showSeatNames && camera.scale >= 11;
  const filterActive = !!matcher;

  const singleSel = selection && selection.ids.length === 1 && (selection.type === 'table' || selection.type === 'element') ? selection : null;
  const selTable = singleSel?.type === 'table' ? project.tables.find((t) => t.id === singleSel.ids[0]) : undefined;
  const selEl = singleSel?.type === 'element' ? project.elements.find((x) => x.id === singleSel.ids[0]) : undefined;
  const busy = gesture && (gesture.t === 'move' || gesture.t === 'handle');

  const empty = !project.tables.length && !project.elements.length;

  return (
    <div ref={wrap} className={`stage plan-stage ${gesture?.t === 'pan' ? 'panning' : ''}`} data-tool={spaceDown ? 'pan' : tool}>
      <svg
        ref={svg}
        className="plan"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={(e) => {
          if (tool === 'wall') setWallDraft([]);
          else if (!(e.target as Element).closest('[data-table-id],[data-el-id]')) fitView();
        }}
        role="application"
        aria-label="Floor plan"
      >
        <defs>
          <pattern id="g-minor" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
            <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} className="grid-minor" fill="none" strokeWidth={k} />
          </pattern>
          <pattern id="g-major" width={major} height={major} patternUnits="userSpaceOnUse">
            <rect width={major} height={major} fill="url(#g-minor)" />
            <path d={`M ${major} 0 L 0 0 0 ${major}`} className="grid-major" fill="none" strokeWidth={1.2 * k} />
          </pattern>
        </defs>
        <g transform={`scale(${camera.scale}) translate(${-camera.x} ${-camera.y})`}>
          <rect x={Math.floor(view.x0 / major) * major} y={Math.floor(view.y0 / major) * major} width={view.x1 - view.x0 + major * 2} height={view.y1 - view.y0 + major * 2} fill="url(#g-major)" />

          {/* reference floor plans */}
          {(project.refs ?? []).filter((r) => r.visible).map((r) => {
            const sel = selection?.type === 'ref' && selection.ids[0] === r.id;
            return (
              <g key={r.id} transform={`translate(${r.x} ${r.y}) rotate(${r.rotation}) scale(${r.scale})`}>
                <image
                  href={r.src}
                  width={r.imgW}
                  height={r.imgH}
                  preserveAspectRatio="none"
                  opacity={r.opacity}
                  data-ref-id={r.id}
                  style={{ pointerEvents: sel && !r.locked && tool === 'select' ? 'auto' : 'none', cursor: sel && !r.locked ? 'move' : undefined }}
                />
                {sel && <rect width={r.imgW} height={r.imgH} fill="none" stroke="var(--accent)" strokeWidth={1.5 / (r.scale * camera.scale)} strokeDasharray={`${6 / (r.scale * camera.scale)} ${4 / (r.scale * camera.scale)}`} pointerEvents="none" />}
              </g>
            );
          })}

          {/* zones under everything */}
          {project.elements.filter((x): x is Zone => x.kind === 'zone').map((z) => (
            <g key={z.id} className={`zone z-${z.zone} ${selIds.has(z.id) ? 'sel' : ''}`} data-el-id={z.id} transform={`translate(${z.x} ${z.y}) rotate(${z.rotation})`} style={{ cursor: 'move' }}>
              <rect x={-z.w / 2} y={-z.h / 2} width={z.w} height={z.h} rx={0.4} strokeWidth={1.2 * k} style={{ strokeDasharray: `${5 * k} ${4 * k}` }} />
              <text textAnchor="middle" dominantBaseline="central" transform={`rotate(${-z.rotation})`} style={{ fontSize: Math.max(0.9, 11 * k) }}>
                {z.label}
              </text>
            </g>
          ))}

          {/* walls, columns, openings */}
          {project.elements.map((el) => {
            if (el.kind === 'wall')
              return (
                <g key={el.id} data-el-id={el.id}>
                  <line className="wall" x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} strokeWidth={el.thickness} />
                  <line className="wall-hit" x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} strokeWidth={Math.max(el.thickness, 12 * k)} />
                  {selIds.has(el.id) && <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} className="sel-outline" strokeWidth={el.thickness + 6 * k} style={{ strokeOpacity: 0.35, stroke: 'var(--accent)', strokeDasharray: 'none' }} />}
                </g>
              );
            if (el.kind === 'column')
              return el.round ? (
                <circle key={el.id} data-el-id={el.id} className="column" cx={el.x} cy={el.y} r={el.size / 2} style={{ cursor: 'move' }} />
              ) : (
                <rect key={el.id} data-el-id={el.id} className="column" x={el.x - el.size / 2} y={el.y - el.size / 2} width={el.size} height={el.size} style={{ cursor: 'move' }} />
              );
            if (el.kind === 'door')
              return (
                <g key={el.id} data-el-id={el.id} className="door" transform={`translate(${el.x} ${el.y}) rotate(${el.rotation})`} style={{ cursor: 'move' }}>
                  <line className="gap" x1={-el.w / 2} y1={0} x2={el.w / 2} y2={0} strokeWidth={1.2} style={{ stroke: 'var(--canvas)' }} />
                  <path d={`M ${-el.w / 2} 0 L ${-el.w / 2} ${el.w} A ${el.w} ${el.w} 0 0 0 ${el.w / 2} 0`} strokeWidth={1.2 * k} style={{ strokeDasharray: `${3 * k} ${3 * k}` }} />
                  <rect x={-el.w / 2} y={-0.6} width={el.w} height={el.w + 0.6} fill="transparent" />
                </g>
              );
            if (el.kind === 'window')
              return (
                <g key={el.id} data-el-id={el.id} className="window" transform={`translate(${el.x} ${el.y}) rotate(${el.rotation})`} style={{ cursor: 'move' }}>
                  <line x1={-el.w / 2} y1={-0.2} x2={el.w / 2} y2={-0.2} strokeWidth={2 * k} />
                  <line x1={-el.w / 2} y1={0.2} x2={el.w / 2} y2={0.2} strokeWidth={2 * k} />
                  <rect x={-el.w / 2} y={-0.6} width={el.w} height={1.2} fill="transparent" />
                </g>
              );
            return null;
          })}

          {/* tables */}
          {project.tables.map((t) => {
            const seats = project.seating[t.id] ?? [];
            const filled = seats.filter(Boolean).length;
            const sel = selIds.has(t.id);
            const anyMatch = !filterActive || seats.some((gid) => gid && matcher!(guestById.get(gid)!));
            const tblDim = filterActive && !anyMatch && (filters.hide || filters.tableId || filters.q);
            const local = seatLocal(t);
            const label = tableName(t);
            const nameSize = Math.max(0.85, 12 * k);
            // run the label along long, narrow tables
            const long = t.shape !== 'round' && t.shape !== 'square' && t.w / Math.max(0.1, t.h) > 1.6;
            let la = ((t.rotation % 180) + 180) % 180;
            if (la > 90) la -= 180;
            const labelRot = long ? la : 0;
            return (
              <g key={t.id} className={`tbl ${t.locked ? 'locked' : ''} ${t.fixed ? 'fixed' : ''} ${overTable === t.id ? 'over' + (dropBad ? ' bad' : '') : ''} ${tblDim ? 'dim' : ''}`} data-table-id={t.id}>
                <g transform={`translate(${t.x} ${t.y}) rotate(${t.rotation})`} data-drop="table" data-table={t.id}>
                  <TableShapeEl t={t} k={k} />
                  {sel && <TableShapeEl t={t} k={k} outline />}
                </g>
                <g transform={`translate(${t.x} ${t.y}) rotate(${labelRot})`} pointerEvents="none">
                  {hasTableName(t) ? (
                    (() => {
                      // always: Chinese flower name as the title, English beneath (the language switcher doesn't change this)
                      const zh = (t.nameZh ?? '').replace(/（.*?）|\(.*?\)/g, '').trim(),
                        en = (t.nameEn ?? '').replace(/\(.*?\)/g, '').trim();
                      const main = zh || en;
                      const latin = zh && en ? en : '';
                      // fit text to the table's length; add detail as you zoom in
                      const room = (long || t.shape === 'round' || t.shape === 'square' ? t.w : t.w) * 0.88;
                      const em = (str: string) => [...str].reduce((a, ch) => a + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.56), 0);
                      const fsMain = Math.min(nameSize, room / Math.max(1, em(main)));
                      const lat = shortLatin(latin);
                      const fsLat = Math.min(Math.max(0.5, 9 * k), room / Math.max(1, em(lat)));
                      // lines stack across the table's depth: Chinese title, then English, then the number if there's room
                      const depth = (t.shape === 'round' ? t.w : t.h) * 0.92;
                      const small = Math.max(0.45, 8 * k);
                      const showLat = !!latin && fsLat * camera.scale >= 6.5 && fsMain * 1.1 + fsLat * 1.2 <= depth;
                      const showNum = camera.scale >= 8 && fsMain * 1.1 + (showLat ? fsLat * 1.2 : 0) + small * 1.3 <= depth;
                      return (
                        <>
                          <text className="tname" textAnchor="middle" y={showLat ? -fsMain * 0.35 : showNum ? -fsMain * 0.1 : fsMain * 0.35} style={{ fontSize: fsMain }}>
                            {main}
                          </text>
                          {showLat && (
                            <text className="tlatin" textAnchor="middle" y={fsMain * 0.35 + fsLat * 0.9} style={{ fontSize: fsLat }}>
                              {lat}
                            </text>
                          )}
                          {showNum && (
                            <text className="tnum" textAnchor="middle" y={(showLat ? fsMain * 0.35 + fsLat * 0.9 : fsMain * 0.2) + small * 1.3} style={{ fontSize: small }}>
                              {t.label.toUpperCase()}
                            </text>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    <text className="tname" textAnchor="middle" dominantBaseline="central" style={{ fontSize: nameSize }}>
                      {label}
                    </text>
                  )}
                  {camera.scale > 6 && !hasTableName(t) && (
                    <text className="tcount" textAnchor="middle" y={nameSize * 1.15} style={{ fontSize: Math.max(0.5, 8.5 * k) }}>
                      {filled}/{t.seats}
                    </text>
                  )}
                </g>
                {local.map((lp, i) => {
                  const wp = toWorld(t, lp);
                  const gid = seats[i];
                  const guest = gid ? guestById.get(gid) : undefined;
                  const match = guest && matcher ? matcher(guest) : false;
                  const dim = filterActive && (!guest || !match);
                  const over = overTable === t.id && overSeat === i;
                  const out = rotate(lp, t.rotation);
                  const len = Math.hypot(out.x, out.y) || 1;
                  const nx = out.x / len,
                    ny = out.y / len;
                  return (
                    <g
                      key={i}
                      className={`seat ${blockPreview?.to.has(t.id + ':' + i) ? 'block-to' : ''} ${blockPreview?.slide.has(t.id + ':' + i) ? 'block-slide' : ''} ${guest ? 'filled' : ''} ${guest && s.colorBy === 'side' ? 'side-' + (guest.side || 'none') : ''} ${dim ? 'dim' : ''} ${match ? 'match' : ''} ${over ? 'over' + (dropBad ? ' bad' : '') : ''} ${focusGuest && gid === focusGuest ? 'focus' : ''} ${guest && selGuests.has(guest.id) ? 'match' : ''}`}
                      data-drop="seat"
                      data-table={t.id}
                      data-seat={i}
                      style={guest && s.colorBy !== 'side' ? ({ '--seat-fill': colorOf(guest) } as React.CSSProperties) : undefined}
                      onPointerDown={(e) => {
                        if (!guest && tool === 'select' && !spaceDown && !usePick.getState().on) {
                          // tap-to-seat: with guests selected, tapping an empty chair seats them there
                          const sel = getState().selection;
                          if (sel?.type === 'guest' && sel.ids.length) {
                            e.stopPropagation();
                            const g0 = guestById.get(sel.ids[0]);
                            if (sel.ids.length === 1) seatGuest(sel.ids[0], t.id, i);
                            else seatAtTable(sel.ids, t.id, i);
                            toast(sel.ids.length === 1 ? `Seated ${g0?.name ?? 'guest'} at ${tableName(t)}, seat ${i + 1}` : `Seated ${sel.ids.length} guests at ${tableName(t)}`, true);
                            setSelection(null);
                            return;
                          }
                        }
                        if (!guest || tool !== 'select' || spaceDown) return;
                        e.stopPropagation();
                        const cur = getState().selection;
                        const picked = cur?.type === 'guest' ? cur.ids : [];
                        // click: select; with Shift / Cmd / Ctrl or "Select several" on, add or remove this guest
                        const onClick = (ev: PointerEvent) => {
                          const add = usePick.getState().on || ev.shiftKey || ev.metaKey || ev.ctrlKey;
                          if (!add) return setSelection({ type: 'guest', ids: [guest.id] });
                          const next = picked.includes(guest.id) ? picked.filter((x) => x !== guest.id) : [...picked, guest.id];
                          setSelection(next.length ? { type: 'guest', ids: next } : null);
                        };
                        // dragging one of several selected guests moves them all, keeping their places relative to each other
                        if (picked.length > 1 && picked.includes(guest.id)) startGuestDrag(e, picked, `${picked.length} guests`, onClick, guest.id);
                        else startGuestDrag(e, [guest.id], guest.name, onClick);
                      }}
                    >
                      {/* a generous, invisible drop zone: chairs are only a few pixels wide when zoomed out */}
                      <circle className="seat-hit" cx={wp.x} cy={wp.y} r={CHAIR_R * 1.6} />
                      <circle className="chair" cx={wp.x} cy={wp.y} r={over ? CHAIR_R * 1.35 : CHAIR_R} strokeWidth={1.1 * k} />
                      {guest && camera.scale >= 7 && (
                        <text className="ini" x={wp.x} y={wp.y} textAnchor="middle" dominantBaseline="central" style={{ fontSize: CHAIR_R * 0.78 }}>
                          {initials(guest.name)}
                        </text>
                      )}
                      {guest && showNames && (
                        <text
                          className="sname"
                          x={wp.x + nx * (CHAIR_R + 0.25)}
                          y={wp.y + ny * (CHAIR_R + 0.25)}
                          textAnchor={nx > 0.35 ? 'start' : nx < -0.35 ? 'end' : 'middle'}
                          dominantBaseline={ny > 0.35 ? 'hanging' : ny < -0.35 ? 'auto' : 'central'}
                          style={{ fontSize: Math.max(0.5, 9.5 * k) }}
                        >
                          {firstName(guest.name)}
                        </text>
                      )}
                      <title>{guest ? `${guest.name} · ${Math.round(happy.byGuest.get(guest.id)?.points ?? 0)} pts${guest.meal ? ' · ' + guest.meal : ''}${guest.dietary ? ' · ' + guest.dietary : ''}` : `Empty seat ${i + 1}`}</title>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* selection outlines for elements */}
          {project.elements.map((el) => {
            if (!selIds.has(el.id) || el.kind === 'wall') return null;
            const w = el.kind === 'column' ? el.size : el.w;
            const h = el.kind === 'column' ? el.size : el.kind === 'zone' ? el.h : el.kind === 'door' ? el.w : 1.2;
            const rot = el.kind === 'column' ? 0 : el.rotation;
            const oy = el.kind === 'door' ? el.w / 2 : 0;
            return (
              <g key={'s' + el.id} transform={`translate(${el.x} ${el.y}) rotate(${rot})`}>
                <rect className="sel-outline" x={-w / 2 - 0.3} y={-h / 2 - 0.3 + oy} width={w + 0.6} height={h + 0.6} strokeWidth={1.5 * k} style={{ strokeDasharray: `${6 * k} ${4 * k}` }} />
              </g>
            );
          })}

          {/* handles */}
          {selTable && !selTable.fixed && <Handles item={selTable} isTable k={k} />}
          {selEl && !selEl.fixed && <Handles item={selEl} isTable={false} k={k} />}

          {/* live dimension readout while resizing */}
          {gesture?.t === 'handle' && (selTable || selEl) && <DimLabel item={(selTable ?? selEl)!} k={k} units={s} />}

          {selection?.type === 'ref' && (() => {
            const r = project.refs?.find((x) => x.id === selection.ids[0]);
            if (!r || r.locked || !r.visible) return null;
            const br = refToWorld(r, { x: r.imgW, y: r.imgH });
            const top = refToWorld(r, { x: r.imgW / 2, y: -40 / (r.scale * camera.scale) });
            return (
              <g>
                <rect className="handle" data-ref-handle="scale" x={br.x - 6 * k} y={br.y - 6 * k} width={12 * k} height={12 * k} rx={2 * k} strokeWidth={1.5 * k} style={{ cursor: 'nwse-resize' }} />
                <circle className="handle rot" data-ref-handle="rotate" cx={top.x} cy={top.y} r={6 * k} strokeWidth={1.5 * k} />
              </g>
            );
          })()}
          {refPts.map((q, i) => (
            <g key={i} pointerEvents="none">
              <circle cx={q.x} cy={q.y} r={7 * k} fill="none" stroke={i % 2 && tool === 'refAlign' ? 'var(--bloom)' : 'var(--accent)'} strokeWidth={2 * k} />
              <circle cx={q.x} cy={q.y} r={1.5 * k} fill={i % 2 && tool === 'refAlign' ? 'var(--bloom)' : 'var(--accent)'} />
              <text x={q.x + 9 * k} y={q.y - 9 * k} className="dim-label" style={{ fontSize: 11 * k }}>
                {tool === 'refAlign' ? (i < 2 ? 'A' : 'B') + (i % 2 ? ' on layout' : ' on plan') : i + 1}
              </text>
            </g>
          ))}
          {tool === 'refScale' && refPts.length === 2 && <line x1={refPts[0].x} y1={refPts[0].y} x2={refPts[1].x} y2={refPts[1].y} className="draft" strokeWidth={2 * k} />}

          {/* marquee */}
          {gesture?.t === 'marquee' && (
            <rect className="marquee" x={Math.min(gesture.start.x, gesture.cur.x)} y={Math.min(gesture.start.y, gesture.cur.y)} width={Math.abs(gesture.cur.x - gesture.start.x)} height={Math.abs(gesture.cur.y - gesture.start.y)} strokeWidth={k} />
          )}

          {/* wall draft */}
          {tool === 'wall' && wallDraft.length > 0 && cursor && (() => {
            const a = wallDraft[wallDraft.length - 1];
            const q0 = { x: snap(cursor.x), y: snap(cursor.y) };
            const q = snapEndpoint(project, q0, 12 * k) ?? q0;
            const len = Math.hypot(q.x - a.x, q.y - a.y);
            return (
              <g>
                <line className="draft" x1={a.x} y1={a.y} x2={q.x} y2={q.y} strokeWidth={0.75} style={{ strokeDasharray: `${6 * k} ${4 * k}`, opacity: 0.7 }} />
                <text className="dim-label" x={(a.x + q.x) / 2} y={(a.y + q.y) / 2 - 10 * k} textAnchor="middle" style={{ fontSize: 11 * k }}>
                  {fmtLen(len, s)}
                </text>
              </g>
            );
          })()}
          {tool !== 'select' && tool !== 'pan' && cursor && tool !== 'wall' && <circle cx={snap(cursor.x)} cy={snap(cursor.y)} r={4 * k} fill="var(--accent)" opacity={0.6} />}
        </g>
      </svg>

      <Palette fitView={() => fitView()} zoom={(f) => zoomAt(f)} scale={camera.scale} />
      <Legend project={project} colorOf={colorOf} />

      {tool === 'wall' && <div className="hint">Click to place wall corners · Shift keeps 45° angles · Enter or double-click to finish</div>}
      {(tool === 'door' || tool === 'window') && <div className="hint">Click on a wall to place a {tool}</div>}
      {tool === 'column' && <div className="hint">Click to place a column · hold Shift to place several</div>}
      {tool === 'refAlign' && (
        <div className="hint">
          {['1 of 4 · Click a clear point on the floor plan image, like a room corner', '2 of 4 · Click where that point is on your layout (snaps to wall corners)', '3 of 4 · Click a second point on the plan image, far from the first', '4 of 4 · Click where that point is on your layout'][refPts.length]} · Esc to cancel
        </div>
      )}
      {tool === 'refScale' && refPts.length < 2 && <div className="hint">Click both ends of something on the plan whose real length you know · Esc to cancel</div>}
      {tool === 'refScale' && refPts.length === 2 && (
        <form
          className="ctx-bar"
          style={{ left: '50%', top: 90, translate: '-50% 0', padding: '6px 6px 6px 12px', gap: 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            const r = selection?.type === 'ref' ? project.refs?.find((x) => x.id === selection.ids[0]) : undefined;
            const v = parseFloat(lenInput);
            if (!r || !(v > 0)) return;
            const ft = s.units === 'm' ? v * 3.28084 : v;
            const patch = scaleFromLength(r, refPts[0], refPts[1], ft);
            if (patch) updateRef(r.id, patch);
            toast('Scale set from that length', true);
            setRefPts([]);
            setLenInput('');
            setTool('select');
          }}
        >
          <span style={{ fontSize: 12.5 }}>That length is really</span>
          <input className="input" autoFocus inputMode="decimal" style={{ width: 80 }} value={lenInput} onChange={(e) => setLenInput(e.target.value)} aria-label="Real length" />
          <span className="muted">{s.units}</span>
          <button className="btn primary sm" type="submit">
            Set scale
          </button>
        </form>
      )}

      {selTable && !busy && !drag.active && <TableContextBar t={selTable} at={toScreen({ x: selTable.x, y: selTable.y - tableHalfHeight(selTable) - 2.2 })} />}

      {empty && <EmptyState fit={() => setTimeout(() => fitView(), 0)} />}
    </div>
  );
}

function tableHalfHeight(t: Table) {
  const pts = tableFootprint(t);
  return Math.max(...pts.map((p) => t.y - p.y));
}

function TableShapeEl({ t, k, outline }: { t: Table; k: number; outline?: boolean }) {
  const cls = outline ? 'sel-outline' : 'table-shape';
  const pad = outline ? 0.35 : 0;
  const sw = (outline ? 1.6 : 1.3) * k;
  const style = outline ? { strokeDasharray: `${6 * k} ${4 * k}` } : undefined;
  if (t.shape === 'round') return <circle className={cls} r={t.w / 2 + pad} strokeWidth={sw} style={style} />;
  if (t.shape === 'oval') return <ellipse className={cls} rx={t.w / 2 + pad} ry={t.h / 2 + pad} strokeWidth={sw} style={style} />;
  return <rect className={cls} x={-t.w / 2 - pad} y={-t.h / 2 - pad} width={t.w + pad * 2} height={t.h + pad * 2} rx={0.15} strokeWidth={sw} style={style} />;
}

function Handles({ item, isTable, k }: { item: Table | RoomElement; isTable: boolean; k: number }) {
  const r = 5 * k;
  const hs: { h: Handle; p: Pt }[] = [];
  const kind = kindOf(item);
  if (kind === 'wall') {
    const w = item as Wall;
    hs.push({ h: { kind: 'wall', end: 1 }, p: { x: w.x1, y: w.y1 } }, { h: { kind: 'wall', end: 2 }, p: { x: w.x2, y: w.y2 } });
  } else {
    const it = item as unknown as Loose;
    const rot = kind === 'column' ? 0 : it.rotation;
    const w = kind === 'column' ? it.size : it.w;
    const h = kind === 'column' ? it.size : isTable || kind === 'zone' ? (isTable && it.shape === 'round' ? it.w : it.h) : 0;
    const frame = { x: it.x, y: it.y, rotation: rot };
    let dirs: [number, number][] = [];
    if (isTable && it.shape === 'round') dirs = [[1, 0]];
    else if (isTable && it.shape === 'square') dirs = [[1, 1], [-1, -1], [1, -1], [-1, 1]];
    else if (isTable || kind === 'zone') dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    else if (kind === 'column') dirs = [[1, 1]];
    else dirs = [[1, 0], [-1, 0]];
    const extra = isTable ? 0 : 0;
    for (const [sx, sy] of dirs) hs.push({ h: { kind: 'resize', sx, sy }, p: toWorld(frame, { x: (sx * w) / 2 + sx * extra, y: (sy * h) / 2 }) });
    if (kind !== 'column') {
      const off = isTable ? Math.max(h / 2, it.shape === 'round' ? it.w / 2 : 0) + 3 : kind === 'zone' ? h / 2 + 1.5 : 1.8;
      hs.push({ h: { kind: 'rotate' }, p: toWorld(frame, { x: 0, y: -off }) });
    }
  }
  return (
    <g>
      {hs.map(({ h, p }, i) => (
        <g key={i} data-handle={JSON.stringify(h)} data-id={item.id} data-is-table={isTable ? '1' : '0'}>
          {h.kind === 'rotate' ? (
            <>
              <circle className="handle rot" cx={p.x} cy={p.y} r={r * 1.15} strokeWidth={1.5 * k} />
              <path d={rotIcon(p, r * 0.6)} fill="none" stroke="var(--accent)" strokeWidth={1.3 * k} pointerEvents="none" />
            </>
          ) : (
            <rect className="handle" x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={1.5 * k} strokeWidth={1.5 * k} style={{ cursor: cursorFor(h, item) }} />
          )}
        </g>
      ))}
    </g>
  );
}

const rotIcon = (p: Pt, r: number) => `M ${p.x + r} ${p.y} A ${r} ${r} 0 1 1 ${p.x} ${p.y - r}`;
function cursorFor(h: Handle, item: Table | RoomElement) {
  if (h.kind !== 'resize') return 'move';
  const rot = 'rotation' in item ? item.rotation : 0;
  const ang = (((Math.atan2(h.sy, h.sx) * 180) / Math.PI + rot) % 180 + 180) % 180;
  return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nwse-resize' : ang < 112.5 ? 'ns-resize' : 'nesw-resize';
}

function DimLabel({ item, k, units }: { item: Table | RoomElement; k: number; units: Project['settings'] }) {
  let text = '';
  let at: Pt = { x: 0, y: 0 };
  if ('kind' in item && item.kind === 'wall') {
    text = fmtLen(Math.hypot(item.x2 - item.x1, item.y2 - item.y1), units);
    at = { x: (item.x1 + item.x2) / 2, y: (item.y1 + item.y2) / 2 };
  } else if ('shape' in item) {
    text = item.shape === 'round' ? `⌀ ${fmtLen(item.w, units)}` : `${fmtLen(item.w, units)} × ${fmtLen(item.h, units)}`;
    if (item.rotation) text += ` · ${Math.round(item.rotation)}°`;
    at = { x: item.x, y: item.y };
  } else if (item.kind === 'column') {
    text = fmtLen(item.size, units);
    at = item;
  } else if (item.kind === 'zone') {
    text = `${fmtLen(item.w, units)} × ${fmtLen(item.h, units)}`;
    at = item;
  } else {
    text = fmtLen(item.w, units);
    at = item;
  }
  const fs = 11 * k;
  const w = text.length * fs * 0.62 + 12 * k;
  return (
    <g pointerEvents="none" transform={`translate(${at.x} ${at.y + 24 * k})`}>
      <rect className="dim-bg" x={-w / 2} y={-fs} width={w} height={fs * 1.9} rx={fs * 0.6} strokeWidth={k} />
      <text className="dim-label" textAnchor="middle" y={fs * 0.05} dominantBaseline="central" style={{ fontSize: fs }}>
        {text}
      </text>
    </g>
  );
}

function TableContextBar({ t, at }: { t: Table; at: Pt }) {
  return (
    <div className="ctx-bar" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <span className="seats">
        <button className="icon-btn sm" title="Remove a seat" onClick={() => updateTables([t.id], { seats: Math.max(0, t.seats - 1) })}>
          <Icon name="minus" size="sm" />
        </button>
        {t.seats} seats
        <button className="icon-btn sm" title="Add a seat" onClick={() => updateTables([t.id], { seats: t.seats + 1 })}>
          <Icon name="plus" size="sm" />
        </button>
      </span>
      <span className="palette-sep" style={{ width: 1, height: 18, background: 'var(--line)' }} />
      <button className="icon-btn sm" title="Rotate 90° (R)" disabled={t.fixed} onClick={() => updateTables([t.id], { rotation: (t.rotation + 90) % 360 })}>
        <Icon name="rotate" size="sm" />
      </button>
      <button className="icon-btn sm" title="Duplicate (Ctrl+D)" onClick={duplicateSelection}>
        <Icon name="copy" size="sm" />
      </button>
      <button className={`icon-btn sm ${t.fixed ? 'is-locked' : ''}`} title={t.fixed ? 'Unlock position' : 'Lock position'} aria-label={t.fixed ? 'Unlock position' : 'Lock position'} aria-pressed={!!t.fixed} onClick={() => updateTables([t.id], { fixed: !t.fixed })}>
        <Icon name={t.fixed ? 'lock' : 'unlock'} size="sm" />
      </button>
      <button className="icon-btn sm" title="Delete (Del)" disabled={t.fixed} onClick={deleteSelection}>
        <Icon name="trash" size="sm" />
      </button>
    </div>
  );
}

/** "Select several guests": taps on seated guests add or remove them, so a group can be dragged together (and works on touch). */
function PickToggle() {
  const on = usePick((s) => s.on);
  return (
    <button
      className="icon-btn"
      aria-pressed={on}
      title={on ? 'Done selecting guests' : 'Select several guests, then drag one to move them all'}
      aria-label="Select several guests"
      onClick={() => {
        setPickMode(!on);
        if (!on) toast('Tap guests to add them, then drag any one of them. The others keep their places beside it.');
      }}
    >
      <Icon name="lasso" />
    </button>
  );
}

/** One button for the whole floor plan: lock everything in place, or unlock it all for rearranging. */
function LayoutLock() {
  const total = useStore((s) => s.project.tables.length + s.project.elements.length);
  const n = useStore((s) => s.project.tables.filter((t) => t.fixed).length + s.project.elements.filter((e) => e.fixed).length);
  const all = total > 0 && n === total,
    some = n > 0;
  const label = all ? 'Floor plan locked. Click to unlock everything' : some ? 'Some items are locked. Click to lock everything' : 'Lock every table and room item in place';
  return (
    <button
      className={`icon-btn ${all ? 'is-locked' : ''}`}
      aria-pressed={all}
      title={label}
      aria-label={all ? 'Unlock floor plan' : 'Lock floor plan'}
      onClick={() => {
        setFixed(!all);
        toast(all ? 'Floor plan unlocked: tables and room items can move.' : 'Floor plan locked. Select an item and use its lock button to unlock just that one.', true);
      }}
    >
      <Icon name={all ? 'lock' : 'unlock'} />
    </button>
  );
}

function Palette({ fitView, zoom, scale }: { fitView: () => void; zoom: (f: number) => void; scale: number }) {
  const tool = useStore((s) => s.tool);
  const add = (p: TablePreset) => {
    const cam = getState().camera;
    const el = document.querySelector('.plan-stage') as HTMLElement | null;
    const w = el?.clientWidth ?? 800,
      h = el?.clientHeight ?? 600;
    const c = { x: Math.round(cam.x + w / 2 / cam.scale), y: Math.round(cam.y + h / 2 / cam.scale) };
    const t = addTable(p, c);
    setSelection({ type: 'table', ids: [t.id] });
    setTool('select');
  };
  const center = () => {
    const cam = getState().camera;
    const el = document.querySelector('.plan-stage') as HTMLElement | null;
    return { x: Math.round(cam.x + (el?.clientWidth ?? 800) / 2 / cam.scale), y: Math.round(cam.y + (el?.clientHeight ?? 600) / 2 / cam.scale) };
  };
  const tb = (name: typeof tool, icon: string, label: string, key: string) => (
    <button className="icon-btn" aria-pressed={tool === name} title={`${label} (${key})`} aria-label={label} onClick={() => setTool(name)}>
      <Icon name={icon} />
    </button>
  );
  return (
    <>
      <div className="palette tools" onPointerDown={(e) => e.stopPropagation()}>
        {tb('select', 'pointer', 'Select & move', 'V')}
        {tb('pan', 'hand', 'Pan', 'H')}
        <PickToggle />
        <LayoutLock />
        <span className="sep" />
        <Menu label="Add table" className="btn ghost sm" trigger={<><Icon name="round" size="sm" /> Table</>}>
          {(close) => (
            <>
              <div className="menu-label">Add one table</div>
              {TABLE_PRESETS.map((p) => (
                <MenuItem key={p.key} icon={p.shape} onClick={() => (add(p), close())}>
                  {p.name}
                </MenuItem>
              ))}
              <div className="menu-sep" />
              <AddManyForm close={close} center={center} />
            </>
          )}
        </Menu>
        <Menu label="Add area" className="btn ghost sm" trigger={<><Icon name="area" size="sm" /> Area</>}>
          {(close) => (
            <>
              <div className="menu-label">Areas & stations</div>
              {ZONE_PRESETS.map((z) => (
                <MenuItem
                  key={z.zone}
                  onClick={() => {
                    const c = center();
                    const el = addElement({ id: uid(), kind: 'zone', zone: z.zone, label: z.label, x: c.x, y: c.y, w: z.w, h: z.h, rotation: 0 });
                    setSelection({ type: 'element', ids: [el.id] });
                    close();
                  }}
                >
                  {z.label}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <PlansMenu />
        <span className="sep" />
        {tb('wall', 'wall', 'Draw walls', 'W')}
        {tb('column', 'column', 'Place column', 'C')}
        {tb('door', 'door', 'Place door', 'D')}
        {tb('window', 'window', 'Place window', '')}
      </div>
      <TapHint />
      <div className="palette zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Zoom out (−)" onClick={() => zoom(1 / 1.25)}>
          <Icon name="zoomOut" />
        </button>
        <button className="zoom-label" title="Fit to room (0)" onClick={fitView}>
          {Math.round((scale / 12) * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in (+)" onClick={() => zoom(1.25)}>
          <Icon name="zoomIn" />
        </button>
        <button className="icon-btn" title="Fit to room (0)" onClick={fitView}>
          <Icon name="fit" />
        </button>
      </div>
    </>
  );
}

function PlansMenu() {
  const refsRaw = useStore((s) => s.project.refs);
  const refs = refsRaw ?? [];
  const selection = useStore((s) => s.selection);
  const [busy, setBusy] = useState('');
  return (
    <Menu label="Venue floor plans" className="btn ghost sm" trigger={<><Icon name="image" size="sm" /> Plans{refs.length ? ` · ${refs.length}` : ''}</>}>
      {(close) => (
        <>
          <div className="menu-label">Venue floor plans</div>
          {refs.map((r) => (
            <div key={r.id} className="menu-item" style={{ gap: 6 }}>
              <button className="icon-btn sm" aria-pressed={r.visible} title={r.visible ? 'Hide' : 'Show'} onClick={() => updateRef(r.id, { visible: !r.visible })}>
                <Icon name="eye" size="sm" />
              </button>
              <button
                className="btn ghost sm"
                style={{ flex: 1, justifyContent: 'flex-start', fontWeight: selection?.type === 'ref' && selection.ids[0] === r.id ? 600 : 400 }}
                onClick={() => {
                  if (!r.visible) updateRef(r.id, { visible: true });
                  setSelection({ type: 'ref', ids: [r.id] });
                  close();
                }}
              >
                {r.name}
              </button>
              <input type="range" min={0.05} max={1} step={0.05} value={r.opacity} style={{ width: 70 }} onChange={(e) => updateRef(r.id, { opacity: +e.target.value }, false)} aria-label={`${r.name} opacity`} />
            </div>
          ))}
          {refs.length > 0 && <div className="menu-sep" />}
          <label className="menu-item" style={{ cursor: 'pointer' }}>
            {busy ? <span className="spinner" /> : <Icon name="upload" size="sm" />}
            <span>{busy || 'Add a floor plan (image or PDF)…'}</span>
            <input
              type="file"
              accept="image/*,.pdf,application/pdf"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  await addReferenceFile(f, setBusy);
                  close();
                } catch (err) {
                  toast((err as Error).message || "Couldn't add that file");
                } finally {
                  setBusy('');
                }
              }}
            />
          </label>
        </>
      )}
    </Menu>
  );
}

function AddManyForm({ close, center }: { close: () => void; center: () => Pt }) {
  const [preset, setPreset] = useState('r60');
  const [count, setCount] = useState(10);
  const [perRow, setPerRow] = useState(5);
  return (
    <div style={{ padding: '6px 10px 8px', display: 'grid', gap: 8 }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="menu-label" style={{ padding: 0 }}>
        Add a block of tables
      </div>
      <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Table type">
        {TABLE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="grid2">
        <label className="field">
          <span>Tables</span>
          <NumField value={count} onChange={setCount} step={1} min={1} max={60} integer />
        </label>
        <label className="field">
          <span>Per row</span>
          <NumField value={perRow} onChange={setPerRow} step={1} min={1} max={20} integer />
        </label>
      </div>
      <button
        className="btn primary sm"
        onClick={() => {
          const p = TABLE_PRESETS.find((x) => x.key === preset)!;
          const c = center();
          addTableGrid(p, count, perRow, { x: c.x - ((perRow - 1) * (p.w + 8)) / 2, y: c.y - 6 });
          close();
        }}
      >
        Add {count} tables
      </button>
    </div>
  );
}

function Legend({ project, colorOf }: { project: Project; colorOf: (g: Guest) => string }) {
  const s = project.settings;
  if (!project.tables.length) return null;
  const items: { label: string; color: string }[] = [];
  if (s.colorBy === 'side' || !['side', 'meal', 'group'].includes(s.colorBy)) {
    items.push({ label: s.partner1, color: 'var(--p1)' }, { label: s.partner2, color: 'var(--p2)' }, { label: 'Both', color: 'var(--both)' });
  } else {
    const seen = new Map<string, string>();
    for (const g of project.guests) {
      const key = s.colorBy === 'meal' ? g.meal || 'No meal yet' : groupTags(g)[0] || 'No group';
      if (!seen.has(key)) seen.set(key, colorOf(g));
    }
    for (const [label, color] of [...seen].slice(0, 8)) items.push({ label, color });
  }
  return (
    <div className="palette legend" onPointerDown={(e) => e.stopPropagation()}>
      <select
        className="input"
        style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }}
        value={['side', 'meal', 'group'].includes(s.colorBy) ? s.colorBy : 'side'}
        onChange={(e) => update((d) => void (d.settings.colorBy = e.target.value as Project['settings']['colorBy']))}
        aria-label="Colour seats by"
      >
        <option value="side">Colour by side</option>
        <option value="meal">Colour by meal</option>
        <option value="group">Colour by group</option>
      </select>
      {items.map((i) => (
        <span key={i.label} className="row" style={{ gap: 5 }}>
          <span className="dot" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function EmptyState({ fit }: { fit: () => void }) {
  const [w, setW] = useState(80);
  const [h, setH] = useState(60);
  const units = useStore((s) => s.project.settings);
  return (
    <div className="empty">
      <div className="empty-card">
        <h2>Start with the room</h2>
        <p>Set the reception room's size. You can drag walls, add columns, doors and areas, and resize everything later.</p>
        <div className="grid2">
          <label className="field">
            <span>Width</span>
            <NumField value={w} onChange={setW} step={1} min={10} max={400} settings={units} />
          </label>
          <label className="field">
            <span>Length</span>
            <NumField value={h} onChange={setH} step={1} min={10} max={400} settings={units} />
          </label>
        </div>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => {
              makeRectRoom(w, h);
              fit();
            }}
          >
            Create room
          </button>
          <button className="btn" onClick={() => window.dispatchEvent(new CustomEvent('app:open-layout'))}>
            <Icon name="layout" size="sm" /> Open a layout file
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- helpers ----------
function snapTableCenter(p: Project, q: Pt, reach: number): Pt | null {
  let best: Pt | null = null,
    bd = reach;
  for (const t of p.tables) {
    const d = Math.hypot(t.x - q.x, t.y - q.y);
    if (d < bd) {
      bd = d;
      best = { x: t.x, y: t.y };
    }
  }
  return best;
}
function constrain(a: Pt, q: Pt): Pt {
  const dx = q.x - a.x,
    dy = q.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: +(a.x + Math.cos(ang) * len).toFixed(2), y: +(a.y + Math.sin(ang) * len).toFixed(2) };
}

function snapEndpoint(p: Project, q: Pt, reach: number, skip?: Id): Pt | null {
  let best: Pt | null = null,
    bd = reach;
  for (const e of p.elements) {
    if (e.kind !== 'wall' || e.id === skip) continue;
    for (const c of [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y2 },
    ]) {
      const d = Math.hypot(c.x - q.x, c.y - q.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  }
  return best;
}

export function seatColorFn(p: Project) {
  const s = p.settings;
  const keys = new Map<string, number>();
  const keyOf = (g: Guest) => (s.colorBy === 'meal' ? g.meal || '' : groupTags(g)[0] || '');
  if (s.colorBy === 'group') allTags(p).forEach((t, i) => keys.set(t.label.toLowerCase(), i));
  for (const g of p.guests) {
    const k = keyOf(g);
    if (k && !keys.has(k)) keys.set(k, keys.size);
  }
  return (g: Guest) => {
    if (s.colorBy === 'side') return g.side === 'partner1' ? 'var(--p1)' : g.side === 'partner2' ? 'var(--p2)' : g.side === 'both' ? 'var(--both)' : 'var(--none)';
    const k = keyOf(g);
    if (!k) return 'var(--none)';
    return s.colorBy === 'group' ? tagColorFor(p, k, keys.get(k)!) : hueColor(keys.get(k)!);
  };
}

export { isCircular };

/** While guests are selected: "Tap an empty seat to seat Alice" (the touch-friendly way to seat someone). */
function TapHint() {
  const sel = useStore((s) => s.selection);
  const guests = useStore((s) => s.project.guests);
  const dragging = useDrag((s) => s.active);
  if (dragging || sel?.type !== 'guest' || !sel.ids.length) return null;
  const who = sel.ids.length === 1 ? guests.find((g) => g.id === sel.ids[0])?.name : `${sel.ids.length} guests`;
  return (
    <div className="tap-hint" onPointerDown={(e) => e.stopPropagation()}>
      <span>
        Tap an empty seat to seat <b>{who}</b>
      </span>
      <button className="icon-btn sm" aria-label="Cancel" onClick={() => setSelection(null)}>
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}
