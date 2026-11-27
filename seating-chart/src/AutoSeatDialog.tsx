import { useEffect, useRef, useState } from 'react';
import { autoSeat, type AutoSeatOptions, type AutoSeatResult } from './autoSeat';
import { getState, seatAtTable, setRelation, swapGuests, tableName, toast, update, updateTables, useStore } from './store';
import { DEFAULT_POINTS, POINT_KINDS, POINT_LABEL, pointsOf, rulesOf, type PointKind, type PointRow, type SeatingRules, DEFAULT_TABLE_POINTS } from './rules';
import { happinessOf } from './happiness';
import { errText, getSample, proposeFromIntent, reviewSeating, type Proposal, type Suggestion } from './claude';
import { describeTie } from './relations';
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
  const startSeated = Object.values(project.seating).flat().some(Boolean);
  // with a seating in place, the useful default is to fine-tune it; otherwise start fresh
  const [opt, setOpt] = useState<AutoSeatOptions>({ mode: startSeated ? 'improve' : 'reseat', includePending: false });
  const [res, setRes] = useState<AutoSeatResult | null>(null);
  const [running, setRunning] = useState(false);
  const seatedNow = Object.values(project.seating).flat().filter(Boolean).length;
  const seatedSet = new Set(Object.values(project.seating).flat().filter(Boolean));
  const unseatedNow = project.guests.filter((g) => (g.rsvp === 'yes' || (opt.includePending && g.rsvp === 'pending')) && !seatedSet.has(g.id)).length;
  const pinned = project.guests.filter((g) => g.pinned).length;
  const locked = project.tables.filter((t) => t.locked).length;
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
      <ol className="steps" style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)' }}>
        <li>
          <b>Table tags.</b> Guests start at a table whose tags match theirs, households together. Tags orient the layout; they aren't requirements.
        </li>
        <li>
          <b>Connections.</b> Everyone else goes where they have the most relationships, household members or shared tags.
        </li>
        <li>
          <b>Happiness.</b> Guests and couples swap chairs, even to another table, while that raises total happiness points (see Rules).
        </li>
      </ol>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Always: "never same table" is respected, pinned guests and tables with locked seats stay put, and couples and households get side-by-side chairs.
      </p>
      <div className="field">
        <span>Who to place</span>
        <div className="seg wrap">
          <button aria-pressed={opt.mode === 'improve'} onClick={() => setOpt({ ...opt, mode: 'improve' })}>
            Improve current seating
          </button>
          <button aria-pressed={opt.mode === 'keep'} onClick={() => setOpt({ ...opt, mode: 'keep' })}>
            Seat new guests only
          </button>
          <button aria-pressed={opt.mode === 'reseat'} onClick={() => setOpt({ ...opt, mode: 'reseat' })}>
            Start over
          </button>
        </div>
        <span className="muted" style={{ fontSize: 12.5, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          {opt.mode === 'improve'
            ? 'Keeps your seating and only makes swaps that raise happiness (after seating anyone new). Best after changing the social graph.'
            : opt.mode === 'keep'
              ? 'Seats people without a seat. Nobody already seated moves.'
              : 'Seats everyone from scratch (pinned guests and tables with locked seats stay).'}
        </span>
        <span className="muted" style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          {seatedNow} seated now · {pinned} pinned · {locked} tables with locked seats
        </span>
        {opt.mode === 'keep' && unseatedNow === 0 && (
          <span className="callout warn" style={{ fontSize: 12.5, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            Everyone coming already has a seat, so this won't change anything. Choose "Improve current seating" or "Start over".
          </span>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={opt.includePending} onChange={(e) => setOpt({ ...opt, includePending: e.target.checked })} /> Also seat guests whose RSVP is pending
      </label>
      {res && (
        <div className="callout" style={{ display: 'grid', gap: 6 }}>
          <b>
            Placed {res.placed} guests{res.unplaced.length ? `, ${res.unplaced.length} didn't fit` : ''}.
          </b>
          {res.tagWanted > 0 && (
            <span>
              {res.tagMatched} of {res.tagWanted} guests with a tagged table are at one.
            </span>
          )}
          <span>
            Happiness: <b className="num">{res.after.toLocaleString()}</b> points
            {res.after !== res.before && <span className="muted"> (swapping seats added {(res.after - res.before).toLocaleString()})</span>}
          </span>
          <LeastHappy seating={res.seating} />
          <MovesList res={res} />
          {res.warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
          <span>Apply to see it on the plan. Hover a seat to see that guest's points. Undo is one click.</span>
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
  return (
    <>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Auto-seat starts people at <b>tables tagged for them</b>, seats everyone else by <b>connections</b>, then swaps chairs to raise happiness. Table tags are a nudge, not a
        requirement. Only these two switches are hard rules.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        <label className="check">
          <input type="checkbox" className="switch" checked={R.couplesSideBySide} onChange={(e) => set({ couplesSideBySide: e.target.checked })} /> Seat couples and households side by side
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={R.apartHard} onChange={(e) => set({ apartHard: e.target.checked })} /> "Never same table" is absolute
        </label>
      </div>
      <PointsTable />
      <label className="field">
        <span>Sitting at a table tagged for you</span>
        <span className="muted" style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          Points each guest earns at a matching table. Higher keeps tag groups at their tables; 0 means tags only set the starting layout.
        </span>
        <input
          className="input num"
          type="number"
          min={0}
          step={1}
          style={{ width: 90 }}
          value={R.tablePoints ?? DEFAULT_TABLE_POINTS}
          onChange={(e) => set({ tablePoints: Math.max(0, +e.target.value || 0) })}
        />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Rules are saved with the seating chart, so anyone you share it with uses the same ones.
      </p>
    </>
  );
}

/** Editable happiness points: relationship × next to / across from / same table. */
function PointsTable() {
  const project = useStore((s) => s.project);
  const R = rulesOf(project.settings);
  const P = pointsOf(R);
  const changed = POINT_KINDS.some((k) => JSON.stringify(P[k]) !== JSON.stringify(DEFAULT_POINTS[k]));
  const set = (k: PointKind, col: keyof PointRow, v: number) =>
    update((d) => {
      const r = (d.settings.rules ??= {});
      r.points = { ...(r.points ?? {}), [k]: { ...P[k], [col]: v } };
    });
  return (
    <div className="field">
      <span>Happiness points</span>
      <span className="muted" style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
        After tags and connections place everyone, auto-seat swaps guests between chairs to raise the total. Each guest earns these points for the people near them; every further
        person counts a little less (×0.85) so nobody hoards all their friends. Small social groups count more than big ones.
      </span>
      <table className="points-table">
        <thead>
          <tr>
            <th />
            <th>Next to</th>
            <th>Across from</th>
            <th>Same table</th>
            <th>Next table in row</th>
          </tr>
        </thead>
        <tbody>
          {POINT_KINDS.map((k) => (
            <tr key={k}>
              <th>{POINT_LABEL[k]}</th>
              {(['next', 'across', 'same', 'row'] as const).map((c) => (
                <td key={c}>
                  <input className="input num" type="number" step={1} value={P[k][c]} onChange={(e) => set(k, c, +e.target.value || 0)} aria-label={`${POINT_LABEL[k]} ${c}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <button className="btn ghost sm" disabled={!changed} onClick={() => update((d) => d.settings.rules && delete d.settings.rules.points)}>
          Reset points
        </button>
      </div>
    </div>
  );
}

/** The five guests with the fewest points, so gaps are easy to spot. */
function LeastHappy({ seating }: { seating: AutoSeatResult['seating'] }) {
  const project = useStore((s) => s.project);
  const h = happinessOf(project, seating);
  const byId = new Map(project.guests.map((g) => [g.id, g]));
  const low = [...h.byGuest].sort((a, b) => a[1].points - b[1].points).slice(0, 5);
  if (!low.length) return null;
  return (
    <span className="muted" style={{ fontSize: 12.5 }}>
      Fewest points: {low.map(([g, x]) => `${byId.get(g)?.name} (${Math.round(x.points)})`).join(', ')}. Drawing a Friend or Introduce line for them helps most.
    </span>
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
      prop.points.forEach((c, i) => {
        if (skip.has('pt:' + i)) return;
        const r = (d.settings.rules ??= {});
        const P = pointsOf(r);
        r.points = { ...(r.points ?? {}), [c.kind]: { ...P[c.kind], [c.col]: c.to } };
      });
      prop.tags.forEach((t, i) => {
        if (skip.has('tag:' + i)) return;
        const g = d.guests.find((x) => x.id === t.guest);
        if (!g) return;
        const cur = g.group.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
        if (!cur.some((x) => x.toLowerCase() === t.add.toLowerCase())) g.group = [...cur, t.add].join(', ');
      });
    });
    prop.ties.forEach((t, i) => !skip.has('tie:' + i) && setRelation(t.a, t.b, { kind: t.kind, seat: t.seat, ...(t.contexts ? { contexts: t.contexts } : {}) }));
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
        Describe how you want people seated. Claude turns it into table tags, guest tags, relationships and point changes for you to approve; auto-seat then does the placing. Claude sees guest names, tags, sides and the current
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
          {prop.points.length > 0 && (
            <>
              <span className="label">Happiness points</span>
              {prop.points.map((c, i) => (
                <label key={i} className="check">
                  {tick('pt:' + i)} {POINT_LABEL[c.kind]}, {COL_LABEL[c.col]}: <span className="muted">{c.from}</span> → <b>{c.to}</b>
                </label>
              ))}
            </>
          )}
          {prop.ties.length > 0 && (
            <>
              <span className="label">Ties</span>
              {prop.ties.map((t, i) => (
                <label key={i} className="check">
                  {tick('tie:' + i)} {t.aName} <span className="badge">{describeTie(t)}</span> {t.bName} <span className="muted">· {t.why}</span>
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


const COL_LABEL: Record<keyof PointRow, string> = { next: 'next to', across: 'across from', same: 'same table', row: 'next table in row' };

/** Who moved in this run, so changes are easy to review before applying. */
function MovesList({ res }: { res: AutoSeatResult }) {
  const project = useStore((s) => s.project);
  const [open, setOpen] = useState(false);
  if (!res.moves.length) return <span>No seats changed.</span>;
  const byId = new Map(project.guests.map((g) => [g.id, g]));
  const tname = (id?: string) => {
    const t = project.tables.find((x) => x.id === id);
    return t ? tableName(t) : 'no seat';
  };
  const newly = res.moves.filter((m) => !m.from).length;
  const within = res.moves.filter((m) => m.sameTable).length;
  const between = res.moves.length - newly - within;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span>
        {between > 0 && `${between} guest${between === 1 ? '' : 's'} change table`}
        {between > 0 && (within > 0 || newly > 0) && ' · '}
        {within > 0 && `${within} change seat at the same table`}
        {within > 0 && newly > 0 && ' · '}
        {newly > 0 && `${newly} newly seated`}{' '}
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} changes
        </button>
      </span>
      {open && (
        <ul className="moves-list">
          {res.moves
            .filter((m) => !m.sameTable)
            .map((m) => (
              <li key={m.guestId}>
                <b>{byId.get(m.guestId)?.name}</b>: {m.from ? tname(m.from) : 'unseated'} → {tname(m.to)}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
