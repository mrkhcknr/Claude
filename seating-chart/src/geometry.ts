import type { Column, Opening, Project, RoomElement, Table, Wall, Zone } from './types';

export type Pt = { x: number; y: number };

/** Distance from table edge to chair centre, and chair "depth" incl. someone sitting. */
export const CHAIR_OFFSET = 1.1;
export const CHAIR_R = 0.75;
export const CHAIR_DEPTH = 1.9;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function rotate(p: Pt, deg: number): Pt {
  const r = rad(deg),
    c = Math.cos(r),
    s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export const toWorld = (t: { x: number; y: number; rotation: number }, p: Pt): Pt => {
  const r = rotate(p, t.rotation);
  return { x: r.x + t.x, y: r.y + t.y };
};

export const isCircular = (t: Table) => t.shape !== 'head';

/** How seats split across the sides of a rectangular table. */
export function rectSides(t: Table) {
  if (t.shape === 'head') return { top: t.seats, right: 0, bottom: 0, left: 0 };
  const n = t.seats;
  let endEach = 0;
  if (t.ends && n >= 3) endEach = n >= 10 && t.h >= 4 ? 2 : 1;
  if (n === 3 && t.ends) return { top: 1, right: 1, bottom: 0, left: 1 };
  const rem = n - endEach * 2;
  return { top: Math.ceil(rem / 2), right: endEach, bottom: Math.floor(rem / 2), left: endEach };
}

/** Seat positions in table-local coordinates, ordered clockwise starting top-left. */
export function seatLocal(t: Table): Pt[] {
  const n = Math.max(0, t.seats);
  const out: Pt[] = [];
  if (t.shape === 'round' || t.shape === 'oval') {
    const a = t.w / 2 + CHAIR_OFFSET;
    const b = (t.shape === 'round' ? t.w : t.h) / 2 + CHAIR_OFFSET;
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      out.push({ x: a * Math.cos(ang), y: b * Math.sin(ang) });
    }
    return out;
  }
  const { top, right, bottom, left } = rectSides(t);
  const hw = t.w / 2,
    hh = t.h / 2;
  for (let k = 0; k < top; k++) out.push({ x: -hw + ((k + 0.5) * t.w) / top, y: -hh - CHAIR_OFFSET });
  for (let k = 0; k < right; k++) out.push({ x: hw + CHAIR_OFFSET, y: -hh + ((k + 0.5) * t.h) / right });
  for (let k = 0; k < bottom; k++) out.push({ x: hw - ((k + 0.5) * t.w) / bottom, y: hh + CHAIR_OFFSET });
  for (let k = 0; k < left; k++) out.push({ x: -hw - CHAIR_OFFSET, y: hh - ((k + 0.5) * t.h) / left });
  return out;
}

export const seatWorld = (t: Table) => seatLocal(t).map((p) => toWorld(t, p));

/** Pairs of seat indices that are next to each other. */
export function neighbours(t: Table): [number, number][] {
  const n = t.seats;
  const pairs: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) pairs.push([i, i + 1]);
  if (isCircular(t) && n > 2) pairs.push([n - 1, 0]);
  return pairs;
}

// ---------- polygons for clearance checks ----------

function circlePoly(cx: number, cy: number, r: number, rx = r, k = 20): Pt[] {
  return Array.from({ length: k }, (_, i) => {
    const a = (i * 2 * Math.PI) / k;
    return { x: cx + rx * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

function rectPoly(o: { x: number; y: number; rotation: number }, x0: number, y0: number, x1: number, y1: number) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ].map((p) => toWorld(o, p));
}

/** Table + chairs footprint. */
export function tableFootprint(t: Table): Pt[] {
  const d = t.seats > 0 ? CHAIR_DEPTH : 0;
  if (t.shape === 'round') return circlePoly(t.x, t.y, t.w / 2 + d);
  if (t.shape === 'oval') {
    return circlePoly(0, 0, t.h / 2 + d, t.w / 2 + d).map((p) => toWorld(t, p));
  }
  const s = rectSides(t);
  const hw = t.w / 2,
    hh = t.h / 2;
  return rectPoly(t, -hw - (s.left ? d : 0), -hh - (s.top ? d : 0), hw + (s.right ? d : 0), hh + (s.bottom ? d : 0));
}

export function elementPoly(e: RoomElement): Pt[] | null {
  switch (e.kind) {
    case 'column':
      return e.round ? circlePoly(e.x, e.y, e.size / 2, e.size / 2, 12) : rectPoly({ ...e, rotation: 0 }, -e.size / 2, -e.size / 2, e.size / 2, e.size / 2);
    case 'wall': {
      const dx = e.x2 - e.x1,
        dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy) || 0.001;
      const nx = (-dy / len) * (e.thickness / 2),
        ny = (dx / len) * (e.thickness / 2);
      return [
        { x: e.x1 + nx, y: e.y1 + ny },
        { x: e.x2 + nx, y: e.y2 + ny },
        { x: e.x2 - nx, y: e.y2 - ny },
        { x: e.x1 - nx, y: e.y1 - ny },
      ];
    }
    case 'zone':
      return zoneBlocks(e) ? rectPoly(e, -e.w / 2, -e.h / 2, e.w / 2, e.h / 2) : null;
    default:
      return null;
  }
}

/** Zones that people can't walk through (vs. a dance floor you can cross). */
export const zoneBlocks = (z: Zone) => ['stage', 'bar', 'buffet', 'dj', 'cake', 'gifts', 'kitchen'].includes(z.zone);

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bbox(poly: Pt[]) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export function polyDist(A: Pt[], B: Pt[]) {
  if (inPoly(A[0], B) || inPoly(B[0], A)) return 0;
  let d = Infinity;
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i],
      a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j],
        b2 = B[(j + 1) % B.length];
      d = Math.min(d, segDist(a1, b1, b2), segDist(b1, a1, a2));
    }
  }
  return d;
}

export interface ClearanceIssue {
  tableId: string;
  otherId: string;
  otherKind: 'table' | 'element';
  gap: number;
}

/** Tables whose chair zone is closer than `clearance` feet to another table or obstacle. */
export function clearanceIssues(p: Project): ClearanceIssue[] {
  const clr = p.settings.clearance;
  const tp = p.tables.map((t) => ({ t, poly: tableFootprint(t) })).map((o) => ({ ...o, bb: bbox(o.poly) }));
  const ep = p.elements
    .map((e) => ({ e, poly: elementPoly(e) }))
    .filter((o): o is { e: RoomElement; poly: Pt[] } => !!o.poly)
    .map((o) => ({ ...o, bb: bbox(o.poly) }));
  const near = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>, m: number) =>
    !(a.x1 + m < b.x0 || b.x1 + m < a.x0 || a.y1 + m < b.y0 || b.y1 + m < a.y0);
  const out: ClearanceIssue[] = [];
  for (let i = 0; i < tp.length; i++) {
    for (let j = i + 1; j < tp.length; j++) {
      if (!near(tp[i].bb, tp[j].bb, clr)) continue;
      const g = polyDist(tp[i].poly, tp[j].poly);
      if (g < clr) out.push({ tableId: tp[i].t.id, otherId: tp[j].t.id, otherKind: 'table', gap: g });
    }
    for (const e of ep) {
      // walls: chairs just need to not collide; aisle along a wall is nice but optional → half clearance
      const need = e.e.kind === 'wall' ? Math.min(clr, 1.5) : clr / 2;
      if (!near(tp[i].bb, e.bb, need)) continue;
      const g = polyDist(tp[i].poly, e.poly);
      if (g < need) out.push({ tableId: tp[i].t.id, otherId: e.e.id, otherKind: 'element', gap: g });
    }
  }
  return out;
}

export function nearestDoorDist(p: Project, pt: Pt) {
  let d = Infinity;
  for (const e of p.elements) if (e.kind === 'door') d = Math.min(d, Math.hypot(e.x - pt.x, e.y - pt.y));
  return d;
}

/** Bounds of everything in the room. */
export function projectBounds(p: Project) {
  const pts: Pt[] = [];
  for (const t of p.tables) pts.push(...tableFootprint(t));
  for (const e of p.elements) {
    const poly = elementPoly(e);
    if (poly) pts.push(...poly);
    else if ('x' in e) pts.push({ x: e.x, y: e.y });
    if (e.kind === 'zone') pts.push(...rectPoly(e, -e.w / 2, -e.h / 2, e.w / 2, e.h / 2));
  }
  if (!pts.length) return { x0: 0, y0: 0, x1: 60, y1: 40 };
  return bbox(pts);
}

/** Snap a door/window onto the closest wall (if any within `reach` ft). */
export function snapToWall(p: Project, pt: Pt, reach = 2.5): { x: number; y: number; rotation: number } | null {
  let best: { d: number; x: number; y: number; rotation: number } | null = null;
  for (const e of p.elements) {
    if (e.kind !== 'wall') continue;
    const w = e as Wall;
    const dx = w.x2 - w.x1,
      dy = w.y2 - w.y1;
    const l2 = dx * dx + dy * dy;
    if (!l2) continue;
    const t = Math.max(0, Math.min(1, ((pt.x - w.x1) * dx + (pt.y - w.y1) * dy) / l2));
    const x = w.x1 + t * dx,
      y = w.y1 + t * dy;
    const d = Math.hypot(pt.x - x, pt.y - y);
    if (d < reach && (!best || d < best.d)) best = { d, x, y, rotation: (Math.atan2(dy, dx) * 180) / Math.PI };
  }
  return best;
}

export const isPointish = (e: RoomElement): e is Column | Opening | Zone => e.kind !== 'wall';
