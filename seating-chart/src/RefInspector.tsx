import type { RefLayer } from './types';
import { deleteSelection, getState, setTool } from './store';
import { projectBounds } from './geometry';
import { refToWorld, updateRef } from './refs';
import { Icon, NumField, TextField } from './ui';

export function RefInspector({ r }: { r: RefLayer }) {
  const s = getState().project.settings;
  const widthFt = r.imgW * r.scale;
  const set = (p: Partial<RefLayer>) => updateRef(r.id, p);
  const center = refToWorld(r, { x: r.imgW / 2, y: r.imgH / 2 });
  return (
    <>
      <div className="section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="label">Venue floor plan</span>
          <span className="row" style={{ gap: 2 }}>
            <button className="icon-btn sm" aria-pressed={r.visible} title={r.visible ? 'Hide' : 'Show'} onClick={() => set({ visible: !r.visible })}>
              <Icon name="eye" size="sm" />
            </button>
            <button className="icon-btn sm" aria-pressed={r.locked} title={r.locked ? 'Unlock' : 'Lock in place'} onClick={() => set({ locked: !r.locked })}>
              <Icon name={r.locked ? 'lock' : 'unlock'} size="sm" />
            </button>
            <button className="icon-btn sm" title="Remove this plan" onClick={deleteSelection}>
              <Icon name="trash" size="sm" />
            </button>
          </span>
        </div>
        <h2 className="insp-title">
          <TextField className="" value={r.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </h2>
        <label className="field">
          <span>Opacity</span>
          <input type="range" min={0.05} max={1} step={0.05} value={r.opacity} onChange={(e) => updateRef(r.id, { opacity: +e.target.value }, false)} />
        </label>
      </div>
      <div className="section">
        <h3>Line it up</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Click a point on the plan image, then the same point on your layout; repeat once more. Position, size and rotation are set together.
        </p>
        <div className="row">
          <button className="btn primary" disabled={r.locked || !r.visible} onClick={() => setTool('refAlign')}>
            <Icon name="link" size="sm" /> Match 2 points
          </button>
          <button className="btn" disabled={r.locked || !r.visible} onClick={() => setTool('refScale')} title="Click two ends of something whose real length you know">
            Set scale from a length
          </button>
        </div>
        <button
          className="btn ghost sm"
          disabled={r.locked}
          onClick={() => {
            const b = projectBounds(getState().project);
            const scale = (b.x1 - b.x0) / r.imgW;
            set({ scale, rotation: 0, x: b.x0, y: (b.y0 + b.y1) / 2 - (r.imgH * scale) / 2 });
          }}
        >
          Stretch over the current room
        </button>
      </div>
      <div className="section">
        <h3>Exact placement</h3>
        <div className="grid2">
          <label className="field">
            <span>Width of the image</span>
            <NumField
              value={widthFt}
              settings={s}
              min={1}
              max={2000}
              onChange={(v) => {
                // scale about the image centre
                const k = v / widthFt;
                set({ scale: r.scale * k, x: center.x + (r.x - center.x) * k, y: center.y + (r.y - center.y) * k });
              }}
            />
          </label>
          <label className="field">
            <span>Rotation</span>
            <NumField value={r.rotation} step={0.5} min={-360} max={720} unit="°" onChange={(v) => set({ rotation: ((v % 360) + 360) % 360 })} />
          </label>
          <label className="field">
            <span>Left edge</span>
            <NumField value={r.x} settings={s} min={-2000} max={2000} onChange={(v) => set({ x: v })} />
          </label>
          <label className="field">
            <span>Top edge</span>
            <NumField value={r.y} settings={s} min={-2000} max={2000} onChange={(v) => set({ y: v })} />
          </label>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          With the plan selected you can also drag it, pull the square corner to resize, or the round handle to rotate. Lock it once it lines up.
        </p>
      </div>
    </>
  );
}
