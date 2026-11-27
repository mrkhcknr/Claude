import { useEffect, useMemo, useState } from 'react';
import type { Guest, Id, ImportRecord } from './types';
import { toast, update, useStore } from './store';
import { parseCsv, parsePaste, type Parsed } from './importer';
import { ACCEPT, loadTable, sheetToParsed } from './fileImport';
import type { Sheet } from './xlsx';
import { CFIELDS, buildRows, detectCrossMapping, diffsFor, matchRows, rsvpWord, type CField, type CrossRow } from './crosscheck';
import { Dialog, Icon } from './ui';
import { knownAs, uid } from './util';

type Step = 'source' | 'map' | 'review';

export function CrosscheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const [step, setStep] = useState<Step>('source');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [label, setLabel] = useState('RSVP list');
  const [mapping, setMapping] = useState<Partial<Record<CField, string>>>({});
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  // review state
  const [manual, setManual] = useState<Record<number, Id | ''>>({});
  const [take, setTake] = useState<Set<string>>(new Set());
  const [addNew, setAddNew] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) {
      setStep('source');
      setParsed(null);
      setText('');
      setManual({});
      setTake(new Set());
      setAddNew(new Set());
    }
  }, [open]);

  function useParsed(p: Parsed, name?: string) {
    setParsed(p);
    setMapping(detectCrossMapping(p));
    if (name) setLabel(name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s*\d{4}[\d\s-]*$/, '').trim() || 'RSVP list');
    setStep('map');
  }
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [fileName, setFileName] = useState('');
  async function onFile(f?: File) {
    if (!f) return;
    setFileName(f.name);
    const r = await loadTable(f);
    if ('error' in r) toast(r.error);
    else if ('sheets' in r) setSheets(r.sheets);
    else useParsed(r.parsed, f.name);
  }

  const rows = useMemo(() => {
    if (!parsed) return [];
    const base = matchRows(buildRows(parsed, mapping), project.guests);
    return base.map((r) => (r.i in manual ? { ...r, guestId: manual[r.i] || null, how: manual[r.i] ? ('manual' as const) : ('none' as const) } : r));
  }, [parsed, mapping, project.guests, manual]);

  const byId = useMemo(() => new Map(project.guests.map((g) => [g.id, g])), [project.guests]);
  const matched = rows.filter((r) => r.guestId);
  const unsure = rows.filter((r) => (r.how === 'fuzzy' || (!r.guestId && r.candidates.length)) && !(r.i in manual));
  const unmatched = rows.filter((r) => !r.guestId);
  const covered = new Set(matched.map((r) => r.guestId!));
  const missing = project.guests.filter((g) => g.rsvp !== 'no' && !covered.has(g.id));
  const diffs = matched.flatMap((r) => diffsFor(r, byId.get(r.guestId!)!).map((d) => ({ r, g: byId.get(r.guestId!)!, d, key: `${r.i}:${d.field}` })));
  const fills = diffs.filter((x) => x.d.auto || x.d.from === '—');
  const conflicts = diffs.filter((x) => !x.d.auto && x.d.from !== '—');

  // default: fill empty meals/dietary from the list; RSVP and real conflicts wait for a decision
  useEffect(() => {
    if (step === 'review') setTake(new Set(fills.map((x) => x.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function apply() {
    const recordId = project.imports?.find((i) => i.label === label)?.id ?? uid();
    const newGuests: Guest[] = [];
    update((p) => {
      for (const r of matched) {
        const g = p.guests.find((x) => x.id === r.guestId);
        if (!g) continue;
        // remember how this list spells the name, so the next import matches it outright
        if (r.fileName && !knownAs(g, r.fileName)) g.aliases = [...(g.aliases ?? []), r.fileName];
        g.sources = { ...(g.sources ?? {}), [label]: clean({ rsvp: r.rsvp ?? undefined, meal: r.meal || undefined, dietary: r.dietary || undefined }) };
      }
      for (const { r, d, key } of diffs) {
        if (!take.has(key)) continue;
        const g = p.guests.find((x) => x.id === r.guestId);
        if (!g) continue;
        if (d.field === 'rsvp' && r.rsvp) g.rsvp = r.rsvp;
        if (d.field === 'meal') g.meal = r.meal;
        if (d.field === 'dietary') g.dietary = r.dietary;
      }
      for (const r of unmatched) {
        if (!addNew.has(r.i)) continue;
        const g: Guest = { id: uid(), name: r.fileName, party: '', group: '', side: '', rsvp: r.rsvp ?? 'yes', meal: r.meal, dietary: r.dietary, child: false, accessible: false, notes: `Added from ${label}`, pinned: false, sources: { [label]: clean({ rsvp: r.rsvp ?? undefined, meal: r.meal || undefined, dietary: r.dietary || undefined }) } };
        p.guests.push(g);
        newGuests.push(g);
      }
      const rec: ImportRecord = {
        id: recordId,
        label,
        kind: 'crosscheck',
        at: new Date().toISOString(),
        rows: rows.length,
        unmatched: unmatched.filter((r) => !addNew.has(r.i)).map((r) => r.fileName),
        covered: [...covered, ...newGuests.map((g) => g.id)],
        dismissed: p.imports?.find((i) => i.id === recordId)?.dismissed ?? [],
      };
      p.imports = [...(p.imports ?? []).filter((i) => i.id !== recordId), rec];
    });
    const left = conflicts.filter((x) => !take.has(x.key)).length + unmatched.length - addNew.size + missing.length;
    toast(`Crosschecked ${label}: ${take.size} updates applied${left ? `, ${left} discrepancies to review` : ''}`, true);
    onClose();
  }

  const guestOptions = useMemo(() => [...project.guests].sort((a, b) => a.name.localeCompare(b.name)), [project.guests]);
  const pick = (r: CrossRow) => (
    <select className="input" style={{ maxWidth: 240 }} value={r.i in manual ? manual[r.i] : r.guestId ?? ''} onChange={(e) => setManual({ ...manual, [r.i]: e.target.value })} aria-label={`Match ${r.fileName}`}>
      <option value="">No match</option>
      {r.candidates.length > 0 && (
        <optgroup label="Likely">
          {r.candidates.map((id) => (
            <option key={id} value={id}>
              {byId.get(id)?.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="All guests">
        {guestOptions.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
  const tickTake = (key: string) => (
    <input
      type="checkbox"
      checked={take.has(key)}
      onChange={(e) => {
        const s = new Set(take);
        if (e.target.checked) s.add(key);
        else s.delete(key);
        setTake(s);
      }}
    />
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={step === 'source' ? 'Crosscheck RSVPs & meals' : step === 'map' ? 'Match columns' : 'Review the crosscheck'}
      footer={
        <>
          {step !== 'source' && (
            <button className="btn ghost" onClick={() => setStep(step === 'review' ? 'map' : 'source')}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step === 'source' && (
            <button
              className="btn primary"
              disabled={!text.trim()}
              onClick={() => {
                const r = parsePaste(text);
                if ('csv' in r) useParsed(r.csv);
                else useParsed(parseCsv('Name\n' + r.guests.map((g) => `"${g.name.replace(/"/g, '""')}"`).join('\n')));
              }}
            >
              Continue
            </button>
          )}
          {step === 'map' && (
            <button className="btn primary" disabled={!rows.length || !(mapping.name || mapping.first || mapping.extId)} onClick={() => setStep('review')}>
              Compare {rows.length} rows
            </button>
          )}
          {step === 'review' && (
            <button className="btn primary" onClick={apply}>
              Apply & save crosscheck
            </button>
          )}
        </>
      }
    >
      {step === 'source' && (
        <>
          <p style={{ margin: 0, color: 'var(--ink-2)' }}>
            Compare another RSVP or meal-choice list with your guests. Nothing changes until you review the differences. Disagreements you don't resolve stay in the Checks list and the Guests view.
          </p>
          <label
            className="dropzone"
            data-over={over}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void onFile(e.dataTransfer.files[0]);
            }}
          >
            <Icon name="upload" />
            <b>Drop the RSVP / meal file here, or choose it</b>
            <span className="muted">Excel (.xlsx), CSV or TSV — from Google Sheets, Excel, Typeform, Zola, The Knot…</span>
            <input type="file" accept={ACCEPT} onChange={(e) => void onFile(e.target.files?.[0])} style={{ maxWidth: 260 }} />
          </label>
          <label className="field">
            <span>Or paste rows (with a header row)</span>
            <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Name\tRSVP\tMeal\nAlex Rivera\tYes\tChicken'} />
          </label>
          {sheets && (
            <SheetPicker
              sheets={sheets}
              onPick={(sh) => {
                setSheets(null);
                useParsed(sheetToParsed(sh), `${fileName.replace(/\.[^.]+$/, '')} ${sh.name}`);
              }}
            />
          )}
          <PrivacyNote />
        </>
      )}

      {step === 'map' && parsed && (
        <>
          <label className="field" style={{ maxWidth: 360 }}>
            <span>Name this list</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <RemovedColumns parsed={parsed} />
          <div className="map-table">
            <span className="label">Field</span>
            <span className="label">Column in the file</span>
            <span className="label">Example</span>
            {CFIELDS.map(({ f, label: l }) => {
              const h = mapping[f];
              const ex = h ? parsed.rows.map((r) => r[h]).find((v) => v?.trim()) ?? '' : '';
              return (
                <div key={f} style={{ display: 'contents' }}>
                  <span>{l}</span>
                  <select className="input" value={h ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}>
                    <option value="">— not used —</option>
                    {parsed.headers.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                  <span className="ex">{ex}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <div className="stat">
              <b>{matched.length}</b>
              <span>Matched</span>
            </div>
            <div className="stat">
              <b>{fills.length}</b>
              <span>Blanks to fill</span>
            </div>
            <div className="stat">
              <b>{conflicts.length}</b>
              <span>Disagreements</span>
            </div>
            <div className="stat">
              <b>{unmatched.length}</b>
              <span>Not on guest list</span>
            </div>
            <div className="stat">
              <b>{missing.length}</b>
              <span>Coming, not in list</span>
            </div>
          </div>

          {unsure.length > 0 && (
            <Section title={`Check these matches (${unsure.length})`} hint="Spellings differ or more than one guest fits.">
              {unsure.map((r) => (
                <div key={r.i} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    “{r.fileName}” in {label}
                  </span>
                  {pick(r)}
                </div>
              ))}
            </Section>
          )}

          {conflicts.length > 0 && (
            <Section title={`Disagreements (${conflicts.length})`} hint="Tick the ones where this list is right. Unticked ones stay flagged for later.">
              <div className="row">
                <button className="btn ghost sm" onClick={() => setTake(new Set([...take, ...conflicts.map((x) => x.key)]))}>
                  Take all from {label}
                </button>
                <button className="btn ghost sm" onClick={() => setTake(new Set([...take].filter((k) => !conflicts.some((x) => x.key === k))))}>
                  Keep all chart values
                </button>
              </div>
              <DiffTable items={conflicts} tick={tickTake} label={label} />
            </Section>
          )}

          {fills.length > 0 && (
            <Section title={`Fill in blanks (${fills.length})`} hint="Meals and dietary notes the chart doesn't have yet.">
              <DiffTable items={fills} tick={tickTake} label={label} />
            </Section>
          )}

          {unmatched.length > 0 && (
            <Section title={`In ${label} but not on the guest list (${unmatched.length})`} hint="Match a different spelling, add them as new guests, or leave them flagged.">
              {unmatched.map((r) => (
                <div key={r.i} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {r.fileName}
                    {r.rsvp && <span className="muted"> · {rsvpWord(r.rsvp)}</span>}
                    {r.meal && <span className="muted"> · {r.meal}</span>}
                  </span>
                  <span className="row">
                    {pick(r)}
                    <label className="check" style={{ fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={addNew.has(r.i)}
                        onChange={(e) => {
                          const s = new Set(addNew);
                          if (e.target.checked) s.add(r.i);
                          else s.delete(r.i);
                          setAddNew(s);
                        }}
                      />
                      Add as guest
                    </label>
                  </span>
                </div>
              ))}
            </Section>
          )}

          {missing.length > 0 && (
            <Section title={`Coming, but not in ${label} (${missing.length})`} hint="These stay flagged in Checks so you can follow up.">
              <p style={{ margin: 0, fontSize: 12.5 }}>
                {missing
                  .slice(0, 80)
                  .map((g) => g.name)
                  .join(', ')}
                {missing.length > 80 ? ` and ${missing.length - 80} more` : ''}
              </p>
            </Section>
          )}
          {!conflicts.length && !fills.length && !unmatched.length && !missing.length && <div className="callout">Everything matches.</div>}
        </>
      )}
    </Dialog>
  );
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="tcard" style={{ gap: 8 }}>
      <b>{title}</b>
      {hint && <span className="muted" style={{ fontSize: 12.5 }}>{hint}</span>}
      {children}
    </section>
  );
}

function DiffTable({ items, tick, label }: { items: { g: Guest; d: { field: string; from: string; to: string }; key: string }[]; tick: (k: string) => React.ReactNode; label: string }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 280 }}>
      <table className="tbl-grid">
        <thead>
          <tr>
            <th style={{ width: 40 }}>Take</th>
            <th>Guest</th>
            <th>Field</th>
            <th>Chart</th>
            <th>{label}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ g, d, key }) => (
            <tr key={key}>
              <td>{tick(key)}</td>
              <td>{g.name}</td>
              <td>{d.field === 'rsvp' ? 'RSVP' : d.field === 'meal' ? 'Meal' : 'Dietary'}</td>
              <td className="muted">{d.from}</td>
              <td>
                <b>{d.to}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PrivacyNote() {
  return (
    <div className="callout">
      <Icon name="info" size="sm" />
      <span>Emails, phone numbers, street addresses and similar details are removed as soon as the file is read. They are never shown, matched on or saved.</span>
    </div>
  );
}

export function RemovedColumns({ parsed }: { parsed: Parsed }) {
  if (!parsed.removed.length) return null;
  return (
    <div className="callout">
      <Icon name="lock" size="sm" />
      <span>
        Removed for privacy: {parsed.removed.map((r) => r.header).join(', ')}.
      </span>
    </div>
  );
}

/** Choose which sheet of a workbook to import. */
export function SheetPicker({ sheets, onPick }: { sheets: Sheet[]; onPick: (s: Sheet) => void }) {
  return (
    <div className="callout" style={{ display: 'grid', gap: 6 }}>
      <b>This workbook has {sheets.length} sheets. Which one is the guest list?</b>
      <div className="row" style={{ gap: 6 }}>
        {sheets.map((sh) => (
          <button key={sh.name} className="btn sm" onClick={() => onPick(sh)}>
            {sh.name} <span className="muted">· {sh.rows.filter((r) => r.some((c) => c.trim())).length - 1} rows</span>
          </button>
        ))}
      </div>
    </div>
  );
}
