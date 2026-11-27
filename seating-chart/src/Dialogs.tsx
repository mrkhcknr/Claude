import { useEffect, useMemo, useState } from 'react';
import type { Guest, ImportRecord, Project } from './types';
import { PrivacyNote, RemovedColumns, SheetPicker } from './CrosscheckDialog';
import { ACCEPT, loadTable, sheetToParsed } from './fileImport';
import type { Sheet } from './xlsx';
import { addGuests, loadProject, migrate, setSelection, tableName, toast, update, useStore } from './store';
import { FIELD_LABEL, detectMapping, parsePaste, planMerge, rowsToGuests, suggestOptions, toRsvp, type Field, type ImportOptions, type Mapping, type Parsed } from './importer';
import { Dialog, Icon, NumField, TextField, ask } from './ui';
import { uid, combineRsvp } from './util';

// ======================= Import guests =======================
const FIELDS: Field[] = ['first', 'last', 'name', 'suffix', 'party', 'group', 'rsvp', 'meal', 'dietary', 'side', 'child', 'notes', 'table', 'plusOne', 'plusOneOf', 'extId'];

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const [step, setStep] = useState<'source' | 'map' | 'preview'>('source');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [pasted, setPasted] = useState<Guest[] | null>(null);
  const [text, setText] = useState('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [opts, setOpts] = useState<Omit<ImportOptions, 'mapping' | 'partner1' | 'partner2'>>({ households: 'column', splitCouples: false, plusOnes: false, eventColumns: [] });
  const [skipDeclined, setSkipDeclined] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [skipDupes, setSkipDupes] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [label, setLabel] = useState('Guest list');

  useEffect(() => {
    if (!open) {
      setStep('source');
      setParsed(null);
      setPasted(null);
      setText('');
      setFileName('');
      setSkipDupes(new Set());
    }
  }, [open]);

  function useParsed(p: Parsed) {
    setParsed(p);
    setLabel(p.source === 'joy' ? 'Joy' : 'Guest list');
    setMapping(detectMapping(p.headers, p.rsvpColumns));
    setOpts(suggestOptions(p));
    setStep('map');
  }
  async function onFile(f: File | undefined) {
    if (!f) return;
    setFileName(f.name);
    if (/\.json$/i.test(f.name)) {
      toast('That looks like a project file. Use "Open layout or backup" instead.');
      return;
    }
    const r = await loadTable(f);
    if ('error' in r) toast(r.error);
    else if ('sheets' in r) setSheets(r.sheets);
    else useParsed(r.parsed);
  }
  function onPasteNext() {
    const r = parsePaste(text);
    if ('csv' in r) useParsed(r.csv);
    else {
      setPasted(r.guests);
      setStep('preview');
    }
  }

  const rows = useMemo(() => {
    if (pasted) return pasted.map((guest) => ({ guest }));
    if (!parsed) return [];
    const s = project.settings;
    const out = rowsToGuests(parsed.rows, { mapping, ...opts, partner1: s.partner1, partner2: s.partner2 });
    return skipDeclined ? out.filter((r) => r.guest.rsvp !== 'no') : out;
  }, [parsed, pasted, mapping, opts, skipDeclined, project.settings]);
  const plan = useMemo(() => planMerge(project.guests, rows), [project.guests, rows]);

  function doImport() {
    const toAdd = plan.add.filter((r) => !skipDupes.has(r.guest.id));
    const tableBy = new Map<string, string>();
    for (const t of project.tables) {
      tableBy.set(t.label.toLowerCase(), t.id);
      if (t.name) tableBy.set(t.name.toLowerCase(), t.id);
      const n = /\d+/.exec(t.label)?.[0];
      if (n) tableBy.set(n, t.id);
    }
    // re-key party ids so a re-import links to existing households
    const partyMap = new Map<string, string>();
    for (const u of plan.update) if (u.incoming.party && u.existing.party) partyMap.set(u.incoming.party, u.existing.party);
    const fix = (g: Guest) => ({ ...g, party: g.party ? partyMap.get(g.party) ?? g.party : '' });
    const src = (g: Guest) => (pasted ? {} : { [label]: Object.fromEntries(Object.entries({ rsvp: mapping.rsvp ? g.rsvp : undefined, meal: g.meal || undefined, dietary: g.dietary || undefined }).filter(([, v]) => v !== undefined)) });
    const added = addGuests(toAdd.map((r) => ({ ...fix(r.guest), sources: src(r.guest) })));
    if (updateExisting && plan.update.length) {
      update((d) => {
        for (const u of plan.update) {
          const g = d.guests.find((x) => x.id === u.existing.id);
          if (!g) continue;
          const inc = fix(u.incoming);
          if (!pasted) g.sources = { ...(g.sources ?? {}), ...src(u.incoming) };
          // one RSVP across lists: a real answer beats pending; Coming vs Declined keeps the chart's and is flagged
          g.rsvp = pasted ? inc.rsvp : combineRsvp([inc.rsvp, ...Object.values(g.sources ?? {}).map((x) => x.rsvp)]) ?? g.rsvp;
          if (inc.meal) g.meal = inc.meal;
          if (inc.dietary) g.dietary = inc.dietary;
          if (inc.extId) g.extId = inc.extId;
          if (inc.events) g.events = inc.events;
          if (inc.party && !g.party) g.party = inc.party;
          if (inc.side && !g.side) g.side = inc.side;
          const tags = new Set([...g.group.split(/[,;|]/), ...inc.group.split(/[,;|]/)].map((x) => x.trim()).filter(Boolean));
          g.group = [...tags].join(', ');
        }
      });
    }
    if (!pasted) {
      const prev = project.imports?.find((i) => i.label === label);
      const rec: ImportRecord = {
        id: prev?.id ?? uid(),
        label,
        kind: 'guests',
        at: new Date().toISOString(),
        rows: rows.length,
        unmatched: [],
        covered: [...added.map((g) => g.id), ...plan.update.map((u) => u.existing.id)],
        dismissed: prev?.dismissed ?? [],
      };
      update((d) => void (d.imports = [...(d.imports ?? []).filter((i) => i.id !== rec.id), rec]));
    }
    // seat from a "table" column, if present
    const seats = toAdd.filter((r) => r.table).map((r, i) => ({ gid: added[i]?.id, t: tableBy.get(r.table!.toLowerCase()) }));
    if (seats.some((x) => x.t)) {
      update((d) => {
        for (const { gid, t } of seats) {
          if (!gid || !t) continue;
          const arr = d.seating[t];
          const i = arr?.indexOf(null) ?? -1;
          if (i >= 0) arr[i] = gid;
        }
      });
    }
    toast(`Imported ${added.length} new guest${added.length === 1 ? '' : 's'}${updateExisting && plan.update.length ? `, updated ${plan.update.length}` : ''}`, true);
    if (added.length) setSelection(null);
    onClose();
  }

  const declined = rows.filter((r) => r.guest.rsvp === 'no').length;
  const households = new Set(rows.map((r) => r.guest.party).filter(Boolean)).size;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={step === 'source' ? 'Import guests' : step === 'map' ? 'Match columns' : 'Review import'}
      footer={
        <>
          {step !== 'source' && (
            <button className="btn ghost" onClick={() => setStep(step === 'preview' && parsed ? 'map' : 'source')}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step === 'source' && (
            <button className="btn primary" disabled={!text.trim()} onClick={onPasteNext}>
              Continue
            </button>
          )}
          {step === 'map' && (
            <button className="btn primary" disabled={!rows.length} onClick={() => setStep('preview')}>
              Review {rows.length} guests
            </button>
          )}
          {step === 'preview' && (
            <button className="btn primary" disabled={!plan.add.length && !(updateExisting && plan.update.length)} onClick={doImport}>
              Import
            </button>
          )}
        </>
      }
    >
      {step === 'source' && (
        <>
          <label
            className="dropzone"
            data-over={over}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void onFile(e.dataTransfer.files[0]);
            }}
          >
            <Icon name="upload" />
            <b>Drop your Joy export here, or choose a file</b>
            <span className="muted">In Joy: Guest List → Export All Guests. Excel (.xlsx) and CSV files from Zola, The Knot or Google Sheets work too.</span>
            <input type="file" accept={ACCEPT} onChange={(e) => void onFile(e.target.files?.[0])} style={{ maxWidth: 260 }} />
          </label>
          <label className="field">
            <span>Or paste names or spreadsheet rows</span>
            <textarea
              className="input"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'College friends:\nAlex & Sam Rivera\nPriya Patel +1\n\nWork:\nJordan Lee'}
            />
          </label>
          {sheets && (
            <SheetPicker
              sheets={sheets}
              onPick={(sh) => {
                setSheets(null);
                useParsed(sheetToParsed(sh));
              }}
            />
          )}
          <PrivacyNote />
        </>
      )}

      {step === 'map' && parsed && (
        <>
          <RemovedColumns parsed={parsed} />
          <label className="field" style={{ maxWidth: 320 }}>
            <span>Name this list (used when comparing lists)</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="row">
            {parsed.source === 'joy' && <span className="badge ok">Joy export detected</span>}
            <span className="muted">
              {fileName || 'Pasted data'} · {parsed.rows.length} rows · {parsed.headers.length} columns
            </span>
          </div>
          {parsed.rsvpColumns.length > 1 && (
            <label className="field">
              <span>Which event's RSVP counts for the reception?</span>
              <select className="input" value={mapping.rsvp ?? ''} onChange={(e) => setMapping({ ...mapping, rsvp: e.target.value || undefined })}>
                {parsed.rsvpColumns.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="map-table">
            <span className="label">Field</span>
            <span className="label">Column in your file</span>
            <span className="label">Example</span>
            {FIELDS.map((f) => (
              <MapRow key={f} f={f} parsed={parsed} mapping={mapping} setMapping={setMapping} />
            ))}
          </div>
          <div className="grid2">
            <label className="field">
              <span>Households</span>
              <select className="input" value={opts.households} onChange={(e) => setOpts({ ...opts, households: e.target.value as ImportOptions['households'] })}>
                <option value="column">From the party / household column</option>
                <option value="lastName">People with the same last name</option>
                <option value="none">Don't link anyone</option>
              </select>
            </label>
            <div style={{ display: 'grid', gap: 8, alignContent: 'end' }}>
              <label className="check">
                <input type="checkbox" checked={opts.splitCouples} onChange={(e) => setOpts({ ...opts, splitCouples: e.target.checked })} /> Split "Ana & Luis Reyes" into two guests
              </label>
              <label className="check">
                <input type="checkbox" checked={skipDeclined} onChange={(e) => setSkipDeclined(e.target.checked)} /> Skip guests who declined
              </label>
            </div>
          </div>
        </>
      )}

      {step === 'preview' && (
        <>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="stat">
              <b>{plan.add.length}</b>
              <span>New guests</span>
            </div>
            <div className="stat">
              <b>{plan.update.length}</b>
              <span>Already here</span>
            </div>
            <div className="stat">
              <b>{households}</b>
              <span>Households</span>
            </div>
            <div className="stat">
              <b>{declined}</b>
              <span>Declined</span>
            </div>
          </div>
          {plan.update.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> Update RSVPs, meals and tags for the {plan.update.length} guests already here (their seats stay as they are)
            </label>
          )}
          {plan.possibleDupes.length > 0 && (
            <div className="callout warn" style={{ display: 'grid' }}>
              <b>Possible duplicates: untick any you don't want added</b>
              {plan.possibleDupes.map((d) => (
                <label key={d.incoming.id} className="check">
                  <input
                    type="checkbox"
                    checked={!skipDupes.has(d.incoming.id)}
                    onChange={(e) => {
                      const s = new Set(skipDupes);
                      if (e.target.checked) s.delete(d.incoming.id);
                      else s.add(d.incoming.id);
                      setSkipDupes(s);
                    }}
                  />
                  Add “{d.incoming.name}” (similar to “{d.existing.name}”)
                </label>
              ))}
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table className="tbl-grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>RSVP</th>
                  <th>Tags</th>
                  <th>Meal</th>
                  <th>Household</th>
                </tr>
              </thead>
              <tbody>
                {plan.add.slice(0, 200).map((r) => (
                  <tr key={r.guest.id}>
                    <td>{r.guest.name}</td>
                    <td>{r.guest.rsvp === 'yes' ? 'Coming' : r.guest.rsvp === 'no' ? 'Declined' : 'Pending'}</td>
                    <td className="muted">{r.guest.group}</td>
                    <td>{r.guest.meal}</td>
                    <td className="muted">{r.guest.party ? rows.filter((x) => x.guest.party === r.guest.party && x.guest.id !== r.guest.id).map((x) => x.guest.name.split(' ')[0]).join(', ') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

function MapRow({ f, parsed, mapping, setMapping }: { f: Field; parsed: Parsed; mapping: Mapping; setMapping: (m: Mapping) => void }) {
  const h = mapping[f];
  const ex = h ? parsed.rows.map((r) => r[h]).find((v) => v && v.trim()) ?? '' : '';
  const display = f === 'party' && /^person-invitee/.test(ex) ? 'Joy party ID' : ex;
  return (
    <>
      <span>{FIELD_LABEL[f]}</span>
      <select className="input" value={h ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}>
        <option value="">— not imported —</option>
        {parsed.headers.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      <span className="ex" title={display}>
        {f === 'rsvp' && ex ? `${ex} → ${toRsvp(ex) === 'yes' ? 'Coming' : toRsvp(ex) === 'no' ? 'Declined' : 'Pending'}` : display}
      </span>
    </>
  );
}

export { AutoSeatDialog } from './AutoSeatDialog';

// ======================= Settings =======================
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const s = project.settings;
  const set = (p: Partial<Project['settings']>) => update((d) => void Object.assign(d.settings, p));
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('wsp:theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('wsp:theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return (
    <Dialog open={open} onClose={onClose} title="Settings" footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="grid2">
        <label className="field">
          <span>Partner 1</span>
          <TextField value={s.partner1} onCommit={(v) => set({ partner1: v || 'Partner 1' })} />
        </label>
        <label className="field">
          <span>Partner 2</span>
          <TextField value={s.partner2} onCommit={(v) => set({ partner2: v || 'Partner 2' })} />
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Units</span>
          <div className="seg">
            <button aria-pressed={s.units === 'ft'} onClick={() => set({ units: 'ft' })}>
              Feet
            </button>
            <button aria-pressed={s.units === 'm'} onClick={() => set({ units: 'm' })}>
              Metres
            </button>
          </div>
        </label>
        <label className="field">
          <span>Theme</span>
          <div className="seg">
            {['system', 'light', 'dark'].map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Grid step</span>
          <NumField value={s.gridSize} onChange={(v) => set({ gridSize: v })} step={0.25} min={0.25} max={10} settings={s} />
        </label>
        <label className="field">
          <span>Aisle space between tables</span>
          <NumField value={s.clearance} onChange={(v) => set({ clearance: v })} step={0.5} min={0} max={12} settings={s} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" className="switch" checked={s.snap} onChange={(e) => set({ snap: e.target.checked })} /> Snap to grid (hold Alt while dragging to override)
      </label>
      <label className="check">
        <input type="checkbox" className="switch" checked={s.showSeatNames} onChange={(e) => set({ showSeatNames: e.target.checked })} /> Show first names next to seats when zoomed in
      </label>
      <div className="callout warn" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Clear seats, relationships, the guest list or the floor plan — you choose which.</span>
        <button
          className="btn sm"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event('app:reset'));
          }}
        >
          Reset…
        </button>
      </div>
    </Dialog>
  );
}

// ======================= Open layout / backup =======================
export function OpenFileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const [file, setFile] = useState<Project | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) {
      setFile(null);
      setErr('');
    }
  }, [open]);
  async function read(f?: File) {
    if (!f) return;
    try {
      const p = migrate(JSON.parse(await f.text()));
      setFile(p);
      setErr('');
    } catch {
      setErr("That file isn't a seating chart backup or layout. Choose a .json file saved from this app.");
    }
  }
  function useLayout() {
    if (!file) return;
    // keep guests; replace room and tables; seats are emptied unless the guest still exists
    const ids = new Set(project.guests.map((g) => g.id));
    update((d) => {
      d.elements = file.elements;
      d.tables = file.tables.map((t) => ({ ...t }));
      d.seating = Object.fromEntries(file.tables.map((t) => [t.id, (file.seating[t.id] ?? Array(t.seats).fill(null)).map((g) => (g && ids.has(g) ? g : null))]));
      if (!project.tables.length && file.name) d.name = project.guests.length ? d.name : file.name;
    });
    toast(`Loaded ${file.tables.length} tables and ${file.elements.length} room items`, true);
    window.dispatchEvent(new Event('plan:fit'));
    onClose();
  }
  function useRoomOnly() {
    if (!file) return;
    update((d) => {
      d.elements = file.elements;
    });
    toast(`Replaced the room with ${file.elements.length} walls, columns, doors and areas. Your tables and guests are unchanged.`, true);
    window.dispatchEvent(new Event('plan:fit'));
    onClose();
  }
  function useAll() {
    if (!file) return;
    loadProject(file);
    toast('Backup restored', true);
    window.dispatchEvent(new Event('plan:fit'));
    onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Open layout or backup">
      <label className="dropzone">
        <Icon name="layout" />
        <b>Choose a layout or backup file (.json)</b>
        <input type="file" accept=".json,application/json" onChange={(e) => void read(e.target.files?.[0])} />
      </label>
      {err && <div className="callout warn">{err}</div>}
      {file && (
        <>
          <div className="callout">
            <span>
              <b>{file.name}</b>: {file.tables.length} tables ({file.tables.reduce((a, t) => a + t.seats, 0)} seats), {file.elements.length} room items, {file.guests.length} guests.
            </span>
          </div>
          <div className="row">
            <button className={`btn ${file.tables.length ? '' : 'primary'}`} onClick={useRoomOnly}>
              Use its room only (keep my tables)
            </button>
            {file.tables.length > 0 && (
              <button className="btn primary" onClick={useLayout}>
                Use its room & tables {project.guests.length ? '(keep my guests)' : ''}
              </button>
            )}
            {file.guests.length > 0 && (
              <button
                className="btn"
                onClick={async () => {
                  if (!project.guests.length || (await ask('Replace everything with this backup?', { detail: 'Your current guests, ties and seating are replaced. You can undo right after.', ok: 'Replace', danger: true }))) useAll();
                }}
              >
                Restore everything from it
              </button>
            )}
          </div>
          {project.tables.length > 0 && <span className="muted">Your current tables and room ({project.tables.map((t) => tableName(t)).slice(0, 3).join(', ')}…) will be replaced. Undo is available.</span>}
        </>
      )}
    </Dialog>
  );
}

export { uid };
