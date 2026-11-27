import { create } from 'zustand';
import type { Id } from './types';
import { getState, tableName, seatAtTable, seatGuest, toast, unseat, updateGuests } from './store';
import { applyBlockMove, planBlockMove } from './seatMove';

/** Where a guest drag can land. Read from data-* attributes on the element under the pointer. */
export type DropTarget =
  | { kind: 'seat'; tableId: Id; seat: number }
  | { kind: 'table'; tableId: Id }
  | { kind: 'unseat' }
  | { kind: 'group'; group: string };

interface DragState {
  guestIds: Id[];
  /** For a group drag from a chair: the guest under the pointer (the rest keep their offset from them) */
  anchor?: Id;
  label: string;
  x: number;
  y: number;
  over: DropTarget | null;
  active: boolean;
}

export const useDrag = create<DragState>(() => ({ guestIds: [], label: '', x: 0, y: 0, over: null, active: false }));

function readTarget(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as Element | null;
  const t = el?.closest('[data-drop]') as (HTMLElement | SVGElement) | null;
  if (!t) return null;
  const d = t.dataset;
  switch (d.drop) {
    case 'seat':
      return { kind: 'seat', tableId: d.table!, seat: +d.seat! };
    case 'table': {
      // over the table itself: aim for the empty chair nearest the pointer (the chair lights up)
      const seat = nearestSeat(d.table!, x, y);
      return seat === null ? { kind: 'table', tableId: d.table! } : { kind: 'seat', tableId: d.table!, seat };
    }
    case 'unseat':
      return { kind: 'unseat' };
    case 'group':
      return { kind: 'group', group: d.group! };
  }
  return null;
}

/** Index of the empty chair at a table closest to a screen point (any chair if all are taken). */
function nearestSeat(tableId: Id, x: number, y: number): number | null {
  const els = Array.from(document.querySelectorAll<SVGGElement>(`[data-drop="seat"][data-table="${CSS.escape(tableId)}"]`));
  if (!els.length) return null;
  const seats = getState().project.seating[tableId] ?? [];
  const dist = (el: SVGGElement) => {
    const r = (el.querySelector('circle.chair') ?? el).getBoundingClientRect();
    return Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y);
  };
  const pick = (list: SVGGElement[]) => list.reduce<SVGGElement | null>((best, el) => (!best || dist(el) < dist(best) ? el : best), null);
  const dragging = new Set(useDrag.getState().guestIds);
  const empty = els.filter((el) => {
    const g = seats[+el.dataset.seat!];
    return !g || dragging.has(g);
  });
  const el = pick(empty.length ? empty : els);
  return el ? +el.dataset.seat! : null;
}

export const sameTarget = (a: DropTarget | null, b: DropTarget | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Start a potential guest drag from a pointerdown. Calls onClick instead if the pointer
 * doesn't move past a small threshold. Works for mouse, pen and touch.
 */
let cancelActive: (() => void) | null = null;
/** Abandon a guest drag in progress (e.g. a second finger turned it into a pinch). */
export function cancelGuestDrag() {
  cancelActive?.();
}

export function startGuestDrag(e: React.PointerEvent | PointerEvent, guestIds: Id[], label: string, onClick?: (ev: PointerEvent) => void, anchor?: Id) {
  if (e.button !== 0) return;
  const sx = e.clientX,
    sy = e.clientY;
  let dragging = false;
  const pid = e.pointerId;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pid) return;
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) {
      dragging = true;
      document.body.classList.add('is-dragging');
      useDrag.setState({ guestIds, label, active: true, anchor });
    }
    if (dragging) {
      ev.preventDefault();
      const over = readTarget(ev.clientX, ev.clientY);
      const cur = useDrag.getState();
      useDrag.setState({ x: ev.clientX, y: ev.clientY, over: sameTarget(cur.over, over) ? cur.over : over });
    }
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('is-dragging');
    if (!dragging) {
      onClick?.(ev);
      return;
    }
    const target = readTarget(ev.clientX, ev.clientY);
    useDrag.setState({ active: false, over: null, guestIds: [], anchor: undefined });
    if (target && ev.type === 'pointerup') drop(guestIds, target, anchor);
  };
  cancelActive = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('is-dragging');
    useDrag.setState({ active: false, over: null, guestIds: [] });
    cancelActive = null;
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export function drop(guestIds: Id[], t: DropTarget, anchor?: Id) {
  const { project } = getState();
  // a group picked up from its chairs moves as a block: same shape, people in the way slide into the gap
  if (anchor && guestIds.length > 1 && t.kind === 'seat') {
    const plan = planBlockMove(project, guestIds, anchor, { t: t.tableId, s: t.seat });
    if (plan) {
      applyBlockMove(plan);
      const n = plan.displaced.size;
      toast(`Moved ${guestIds.length} guests${n ? `; ${n} ${n === 1 ? 'guest' : 'guests'} slid over to make room` : ''}`, true);
      return;
    }
  }
  const names = guestIds.map((id) => project.guests.find((g) => g.id === id)?.name ?? '').filter(Boolean);
  const who = names.length === 1 ? names[0] : `${names.length} guests`;
  if (t.kind === 'unseat') {
    unseat(guestIds);
    return;
  }
  if (t.kind === 'group') {
    for (const id of guestIds) {
      const g = project.guests.find((x) => x.id === id);
      if (!g) continue;
      const tags = g.group.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      if (!tags.some((x) => x.toLowerCase() === t.group.toLowerCase())) updateGuests([id], { group: [...tags, t.group].join(', ') });
    }
    toast(`Added ${who} to ${t.group}`, true);
    return;
  }
  const table = project.tables.find((x) => x.id === t.tableId);
  if (!table) return;
  if (t.kind === 'seat' && guestIds.length === 1) {
    seatGuest(guestIds[0], t.tableId, t.seat);
    return;
  }
  const n = seatAtTable(guestIds, t.tableId, t.kind === 'seat' ? t.seat : undefined);
  if (n < guestIds.length) toast(n ? `Only ${n} of ${guestIds.length} fit at ${tableName(table)}` : `${tableName(table)} is full`);
  else if (guestIds.length > 1) toast(`Seated ${who} at ${tableName(table)}`, true);
}
