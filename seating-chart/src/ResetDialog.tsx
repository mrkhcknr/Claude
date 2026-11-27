import { useEffect, useMemo, useState } from 'react';
import { saveLayout, update, useStore } from './store';
import { Dialog, ask } from './ui';

type Part = 'seats' | 'relations' | 'placements' | 'rules' | 'guests' | 'imports' | 'floor' | 'saved';

/**
 * Clear only the parts of the chart you choose. Seat assignments are the only thing ticked by default;
 * clearing the guest list or the floor plan also clears what depends on it (shown, not hidden).
 */
export function ResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = useStore((s) => s.project);
  const [pick, setPick] = useState<Set<Part>>(new Set(['seats']));
  const [keepPinned, setKeepPinned] = useState(true);
  const [backupFloor, setBackupFloor] = useState(true);
  useEffect(() => {
    if (open) {
      setPick(new Set(['seats']));
      setKeepPinned(true);
      setBackupFloor(true);
    }
  }, [open]);

  const seated = useMemo(() => Object.values(p.seating).flat().filter(Boolean).length, [p.seating]);
  const pinnedSeated = useMemo(() => {
    const pinned = new Set(p.guests.filter((g) => g.pinned).map((g) => g.id));
    return Object.values(p.seating).flat().filter((g) => g && pinned.has(g)).length;
  }, [p]);
  const rulesChanged = Object.keys(p.settings.rules ?? {}).length;

  // clearing guests or the floor plan takes what depends on it with it
  const implied = new Set<Part>();
  if (pick.has('guests')) ['seats', 'relations', 'imports'].forEach((x) => implied.add(x as Part));
  if (pick.has('floor')) implied.add('seats');
  const on = (x: Part) => pick.has(x) || implied.has(x);
  const toggle = (x: Part) => setPick((s) => (s.has(x) ? new Set([...s].filter((y) => y !== x)) : new Set([...s, x])));

  const parts: { k: Part; label: string; detail: string; danger?: boolean }[] = [
    { k: 'seats', label: 'Seat assignments', detail: `${seated} guests seated now. Everyone goes back to unseated.` },
    { k: 'relations', label: 'Relationships', detail: `${p.relations.length} relationship${p.relations.length === 1 ? "" : "s"} drawn in the social graph.` },
    { k: 'placements', label: 'Group placements', detail: `${p.settings.placements?.length ?? 0} "where groups sit" assignments.` },
    { k: 'rules', label: 'Seating rules', detail: rulesChanged ? `${rulesChanged} rules changed from the defaults.` : 'Already at the defaults.' },
    { k: 'imports', label: 'Import history & discrepancies', detail: `${p.imports?.length ?? 0} imported lists. Clears dismissed discrepancies and list comparisons.` },
    { k: 'guests', label: 'Guest list', detail: `${p.guests.length} guests. Also clears their seats, relationships and import history.`, danger: true },
    { k: 'floor', label: 'Floor plan: tables & room', detail: `${p.tables.length} tables and ${p.elements.length} room items. Also clears seats.`, danger: true },
    { k: 'saved', label: 'Saved floor plans', detail: `${p.layouts?.length ?? 0} saved: ${(p.layouts ?? []).map((l) => l.name).join(', ') || 'none'}.`, danger: true },
  ];
  const chosen = parts.filter((x) => on(x.k));

  async function go() {
    if (!chosen.length) return;
    const ok = await ask(`Clear ${chosen.map((x) => x.label.toLowerCase()).join(', ')}?`, {
      detail: 'This changes the chart for everyone it is shared with. Undo is available right after.',
      ok: 'Clear',
      danger: chosen.some((x) => x.danger),
    });
    if (!ok) return;
    if (on('floor') && backupFloor && p.tables.length) saveLayout(`Before reset ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
    update((d) => {
      if (on('seats')) {
        const keep = new Set(keepPinned && !on('guests') && !on('floor') ? d.guests.filter((g) => g.pinned).map((g) => g.id) : []);
        for (const t of Object.keys(d.seating)) d.seating[t] = d.seating[t].map((g) => (g && keep.has(g) ? g : null));
      }
      if (on('relations')) d.relations = [];
      if (on('placements')) delete d.settings.placements;
      if (on('rules')) delete d.settings.rules;
      if (on('imports')) {
        d.imports = [];
        for (const g of d.guests) delete g.sources;
      }
      if (on('guests')) d.guests = [];
      if (on('floor')) {
        d.tables = [];
        d.elements = [];
        d.seating = {};
      }
      if (on('saved')) d.layouts = [];
    });
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reset"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${chosen.some((x) => x.danger) ? 'danger' : 'primary'}`} onClick={() => void go()} disabled={!chosen.length}>
            Clear {chosen.length} {chosen.length === 1 ? 'thing' : 'things'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Choose exactly what to clear. Everything else stays as it is.
      </p>
      <div className="reset-list">
        {parts.map((x) => (
          <label key={x.k} className={`reset-item ${x.danger ? 'danger' : ''} ${implied.has(x.k) && !pick.has(x.k) ? 'implied' : ''}`}>
            <input type="checkbox" checked={on(x.k)} disabled={implied.has(x.k) && !pick.has(x.k)} onChange={() => toggle(x.k)} />
            <span>
              <b>{x.label}</b>
              {implied.has(x.k) && !pick.has(x.k) && <span className="badge">included</span>}
              <span className="muted small">{x.detail}</span>
            </span>
          </label>
        ))}
      </div>
      {on('seats') && !on('guests') && !on('floor') && pinnedSeated > 0 && (
        <label className="check">
          <input type="checkbox" checked={keepPinned} onChange={(e) => setKeepPinned(e.target.checked)} /> Keep the {pinnedSeated} pinned guests in their seats
        </label>
      )}
      {on('floor') && p.tables.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={backupFloor} onChange={(e) => setBackupFloor(e.target.checked)} /> Save the current floor plan to Saved floor plans first
        </label>
      )}
    </Dialog>
  );
}
