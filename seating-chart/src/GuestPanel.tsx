import { useMemo, useRef, useState } from 'react';
import type { Guest, Id, Project } from './types';
import { addGuests, setSelection, tableName, useStore } from './store';
import { activeCount, allMeals, allTags, clearFilters, guestMatcher, setFilters, useFilters, type Filters } from './filters';
import { startGuestDrag, useDrag } from './dnd';
import { splitCouple } from './importer';
import { lastName, uid } from './util';
import { Icon, Menu } from './ui';
import type { Analysis } from './scoring';

type Sort = 'party' | 'first' | 'last' | 'table';

export function GuestPanel({ analysis, onImport }: { analysis: Analysis; onImport: () => void }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const filters = useFilters();
  const dragOver = useDrag((s) => s.active && s.over?.kind === 'unseat');
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<Sort>('party');
  const [quick, setQuick] = useState('');
  const anchor = useRef<Id | null>(null);
  const selected = new Set(selection?.type === 'guest' ? selection.ids : []);
  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf), [project, filters, analysis.tableOf]);
  const tableLabel = useMemo(() => new Map(project.tables.map((t) => [t.id, tableName(t)])), [project.tables]);

  const visible = useMemo(() => (matcher ? project.guests.filter(matcher) : project.guests), [project.guests, matcher]);

  const groups = useMemo(() => {
    const list = [...visible];
    const tl = (g: Guest) => tableLabel.get(analysis.tableOf.get(g.id) ?? '') ?? '~';
    if (sort === 'first') list.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'last') list.sort((a, b) => (lastName(a.name) || a.name).localeCompare(lastName(b.name) || b.name) || a.name.localeCompare(b.name));
    if (sort === 'table') list.sort((a, b) => tl(a).localeCompare(tl(b), undefined, { numeric: true }) || a.name.localeCompare(b.name));
    if (sort !== 'party') return list.map((g) => [g]);
    // keep households together, households ordered by first member's surname
    const byParty = new Map<string, Guest[]>();
    const out: Guest[][] = [];
    for (const g of list) {
      if (!g.party) {
        out.push([g]);
        continue;
      }
      const arr = byParty.get(g.party);
      if (arr) arr.push(g);
      else {
        const a = [g];
        byParty.set(g.party, a);
        out.push(a);
      }
    }
    const key = (gs: Guest[]) => lastName(gs[0].name) || gs[0].name;
    const declined = (gs: Guest[]) => (gs.every((g) => g.rsvp === 'no') ? 1 : 0);
    return out.sort((a, b) => declined(a) - declined(b) || key(a).localeCompare(key(b)) || a[0].name.localeCompare(b[0].name));
  }, [visible, sort, tableLabel, analysis.tableOf]);
  const flat = useMemo(() => groups.flat(), [groups]);

  function clickRow(g: Guest, e: PointerEvent) {
    if (e.shiftKey && anchor.current) {
      const a = flat.findIndex((x) => x.id === anchor.current),
        b = flat.findIndex((x) => x.id === g.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelection({ type: 'guest', ids: flat.slice(lo, hi + 1).map((x) => x.id) });
        return;
      }
    }
    anchor.current = g.id;
    if (e.metaKey || e.ctrlKey) {
      const ids = selected.has(g.id) ? [...selected].filter((x) => x !== g.id) : [...selected, g.id];
      setSelection(ids.length ? { type: 'guest', ids } : null);
    } else setSelection({ type: 'guest', ids: [g.id] });
  }

  function addQuick() {
    const lines = quick.split(/\n|;/).map((s) => s.trim()).filter(Boolean);
    const made: Partial<Guest>[] = [];
    for (const l of lines) {
      const names = splitCouple(l);
      const party = names.length > 1 ? uid() : '';
      for (const n of names) made.push({ name: n, party, group: filters.tags.join(', '), notes: /^Guest of /.test(n) ? 'Plus-one' : '' });
    }
    if (!made.length) return;
    const gs = addGuests(made);
    setSelection({ type: 'guest', ids: gs.map((g) => g.id) });
    setQuick('');
  }

  const st = analysis.stats;
  const n = activeCount(filters);
  return (
    <aside className="panel left" aria-label="Guest list">
      <div className="panel-head">
        <div className="panel-title">
          <h2>Guests</h2>
          <span className="muted num">
            {st.seated}/{st.attending} seated
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <Menu label="Sort guests" className="icon-btn" align="end" trigger={<Icon name="list" />}>
            {(close) => (
              <>
                <div className="menu-label">Sort by</div>
                {(
                  [
                    ['party', 'Household'],
                    ['last', 'Last name'],
                    ['first', 'First name'],
                    ['table', 'Table'],
                  ] as [Sort, string][]
                ).map(([k, l]) => (
                  <button key={k} className="menu-item" onClick={() => (setSort(k), close())}>
                    {sort === k ? <Icon name="check" size="sm" /> : <span style={{ width: 15 }} />} {l}
                  </button>
                ))}
              </>
            )}
          </Menu>
        </div>
        <SearchBox open={open} setOpen={setOpen} />
        {open && <FilterSheet project={project} analysis={analysis} />}
        {n > 0 && (
          <div className="filter-summary">
            <span className="num">
              {visible.length} of {project.guests.length} match
            </span>
            <button className="btn ghost sm" onClick={clearFilters}>
              Clear filters
            </button>
            {selected.size < visible.length && (
              <button className="btn ghost sm" onClick={() => setSelection({ type: 'guest', ids: visible.map((g) => g.id) })}>
                Select all {visible.length}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="panel-body">
        <div className="unseat-zone" data-drop="unseat" data-over={dragOver}>
          Drop here to unseat
        </div>
        {project.guests.length === 0 ? (
          <div className="section" style={{ border: 0 }}>
            <p className="muted" style={{ margin: 0 }}>
              No guests yet. Import your Joy export or another spreadsheet, or type names below.
            </p>
            <button className="btn primary" onClick={onImport}>
              <Icon name="upload" size="sm" /> Import guest list
            </button>
          </div>
        ) : (
          <ul className="glist" role="listbox" aria-multiselectable="true" aria-label="Guests">
            {groups.map((gs) => (
              <li key={gs[0].id} className={`party ${gs.length > 1 ? 'multi' : ''}`}>
                {gs.length > 1 && (
                  <span
                    className="party-handle"
                    title="Drag the whole household"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startGuestDrag(e, gs.map((g) => g.id), `${gs.map((g) => g.name.split(' ')[0]).join(' & ')}`, () => setSelection({ type: 'guest', ids: gs.map((g) => g.id) }));
                    }}
                  >
                    {gs.length}
                  </span>
                )}
                {gs.map((g) => (
                  <GuestRow key={g.id} g={g} selected={selected.has(g.id)} table={tableLabel.get(analysis.tableOf.get(g.id) ?? '')} onClick={clickRow} dragIds={selected.has(g.id) && selected.size > 1 ? [...selected] : [g.id]} />
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel-foot">
        <div className="quick-add" style={{ flex: 1 }}>
          <input
            className="input"
            value={quick}
            placeholder="Add guest, e.g. Ana & Luis Reyes"
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addQuick()}
            aria-label="Add guests"
          />
          <button className="icon-btn" onClick={addQuick} title="Add" aria-label="Add guest">
            <Icon name="plus" />
          </button>
        </div>
        <button className="icon-btn" onClick={onImport} title="Import guest list" aria-label="Import guest list">
          <Icon name="upload" />
        </button>
      </div>
    </aside>
  );
}

function GuestRow({ g, selected, table, onClick, dragIds }: { g: Guest; selected: boolean; table?: string; onClick: (g: Guest, e: PointerEvent) => void; dragIds: Id[] }) {
  return (
    <div
      className={`grow ${g.rsvp === 'no' ? 'declined' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onPointerDown={(e) => startGuestDrag(e, dragIds, dragIds.length > 1 ? `${dragIds.length} guests` : g.name, (ev) => onClick(g, ev))}
      onKeyDown={(e) => e.key === 'Enter' && setSelection({ type: 'guest', ids: [g.id] })}
    >
      <span className="handle">
        <Icon name="grip" size="sm" />
      </span>
      <span className="gname">
        <span className={`dot side-${g.side || 'none'}`} />
        <span className="n">{g.name}</span>
        {g.pinned && <Icon name="pin" size="sm" className="muted" />}
      </span>
      <span className="gmeta">
        {g.child && <span className="badge">Child</span>}
        {g.dietary && <span className="badge warn" title={g.dietary}>Diet</span>}
        {g.accessible && <span className="badge" title="Needs an accessible seat">♿</span>}
        {g.rsvp === 'pending' && <span className="badge">?</span>}
        {g.rsvp !== 'no' && <span className={`seat-tag ${table ? '' : 'none'}`}>{table ?? 'Unseated'}</span>}
      </span>
    </div>
  );
}

export function SearchBox({ open, setOpen, placeholder = 'Search names, groups, meals…' }: { open: boolean; setOpen: (v: boolean) => void; placeholder?: string }) {
  const f = useFilters();
  const n = activeCount(f) - (f.q.trim() ? 1 : 0);
  return (
    <div className="search">
      <Icon name="search" size="sm" />
      <input className="input" type="search" value={f.q} placeholder={placeholder} onChange={(e) => setFilters({ q: e.target.value })} aria-label="Search guests" />
      <button className="icon-btn sm filter-toggle" aria-pressed={open} onClick={() => setOpen(!open)} title="Filters" aria-label="Filters" style={{ position: 'absolute', right: 4 }}>
        <Icon name="filter" size="sm" />
        {n > 0 && <span className="filter-dot">{n}</span>}
      </button>
    </div>
  );
}

const FLAG_LABEL: Record<Filters['flags'][number], string> = {
  noTies: 'No ties yet',
  dietary: 'Dietary needs',
  child: 'Children',
  accessible: 'Accessible seat',
  plusOne: 'Plus-ones',
  pinned: 'Pinned',
};

export function FilterSheet({ project, analysis }: { project: Project; analysis: Analysis }) {
  const f = useFilters();
  const tags = useMemo(() => allTags(project), [project]);
  const meals = useMemo(() => allMeals(project), [project]);
  const s = project.settings;
  const toggle = <K extends 'tags' | 'flags'>(k: K, v: Filters[K][number]) => {
    const cur = f[k] as string[];
    setFilters({ [k]: cur.includes(v as string) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<Filters>);
  };
  const seg = <K extends keyof Filters>(k: K, opts: [Filters[K], string][]) => (
    <div className="seg" style={{ flexWrap: 'wrap' }}>
      {opts.map(([v, l]) => (
        <button key={String(v)} aria-pressed={f[k] === v} onClick={() => setFilters({ [k]: v } as Partial<Filters>)} style={{ padding: '3px 9px', fontSize: 12 }}>
          {l}
        </button>
      ))}
    </div>
  );
  return (
    <div className="filters">
      {seg('seated', [
        ['', 'Everyone'],
        ['unseated', `Unseated · ${analysis.stats.unseated}`],
        ['seated', 'Seated'],
      ])}
      {seg('rsvp', [
        ['', 'Any RSVP'],
        ['attending', 'Coming'],
        ['pending', 'Pending'],
        ['no', 'Declined'],
      ])}
      {seg('side', [
        ['', 'Both sides'],
        ['partner1', s.partner1],
        ['partner2', s.partner2],
        ['both', 'Mutual'],
      ])}
      <div className="grid2">
        <label className="field">
          <span>Table</span>
          <select className="input" value={f.tableId} onChange={(e) => setFilters({ tableId: e.target.value })}>
            <option value="">Any table</option>
            {[...project.tables]
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {tableName(t)}
                  {t.name ? ` (${t.label})` : ''}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Meal</span>
          <select className="input" value={f.meal} onChange={(e) => setFilters({ meal: e.target.value })}>
            <option value="">Any meal</option>
            {meals.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="chips">
        {(Object.keys(FLAG_LABEL) as Filters['flags']).map((k) => (
          <button key={k} className="chip" aria-pressed={f.flags.includes(k)} onClick={() => toggle('flags', k)}>
            {FLAG_LABEL[k]}
          </button>
        ))}
      </div>
      {tags.length > 0 && (
        <>
          <span className="label">Groups & tags</span>
          <div className="chips">
            {tags.map((t) => (
              <button key={t.label} className="chip" aria-pressed={f.tags.includes(t.label.toLowerCase())} onClick={() => toggle('tags', t.label.toLowerCase())}>
                {t.label} <span className="count">{t.count}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <label className="check" style={{ fontSize: 12.5 }}>
        <input type="checkbox" className="switch" checked={f.hide} onChange={(e) => setFilters({ hide: e.target.checked })} />
        Hide non-matching guests on the plan and graph
      </label>
    </div>
  );
}
