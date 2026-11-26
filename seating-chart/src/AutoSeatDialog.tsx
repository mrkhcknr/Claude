import { useEffect, useRef, useState } from 'react';
import { autoSeat, type AutoSeatOptions, type AutoSeatResult } from './autoSeat';
import { getState, seatAtTable, setRelation, swapGuests, toast, update, updateTables, useStore } from './store';
import { DEFAULT_RULES, PRESETS, SLIDERS, rulesOf, type SeatingRules } from './rules';
import { errText, getSample, proposeFromIntent, reviewSeating, type Proposal, type Suggestion } from './claude';
import { REL_SHORT } from './scoring';
import { Dialog, Icon } from './ui';

type Tab = 'seat' | 'rules' | 'claude';

export function AutoSeatDialog({ open, onClose, initialTab = 'seat' }: { open: boolean; onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  return (
    <Dialog open={open} onClose={onClose} wide title="Auto-seat">
      <div className="seg" style={{ justifySelf: 'start' }}>
        <button aria-pressed={tab === 'seat'} onClick={() => setTab('seat')}>
          <Icon name="wand" size="sm" /> Seat guests
        </button>
        <button aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>
          <Icon name="settings" size="sm" /> Rules
        </button>
        <button aria-pressed={tab === 'claude'} onClick={() => setTab('claude')}>
          <Icon name="sparkle" size="sm" /> Ask Claude
        </button>
      </div>
      {tab === 'seat' && <SeatTab onDone={onClose} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'claude' && <ClaudeTab goSeat={() => setTab('seat')} goRules={() => setTab('rules')} />}
    </Dialog>
  );
}

// ---------------- run ----------------
function SeatTab({ onDone }: { onDone: () => void }) {
  const project = useStore((s) => s.project);
  const R = rulesOf(project.settings);
  const [opt, setOpt] = useState<AutoSeatOptions>({ mode: 'keep', includePending: false });
  const [res, setRes] = useState<AutoSeatResult | null>(null);
  const [running, setRunning] = useState(false);
  const seatedNow = Object.values(project.seating).flat().filter(Boolean).length;
  const pinned = project.guests.filter((g) => g.pinned).length;
  const locked = project.tables.filter((t) => t.locked).length;
  const setRule = (p: Partial<SeatingRules>) => update((d) => void (d.settings.rules = { ...(d.settings.rules ?? {}), ...p }));
  function run() {
    setRunning(true);
    setRes(null);
    setTimeout(() => {
      setRes(autoSeat(getState().project, opt));
      setRunning(false);
    }, 30);
  }
  function apply() {
    if (!res) return;
    update((d) => {
      d.seating = res.seating;
    });
    toast(`Seated ${res.placed} guests`, true);
    onDone();
  }
  return (
    <>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Auto-seat weighs everyone's ties, groups and sides using your <b>rules</b>, then orders the chairs at each table so the closest pairs sit side by side. Pinned guests and locked tables
        never move.
      </p>
      <div className="grid2">
        <div className="field">
          <span>Who to place</span>
          <div className="seg">
            <button aria-pressed={opt.mode === 'keep'} onClick={() => setOpt({ ...opt, mode: 'keep' })}>
              Only unseated
            </button>
            <button aria-pressed={opt.mode === 'reseat'} onClick={() => setOpt({ ...opt, mode: 'reseat' })}>
              Re-seat everyone
            </button>
          </div>
          <span className="muted" style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            {seatedNow} seated now · {pinned} pinned · {locked} locked tables
          </span>
        </div>
        <div className="field">
          <span>Table fill</span>
          <div className="seg">
            <button aria-pressed={R.balance === 'even'} onClick={() => setRule({ balance: 'even' })}>
              Spread evenly
            </button>
            <button aria-pressed={R.balance === 'full'} onClick={() => setRule({ balance: 'full' })}>
              Fill tables
            </button>
          </div>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={opt.includePending} onChange={(e) => setOpt({ ...opt, includePending: e.target.checked })} /> Also seat guests whose RSVP is pending
      </label>
      {res && (
        <div className="callout" style={{ display: 'grid', gap: 6 }}>
          <b>
            Placed {res.placed} guests{res.unplaced.length ? `, ${res.unplaced.length} didn't fit` : ''}.
          </b>
          {res.warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
          <span>Apply to see it on the plan. The Checks list shows anyone without a tie at their table. Undo is one click.</span>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={run} disabled={running}>
          {running ? <span className="spinner" /> : <Icon name="wand" size="sm" />} {res ? 'Try again' : 'Find seats'}
        </button>
        <button className="btn primary" onClick={apply} disabled={!res || running}>
          Apply
        </button>
      </div>
    </>
  );
}

// ---------------- rules ----------------
function RulesTab() {
  const project = useStore((s) => s.project);
  const R = rulesOf(project.settings);
  const set = (p: Partial<SeatingRules>) => update((d) => void (d.settings.rules = { ...(d.settings.rules ?? {}), ...p }));
  const changed = (Object.keys(DEFAULT_RULES) as (keyof SeatingRules)[]).filter((k) => R[k] !== DEFAULT_RULES[k]).length;
  return (
    <>
      <div className="row">
        <span className="label">Presets</span>
        {PRESETS.map((p) => (
          <button key={p.name} className="chip" title={p.help} onClick={() => update((d) => void (d.settings.rules = { ...p.rules }))}>
            {p.name}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={!changed} onClick={() => update((d) => void (d.settings.rules = {}))}>
          Reset {changed ? `(${changed} changed)` : ''}
        </button>
      </div>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="field">
          <span>Households (Joy parties, couples)</span>
          <select className="input" value={R.household} onChange={(e) => set({ household: e.target.value as SeatingRules['household'] })}>
            <option value="adjacent">Always side by side</option>
            <option value="table">Always the same table</option>
            <option value="soft">Strong preference only</option>
          </select>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <label className="check">
            <input type="checkbox" className="switch" checked={R.apartHard} onChange={(e) => set({ apartHard: e.target.checked })} /> "Never same table" is absolute
          </label>
          <label className="check">
            <input type="checkbox" className="switch" checked={R.neighbours} onChange={(e) => set({ neighbours: e.target.checked })} /> Seat the closest pairs side by side
          </label>
          <label className="check">
            <input type="checkbox" className="switch" checked={R.specificGroups} onChange={(e) => set({ specificGroups: e.target.checked })} /> Small groups count more than big ones
          </label>
        </div>
      </div>
      {SLIDERS.map((sec) => (
        <div key={sec.section} style={{ display: 'grid', gap: 10 }}>
          <span className="label">{sec.section}</span>
          {sec.items.map((it) => {
            const v = R[it.key] as number;
            const isDefault = v === DEFAULT_RULES[it.key];
            return (
              <div key={it.key} className="rule-row">
                <div>
                  <label htmlFor={'r-' + it.key} style={{ fontWeight: 500 }}>
                    {it.label}
                  </label>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {it.help}
                  </div>
                </div>
                <div className="rule-ctl">
                  <span className="muted end">{it.ends[0]}</span>
                  <input id={'r-' + it.key} type="range" min={it.min} max={it.max} step={it.step} value={v} onChange={(e) => set({ [it.key]: +e.target.value } as Partial<SeatingRules>)} />
                  <span className="muted end">{it.ends[1]}</span>
                  <output className="num">{+v.toFixed(1)}</output>
                  <button className="icon-btn sm" title="Reset to default" disabled={isDefault} onClick={() => set({ [it.key]: DEFAULT_RULES[it.key] } as Partial<SeatingRules>)}>
                    <Icon name="undo" size="sm" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Rules are saved with the seating chart, so anyone you share it with uses the same ones.
      </p>
    </>
  );
}

// ---------------- Claude ----------------
const EXAMPLES = [
  'Mix the two families at every table, but keep friend groups together.',
  'Keep the NYC friends near each other and seat the couples side by side.',
  'Grandparents near the entrance, kids together at one table.',
  'Seat people who only know one other person next to that person.',
];

function ClaudeTab({ goSeat, goRules }: { goSeat: () => void; goRules: () => void }) {
  const project = useStore((s) => s.project);
  const [avail, setAvail] = useState<boolean | null>(null);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState<'' | 'plan' | 'review'>('');
  const [err, setErr] = useState('');
  const [prop, setProp] = useState<Proposal | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<{ summary: string; suggestions: Suggestion[] } | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    void getSample().then((s) => setAvail(!!s));
  }, []);

  async function ask() {
    ctl.current = new AbortController();
    setBusy('plan');
    setErr('');
    setProp(null);
    try {
      setProp(await proposeFromIntent(getState().project, intent, ctl.current.signal));
      setSkip(new Set());
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') setErr(errText(e));
    } finally {
      setBusy('');
    }
  }
  async function doReview() {
    ctl.current = new AbortController();
    setBusy('review');
    setErr('');
    setReview(null);
    try {
      setReview(await reviewSeating(getState().project, intent, ctl.current.signal));
      setDone(new Set());
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') setErr(errText(e));
    } finally {
      setBusy('');
    }
  }
  function applyProposal() {
    if (!prop) return;
    const R = rulesOf(project.settings);
    update((d) => {
      const ruleKeys = Object.keys(prop.rules).filter((k) => !skip.has('rule:' + k));
      if (ruleKeys.length) d.settings.rules = { ...(d.settings.rules ?? {}), ...Object.fromEntries(ruleKeys.map((k) => [k, (prop.rules as Record<string, unknown>)[k]])) };
      prop.tags.forEach((t, i) => {
        if (skip.has('tag:' + i)) return;
        const g = d.guests.find((x) => x.id === t.guest);
        if (!g) return;
        const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
        if (!cur.some((x) => x.toLowerCase() === t.add.toLowerCase())) g.group = [...cur, t.add].join(', ');
      });
    });
    prop.ties.forEach((t, i) => !skip.has('tie:' + i) && setRelation(t.a, t.b, t.kind));
    prop.reserve.forEach((r, i) => !skip.has('res:' + i) && updateTables([r.table], { reservedFor: r.reservedFor }));
    void R;
    toast('Applied Claude’s suggestions. Run auto-seat to use them.', true);
    setProp(null);
    goSeat();
  }
  const tick = (key: string) => (
    <input
      type="checkbox"
      checked={!skip.has(key)}
      onChange={(e) => {
        const s = new Set(skip);
        if (e.target.checked) s.delete(key);
        else s.add(key);
        setSkip(s);
      }}
    />
  );
  const R = rulesOf(project.settings);
  const label = (k: string) => SLIDERS.flatMap((s) => s.items).find((i) => i.key === k)?.label ?? k;

  if (avail === false)
    return (
      <div className="callout">
        <Icon name="info" size="sm" />
        <span>Asking Claude works when this seating chart is opened in claude.ai. Everything else, including the rules, works here too.</span>
      </div>
    );
  return (
    <>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Describe how you want people seated. Claude turns it into rules, ties and tags for you to approve; auto-seat then does the placing. Claude sees guest names, tags, sides and the current
        seating, never contact details.
      </p>
      <textarea className="input" rows={3} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="e.g. Keep Mark’s high-school friends together and mix the families elsewhere." />
      <div className="row" style={{ gap: 5 }}>
        {EXAMPLES.map((x) => (
          <button key={x} className="chip" onClick={() => setIntent(x)}>
            {x}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!intent.trim() || !!busy} onClick={ask}>
          {busy === 'plan' ? <span className="spinner" /> : <Icon name="sparkle" size="sm" />} Turn into rules
        </button>
        <button className="btn" disabled={!!busy || !Object.values(project.seating).some((a) => a.some(Boolean))} onClick={doReview} title="Claude reviews the current seating and suggests swaps">
          {busy === 'review' ? <span className="spinner" /> : <Icon name="eye" size="sm" />} Review current seating
        </button>
        {busy && (
          <button className="btn ghost" onClick={() => ctl.current?.abort()}>
            Stop
          </button>
        )}
        {busy && <span className="muted">Claude is thinking. This can take up to a minute.</span>}
      </div>
      {err && <div className="callout warn">{err}</div>}

      {prop && (
        <div className="tcard" style={{ gap: 10 }}>
          <b>{prop.summary || 'Here’s what Claude suggests.'}</b>
          {prop.questions.length > 0 && (
            <div className="callout warn" style={{ display: 'grid' }}>
              {prop.questions.map((q, i) => (
                <span key={i}>{q}</span>
              ))}
            </div>
          )}
          {Object.keys(prop.rules).length > 0 && (
            <>
              <span className="label">Rule changes</span>
              {Object.entries(prop.rules).map(([k, v]) => (
                <label key={k} className="check">
                  {tick('rule:' + k)} {label(k)}: <span className="muted">{String((R as unknown as Record<string, unknown>)[k])}</span> → <b>{String(v)}</b>
                </label>
              ))}
            </>
          )}
          {prop.ties.length > 0 && (
            <>
              <span className="label">Ties</span>
              {prop.ties.map((t, i) => (
                <label key={i} className="check">
                  {tick('tie:' + i)} {t.aName} <span className="badge">{REL_SHORT[t.kind]}</span> {t.bName} <span className="muted">· {t.why}</span>
                </label>
              ))}
            </>
          )}
          {prop.tags.length > 0 && (
            <>
              <span className="label">Tags</span>
              {prop.tags.map((t, i) => (
                <label key={i} className="check">
                  {tick('tag:' + i)} Add <b>{t.add}</b> to {t.name}
                </label>
              ))}
            </>
          )}
          {prop.reserve.length > 0 && (
            <>
              <span className="label">Table reservations</span>
              {prop.reserve.map((r, i) => (
                <label key={i} className="check">
                  {tick('res:' + i)} {r.name}: reserved for <b>{r.reservedFor || 'nobody'}</b>
                </label>
              ))}
            </>
          )}
          <div className="row">
            <button className="btn primary" onClick={applyProposal}>
              Apply selected
            </button>
            <button className="btn ghost" onClick={goRules}>
              See all rules
            </button>
            <button className="btn ghost" onClick={() => setProp(null)}>
              Discard
            </button>
          </div>
        </div>
      )}

      {review && (
        <div className="tcard" style={{ gap: 8 }}>
          <b>{review.summary}</b>
          {!review.suggestions.length && <span className="muted">No changes suggested.</span>}
          {review.suggestions.map((s, i) => (
            <div key={i} className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', opacity: done.has(i) ? 0.5 : 1 }}>
              <span>
                {s.text} <span className="muted">· {s.why}</span>
              </span>
              <button
                className="btn sm"
                disabled={done.has(i)}
                onClick={() => {
                  if (s.kind === 'swap' && s.b) swapGuests(s.a, s.b);
                  else if (s.table) {
                    const n = seatAtTable([s.a], s.table);
                    if (!n) return toast('That table is full now');
                  }
                  setDone(new Set(done).add(i));
                }}
              >
                {done.has(i) ? 'Done' : 'Apply'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
