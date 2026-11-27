import { useMemo, useState } from 'react';
import type { Bond, Guest, Id, Project, Relation, RoomElement, SeatRule, Rsvp, Side, Table, TableShape, ZoneKind } from './types';
import {
  alignTables,
  clearTables,
  deleteSelection,
  duplicateSelection,
  focusGuest,
  FLOWERS,
  splitTableName,
  locate,
  makeParty,
  nameTablesAfterFlowers,
  addTieContext,
  relateAll,
  toast,
  renumberTables,
  scaleRoom,
  seatAtTable,
  seatGuest,
  setRelation,
  setSelection,
  setView,
  tableName,
  unseat,
  update,
  updateElements,
  updateGuests,
  updateTables,
  useStore,
  ZONE_PRESETS,
} from './store';
import { type Analysis, type Issue } from './scoring';
import { BONDS, BOND_HELP, BOND_LABEL, SEAT_LABEL, SEAT_RULES } from './relations';
import { allMeals, allTags, setFilters } from './filters';
import { useDrag } from './dnd';
import { RefInspector } from './RefInspector';
import { discLabel, dismiss, useListValue } from './discrepancies';
import { fmtLen, uid } from './util';
import { Icon, NumField, TextField } from './ui';

/** [中文, English] for every flower name, for the two name pickers. */
const FLOWER_PAIRS: [string, string][] = FLOWERS.map((f) => {
  const n = splitTableName<{ name?: string; nameZh?: string; nameEn?: string }>({ name: f });
  return [n.nameZh ?? '', n.nameEn ?? ''];
});
const FLOWER_EN = new Map(FLOWER_PAIRS.filter(([z, e]) => z && e));
const FLOWER_ZH = new Map(FLOWER_PAIRS.filter(([z, e]) => z && e).map(([z, e]) => [e, z]));

export function Inspector({ analysis, onAutoSeat, onSettings }: { analysis: Analysis; onAutoSeat: (tab?: 'rules' | 'claude') => void; onSettings: () => void }) {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  let body: React.ReactNode;
  if (selection?.type === 'table') {
    const ts = project.tables.filter((t) => selection.ids.includes(t.id));
    body = ts.length === 1 ? <TableInspector t={ts[0]} analysis={analysis} /> : ts.length ? <MultiTable tables={ts} /> : null;
  } else if (selection?.type === 'element') {
    const els = project.elements.filter((e) => selection.ids.includes(e.id));
    body = els.length === 1 ? <ElementInspector el={els[0]} /> : els.length ? <MultiElement n={els.length} /> : null;
  } else if (selection?.type === 'ref') {
    const r = project.refs?.find((x) => x.id === selection.ids[0]);
    body = r ? <RefInspector r={r} /> : null;
  } else if (selection?.type === 'guest') {
    const gs = project.guests.filter((g) => selection.ids.includes(g.id));
    body = gs.length === 1 ? <GuestInspector g={gs[0]} analysis={analysis} /> : gs.length ? <MultiGuest guests={gs} /> : null;
  }
  return (
    <aside className="panel right" aria-label="Details">
      <div className="panel-body">{body ?? <Overview analysis={analysis} onAutoSeat={onAutoSeat} onSettings={onSettings} />}</div>
    </aside>
  );
}

// ---------------- overview ----------------
function Overview({ analysis, onAutoSeat, onSettings }: { analysis: Analysis; onAutoSeat: (tab?: 'rules' | 'claude') => void; onSettings: () => void }) {
  const project = useStore((s) => s.project);
  const st = analysis.stats;
  const [level, setLevel] = useState<'all' | Issue['level']>('all');
  const issues = analysis.issues.filter((i) => level === 'all' || i.level === level);
  const pct = st.attending ? Math.round((st.seated / st.attending) * 100) : 0;
  const meals = Object.entries(st.meals).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="section">
        <h3>Overview</h3>
        <div className="stats">
          <Stat n={st.attending} l="Coming" />
          <Stat n={st.seated} l="Seated" />
          <Stat n={st.unseated} l="Unseated" onClick={() => setFilters({ seated: 'unseated' })} />
          <Stat n={st.capacity} l="Seats" />
          <Stat n={st.tables} l="Tables" />
          <Stat n={st.happiness ? st.happiness + '%' : '—'} l="Sit with a tie" />
        </div>
        <div className="meter" title={`${pct}% seated`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => onAutoSeat()} disabled={!project.tables.length || !project.guests.length}>
            <Icon name="wand" size="sm" /> Auto-seat
          </button>
          <button className="btn" onClick={() => onAutoSeat('rules')}>
            <Icon name="settings" size="sm" /> Seating rules
          </button>
          <button className="btn" onClick={() => onAutoSeat('claude')} disabled={!project.guests.length}>
            <Icon name="sparkle" size="sm" /> Ask Claude
          </button>
          <button className="btn" onClick={() => nameTablesAfterFlowers()} disabled={!project.tables.length}>
            <Icon name="flower" size="sm" /> Name tables after flowers
          </button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {st.pending ? `${st.pending} RSVPs pending · ` : ''}
          {st.declined} declined{st.children ? ` · ${st.children} children` : ''}
        </span>
      </div>
      {analysis.discrepancies.length > 0 && (
        <div className="section">
          <h3>
            Discrepancies <span className="badge bad num">{analysis.discrepancies.length}</span>
            <span className="spacer" />
            <button
              className="btn ghost sm"
              onClick={() => {
                setFilters({ flags: ['discrepancy'] });
                setView('guests');
              }}
            >
              Review
            </button>
          </h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {(['rsvp', 'meal', 'dietary', 'missing', 'unmatched'] as const)
              .map((k) => [k, analysis.discrepancies.filter((d) => d.kind === k).length] as const)
              .filter(([, n]) => n)
              .map(([k, n]) => `${n} ${discLabel[k].toLowerCase()}`)
              .join(' · ')}
          </span>
        </div>
      )}
      {meals.length > 0 && (
        <div className="section">
          <h3>
            Meals <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setView('lists')}>
              Caterer list
            </button>
          </h3>
          {meals.map(([m, n]) => (
            <button key={m} className="kv" onClick={() => setFilters({ meal: m })}>
              <span>{m}</span>
              <b className="num">{n}</b>
            </button>
          ))}
        </div>
      )}
      <div className="section">
        <h3>
          Checks <span className="badge num">{analysis.issues.length}</span>
          <span className="spacer" />
          <select className="input" style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Show checks">
            <option value="all">All</option>
            <option value="error">Problems</option>
            <option value="warn">Warnings</option>
            <option value="info">Tips</option>
          </select>
        </h3>
        {issues.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing to fix.</p>}
        {issues.slice(0, 60).map((i, k) => (
          <button
            key={k}
            className={`issue ${i.level}`}
            onClick={() => {
              if (i.guestIds?.length) {
                setSelection({ type: 'guest', ids: i.guestIds });
                focusGuest(i.guestIds[0]);
              } else if (i.tableId) setSelection({ type: 'table', ids: [i.tableId] });
            }}
          >
            {i.text}
          </button>
        ))}
        {issues.length > 60 && <span className="muted">+{issues.length - 60} more</span>}
      </div>
      <div className="section">
        <button className="btn ghost" onClick={onSettings}>
          <Icon name="settings" size="sm" /> Settings: names, units, spacing
        </button>
      </div>
    </>
  );
}

function Stat({ n, l, onClick }: { n: number | string; l: string; onClick?: () => void }) {
  return (
    <div className="stat" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <b>{n}</b>
      <span>{l}</span>
    </div>
  );
}

// ---------------- table ----------------
const SHAPES: { s: TableShape; l: string }[] = [
  { s: 'round', l: 'Round' },
  { s: 'rect', l: 'Banquet' },
  { s: 'square', l: 'Square' },
  { s: 'oval', l: 'Oval' },
  { s: 'head', l: 'One-sided' },
];

function TableInspector({ t, analysis }: { t: Table; analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const s = project.settings;
  const rep = analysis.reports.get(t.id);
  const seats = project.seating[t.id] ?? [];
  const byId = useMemo(() => new Map(project.guests.map((g) => [g.id, g])), [project.guests]);
  const drag = useDrag();
  const tags = useMemo(() => allTags(project), [project]);
  const set = (p: Partial<Table>) => updateTables([t.id], p);
  return (
    <>
      <div className="section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">{t.label || 'Table'}</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn sm" title="Duplicate" onClick={duplicateSelection}>
              <Icon name="copy" size="sm" />
            </button>
            <button className="icon-btn sm" title={t.locked ? 'Unlock' : 'Lock'} aria-pressed={t.locked} onClick={() => set({ locked: !t.locked })}>
              <Icon name={t.locked ? 'lock' : 'unlock'} size="sm" />
            </button>
            <button className="icon-btn sm" title="Delete table" onClick={deleteSelection}>
              <Icon name="trash" size="sm" />
            </button>
          </span>
        </div>
        <h2 className="insp-title">
          <TextField className="" value={tableName(t)} placeholder={t.label || 'Name this table'} onCommit={(v) => set(splitTableName({ name: v }))} list="flower-list" />
        </h2>
        <datalist id="flower-list">
          {FLOWERS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <datalist id="flower-zh">
          {FLOWER_PAIRS.filter(([zh]) => zh).map(([zh, en]) => (
            <option key={zh} value={zh} label={en} />
          ))}
        </datalist>
        <datalist id="flower-en">
          {FLOWER_PAIRS.filter(([, en]) => en).map(([zh, en]) => (
            <option key={en} value={en} label={zh} />
          ))}
        </datalist>
        <div className="grid2">
          <label className="field">
            <span>Name · 中文</span>
            <TextField value={t.nameZh ?? ''} placeholder="中文名" list="flower-zh" onCommit={(v) => set({ nameZh: v, ...(!t.nameEn?.trim() && FLOWER_EN.has(v.trim()) ? { nameEn: FLOWER_EN.get(v.trim()) } : {}) })} />
          </label>
          <label className="field">
            <span>Name · English</span>
            <TextField value={t.nameEn ?? ''} placeholder="English name" list="flower-en" onCommit={(v) => set({ nameEn: v, ...(!t.nameZh?.trim() && FLOWER_ZH.has(v.trim()) ? { nameZh: FLOWER_ZH.get(v.trim()) } : {}) })} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Number / label</span>
            <TextField value={t.label} onCommit={(v) => set({ label: v })} />
          </label>
          <label className="field">
            <span>Seats</span>
            <NumField value={t.seats} onChange={(v) => set({ seats: v })} step={1} min={0} max={40} integer />
          </label>
        </div>
      </div>
      <div className="section">
        <h3>Shape & size</h3>
        <div className="shape-pick">
          {SHAPES.map((x) => (
            <button key={x.s} aria-pressed={t.shape === x.s} title={x.l} onClick={() => set({ shape: x.s, h: x.s === 'round' || x.s === 'square' ? t.w : t.shape === 'round' || t.shape === 'square' ? Math.max(2.5, t.w / 2) : t.h })}>
              <Icon name={x.s} />
            </button>
          ))}
        </div>
        <div className="grid2">
          <label className="field">
            <span>{t.shape === 'round' ? 'Diameter' : t.shape === 'square' ? 'Side' : 'Length'}</span>
            <NumField value={t.w} onChange={(v) => set({ w: v })} min={1} max={60} settings={s} />
          </label>
          {t.shape !== 'round' && t.shape !== 'square' && (
            <label className="field">
              <span>Width</span>
              <NumField value={t.h} onChange={(v) => set({ h: v })} min={1} max={20} settings={s} />
            </label>
          )}
          <label className="field">
            <span>Rotation</span>
            <NumField value={t.rotation} onChange={(v) => set({ rotation: ((v % 360) + 360) % 360 })} step={15} min={-360} max={720} unit="°" />
          </label>
        </div>
        {(t.shape === 'rect' || t.shape === 'oval') && (
          <label className="check">
            <input type="checkbox" className="switch" checked={t.ends} onChange={(e) => set({ ends: e.target.checked })} /> Seats on the ends
          </label>
        )}
        <label className="field">
          <span>Area</span>
          <TextField value={t.area ?? ''} placeholder="e.g. Top room" onCommit={(v) => set({ area: v.trim() || undefined })} list="area-list" />
          <AreaList />
        </label>
        <label className="field">
          <span>Reserved for</span>
          <TextField value={t.reservedFor} placeholder="e.g. Kids, Family, a group name" onCommit={(v) => set({ reservedFor: v })} list="tag-list" />
          <datalist id="tag-list">
            {tags.map((x) => (
              <option key={x.label} value={x.label} />
            ))}
            <option value="Kids" />
            <option value="Wedding party" />
          </datalist>
        </label>
      </div>
      <div className="section">
        <h3>
          Guests <span className="badge num">{seats.filter(Boolean).length}/{t.seats}</span>
          <span className="spacer" />
          {rep && rep.guests.length > 0 && (
            <span className={`badge ${rep.happiness >= 80 ? 'ok' : rep.happiness >= 50 ? 'warn' : 'bad'}`} title="Share of guests with at least one tie at this table">
              {rep.happiness}% connected
            </span>
          )}
        </h3>
        <ul className="seat-list">
          {seats.map((gid, i) => {
            const g = gid ? byId.get(gid) : undefined;
            const over = drag.active && drag.over?.kind === 'seat' && drag.over.tableId === t.id && drag.over.seat === i;
            return (
              <li key={i} className={`seat-row ${g ? '' : 'empty'}`} data-drop="seat" data-table={t.id} data-seat={i} data-over={over}>
                <span className="i">{i + 1}</span>
                {g ? (
                  <button className="btn ghost sm" style={{ justifyContent: 'flex-start', padding: '2px 4px' }} onClick={() => setSelection({ type: 'guest', ids: [g.id] })}>
                    <span className={`dot side-${g.side || 'none'}`} /> {g.name}
                    {g.meal && <span className="muted">· {g.meal}</span>}
                  </button>
                ) : (
                  <span>Empty</span>
                )}
                {g && (
                  <button className="icon-btn sm" title="Unseat" onClick={() => unseat([g.id])}>
                    <Icon name="x" size="sm" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {rep && (rep.conflicts.length > 0 || rep.isolated.length > 0) && (
          <div style={{ display: 'grid', gap: 4 }}>
            {rep.conflicts.map((c, i) => (
              <div key={i} className={`issue ${c.kind === 'apart' ? 'error' : 'warn'}`}>
                {c.a.name} & {c.b.name}: {c.kind === 'apart' ? 'never same table' : 'tension'}
              </div>
            ))}
            {rep.isolated.map((g) => (
              <div key={g.id} className="issue">
                {g.name} doesn't know anyone here yet
              </div>
            ))}
          </div>
        )}
        {rep && Object.keys(rep.meals).length > 0 && (
          <div className="row" style={{ gap: 4 }}>
            {Object.entries(rep.meals).map(([m, n]) => (
              <span key={m} className="badge">
                {n}× {m}
              </span>
            ))}
          </div>
        )}
        <div className="row">
          <button className="btn sm" onClick={() => setFilters({ tableId: t.id })}>
            Filter list to this table
          </button>
          <button className="btn sm danger" onClick={() => clearTables([t.id])} disabled={!seats.some(Boolean)}>
            Clear seats
          </button>
        </div>
      </div>
    </>
  );
}

function MultiTable({ tables }: { tables: Table[] }) {
  const ids = tables.map((t) => t.id);
  const s = useStore((x) => x.project.settings);
  const first = tables[0];
  const ab = (m: Parameters<typeof alignTables>[1], icon: string, title: string) => (
    <button className="btn sm" title={title} onClick={() => alignTables(ids, m)}>
      {icon}
    </button>
  );
  return (
    <>
      <div className="section">
        <span className="label">Selection</span>
        <h2 className="insp-title">{tables.length} tables</h2>
        <span className="muted">{tables.reduce((a, t) => a + t.seats, 0)} seats in total</span>
      </div>
      <div className="section">
        <h3>Align & space</h3>
        <div className="row" style={{ gap: 4 }}>
          {ab('left', '⇤ Left', 'Align left')}
          {ab('cx', '↔ Centre', 'Align centres horizontally')}
          {ab('right', 'Right ⇥', 'Align right')}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {ab('top', '⤒ Top', 'Align top')}
          {ab('cy', '↕ Middle', 'Align middles')}
          {ab('bottom', 'Bottom ⤓', 'Align bottom')}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {ab('dh', 'Space evenly across', 'Distribute horizontally')}
          {ab('dv', 'Space evenly down', 'Distribute vertically')}
        </div>
      </div>
      <div className="section">
        <h3>Change all</h3>
        <div className="grid2">
          <label className="field">
            <span>Seats each</span>
            <NumField value={first.seats} onChange={(v) => updateTables(ids, { seats: v })} step={1} integer max={40} />
          </label>
          <label className="field">
            <span>Size</span>
            <NumField value={first.w} onChange={(v) => updateTables(ids, { w: v })} min={1} max={60} settings={s} />
          </label>
          <label className="field">
            <span>Rotation</span>
            <NumField value={first.rotation} onChange={(v) => updateTables(ids, { rotation: ((v % 360) + 360) % 360 })} step={15} min={-360} max={720} unit="°" />
          </label>
          <label className="field">
            <span>Area</span>
            <TextField value={tables.every((t) => t.area === first.area) ? first.area ?? '' : ''} placeholder={tables.every((t) => t.area === first.area) ? 'e.g. Top room' : 'Mixed'} onCommit={(v) => updateTables(ids, { area: v.trim() || undefined })} list="area-list" />
            <AreaList />
          </label>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => nameTablesAfterFlowers(ids)}>
            <Icon name="flower" size="sm" /> Name after flowers
          </button>
          <button className="btn sm" onClick={renumberTables}>
            Renumber by position
          </button>
          <button className="btn sm" onClick={() => updateTables(ids, (t) => void (t.locked = !first.locked))}>
            {first.locked ? 'Unlock' : 'Lock'} all
          </button>
        </div>
        <div className="row">
          <button className="btn sm" onClick={duplicateSelection}>
            Duplicate
          </button>
          <button className="btn sm danger" onClick={() => clearTables(ids)}>
            Clear seats
          </button>
          <button className="btn sm danger" onClick={deleteSelection}>
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------- room elements ----------------
function ElementInspector({ el }: { el: RoomElement }) {
  const s = useStore((x) => x.project.settings);
  const set = (fn: (e: RoomElement) => void) => updateElements([el.id], fn as never);
  const title = el.kind === 'zone' ? el.label : el.kind[0].toUpperCase() + el.kind.slice(1);
  return (
    <>
      <div className="section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">{el.kind === 'zone' ? 'Area' : 'Room'}</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn sm" title="Duplicate" onClick={duplicateSelection}>
              <Icon name="copy" size="sm" />
            </button>
            <button className="icon-btn sm" title="Delete" onClick={deleteSelection}>
              <Icon name="trash" size="sm" />
            </button>
          </span>
        </div>
        {el.kind === 'zone' ? (
          <h2 className="insp-title">
            <TextField className="" value={el.label} onCommit={(v) => set((e) => void ((e as typeof el).label = v))} />
          </h2>
        ) : (
          <h2 className="insp-title">{title}</h2>
        )}
      </div>
      <div className="section">
        <h3>Size & position</h3>
        {el.kind === 'wall' && <WallFields el={el} />}
        {el.kind === 'column' && (
          <>
            <div className="grid2">
              <label className="field">
                <span>Size</span>
                <NumField value={el.size} onChange={(v) => set((e) => void ((e as typeof el).size = v))} min={0.5} max={20} settings={s} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" className="switch" checked={el.round} onChange={(e) => set((x) => void ((x as typeof el).round = e.target.checked))} /> Round column
            </label>
          </>
        )}
        {(el.kind === 'door' || el.kind === 'window') && (
          <div className="grid2">
            <label className="field">
              <span>Width</span>
              <NumField value={el.w} onChange={(v) => set((e) => void ((e as typeof el).w = v))} min={1} max={40} settings={s} />
            </label>
            <label className="field">
              <span>Rotation</span>
              <NumField value={el.rotation} onChange={(v) => set((e) => void ((e as typeof el).rotation = ((v % 360) + 360) % 360))} step={15} min={-360} max={720} unit="°" />
            </label>
          </div>
        )}
        {el.kind === 'zone' && (
          <>
            <label className="field">
              <span>Type</span>
              <select className="input" value={el.zone} onChange={(e) => set((x) => void ((x as typeof el).zone = e.target.value as ZoneKind))}>
                {ZONE_PRESETS.map((z) => (
                  <option key={z.zone} value={z.zone}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid2">
              <label className="field">
                <span>Width</span>
                <NumField value={el.w} onChange={(v) => set((e) => void ((e as typeof el).w = v))} min={1} max={200} settings={s} />
              </label>
              <label className="field">
                <span>Depth</span>
                <NumField value={el.h} onChange={(v) => set((e) => void ((e as typeof el).h = v))} min={1} max={200} settings={s} />
              </label>
              <label className="field">
                <span>Rotation</span>
                <NumField value={el.rotation} onChange={(v) => set((e) => void ((e as typeof el).rotation = ((v % 360) + 360) % 360))} step={15} min={-360} max={720} unit="°" />
              </label>
            </div>
          </>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Drag the square handles on the plan to resize. Hold Alt to move off the grid.
        </p>
      </div>
    </>
  );
}

function WallFields({ el }: { el: Extract<RoomElement, { kind: 'wall' }> }) {
  const s = useStore((x) => x.project.settings);
  const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1);
  const ang = (Math.atan2(el.y2 - el.y1, el.x2 - el.x1) * 180) / Math.PI;
  const setLen = (L: number) =>
    updateElements([el.id], (e) => {
      if (e.kind !== 'wall') return;
      const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
      e.x2 = +(e.x1 + Math.cos(a) * L).toFixed(2);
      e.y2 = +(e.y1 + Math.sin(a) * L).toFixed(2);
    });
  const setAng = (A: number) =>
    updateElements([el.id], (e) => {
      if (e.kind !== 'wall') return;
      const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      const a = (A * Math.PI) / 180;
      e.x2 = +(e.x1 + Math.cos(a) * L).toFixed(2);
      e.y2 = +(e.y1 + Math.sin(a) * L).toFixed(2);
    });
  return (
    <>
    <div className="grid2">
      <label className="field">
        <span>Length</span>
        <NumField value={len} onChange={setLen} min={0.5} max={500} settings={s} />
      </label>
      <label className="field">
        <span>Thickness</span>
        <NumField value={el.thickness} onChange={(v) => updateElements([el.id], (e) => void (e.kind === 'wall' && (e.thickness = v)))} min={0.1} max={10} step={0.25} settings={s} />
      </label>
      <label className="field">
        <span>Angle</span>
        <NumField value={Math.round(ang * 10) / 10} onChange={setAng} step={15} min={-360} max={360} unit="°" />
      </label>
    </div>
    <RescaleRoom len={len} origin={{ x: el.x1, y: el.y1 }} />
    </>
  );
}

function RescaleRoom({ len, origin }: { len: number; origin: { x: number; y: number } }) {
  const s = useStore((x) => x.project.settings);
  const [real, setReal] = useState('');
  const apply = () => {
    const v = parseFloat(real);
    if (!(v > 0)) return;
    scaleRoom((s.units === 'm' ? v * 3.28084 : v) / len, origin);
    setReal('');
  };
  return (
    <div className="callout" style={{ display: 'grid', gap: 6 }}>
      <span>Know this wall's real length? Rescale the whole room to match. Table sizes stay the same; their positions move with the room.</span>
      <div className="row">
        <input className="input" style={{ width: 90 }} inputMode="decimal" placeholder={s.units} value={real} onChange={(e) => setReal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} aria-label="Real length of this wall" />
        <span className="muted">{s.units}</span>
        <button className="btn sm" onClick={apply} disabled={!(parseFloat(real) > 0)}>
          Rescale room
        </button>
      </div>
    </div>
  );
}

function MultiElement({ n }: { n: number }) {
  return (
    <div className="section">
      <span className="label">Selection</span>
      <h2 className="insp-title">{n} room items</h2>
      <div className="row">
        <button className="btn sm" onClick={duplicateSelection}>
          Duplicate
        </button>
        <button className="btn sm danger" onClick={deleteSelection}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------- guests ----------------
function GuestInspector({ g, analysis }: { g: Guest; analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const s = project.settings;
  const set = (p: Partial<Guest>) => updateGuests([g.id], p);
  const loc = useMemo(() => locate(project).get(g.id), [project, g.id]);
  const meals = useMemo(() => allMeals(project).filter((m) => m !== 'Unspecified'), [project]);
  const tags = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  const allT = useMemo(() => allTags(project), [project]);
  const household = g.party ? project.guests.filter((x) => x.party === g.party && x.id !== g.id) : [];
  const [newTag, setNewTag] = useState('');
  const rels = project.relations.filter((r) => r.a === g.id || r.b === g.id);
  const byId = useMemo(() => new Map(project.guests.map((x) => [x.id, x])), [project.guests]);
  const table = loc ? project.tables.find((t) => t.id === loc.tableId) : undefined;
  return (
    <>
      <div className="section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">Guest</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn sm" title={g.pinned ? 'Unpin (auto-seat may move them)' : 'Pin seat (auto-seat keeps them here)'} aria-pressed={g.pinned} onClick={() => set({ pinned: !g.pinned })}>
              <Icon name="pin" size="sm" />
            </button>
            <button className="icon-btn sm" title="Delete guest" onClick={deleteSelection}>
              <Icon name="trash" size="sm" />
            </button>
          </span>
        </div>
        <h2 className="insp-title">
          <TextField className="" value={g.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </h2>
        <div className="row">
          {table ? (
            <>
              <span className="badge ok">
                {tableName(table)} · seat {loc!.seat + 1}
              </span>
              <button
                className="btn ghost sm"
                onClick={() => {
                  setView('plan');
                  focusGuest(g.id);
                }}
              >
                Show on plan
              </button>
              <button className="btn ghost sm" onClick={() => unseat([g.id])}>
                Unseat
              </button>
            </>
          ) : (
            <span className="badge">Not seated yet</span>
          )}
        </div>
        <label className="field">
          <span>Seat at</span>
          <select
            className="input"
            value={loc?.tableId ?? ''}
            onChange={(e) => {
              if (!e.target.value) unseat([g.id]);
              else seatAtTable([g.id], e.target.value);
            }}
          >
            <option value="">Unseated</option>
            {[...project.tables]
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
              .map((t) => {
                const free = (project.seating[t.id] ?? []).filter((x) => !x).length;
                return (
                  <option key={t.id} value={t.id} disabled={!free && loc?.tableId !== t.id}>
                    {tableName(t)} — {free} free
                  </option>
                );
              })}
          </select>
        </label>
      </div>
      {(analysis.discByGuest.get(g.id)?.length ?? 0) > 0 && (
        <div className="section">
          <h3>
            Discrepancies <span className="badge bad num">{analysis.discByGuest.get(g.id)!.length}</span>
          </h3>
          {analysis.discByGuest.get(g.id)!.map((d) => (
            <div key={d.key} style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12.5 }}>{d.text}</span>
              <span className="row" style={{ gap: 4 }}>
                {(d.kind === 'rsvp' || d.kind === 'meal' || d.kind === 'dietary') && (
                  <button className="btn sm" onClick={() => useListValue(d)}>
                    Use {d.label}: {d.list}
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => dismiss(d)}>
                  {d.kind === 'missing' ? 'Ignore' : 'Keep chart'}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {Object.keys(g.sources ?? {}).length > 0 && (
        <div className="section">
          <h3>What each list says</h3>
          {Object.entries(g.sources!).map(([l, s]) => (
            <div key={l} className="kv" style={{ cursor: 'default' }}>
              <span>{l}</span>
              <span className="muted">{[s.rsvp && (s.rsvp === 'yes' ? 'Coming' : s.rsvp === 'no' ? 'Declined' : 'Pending'), s.meal, s.dietary].filter(Boolean).join(' · ') || 'listed'}</span>
            </div>
          ))}
        </div>
      )}
      <div className="section">
        <h3>RSVP & meal</h3>
        <div className="seg">
          {(['yes', 'pending', 'no'] as Rsvp[]).map((r) => (
            <button key={r} aria-pressed={g.rsvp === r} onClick={() => set({ rsvp: r })}>
              {r === 'yes' ? 'Coming' : r === 'pending' ? 'Pending' : 'Declined'}
            </button>
          ))}
        </div>
        <div className="grid2">
          <label className="field">
            <span>Meal</span>
            <TextField value={g.meal} placeholder="Not chosen" onCommit={(v) => set({ meal: v })} list="meal-list" />
            <datalist id="meal-list">
              {meals.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Dietary / allergies</span>
            <TextField value={g.dietary} placeholder="None" onCommit={(v) => set({ dietary: v })} />
          </label>
        </div>
        <div className="row" style={{ gap: 14 }}>
          <label className="check">
            <input type="checkbox" checked={g.child} onChange={(e) => set({ child: e.target.checked })} /> Child
          </label>
          <label className="check">
            <input type="checkbox" checked={g.accessible} onChange={(e) => set({ accessible: e.target.checked })} /> Accessible seat
          </label>
        </div>
      </div>
      <div className="section">
        <h3>Side</h3>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {(
            [
              ['partner1', s.partner1],
              ['partner2', s.partner2],
              ['both', 'Both'],
              ['', 'Not set'],
            ] as [Side, string][]
          ).map(([v, l]) => (
            <button key={v || 'none'} aria-pressed={g.side === v} onClick={() => set({ side: v })}>
              {v && <span className={`dot side-${v}`} />}
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <h3>Groups & tags</h3>
        <div className="row" style={{ gap: 5 }}>
          {tags.map((t) => (
            <span key={t} className="chip" aria-pressed="true">
              <span onClick={() => setFilters({ tags: [t.toLowerCase()] })}>{t}</span>
              <button className="icon-btn sm" style={{ width: 16, height: 16 }} aria-label={`Remove ${t}`} onClick={() => set({ group: tags.filter((x) => x !== t).join(', ') })}>
                <Icon name="x" size="sm" />
              </button>
            </span>
          ))}
          <input
            className="input"
            style={{ width: 140, padding: '3px 8px' }}
            placeholder="Add tag…"
            list="tag-list-g"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTag.trim()) {
                if (!tags.some((t) => t.toLowerCase() === newTag.trim().toLowerCase())) set({ group: [...tags, newTag.trim()].join(', ') });
                setNewTag('');
              }
            }}
          />
          <datalist id="tag-list-g">
            {allT.map((t) => (
              <option key={t.label} value={t.label} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="section">
        <h3>Household</h3>
        {household.length ? (
          <div className="row" style={{ gap: 5 }}>
            {household.map((h) => (
              <button key={h.id} className="chip" onClick={() => setSelection({ type: 'guest', ids: [h.id] })}>
                {h.name}
              </button>
            ))}
            <button className="btn ghost sm" onClick={() => set({ party: '' })}>
              Separate from household
            </button>
          </div>
        ) : (
          <span className="muted">Not linked. Select several guests to make a household.</span>
        )}
      </div>
      <div className="section">
        <h3>
          Relationships <span className="badge num">{rels.length}</span>
        </h3>
        {rels.map((r) => {
          const other = byId.get(r.a === g.id ? r.b : r.a);
          if (!other) return null;
          return <TieRow key={r.id} g={g} other={other} r={r} />;
        })}
        <datalist id="tie-contexts">
          {allTags(project).map((t) => (
            <option key={t.label} value={t.label} />
          ))}
        </datalist>
        <AddTie g={g} guests={project.guests} />
        <button className="btn ghost sm" onClick={() => setView('network')}>
          <Icon name="graph" size="sm" /> Open the social graph
        </button>
      </div>
      <div className="section">
        <h3>Also known as</h3>
        <TextField
          value={(g.aliases ?? []).join(', ')}
          placeholder="Other spellings, e.g. 陳大文, David Chen"
          onCommit={(v) => updateGuests([g.id], { aliases: [...new Set(v.split(/[,，、;]/).map((x) => x.trim()).filter((x) => x && x !== g.name))] })}
        />
        <p className="muted small">Used to match this guest in other lists. Chinese names match with or without a space and in either order.</p>
      </div>
      <div className="section">
        <h3>Notes</h3>
        <NotesField g={g} />
      </div>
    </>
  );
}

function NotesField({ g }: { g: Guest }) {
  const [t, setT] = useState(g.notes);
  return <textarea className="input" value={t} placeholder="Anything to remember" onChange={(e) => setT(e.target.value)} onBlur={() => t !== g.notes && updateGuests([g.id], { notes: t })} />;
}

function BondSelect({ value, onChange }: { value: Bond; onChange: (b: Bond) => void }) {
  return (
    <select className="rel-kind" value={value} onChange={(e) => onChange(e.target.value as Bond)} aria-label="Relationship">
      {BONDS.map((k) => (
        <option key={k} value={k} title={BOND_HELP[k]}>
          {BOND_LABEL[k]}
        </option>
      ))}
    </select>
  );
}

function TieRow({ g, other, r }: { g: Guest; other: Guest; r: Relation }) {
  const [ctx, setCtx] = useState('');
  const addCtx = () => {
    if (ctx.trim()) addTieContext(g.id, other.id, ctx);
    setCtx('');
  };
  return (
    <div className={`tie b-${r.kind}`}>
      <div className="rel-row">
        <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => setSelection({ type: 'guest', ids: [other.id] })}>
          <span className="sw" /> {other.name}
        </button>
        <BondSelect value={r.kind} onChange={(kind) => setRelation(g.id, other.id, { kind })} />
        <button className="icon-btn sm" aria-label="Remove tie" onClick={() => setRelation(g.id, other.id, null)}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div className="tie-detail">
        {(r.contexts ?? []).map((c) => (
          <span key={c} className="chip ctx">
            {c}
            <button aria-label={`Remove ${c}`} onClick={() => setRelation(g.id, other.id, { contexts: (r.contexts ?? []).filter((x) => x !== c) })}>
              ×
            </button>
          </span>
        ))}
        <input className="ctx-input" value={ctx} list="tie-contexts" placeholder="+ how they know each other" onChange={(e) => setCtx(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCtx()} onBlur={addCtx} aria-label="Add context" />
        <select className="rel-kind seat" value={r.seat ?? ''} onChange={(e) => setRelation(g.id, other.id, { seat: (e.target.value || undefined) as SeatRule | undefined })} aria-label="Seating instruction">
          <option value="">{r.kind === 'partner' ? 'Next to (partner)' : 'No seating rule'}</option>
          {SEAT_RULES.map((k) => (
            <option key={k} value={k}>
              {SEAT_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function AddTie({ g, guests }: { g: Guest; guests: Guest[] }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Bond>('friend');
  const listId = 'ties-' + g.id;
  const add = () => {
    const other = guests.find((x) => x.name.toLowerCase() === q.trim().toLowerCase() && x.id !== g.id);
    if (!other) return;
    setRelation(g.id, other.id, { kind });
    setQ('');
  };
  return (
    <div className="rel-row">
      <input className="input" value={q} list={listId} placeholder="Add a relationship with…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <datalist id={listId}>
        {guests
          .filter((x) => x.id !== g.id)
          .map((x) => (
            <option key={x.id} value={x.name} />
          ))}
      </datalist>
      <BondSelect value={kind} onChange={setKind} />
      <button className="icon-btn sm" onClick={add} aria-label="Add tie">
        <Icon name="plus" size="sm" />
      </button>
    </div>
  );
}

export function MultiGuest({ guests }: { guests: Guest[] }) {
  const project = useStore((s) => s.project);
  const ids = guests.map((g) => g.id);
  const [tag, setTag] = useState('');
  const allT = useMemo(() => allTags(project), [project]);
  const s = project.settings;
  const addTag = () => {
    const t = tag.trim();
    if (!t) return;
    update((d) => {
      for (const g of d.guests) {
        if (!ids.includes(g.id)) continue;
        const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
        if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) g.group = [...cur, t].join(', ');
      }
    });
    setTag('');
  };
  return (
    <>
      <div className="section">
        <span className="label">Selection</span>
        <h2 className="insp-title">{guests.length} guests</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {guests
            .slice(0, 6)
            .map((g) => g.name)
            .join(', ')}
          {guests.length > 6 ? ` and ${guests.length - 6} more` : ''}
        </span>
      </div>
      <div className="section">
        <h3>Seat together</h3>
        <select
          className="input"
          value=""
          onChange={(e) => {
            if (e.target.value) seatAtTable(ids, e.target.value);
          }}
        >
          <option value="">Choose a table…</option>
          {project.tables.map((t) => {
            const free = (project.seating[t.id] ?? []).filter((x) => !x || ids.includes(x)).length;
            return (
              <option key={t.id} value={t.id} disabled={free < ids.length}>
                {tableName(t)} — {free} free
              </option>
            );
          })}
        </select>
        <button className="btn sm" onClick={() => unseat(ids)}>
          Unseat all
        </button>
      </div>
      <div className="section">
        <h3>Relationships between them</h3>
        <div className="row" style={{ gap: 5 }}>
          <button className="btn sm" onClick={() => makeParty(ids)} title="Always seated together, as one household">
            Make a household
          </button>
          {ids.length === 2 && (
            <button className="btn sm" onClick={() => relateAll(ids, { kind: 'partner' })} title="A couple: seated side by side">
              Partners
            </button>
          )}
          {(['family', 'friend', 'coworker', 'acquaintance'] as const).map((k) => (
            <button key={k} className="btn sm" onClick={() => relateAll(ids, { kind: k })} title={BOND_HELP[k]}>
              {k === 'family' ? 'Family' : BOND_LABEL[k] + 's'}
            </button>
          ))}
          <button className="btn sm" onClick={() => relateAll(ids, { kind: 'tension', seat: 'apart' })}>
            Keep apart
          </button>
        </div>
        <div className="row" style={{ gap: 5, marginTop: 6 }}>
          <button className="btn sm" onClick={() => relateAll(ids, { seat: 'beside' })} title="Auto-seat puts them in adjacent chairs">
            Seat next to each other
          </button>
          <button className="btn sm" onClick={() => relateAll(ids, { seat: 'together' })}>
            Same table
          </button>
        </div>
        <MetThrough ids={ids} />
        <div className="row" style={{ gap: 5, marginTop: 6 }}>
          <button className="btn ghost sm" onClick={() => relateAll(ids, null)}>
            Clear ties
          </button>
        </div>
      </div>
      <div className="section">
        <h3>Tag all</h3>
        <div className="quick-add">
          <input className="input" list="tag-list-m" value={tag} placeholder="e.g. College friends" onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} />
          <datalist id="tag-list-m">
            {allT.map((t) => (
              <option key={t.label} value={t.label} />
            ))}
          </datalist>
          <button className="btn sm" onClick={addTag}>
            Add
          </button>
        </div>
      </div>
      <div className="section">
        <h3>Set for all</h3>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {(
            [
              ['partner1', s.partner1],
              ['partner2', s.partner2],
              ['both', 'Both'],
            ] as [Side, string][]
          ).map(([v, l]) => (
            <button key={v} onClick={() => updateGuests(ids, { side: v })}>
              <span className={`dot side-${v}`} /> {l}
            </button>
          ))}
        </div>
        <div className="seg">
          {(['yes', 'pending', 'no'] as Rsvp[]).map((r) => (
            <button key={r} onClick={() => updateGuests(ids, { rsvp: r })}>
              {r === 'yes' ? 'Coming' : r === 'pending' ? 'Pending' : 'Declined'}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => updateGuests(ids, { pinned: true })}>
            Pin seats
          </button>
          <button className="btn sm" onClick={() => updateGuests(ids, { pinned: false })}>
            Unpin
          </button>
          <button className="btn sm danger" onClick={deleteSelection}>
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

export { fmtLen, uid, seatGuest };
export type { Id, Project };

/** "How do they know each other?" for a selection: adds the context to every tie between them. */
function MetThrough({ ids }: { ids: Id[] }) {
  const project = useStore((s) => s.project);
  const [v, setV] = useState('');
  const go = () => {
    if (!v.trim()) return;
    relateAll(ids, { contexts: [v.trim()] });
    toast(`Added "${v.trim()}" to ties between ${ids.length} guests`, true);
    setV('');
  };
  return (
    <div className="row" style={{ gap: 5, marginTop: 6 }}>
      <input className="input" style={{ flex: 1 }} value={v} list="met-through" placeholder="How they know each other (Fire Island, Google…)" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <datalist id="met-through">
        {allTags(project).map((t) => (
          <option key={t.label} value={t.label} />
        ))}
      </datalist>
      <button className="btn sm" onClick={go} disabled={!v.trim()}>
        Add
      </button>
    </div>
  );
}

/** Existing seating areas, for the Area pickers. */
function AreaList() {
  const tables = useStore((s) => s.project.tables);
  const areas = [...new Set(tables.map((t) => t.area?.trim()).filter(Boolean))] as string[];
  return (
    <datalist id="area-list">
      {areas.map((a) => (
        <option key={a} value={a} />
      ))}
    </datalist>
  );
}
