/** Reference floor plans: loading images and PDFs, storing them, and aligning them to the layout. */
import type { Id, Project, RefLayer } from './types';
import { getState, setSelection, toast, update } from './store';
import { projectBounds, type Pt } from './geometry';
import { uid } from './util';

interface AssetsNs {
  upload(b: Blob, o?: { type?: string; name?: string }): Promise<{ id: string; url: string }>;
}
let assetsP: Promise<AssetsNs | null> | null = null;
const getAssets = () => (assetsP ??= window.claude ? (window.claude.use('assets') as Promise<AssetsNs | null>).catch(() => null) : Promise.resolve(null));

interface PdfJs {
  getDocument(o: { data: ArrayBuffer }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> } }> }> };
}
let pdfjsP: Promise<PdfJs> | null = null;
/** Bundled pdf.js, loaded on first use. Its worker code runs on the main thread so the page needs no extra files. */
function loadPdfJs(): Promise<PdfJs> {
  return (pdfjsP ??= (async () => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker;
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return lib as unknown as PdfJs;
  })());
}

const canvasBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));

/** Render up to `max` PDF pages as PNG images, longest side about 2400px. */
async function pdfPages(file: File, max = 8): Promise<{ blob: Blob; w: number; h: number; page: number }[]> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, max); n++) {
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const scale = 2400 / Math.max(v1.width, v1.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push({ blob: await canvasBlob(c), w: c.width, h: c.height, page: n });
  }
  return out;
}

async function imageInfo(file: Blob): Promise<{ blob: Blob; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("That image couldn't be opened"));
      img.src = url;
    });
    let w = img.naturalWidth,
      h = img.naturalHeight;
    // keep very large photos manageable
    if (Math.max(w, h) > 3200 || file.size > 6e6) {
      const k = 3200 / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.round(w * Math.min(1, k));
      c.height = Math.round(h * Math.min(1, k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      w = c.width;
      h = c.height;
      return { blob: await canvasBlob(c), w, h };
    }
    return { blob: file, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function store(blob: Blob, name: string): Promise<string> {
  const assets = await getAssets();
  if (assets) {
    const r = await assets.upload(blob, { type: blob.type || 'image/png', name });
    return '/_blob/' + r.id;
  }
  return await new Promise<string>((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.readAsDataURL(blob);
  });
}

/** Add a floor plan file (image or PDF) as reference layers, initially fitted over the room. */
export async function addReferenceFile(file: File, onProgress?: (s: string) => void): Promise<RefLayer[]> {
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  const base = file.name.replace(/\.[^.]+$/, '');
  onProgress?.(isPdf ? 'Reading the PDF…' : 'Reading the image…');
  const pages = isPdf ? await pdfPages(file) : [{ ...(await imageInfo(file)), page: 1 }];
  const p = getState().project;
  const b = projectBounds(p);
  const hasRoom = p.elements.length || p.tables.length;
  const made: RefLayer[] = [];
  for (const pg of pages) {
    onProgress?.(pages.length > 1 ? `Saving page ${pg.page} of ${pages.length}…` : 'Saving…');
    const src = await store(pg.blob, `${base}-p${pg.page}.png`);
    const widthFt = hasRoom ? Math.max(20, b.x1 - b.x0) : 80;
    const scale = widthFt / pg.w;
    made.push({
      id: uid(),
      name: pages.length > 1 ? `${base} · page ${pg.page}` : base,
      src,
      imgW: pg.w,
      imgH: pg.h,
      x: hasRoom ? b.x0 : 0,
      y: hasRoom ? (b.y0 + b.y1) / 2 - (pg.h * scale) / 2 : 0,
      scale,
      rotation: 0,
      opacity: 0.55,
      visible: made.length === 0,
      locked: false,
    });
  }
  update((d) => {
    d.refs = [...(d.refs ?? []), ...made];
  });
  if (made[0]) setSelection({ type: 'ref', ids: [made[0].id] });
  toast(`Added ${made.length} floor plan${made.length > 1 ? ' pages' : ''}. Align it with "Match 2 points".`, true);
  return made;
}

// ---------- transforms ----------
const rad = (d: number) => (d * Math.PI) / 180;
/** image pixel → world feet */
export function refToWorld(r: RefLayer, p: Pt): Pt {
  const c = Math.cos(rad(r.rotation)),
    s = Math.sin(rad(r.rotation));
  return { x: r.x + r.scale * (p.x * c - p.y * s), y: r.y + r.scale * (p.x * s + p.y * c) };
}
/** world feet → image pixel */
export function worldToRef(r: RefLayer, p: Pt): Pt {
  const c = Math.cos(rad(-r.rotation)),
    s = Math.sin(rad(-r.rotation));
  const dx = (p.x - r.x) / r.scale,
    dy = (p.y - r.y) / r.scale;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function updateRef(id: Id, patch: Partial<RefLayer>, history = true) {
  update(
    (d) => {
      const r = d.refs?.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
    { history },
  );
}
export function deleteRef(id: Id) {
  update((d) => {
    d.refs = (d.refs ?? []).filter((x) => x.id !== id);
  });
  setSelection(null);
}

/**
 * Line a plan up from two point pairs: image points a,b (px) should land on world points A,B (ft).
 * Solves position, scale and rotation together.
 */
export function alignTwoPoints(a: Pt, b: Pt, A: Pt, B: Pt): Partial<RefLayer> | null {
  const li = Math.hypot(b.x - a.x, b.y - a.y),
    lw = Math.hypot(B.x - A.x, B.y - A.y);
  if (li < 2 || lw < 0.1) return null;
  const scale = lw / li;
  const rot = Math.atan2(B.y - A.y, B.x - A.x) - Math.atan2(b.y - a.y, b.x - a.x);
  const c = Math.cos(rot),
    s = Math.sin(rot);
  return { scale, rotation: ((rot * 180) / Math.PI + 360) % 360, x: A.x - scale * (a.x * c - a.y * s), y: A.y - scale * (a.x * s + a.y * c) };
}

/** Rescale so the distance between two world points measures `realFt`, keeping the first point fixed. */
export function scaleFromLength(r: RefLayer, P1: Pt, P2: Pt, realFt: number): Partial<RefLayer> | null {
  const cur = Math.hypot(P2.x - P1.x, P2.y - P1.y);
  if (cur < 0.01 || realFt <= 0) return null;
  const k = realFt / cur;
  return { scale: r.scale * k, x: P1.x + (r.x - P1.x) * k, y: P1.y + (r.y - P1.y) * k };
}

export function refById(p: Project, id: Id) {
  return p.refs?.find((r) => r.id === id);
}
