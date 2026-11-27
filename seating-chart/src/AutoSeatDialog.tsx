import { useEffect, useRef, useState } from 'react';
import { autoSeat, type AutoSeatOptions, type AutoSeatResult } from './autoSeat';
import { getState, seatAtTable, setRelation, swapGuests, tableName, toast, update, updateTables, useStore } from './store';
import { SLIDERS, DEFAULT_POINTS, POINT_KINDS, POINT_LABEL, pointsOf, rulesOf, type PointKind, type PointRow, type SeatingRules } from './rules';
import { happinessOf } from './happiness';
import { errText, getSample, proposeFromIntent, reviewSeating, type Proposal, type Suggestion } from './claude';
import { describeTie } from './relations';
import { allTags } from './filters';
import { groupLabel, inGroup, targetHas, targetLabel } from './scoring';
import { uid } from './util';
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
  const [opt, setOpt] = useState<AutoSeatOptions>({ mode: 'keep', includePending: false });
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
          <b>Table tags first.</b> Guests whose tags match a table's tags sit there, households together. If a tag has more guests than seats, the rest go to step 2.
        </li>
        <li>
          <b>Then connections.</b> Everyone else goes to the table where they have the most relationships or household members, then next to people who share a tag, then any free seat.
        </li>
      </ol>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Always: "never same table" is respected, pinned guests and locked tables stay put, and couples and households get side-by-side chairs.
      </p>
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
        {opt.mode === 'keep' && unseatedNow === 0 && (
          <span className="callout warn" style={{ fontSize: 12.5, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            Everyone coming already has a seat, so "Only unseated" won't change anything. Choose "Re-seat everyone" to apply new table tags.
          </span>
        )}
      </div>
      <Placements />
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
        Auto-seat follows two steps: <b>table tags</b> first, then <b>connections</b> (relationships and households). Give tables tags in the table panel, and draw relationships in the
        social graph. These switches are the only other rules.
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

// ---------------- where groups sit ----------------
function Placements() {
  const project = useStore((s) => s.project);
  const list = project.settings.placements ?? [];
  const [group, setGroup] = useState('');
  const [target, setTarget] = useState('');
  const tags = allTags(project);
  const areas = [...new Set(project.tables.map((t) => t.area?.trim()).filter(Boolean))] as string[];
  const s = project.settings;
  const groups: [string, string][] = [...tags.map((t) => [t.label.toLowerCase(), t.label] as [string, string]), ['partner1', `${s.partner1}'s side`], ['partner2', `${s.partner2}'s side`], ['kids', 'Kids']];
  const attending = project.guests.filter((g) => g.rsvp !== 'no');
  const add = () => {
    if (!group || !target) return;
    update((d) => void (d.settings.placements = [...(d.settings.placements ?? []), { id: uid(), group, target }]));
    setGroup('');
    setTarget('');
  };
  const remove = (id: string) => update((d) => void (d.settings.placements = (d.settings.placements ?? []).filter((p) => p.id !== id)));
  return (
    <div className="field placements">
      <span>Where groups sit</span>
      {list.map((pl) => {
        const n = attending.filter((g) => inGroup(g, pl.group)).length;
        const seats = project.tables.filter((t) => targetHas(pl.target, t)).reduce((a, t) => a + t.seats, 0);
        return (
          <div key={pl.id} className="placement">
            <b>{groupLabel(pl.group, project)}</b> <span className="muted">({n})</span> → <b>{targetLabel(pl.target, project)}</b>{' '}
            <span className={`muted ${n > seats ? 'warn-text' : ''}`}>({seats} seats)</span>
            <button className="icon-btn sm" aria-label="Remove" onClick={() => remove(pl.id)}>
              <Icon name="x" size="sm" />
            </button>
          </div>
        );
      })}
      <div className="row" style={{ gap: 6 }}>
        <select className="input" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">Group…</option>
          {groups.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <span className="muted">sits at</span>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Table or area">
          <option value="">Table or area…</option>
          {areas.length > 0 && (
            <optgroup label="Areas">
              {areas.map((a) => (
                <option key={a} value={'area:' + a}>
                  {a}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Tables">
            {project.tables.map((t) => (
              <option key={t.id} value={'table:' + t.id}>
                {t.label}
                {tableName(t) !== t.label ? ` · ${tableName(t)}` : ''}
              </option>
            ))}
          </optgroup>
        </select>
        <button className="btn sm" onClick={add} disabled={!group || !target}>
          Add
        </button>
      </div>
      {!areas.length && <span className="muted small">Give tables an Area (in the table panel) to assign groups to a whole room.</span>}
    </div>
  );
}
