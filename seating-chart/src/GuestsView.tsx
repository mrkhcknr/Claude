import { useMemo, useState } from 'react';
import type { Guest, Rsvp, Side } from './types';
import { deleteGuests, locate, seatAtTable, setSelection, tableName, unseat, update, updateGuests, useStore } from './store';
import { activeCount, allMeals, clearFilters, guestMatcher, setFilters, useFilters } from './filters';
import { FilterSheet, SearchBox } from './GuestPanel';
import { addUnmatched, discLabel, dismiss, linkUnmatched, useListValue, type Discrepancy } from './discrepancies';
import { saveFile, toCsv } from './exporters';
import { groupTags, type Analysis } from './scoring';
import { lastName, slug } from './util';
import { Icon, Menu, TextField, ask } from './ui';

type Col = 'household' | 'rsvp' | 'meal' | 'dietary' | 'side' | 'tags' | 'table' | 'flags' | 'ties' | 'sources' | 'issues' | 'notes';
const COLS: { c: Col; label: string }[] = [
  { c: 'household', label: 'Household' },
  { c: 'rsvp', label: 'RSVP' },
  { c: 'meal', label: 'Meal' },
  { c: 'dietary', label: 'Dietary' },
  { c: 'side', label: 'Side' },
  { c: 'tags', label: 'Groups & tags' },
  { c: 'table', label: 'Table · seat' },
  { c: 'flags', label: 'Child · access · pinned' },
  { c: 'ties', label: 'Ties' },
  { c: 'sources', label: 'Imported lists' },
  { c: 'issues', label: 'Discrepancies' },
  { c: 'notes', label: 'Notes' },
];
type SortKey = 'name' | 'last' | 'rsvp' | 'meal' | 'table' | 'side' | 'issues';

export function GuestsView({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const filters = useFilters();
  const [showFilters, setShowFilters] = useState(false);
  const [hidden, setHidden] = useState<Set<Col>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('wsp:guest-cols') ?? '[]'));
    } catch {
      return new Set();
    }
  });
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'last', dir: 1 });
  const [panel, setPanel] = useState(false);
  const s = project.settings;
  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf, analysis.discByGuest), [project, filters, analysis.tableOf, analysis.discByGuest]);
  const loc = useMemo(() => locate(project), [project]);
  const tableById = useMemo(() => new Map(project.tables.map((t) => [t.id, t])), [project.tables]);
  const byParty = useMemo(() => {
    const m = new Map<string, Guest[]>();
    for (const g of project.guests) if (g.party) m.set(g.party, [...(m.get(g.party) ?? []), g]);
    return m;
  }, [project.guests]);
  const ties = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of project.relations) {
      m.set(r.a, (m.get(r.a) ?? 0) + 1);
      m.set(r.b, (m.get(r.b) ?? 0) + 1);
    }
    return m;
  }, [project.relations]);
  const labels = (project.imports ?? []).map((i) => i.label);
  const meals = useMemo(() => allMeals(project).filter((m) => m !== 'Unspecified'), [project]);
  const selected = new Set(selection?.type === 'guest' ? selection.ids : []);

  const rows = useMemo(() => {
    const list = matcher ? project.guests.filter(matcher) : [...project.guests];
    const tl = (g: Guest) => {
      const l = loc.get(g.id);
      return l ? `${tableById.get(l.tableId)?.label ?? ''}`.padStart(12, ' ') + String(l.seat).padStart(3, '0') : '~';
    };
    const v = (g: Guest): string => {
      switch (sort.k) {
        case 'name':
          return g.name;
        case 'last':
          return (lastName(g.name) || g.name) + ' ' + g.name;
        case 'rsvp':
          return g.rsvp;
        case 'meal':
          return g.meal || '~';
        case 'table':
          return tl(g);
        case 'side':
          return g.side || '~';
        case 'issues':
          return String(99 - (analysis.discByGuest.get(g.id)?.length ?? 0)).padStart(3, '0');
      }
    };
    return list.sort((a, b) => sort.dir * v(a).localeCompare(v(b), undefined, { numeric: true }));
  }, [project.guests, matcher, sort, loc, tableById, analysis.discByGuest]);

  const show = (c: Col) => !hidden.has(c);
  const toggleCol = (c: Col) => {
    const n = new Set(hidden);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    setHidden(n);
    try {
      localStorage.setItem('wsp:guest-cols', JSON.stringify([...n]));
    } catch {
      /* ignore */
    }
  };
  const th = (label: string, k?: SortKey) => (
    <th onClick={k ? () => setSort((x) => ({ k, dir: x.k === k ? (-x.dir as 1 | -1) : 1 })) : undefined} aria-sort={k && sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} style={k ? undefined : { cursor: 'default' }}>
      {label}
      {k && sort.k === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );
  const allSel = rows.length > 0 && rows.every((g) => selected.has(g.id));
  const toggleRow = (id: string) => {
    const ids = selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id];
    setSelection(ids.length ? { type: 'guest', ids } : null);
  };

  function exportView() {
    const head = ['Guest', 'Household', 'RSVP', 'Meal', 'Dietary', 'Side', 'Groups', 'Table', 'Seat', 'Child', 'Accessible', 'Notes', ...labels.flatMap((l) => [`${l} RSVP`, `${l} meal`]), 'Discrepancies'];
    const body = rows.map((g) => {
      const l = loc.get(g.id);
      return [
        g.name,
        (byParty.get(g.party) ?? []).filter((x) => x.id !== g.id).map((x) => x.name).join('; '),
        rsvpWord(g.rsvp),
        g.meal,
        g.dietary,
        sideWord(g.side, s),
        groupTags(g).join('; '),
        l ? tableName(tableById.get(l.tableId)!) : '',
        l ? l.seat + 1 : '',
        g.child ? 'Yes' : '',
        g.accessible ? 'Yes' : '',
        g.notes,
        ...labels.flatMap((lb) => [g.sources?.[lb]?.rsvp ? rsvpWord(g.sources[lb].rsvp!) : '', g.sources?.[lb]?.meal ?? '']),
        (analysis.discByGuest.get(g.id) ?? []).map((d) => d.text).join(' | '),
      ];
    });
    void saveFile(`${slug(project.name)}-guest-list.csv`, toCsv([head, ...body]), 'text/csv');
  }

  const nDisc = analysis.discrepancies.length;
  return (
    <div className="stage guests-full">
      <div className="lists">
        <div className="lists-head">
          <h2>Guest list</h2>
          <span className="muted num">
            {rows.length === project.guests.length ? `${project.guests.length} guests` : `${rows.length} of ${project.guests.length} guests`} · {analysis.stats.attending} coming · {analysis.stats.seated} seated
          </span>
          <span className="spacer" />
          <button className={`btn ${nDisc ? 'bloom' : ''}`} onClick={() => setPanel(!panel)} aria-pressed={panel}>
            <Icon name="alert" size="sm" /> Discrepancies {nDisc ? `(${nDisc})` : ''}
          </button>
          <Menu label="Columns" className="btn" align="end" trigger={<><Icon name="layout" size="sm" /> Columns</>}>
            {() => (
              <>
                {COLS.map(({ c, label }) => (
                  <label key={c} className="menu-item">
                    <input type="checkbox" checked={show(c)} onChange={() => toggleCol(c)} /> {label}
                  </label>
                ))}
              </>
            )}
          </Menu>
          <button className="btn" onClick={() => window.dispatchEvent(new Event('app:tags'))}>
            <Icon name="flower" size="sm" /> Manage tags
          </button>
          <button className="btn" onClick={exportView}>
            <Icon name="download" size="sm" /> Export view
          </button>
        </div>

        <div className="guests-toolbar">
          <div style={{ width: 'min(420px, 100%)' }}>
            <SearchBox open={showFilters} setOpen={setShowFilters} />
          </div>
          <div className="row" style={{ gap: 5 }}>
            <button className="chip" aria-pressed={filters.flags.includes('discrepancy')} onClick={() => toggleFlag('discrepancy', filters.flags)}>
              Has discrepancy <span className="count">{analysis.discByGuest.size}</span>
            </button>
            <button className="chip" aria-pressed={filters.flags.includes('noMeal')} onClick={() => toggleFlag('noMeal', filters.flags)}>
              No meal yet
            </button>
            <button className="chip" aria-pressed={filters.seated === 'unseated'} onClick={() => setFilters({ seated: filters.seated === 'unseated' ? '' : 'unseated' })}>
              Unseated <span className="count">{analysis.stats.unseated}</span>
            </button>
            <button className="chip" aria-pressed={filters.rsvp === 'attending'} onClick={() => setFilters({ rsvp: filters.rsvp === 'attending' ? '' : 'attending' })}>
              Coming only
            </button>
            {activeCount(filters) > 0 && (
              <button className="btn ghost sm" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
        {showFilters && (
          <div style={{ maxWidth: 720, marginBottom: 12 }}>
            <FilterSheet project={project} analysis={analysis} />
          </div>
        )}

        {panel && <DiscrepancyPanel items={analysis.discrepancies} guests={project.guests} onClose={() => setPanel(false)} />}

        {selected.size > 1 && <BulkBar ids={[...selected]} />}

        <datalist id="gv-meals">
          {meals.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="table-wrap guest-grid-wrap">
          <table className="tbl-grid guest-grid">
            <thead>
              <tr>
                <th style={{ width: 34, cursor: 'default' }}>
                  <input type="checkbox" aria-label="Select all shown" checked={allSel} onChange={() => setSelection(allSel ? null : { type: 'guest', ids: rows.map((g) => g.id) })} />
                </th>
                {th('Guest', 'last')}
                {show('household') && th('Household')}
                {show('rsvp') && th('RSVP', 'rsvp')}
                {show('meal') && th('Meal', 'meal')}
                {show('dietary') && th('Dietary')}
                {show('side') && th('Side', 'side')}
                {show('tags') && th('Groups & tags')}
                {show('table') && th('Table · seat', 'table')}
                {show('flags') && th('Child · ♿ · pin')}
                {show('ties') && th('Ties')}
                {show('sources') && labels.map((l) => <th key={l}>{l}</th>)}
                {show('issues') && th('Discrepancies', 'issues')}
                {show('notes') && th('Notes')}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const l = loc.get(g.id);
                const hh = (byParty.get(g.party) ?? []).filter((x) => x.id !== g.id);
                const ds = analysis.discByGuest.get(g.id) ?? [];
                return (
                  <tr key={g.id} aria-selected={selected.has(g.id)} className={g.rsvp === 'no' ? 'declined' : ''}>
                    <td>
                      <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggleRow(g.id)} aria-label={`Select ${g.name}`} />
                    </td>
                    <td className="name-cell">
                      <span className={`dot side-${g.side || 'none'}`} />
                      <TextField className="cell-input strong" value={g.name} onCommit={(v) => v.trim() && updateGuests([g.id], { name: v.trim() })} />
                      <button className="icon-btn sm" title="Open details" onClick={() => setSelection({ type: 'guest', ids: [g.id] })}>
                        <Icon name="chevron" size="sm" />
                      </button>
                    </td>
                    {show('household') && <td className="muted small">{hh.map((x) => x.name).join(', ')}</td>}
                    {show('rsvp') && (
                      <td>
                        <select className={`cell-input rsvp-${g.rsvp}`} value={g.rsvp} onChange={(e) => updateGuests([g.id], { rsvp: e.target.value as Rsvp })} aria-label="RSVP">
                          <option value="yes">Coming</option>
                          <option value="pending">Pending</option>
                          <option value="no">Declined</option>
                        </select>
                      </td>
                    )}
                    {show('meal') && (
                      <td style={{ minWidth: 150 }}>
                        <TextField className="cell-input" value={g.meal} list="gv-meals" placeholder="—" onCommit={(v) => updateGuests([g.id], { meal: v })} />
                      </td>
                    )}
                    {show('dietary') && (
                      <td style={{ minWidth: 150 }}>
                        <TextField className="cell-input" value={g.dietary} placeholder="—" onCommit={(v) => updateGuests([g.id], { dietary: v })} />
                      </td>
                    )}
                    {show('side') && (
                      <td>
                        <select className="cell-input" value={g.side} onChange={(e) => updateGuests([g.id], { side: e.target.value as Side })} aria-label="Side">
                          <option value="">—</option>
                          <option value="partner1">{s.partner1}</option>
                          <option value="partner2">{s.partner2}</option>
                          <option value="both">Both</option>
                        </select>
                      </td>
                    )}
                    {show('tags') && (
                      <td style={{ minWidth: 180 }}>
                        <TextField className="cell-input" value={g.group} placeholder="—" onCommit={(v) => updateGuests([g.id], { group: v })} />
                      </td>
                    )}
                    {show('table') && (
                      <td>
                        <select
                          className="cell-input"
                          value={l?.tableId ?? ''}
                          onChange={(e) => (e.target.value ? seatAtTable([g.id], e.target.value) : unseat([g.id]))}
                          aria-label="Table"
                        >
                          <option value="">Unseated</option>
                          {project.tables.map((t) => (
                            <option key={t.id} value={t.id}>
                              {tableName(t)}
                            </option>
                          ))}
                        </select>
                        {l && <span className="muted small"> · {l.seat + 1}</span>}
                      </td>
                    )}
                    {show('flags') && (
                      <td className="flags">
                        <input type="checkbox" title="Child" checked={g.child} onChange={(e) => updateGuests([g.id], { child: e.target.checked })} />
                        <input type="checkbox" title="Needs an accessible seat" checked={g.accessible} onChange={(e) => updateGuests([g.id], { accessible: e.target.checked })} />
                        <input type="checkbox" title="Pinned seat" checked={g.pinned} onChange={(e) => updateGuests([g.id], { pinned: e.target.checked })} />
                      </td>
                    )}
                    {show('ties') && <td className="num">{ties.get(g.id) || ''}</td>}
                    {show('sources') &&
                      labels.map((lb) => {
                        const src = g.sources?.[lb];
                        const off = ds.some((d) => d.label === lb && d.kind !== 'missing');
                        const miss = ds.some((d) => d.label === lb && d.kind === 'missing');
                        return (
                          <td key={lb} className={`small ${off ? 'src-off' : ''}`}>
                            {src ? [src.rsvp && rsvpWord(src.rsvp), src.meal].filter(Boolean).join(' · ') || '✓' : miss ? <span className="badge warn">missing</span> : <span className="muted">—</span>}
                          </td>
                        );
                      })}
                    {show('issues') && (
                      <td>
                        {ds.length > 0 && (
                          <button className="badge bad" style={{ border: 0, cursor: 'pointer' }} title={ds.map((d) => d.text).join('\n')} onClick={() => setSelection({ type: 'guest', ids: [g.id] })}>
                            {ds.map((d) => discLabel[d.kind]).join(', ')}
                          </button>
                        )}
                      </td>
                    )}
                    {show('notes') && (
                      <td style={{ minWidth: 200 }}>
                        <TextField className="cell-input" value={g.notes} placeholder="—" onCommit={(v) => updateGuests([g.id], { notes: v })} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const rsvpWord = (r: Rsvp) => (r === 'yes' ? 'Coming' : r === 'no' ? 'Declined' : 'Pending');
const sideWord = (v: Side, s: { partner1: string; partner2: string }) => (v === 'partner1' ? s.partner1 : v === 'partner2' ? s.partner2 : v === 'both' ? 'Both' : '');
function toggleFlag(f: 'discrepancy' | 'noMeal', flags: string[]) {
  setFilters({ flags: (flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f]) as never });
}

function BulkBar({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const [tag, setTag] = useState('');
  const s = project.settings;
  return (
    <div className="bulk-bar">
      <b className="num">{ids.length} selected</b>
      <select className="input" value="" onChange={(e) => e.target.value && updateGuests(ids, { rsvp: e.target.value as Rsvp })} aria-label="Set RSVP">
        <option value="">Set RSVP…</option>
        <option value="yes">Coming</option>
        <option value="pending">Pending</option>
        <option value="no">Declined</option>
      </select>
      <select className="input" value="" onChange={(e) => e.target.value && updateGuests(ids, { side: e.target.value === 'none' ? '' : (e.target.value as Side) })} aria-label="Set side">
        <option value="">Set side…</option>
        <option value="partner1">{s.partner1}</option>
        <option value="partner2">{s.partner2}</option>
        <option value="both">Both</option>
        <option value="none">Not set</option>
      </select>
      <input
        className="input"
        style={{ width: 150 }}
        placeholder="Add tag…"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !tag.trim()) return;
          const t = tag.trim();
          update((d) => {
            for (const g of d.guests) {
              if (!ids.includes(g.id)) continue;
              const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
              if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) g.group = [...cur, t].join(', ');
            }
          });
          setTag('');
        }}
      />
      <select className="input" value="" onChange={(e) => e.target.value && seatAtTable(ids, e.target.value)} aria-label="Seat at table">
        <option value="">Seat together at…</option>
        {project.tables.map((t) => (
          <option key={t.id} value={t.id}>
            {tableName(t)}
          </option>
        ))}
      </select>
      <button
        className="btn sm danger"
        onClick={async () => (await ask(`Delete ${ids.length} guests?`, { detail: 'You can undo this.', ok: 'Delete', danger: true })) && deleteGuests(ids)}
      >
        Delete
      </button>
      <button className="btn ghost sm" onClick={() => setSelection(null)}>
        Clear
      </button>
    </div>
  );
}

export function DiscrepancyPanel({ items, guests, onClose }: { items: Discrepancy[]; guests: Guest[]; onClose?: () => void }) {
  const [kind, setKind] = useState<'' | Discrepancy['kind']>('');
  const list = items.filter((d) => !kind || d.kind === kind);
  const kinds = [...new Set(items.map((d) => d.kind))];
  const sorted = useMemo(() => [...guests].sort((a, b) => a.name.localeCompare(b.name)), [guests]);
  return (
    <section className="tcard disc-panel">
      <header>
        <h3 style={{ fontSize: 20 }}>Discrepancies</h3>
        <span className="muted">Differences between your imported lists and the chart. They stay here until you resolve them.</span>
        <span className="spacer" style={{ flex: 1 }} />
        {onClose && (
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size="sm" />
          </button>
        )}
      </header>
      {!items.length ? (
        <span className="muted">No discrepancies. Import a second list with More → Crosscheck RSVPs & meals to compare.</span>
      ) : (
        <>
          <div className="row" style={{ gap: 5 }}>
            <button className="chip" aria-pressed={!kind} onClick={() => setKind('')}>
              All <span className="count">{items.length}</span>
            </button>
            {kinds.map((k) => (
              <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {discLabel[k]} <span className="count">{items.filter((d) => d.kind === k).length}</span>
              </button>
            ))}
          </div>
          <div className="disc-list">
            {list.slice(0, 200).map((d) => (
              <div key={d.key} className="disc-row">
                <span className={`badge ${d.kind === 'rsvp' || d.kind === 'unmatched' ? 'bad' : 'warn'}`}>{discLabel[d.kind]}</span>
                <span className="t">
                  {d.guestId ? (
                    <button className="btn ghost sm" style={{ padding: '0 3px' }} onClick={() => setSelection({ type: 'guest', ids: [d.guestId!] })}>
                      {d.text}
                    </button>
                  ) : (
                    d.text
                  )}
                </span>
                <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  {(d.kind === 'rsvp' || d.kind === 'meal' || d.kind === 'dietary') && (
                    <button className="btn sm" onClick={() => useListValue(d)} title={`Change the chart to ${d.list}`}>
                      Use {d.label}
                    </button>
                  )}
                  {d.kind === 'unmatched' && (
                    <>
                      <select className="input" style={{ width: 160 }} value="" onChange={(e) => e.target.value && linkUnmatched(d, e.target.value)} aria-label="Same person as">
                        <option value="">Same person as…</option>
                        {sorted.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      <button className="btn sm" onClick={() => addUnmatched(d)}>
                        Add guest
                      </button>
                    </>
                  )}
                  <button className="btn ghost sm" onClick={() => dismiss(d)} title="Mark as fine; it won't be flagged again">
                    {d.kind === 'rsvp' || d.kind === 'meal' || d.kind === 'dietary' ? 'Keep chart' : 'Ignore'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
