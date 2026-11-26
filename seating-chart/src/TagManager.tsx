import { useMemo, useState } from 'react';
import { getState, setSelection, setView, useStore } from './store';
import { allTags, setFilters } from './filters';
import { TAG_SWATCHES, addTagTo, deleteTag, renameTag, setTagColor, tagColor } from './tags';
import { Dialog, Icon, Menu, TextField, ask } from './ui';
import { groupTags } from './scoring';

export function TagManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [q, setQ] = useState('');
  const [newTag, setNewTag] = useState('');
  const tags = useMemo(() => allTags(project), [project]);
  const shown = tags.filter((t) => t.label.toLowerCase().includes(q.trim().toLowerCase()));
  const selGuests = selection?.type === 'guest' ? selection.ids : [];

  async function rename(from: string, to: string) {
    const target = tags.find((t) => t.label.toLowerCase() === to.trim().toLowerCase() && t.label.toLowerCase() !== from.toLowerCase());
    if (target && !(await ask(`Merge "${from}" into "${target.label}"?`, { detail: `Everyone tagged "${from}" will be tagged "${target.label}" instead. You can undo this.`, ok: 'Merge' }))) return;
    renameTag(from, target ? target.label : to);
  }
  function guestsWith(tag: string) {
    const k = tag.toLowerCase();
    return getState().project.guests.filter((g) => groupTags(g).includes(k)).map((g) => g.id);
  }

  return (
    <Dialog open={open} onClose={onClose} title="Tags" footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Rename, merge, recolour or remove tags for every guest at once. Renaming a tag to one that already exists merges them. Changes can be undone.
      </p>
      <div className="row">
        <div className="search" style={{ flex: 1, minWidth: 200 }}>
          <Icon name="search" size="sm" />
          <input className="input" type="search" placeholder="Find a tag…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a tag" />
        </div>
        {selGuests.length > 0 && (
          <span className="row" style={{ gap: 6 }}>
            <input
              className="input"
              style={{ width: 170 }}
              placeholder={`New tag for ${selGuests.length} selected`}
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTag.trim()) {
                  addTagTo(selGuests, newTag);
                  setNewTag('');
                }
              }}
              aria-label="New tag for selected guests"
            />
            <button
              className="btn sm"
              disabled={!newTag.trim()}
              onClick={() => {
                addTagTo(selGuests, newTag);
                setNewTag('');
              }}
            >
              Add
            </button>
          </span>
        )}
      </div>
      {!tags.length && <span className="muted">No tags yet. Import your guest list or add a tag to a guest.</span>}
      <div className="tag-list">
        {shown.map((t) => {
          const i = tags.indexOf(t);
          const color = tagColor(project, t.label, i);
          const custom = !!project.settings.tagColors?.[t.label.toLowerCase()];
          return (
            <div key={t.label} className="tag-row">
              <Menu label={`Colour for ${t.label}`} className="swatch-btn" trigger={<span className="dot" style={{ background: color, width: 14, height: 14 }} />}>
                {(close) => (
                  <div style={{ padding: 8, display: 'grid', gap: 8 }}>
                    <div className="swatches">
                      {TAG_SWATCHES.map((c) => (
                        <button key={c} className="swatch" style={{ background: c }} aria-label={c} onClick={() => (setTagColor(t.label, c), close())} />
                      ))}
                    </div>
                    <button className="btn ghost sm" disabled={!custom} onClick={() => (setTagColor(t.label, null), close())}>
                      Automatic colour
                    </button>
                  </div>
                )}
              </Menu>
              <TextField className="input tag-name" value={t.label} onCommit={(v) => v.trim() && void rename(t.label, v)} />
              <span className="muted num" style={{ minWidth: 70, textAlign: 'right' }}>
                {t.count} guest{t.count === 1 ? '' : 's'}
              </span>
              <button
                className="btn ghost sm"
                title="Select these guests"
                onClick={() => {
                  setSelection({ type: 'guest', ids: guestsWith(t.label) });
                  setFilters({ tags: [t.label.toLowerCase()] });
                  setView('guests');
                  onClose();
                }}
              >
                Show
              </button>
              <button
                className="icon-btn sm"
                title={`Remove "${t.label}" from everyone`}
                onClick={async () => {
                  if (await ask(`Remove the tag "${t.label}"?`, { detail: `It comes off all ${t.count} guests. The guests themselves stay. You can undo this.`, ok: 'Remove tag', danger: true })) deleteTag(t.label);
                }}
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
