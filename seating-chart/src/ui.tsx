import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { fromFt, toFt } from './util';
import type { Settings } from './types';

// ---------- icons (hand-drawn 24px strokes) ----------
const P: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  filter: <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  pointer: <path d="m5 3 14 7-6 2-2 6z" />,
  hand: <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.4 15a1.6 1.6 0 0 1 2.4-2.1L8 15" />,
  wall: <path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6" />,
  column: <><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M7 7l10 10M17 7 7 17" /></>,
  door: <path d="M4 20h16M6 20V8a8 8 0 0 1 8 8" />,
  window: <path d="M3 10h18M3 14h18M3 10v4M21 10v4" />,
  round: <><circle cx="12" cy="12" r="5" /><circle cx="12" cy="3.5" r="1.4" /><circle cx="12" cy="20.5" r="1.4" /><circle cx="3.5" cy="12" r="1.4" /><circle cx="20.5" cy="12" r="1.4" /></>,
  rect: <><rect x="4" y="9" width="16" height="6" rx="1" /><circle cx="8" cy="5.5" r="1.3" /><circle cx="16" cy="5.5" r="1.3" /><circle cx="8" cy="18.5" r="1.3" /><circle cx="16" cy="18.5" r="1.3" /></>,
  square: <><rect x="7" y="7" width="10" height="10" rx="1" /><circle cx="12" cy="3.5" r="1.3" /><circle cx="12" cy="20.5" r="1.3" /><circle cx="3.5" cy="12" r="1.3" /><circle cx="20.5" cy="12" r="1.3" /></>,
  oval: <><ellipse cx="12" cy="12" rx="8" ry="4.5" /><circle cx="12" cy="4.5" r="1.3" /><circle cx="12" cy="19.5" r="1.3" /></>,
  head: <><rect x="3" y="11" width="18" height="5" rx="1" /><circle cx="7" cy="7.5" r="1.3" /><circle cx="12" cy="7.5" r="1.3" /><circle cx="17" cy="7.5" r="1.3" /></>,
  area: <><rect x="4" y="5" width="16" height="14" rx="2" strokeDasharray="3 2.5" /><path d="M9 12h6" /></>,
  zoomIn: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5" /></>,
  zoomOut: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8.5 11h5" /></>,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
  pin: <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.5a5 5 0 0 1 5.5 5" /></>,
  graph: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="M8.3 7l7.3.7M7 8.3l1.4 7.3M16.5 10l-5.7 6.3" /></>,
  plan: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2.5" /><rect x="13" y="13" width="5" height="4" rx=".5" /></>,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  flower: <><circle cx="12" cy="12" r="2.5" /><path d="M12 9.5C10 6 10.5 3 12 3s2 3 0 6.5zM14.5 12C18 10 21 10.5 21 12s-3 2-6.5 0zM12 14.5c2 3.5 1.5 6.5 0 6.5s-2-3 0-6.5zM9.5 12C6 14 3 13.5 3 12s3-2 6.5 0z" /></>,
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="2.6" />,
  alert: <path d="M12 3 2 20h20zM12 10v4M12 17h.01" />,
  check: <path d="m5 12 5 5L20 7" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  lasso: <path d="M7 18c-2-1-4-3-4-6 0-4 4-7 9-7s9 3 9 7-4 7-9 7c-1 0-2 0-3-.3M7 18a2 2 0 1 0 2 2c0-1-1-1.5-2-2zM9 20c0 1-.5 2-1.5 2.5" />,
  eraser: <path d="m16 3 5 5-11 11H5l-2-2zM9 10l5 5M10 21h11" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  wand: <path d="m15 4 5 5L8 21l-5-5zM12 7l5 5M5 3v3M3.5 4.5h3M19 15v3M17.5 16.5h3" />,
  layout: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  file: <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
};

export function Icon({ name, size, className = '' }: { name: keyof typeof P | string; size?: 'sm'; className?: string }) {
  return (
    <svg className={`icon ${size ?? ''} ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        return <circle key={i} cx={16 + 12.5 * Math.cos(a)} cy={16 + 12.5 * Math.sin(a)} r="2.3" fill="currentColor" opacity={i % 2 ? 0.45 : 1} />;
      })}
    </svg>
  );
}

// ---------- Menu built on the native popover API ----------
export function Menu({
  trigger,
  children,
  label,
  className = 'btn',
  align = 'start',
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  className?: string;
  align?: 'start' | 'end';
}) {
  const id = useId().replace(/:/g, '');
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    const place = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open' || !btn.current) return;
      const r = btn.current.getBoundingClientRect();
      const w = Math.max(220, el.offsetWidth);
      let left = align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      let top = r.bottom + 6;
      const h = el.offsetHeight || 300;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    el.addEventListener('toggle', place);
    el.addEventListener('beforetoggle', place);
    return () => {
      el.removeEventListener('toggle', place);
      el.removeEventListener('beforetoggle', place);
    };
  }, [align]);
  const close = () => pop.current?.hidePopover();
  return (
    <>
      <button ref={btn} className={className} popoverTarget={id} aria-label={label} title={label}>
        {trigger}
      </button>
      <div ref={pop} id={id} popover="auto" className="menu" role="menu">
        {children(close)}
      </div>
    </>
  );
}

export function MenuItem({ icon, children, onClick, kbd, danger }: { icon?: string; children: ReactNode; onClick: () => void; kbd?: string; danger?: boolean }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} role="menuitem" onClick={onClick}>
      {icon && <Icon name={icon} size="sm" />}
      <span>{children}</span>
      {kbd && <span className="k">{kbd}</span>}
    </button>
  );
}

// ---------- Dialog on <dialog> ----------
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dlg ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {open && (
        <>
          <div className="dlg-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
          <div className="dlg-body">{children}</div>
          {footer && <div className="dlg-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---------- in-page confirm (window.confirm is blocked inside claude.ai) ----------
interface ConfirmReq {
  text: string;
  detail?: string;
  ok: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
export const useConfirm = create<{ req: ConfirmReq | null }>(() => ({ req: null }));
export function ask(text: string, opts: { detail?: string; ok?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) => useConfirm.setState({ req: { text, detail: opts.detail, ok: opts.ok ?? 'OK', danger: opts.danger, resolve } }));
}
export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  const done = (v: boolean) => {
    req?.resolve(v);
    useConfirm.setState({ req: null });
  };
  return (
    <Dialog
      open={!!req}
      onClose={() => done(false)}
      title={req?.text ?? ''}
      footer={
        <>
          <button className="btn ghost" onClick={() => done(false)}>
            Cancel
          </button>
          <button className={`btn ${req?.danger ? 'bloom' : 'primary'}`} onClick={() => done(true)} autoFocus>
            {req?.ok}
          </button>
        </>
      }
    >
      {req?.detail && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{req.detail}</p>}
    </Dialog>
  );
}

// ---------- numeric field with unit conversion and live updates ----------
export function NumField({
  value,
  onChange,
  step = 0.5,
  min = 0,
  max = 999,
  unit,
  settings,
  id,
  integer,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  /** When given, value is in feet and is shown in the project's units. */
  settings?: Pick<Settings, 'units'>;
  id?: string;
  integer?: boolean;
}) {
  const shown = settings ? fromFt(value, settings) : value;
  const fmt = (v: number) => (integer ? String(Math.round(v)) : String(+v.toFixed(2)));
  const [text, setText] = useState(fmt(shown));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(shown));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, focused]);
  const st = settings?.units === 'm' && !integer ? step / 3 : step;
  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    let v = settings ? toFt(raw, settings) : raw;
    v = Math.max(min, Math.min(max, integer ? Math.round(v) : v));
    onChange(v);
  };
  const u = unit ?? (settings ? settings.units : '');
  return (
    <div className="num-field">
      <button tabIndex={-1} onClick={() => commit(shown - st)} aria-label="Decrease">
        −
      </button>
      <input
        id={id}
        inputMode="decimal"
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(parseFloat(text));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) commit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const m = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            commit((parseFloat(text) || 0) + st * m);
          }
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {u && <span className="unit">{u}</span>}
      <button tabIndex={-1} onClick={() => commit(shown + st)} aria-label="Increase">
        +
      </button>
    </div>
  );
}

/** Text input that commits on blur/enter but shows typing immediately. */
export function TextField({ value, onCommit, placeholder, id, className = 'input', list }: { value: string; onCommit: (v: string) => void; placeholder?: string; id?: string; className?: string; list?: string }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return (
    <input
      id={id}
      className={className}
      value={t}
      list={list}
      placeholder={placeholder}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => t !== value && onCommit(t)}
      onKeyDown={(e) => {
        // stop the key here so it can't also press a button in a confirmation that the commit opens
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setT(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
