/**
 * Telling trackpad gestures from a mouse wheel.
 *  - Pinch on a trackpad arrives as a wheel event with ctrlKey set (Chrome, Edge, Firefox) → zoom.
 *  - Two-finger swipe arrives as small, often fractional or sideways wheel deltas → pan.
 *  - A mouse wheel sends big notched steps (or line-based deltas) straight up/down → zoom.
 * Once a swipe is recognised the rest of that gesture stays a swipe, so a fast flick doesn't
 * suddenly turn into zooming.
 */
let lastPanAt = 0;

export type WheelIntent = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

export function wheelIntent(e: WheelEvent): WheelIntent {
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * px,
    dy = e.deltaY * px;
  // trackpad pinch (and Ctrl/Cmd + wheel): zoom, smoothly
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-dy * 0.01) };
  const now = performance.now();
  const swipe =
    e.deltaMode === 0 && (now - lastPanAt < 250 || e.deltaX !== 0 || Math.abs(e.deltaY) < 50 || !Number.isInteger(e.deltaY));
  if (swipe || e.shiftKey) {
    lastPanAt = now;
    return { kind: 'pan', dx: e.shiftKey && !dx ? dy : dx, dy: e.shiftKey && !dx ? 0 : dy };
  }
  return { kind: 'zoom', factor: Math.exp(-dy * 0.0015) };
}

/**
 * Safari reports trackpad pinches as gesture events (scale relative to the gesture's start)
 * instead of ctrl + wheel. Calls onZoom with the step factor and the pointer position.
 */
export function onSafariPinch(el: Element, onZoom: (factor: number, clientX: number, clientY: number) => void) {
  let last = 1;
  type GE = Event & { scale: number; clientX: number; clientY: number };
  const start = (e: Event) => {
    e.preventDefault();
    last = 1;
  };
  const change = (e: Event) => {
    e.preventDefault();
    const g = e as GE;
    onZoom(g.scale / last, g.clientX, g.clientY);
    last = g.scale;
  };
  el.addEventListener('gesturestart', start);
  el.addEventListener('gesturechange', change);
  el.addEventListener('gestureend', start);
  return () => {
    el.removeEventListener('gesturestart', start);
    el.removeEventListener('gesturechange', change);
    el.removeEventListener('gestureend', start);
  };
}
