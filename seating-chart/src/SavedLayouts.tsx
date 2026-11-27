import { useState } from 'react';
import { deleteLayout, loadLayout, saveLayout, useStore } from './store';
import { Dialog, Icon } from './ui';

/** Named copies of the room and tables, saved with the chart so anyone sharing it can load them. */
export function SavedLayoutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const layouts = [...(project.layouts ?? [])].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const [name, setName] = useState('');
  const seats = project.tables.reduce((a, t) => a + t.seats, 0);
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const same = layouts.find((l) => l.name.toLowerCase() === n.toLowerCase());
    saveLayout(n, same?.id);
    setName('');
  };
  return (
    <Dialog open={open} onClose={onClose} title="Saved floor plans">
      <p className="muted" style={{ margin: 0 }}>
        Save the room and tables as they are now, then load them back any time. Guests and seating aren't part of a saved floor plan.
      </p>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" style={{ flex: 1 }} value={name} placeholder="Name, e.g. Brickyard Wedding" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} aria-label="Floor plan name" />
        <button className="btn primary" onClick={save} disabled={!name.trim() || !project.tables.length}>
          Save current plan
        </button>
      </div>
      <span className="muted small">
        Current plan: {project.tables.length} tables · {seats} seats · {project.elements.length} room items
      </span>
      <div className="saved-layouts">
        {layouts.map((l) => (
          <div key={l.id} className="saved-layout">
            <div>
              <b>{l.name}</b>
              <div className="muted small">
                {l.tables.length} tables · {l.tables.reduce((a, t) => a + t.seats, 0)} seats · {l.elements.length} room items · saved {new Date(l.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            </div>
            <button className="btn sm" onClick={() => void loadLayout(l.id).then(onClose)}>
              Load
            </button>
            <button className="btn ghost sm" title="Replace this saved plan with the current room and tables" onClick={() => saveLayout(l.name, l.id)} disabled={!project.tables.length}>
              Update
            </button>
            <button className="icon-btn sm" aria-label={`Delete ${l.name}`} onClick={() => void deleteLayout(l.id)}>
              <Icon name="trash" size="sm" />
            </button>
          </div>
        ))}
        {!layouts.length && <span className="muted">No saved floor plans yet.</span>}
      </div>
    </Dialog>
  );
}
