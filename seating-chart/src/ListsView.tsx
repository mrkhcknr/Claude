import { useMemo, useState } from 'react';
import type { Guest } from './types';
import { setSelection, tableName, updateGuests, useStore } from './store';
import { guestMatcher, useFilters, activeCount, clearFilters } from './filters';
import { backupJson, catererCsv, fileBase, guestListCsv, layoutJson, mealSummary, planPng, planSvg, saveFile, seatingChartHtml, tablesCsv } from './exporters';
import { lastName } from './util';
import { Icon, TextField } from './ui';
import { SearchBox, FilterSheet } from './GuestPanel';
import type { Analysis } from './scoring';

type Tab = 'tables' | 'guests' | 'meals' | 'export';

export function ListsView({ analysis }: { analysis: Analysis }) {
  const [tab, setTab] = useState<Tab>('tables');
  return (
    <div className="stage">
      <div className="lists">
        <div className="lists-head">
          <h2>Lists & export</h2>
          <span className="spacer" />
          <div className="seg">
            {(
              [
                ['tables', 'By table'],
                ['guests', 'Guest list'],
                ['meals', 'Meals'],
                ['export', 'Export'],
              ] as [Tab, string][]
            ).map(([k, l]) => (
              <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {tab === 'tables' && <ByTable analysis={analysis} />}
        {tab === 'guests' && <GuestTable analysis={analysis} />}
        {tab === 'meals' && <Meals />}
        {tab === 'export' && <ExportPanel />}
      </div>
    </div>
  );
}

function ByTable({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const filters = useFilters();
  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf), [project, filters, analysis.tableOf]);
  const byId = useMemo(() => new Map(project.guests.map((g) => [g.id, g])), [project.guests]);
  const tables = [...project.tables].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return (
    <>
      {activeCount(filters) > 0 && (
        <div className="filter-summary" style={{ marginBottom: 12 }}>
          Showing tables with matching guests · <button className="btn ghost sm" onClick={clearFilters}>Clear filters</button>
        </div>
      )}
      <div className="cards">
        {tables.map((t) => {
          const gs = (project.seating[t.id] ?? []).map((x) => (x ? byId.get(x) : undefined)).filter((g): g is Guest => !!g);
          if (matcher && !gs.some(matcher)) return null;
          const rep = analysis.reports.get(t.id);
          return (
            <section key={t.id} className="tcard">
              <header>
                <h3>{tableName(t)}</h3>
                {t.name && <span className="label">{t.label}</span>}
                <span className="spacer" style={{ flex: 1 }} />
                <span className="badge num">
                  {gs.length}/{t.seats}
                </span>
              </header>
              {gs.length ? (
                <ol>
                  {gs.map((g) => (
                    <li key={g.id} style={{ opacity: matcher && !matcher(g) ? 0.4 : 1 }}>
                      <button className="btn ghost sm" style={{ padding: '0 4px', fontWeight: 400 }} onClick={() => setSelection({ type: 'guest', ids: [g.id] })}>
                        {g.name}
                      </button>
                      {g.meal && <span className="meal"> · {g.meal}</span>}
                      {g.dietary && <span className="badge warn" style={{ marginLeft: 4 }}>{g.dietary}</span>}
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="muted">No one seated yet</span>
              )}
              {rep && rep.conflicts.length > 0 && <span className="badge bad">{rep.conflicts.length} conflict(s)</span>}
            </section>
          );
        })}
      </div>
    </>
  );
}

type Col = 'name' | 'table' | 'meal' | 'dietary' | 'rsvp' | 'group';
function GuestTable({ analysis }: { analysis: Analysis }) {
  const project = useStore((s) => s.project);
  const filters = useFilters();
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<{ c: Col; dir: 1 | -1 }>({ c: 'name', dir: 1 });
  const matcher = useMemo(() => guestMatcher(project, filters, analysis.tableOf), [project, filters, analysis.tableOf]);
  const tname = useMemo(() => new Map(project.tables.map((t) => [t.id, tableName(t)])), [project.tables]);
  const meals = useMemo(() => [...new Set(project.guests.map((g) => g.meal).filter(Boolean))].sort(), [project.guests]);
  const rows = useMemo(() => {
    const list = matcher ? project.guests.filter(matcher) : [...project.guests];
    const val = (g: Guest): string => {
      switch (sort.c) {
        case 'name':
          return (lastName(g.name) || g.name) + ' ' + g.name;
        case 'table':
          return tname.get(analysis.tableOf.get(g.id) ?? '') ?? '~';
        case 'meal':
          return g.meal || '~';
        case 'dietary':
          return g.dietary || '~';
        case 'rsvp':
          return g.rsvp;
        case 'group':
          return g.group || '~';
      }
    };
    return list.sort((a, b) => sort.dir * val(a).localeCompare(val(b), undefined, { numeric: true }));
  }, [project.guests, matcher, sort, tname, analysis.tableOf]);
  const th = (c: Col, l: string) => (
    <th onClick={() => setSort((s) => ({ c, dir: s.c === c ? (-s.dir as 1 | -1) : 1 }))} aria-sort={sort.c === c ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {l} {sort.c === c ? (sort.dir === 1 ? '↑' : '↓') : ''}
    </th>
  );
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ maxWidth: 520, display: 'grid', gap: 8 }}>
        <SearchBox open={open} setOpen={setOpen} />
        {open && <FilterSheet project={project} analysis={analysis} />}
        <span className="muted num">
          {rows.length} of {project.guests.length} guests · edit meals and dietary notes right in the table
        </span>
      </div>
      <datalist id="meal-list-t">
        {meals.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="table-wrap">
        <table className="tbl-grid">
          <thead>
            <tr>
              {th('name', 'Guest')}
              {th('table', 'Table')}
              {th('meal', 'Meal')}
              {th('dietary', 'Dietary')}
              {th('rsvp', 'RSVP')}
              {th('group', 'Groups')}
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id}>
                <td>
                  <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => setSelection({ type: 'guest', ids: [g.id] })}>
                    {g.name}
                  </button>
                </td>
                <td>{tname.get(analysis.tableOf.get(g.id) ?? '') ?? <span className="muted">—</span>}</td>
                <td style={{ minWidth: 140 }}>
                  <TextField className="input" value={g.meal} list="meal-list-t" placeholder="—" onCommit={(v) => updateGuests([g.id], { meal: v })} />
                </td>
                <td style={{ minWidth: 160 }}>
                  <TextField className="input" value={g.dietary} placeholder="—" onCommit={(v) => updateGuests([g.id], { dietary: v })} />
                </td>
                <td>{g.rsvp === 'yes' ? 'Coming' : g.rsvp === 'no' ? 'Declined' : 'Pending'}</td>
                <td className="muted" style={{ maxWidth: 260 }}>
                  {g.group}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Meals() {
  const project = useStore((s) => s.project);
  const { meals, rows, totals } = useMemo(() => mealSummary(project), [project]);
  return (
    <div className="table-wrap">
      <table className="tbl-grid">
        <thead>
          <tr>
            <th>Table</th>
            <th>Guests</th>
            {meals.map((m) => (
              <th key={m}>{m}</th>
            ))}
            <th>Dietary notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t.id}>
              <td>
                {tableName(r.t)} {r.t.name && <span className="muted">· {r.t.label}</span>}
              </td>
              <td>{r.gs.length}</td>
              {r.counts.map((c, i) => (
                <td key={i}>{c || ''}</td>
              ))}
              <td style={{ fontSize: 12 }}>{r.dietary.join('; ')}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>Total</b>
            </td>
            <td>
              <b>{rows.reduce((a, r) => a + r.gs.length, 0)}</b>
            </td>
            {totals.map((c, i) => (
              <td key={i}>
                <b>{c}</b>
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ExportPanel() {
  const project = useStore((s) => s.project);
  const base = fileBase(project);
  const [busy, setBusy] = useState('');
  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } finally {
      setBusy('');
    }
  };
  const item = (k: string, icon: string, title: string, desc: string, fn: () => Promise<void>) => (
    <section className="tcard" key={k}>
      <header>
        <Icon name={icon} />
        <h3 style={{ fontSize: 19 }}>{title}</h3>
      </header>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {desc}
      </p>
      <button className="btn" disabled={!!busy} onClick={() => run(k, fn)}>
        {busy === k ? <span className="spinner" /> : <Icon name="download" size="sm" />} Download
      </button>
    </section>
  );
  return (
    <div className="cards">
      {item('chart', 'file', 'Seating chart', 'One print-ready page: the floor plan, every table with its guests and meals, the guest list A–Z and meal counts. Open it and print or save as PDF.', () => saveFile(`${base}-seating-chart.html`, seatingChartHtml(project), 'text/html'))}
      {item('png', 'image', 'Floor plan image', 'High-resolution PNG of the room with table names and guest first names.', async () => saveFile(`${base}-floor-plan.png`, await planPng(project), 'image/png'))}
      {item('svg', 'image', 'Floor plan (vector)', 'SVG for a designer or stationer to restyle at any size.', () => saveFile(`${base}-floor-plan.svg`, planSvg(project), 'image/svg+xml'))}
      {item('guests', 'list', 'Guest list with tables & meals', 'CSV, A–Z by last name: table, seat, meal, dietary notes, RSVP, groups. Ready for escort cards or mail merge.', () => saveFile(`${base}-guests.csv`, guestListCsv(project), 'text/csv'))}
      {item('tables', 'list', 'Table lists', 'CSV, one row per seat in table order, for the venue coordinator.', () => saveFile(`${base}-tables.csv`, tablesCsv(project), 'text/csv'))}
      {item('meals', 'list', 'Caterer meal counts', 'CSV, meal counts per table with dietary notes and totals.', () => saveFile(`${base}-meals.csv`, catererCsv(project), 'text/csv'))}
      {item('backup', 'download', 'Full backup', 'Everything: guests, ties, room and seating. Keep a copy somewhere safe.', () => saveFile(`${base}-backup.json`, backupJson(project), 'application/json'))}
      {item('layout', 'layout', 'Room layout only', 'Walls, areas and tables without guests, to reuse or share with the venue.', () => saveFile(`${base}-layout.json`, layoutJson(project), 'application/json'))}
    </div>
  );
}
