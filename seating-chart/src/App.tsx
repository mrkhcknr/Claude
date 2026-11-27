import { useEffect, useMemo, useState, useRef } from 'react';
import { SavedLayoutsDialog } from './SavedLayouts';
import { ResetDialog } from './ResetDialog';
import { deleteSelection, duplicateSelection, getState, redo, setSelection, setTool, setView, undo, update, updateTables, useStore } from './store';
import { analyse } from './scoring';
import { useDrag } from './dnd';
import { useSync } from './sync';
import { FloorPlan } from './FloorPlan';
import { GuestPanel } from './GuestPanel';
import { Inspector } from './Inspector';
import { NetworkView } from './NetworkView';
import { ListsView } from './ListsView';
import { GuestsView } from './GuestsView';
import { CrosscheckDialog } from './CrosscheckDialog';
import { TagManager } from './TagManager';
import { AutoSeatDialog, ImportDialog, OpenFileDialog, SettingsDialog } from './Dialogs';
import { BrandMark, ConfirmHost, Icon, Menu, MenuItem } from './ui';
import { backupJson, fileBase, saveFile, seatingChartHtml } from './exporters';
import { setTableLang, tableName } from './store';

export function App() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const toastMsg = useStore((s) => s.toast);
  const sync = useSync();
  const [dlg, setDlg] = useState<'' | 'import' | 'cross' | 'auto' | 'rules' | 'claude' | 'settings' | 'open' | 'tags' | 'layouts' | 'reset'>('');
  const selection = useStore((s) => s.selection);
  const [mpane, setMpane] = useState<'guests' | 'stage' | 'details'>('stage');
  /** where to return when details are closed on a phone */
  const lastPane = useRef<'guests' | 'stage'>('stage');
  // analysis is shared by every panel; recomputed when the project changes
  const analysis = useMemo(() => analyse(project), [project]);

  useEffect(() => {
    try {
      const t = localStorage.getItem('wsp:theme');
      if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t);
    } catch {
      /* ignore */
    }
    const open = () => setDlg('open');
    const tags = () => setDlg('tags');
    const reset = () => setDlg('reset');
    const pickSeat = () => {
      setView('plan');
      setMpane('stage');
    };
    window.addEventListener('app:pick-seat', pickSeat);
    const showDetails = () => setMpane((m) => (m === 'details' ? m : ((lastPane.current = m), 'details')));
    const closeDetails = () => setMpane(lastPane.current);
    window.addEventListener('app:show-details', showDetails);
    window.addEventListener('app:close-details', closeDetails);
    window.addEventListener('app:open-layout', open);
    window.addEventListener('app:tags', tags);
    window.addEventListener('app:reset', reset);
    return () => {
      window.removeEventListener('app:reset', reset);
      window.removeEventListener('app:pick-seat', pickSeat);
      window.removeEventListener('app:show-details', showDetails);
      window.removeEventListener('app:close-details', closeDetails);
      window.removeEventListener('app:open-layout', open);
      window.removeEventListener('app:tags', tags);
    };
  }, []);

  useEffect(() => {
    document.title = `${project.name} · Seating`;
  }, [project.name]);

  // keyboard shortcuts
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && k === 'a' && getState().view === 'plan') {
        e.preventDefault();
        setSelection({ type: 'table', ids: getState().project.tables.map((t) => t.id) });
        return;
      }
      if (mod) return;
      const st = getState();
      if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        deleteSelection();
      } else if (k === 'escape') {
        setSelection(null);
        setTool('select');
      } else if (st.view === 'plan') {
        if (k === 'v') setTool('select');
        else if (k === 'h') setTool('pan');
        else if (k === 'w') setTool('wall');
        else if (k === 'c') setTool('column');
        else if (k === 'd') setTool('door');
        else if (k === '0') window.dispatchEvent(new Event('plan:fit'));
        else if (k === 'r' && st.selection?.type === 'table') updateTables(st.selection.ids, (t) => void (t.rotation = (t.rotation + (e.shiftKey ? -15 : 15) + 360) % 360));
        else if (k.startsWith('arrow') && st.selection && st.selection.type !== 'guest') {
          e.preventDefault();
          const step = e.shiftKey ? 2 : e.altKey ? 0.1 : st.project.settings.gridSize;
          const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
          const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
          const ids = new Set(st.selection.ids);
          update((d) => {
            for (const t of d.tables) if (ids.has(t.id) && !t.locked) (t.x += dx), (t.y += dy);
            for (const el of d.elements)
              if (ids.has(el.id)) {
                if (el.kind === 'wall') (el.x1 += dx), (el.x2 += dx), (el.y1 += dy), (el.y2 += dy);
                else (el.x += dx), (el.y += dy);
              }
          });
        }
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  const syncLabel =
    sync.mode === 'shared'
      ? sync.pending
        ? 'Saving…'
        : 'Saved · shared'
      : sync.mode === 'connecting'
        ? 'Connecting…'
        : sync.mode === 'readonly'
          ? 'View only'
          : sync.mode === 'offline'
            ? 'Not connected'
            : 'Saved in this browser';

  return (
    <div className="app" data-mpane={mpane} data-panels={view === 'guests' ? (selection?.type === 'guest' && selection.ids.length === 1 ? 'full-detail' : 'full') : undefined}>
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <input value={project.name} onChange={(e) => update((d) => void (d.name = e.target.value))} aria-label="Seating chart name" />
        </div>
        <span className="sync-pill hide-sm" data-mode={sync.mode} data-busy={sync.pending > 0} title={sync.error || syncLabel}>
          {syncLabel}
        </span>
        <span className="spacer" />
        <nav className="seg" aria-label="Views">
          <button aria-pressed={view === 'plan'} onClick={() => setView('plan')} aria-label="Floor plan" title="Floor plan">
            <Icon name="plan" size="sm" /> <span className="hide-sm">Floor plan</span>
          </button>
          <button aria-pressed={view === 'guests'} onClick={() => setView('guests')} aria-label="Guests" title="Guests">
            <Icon name="users" size="sm" /> <span className="hide-sm">Guests</span>
          </button>
          <button aria-pressed={view === 'network'} onClick={() => setView('network')} aria-label="Social graph" title="Social graph">
            <Icon name="graph" size="sm" /> <span className="hide-sm">Social graph</span>
          </button>
          <button aria-pressed={view === 'lists'} onClick={() => setView('lists')} aria-label="Lists & export" title="Lists & export">
            <Icon name="list" size="sm" /> <span className="hide-sm">Lists & export</span>
          </button>
        </nav>
        <span className="spacer" />
        <nav className="seg lang-seg hide-sm" aria-label="Table name language" title="Table names: Chinese, English, or both">
          {(['zh', 'en', 'both'] as const).map((l) => (
            <button key={l} lang={l === 'en' ? 'en' : 'zh'} aria-pressed={(project.settings.tableLang ?? 'both') === l} onClick={() => setTableLang(l)}>
              {l === 'zh' ? '中' : l === 'en' ? 'EN' : '中+EN'}
            </button>
          ))}
        </nav>
        <button className="icon-btn" onClick={undo} disabled={!past} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Icon name="undo" />
        </button>
        <button className="icon-btn hide-xs" onClick={redo} disabled={!future} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Icon name="redo" />
        </button>
        <button className="btn primary hide-sm" onClick={() => setDlg('auto')} disabled={!project.tables.length || !project.guests.length}>
          <Icon name="wand" size="sm" /> Auto-seat
        </button>
        <button className="icon-btn primary show-sm" onClick={() => setDlg('auto')} disabled={!project.tables.length || !project.guests.length} aria-label="Auto-seat" title="Auto-seat">
          <Icon name="wand" />
        </button>
        <Menu label="More" className="icon-btn" align="end" trigger={<Icon name="more" />}>
          {(close) => (
            <>
              <div className="show-sm menu-lang" role="group" aria-label="Table name language">
                {(['zh', 'en', 'both'] as const).map((l) => (
                  <button key={l} className="chip" aria-pressed={(project.settings.tableLang ?? 'both') === l} onClick={() => setTableLang(l)}>
                    {l === 'zh' ? '中文' : l === 'en' ? 'English' : '中+EN'}
                  </button>
                ))}
              </div>
              <div className="show-sm menu-sep" />
              <MenuItem icon="upload" onClick={() => (setDlg('import'), close())}>
                Import guests (Joy, CSV…)
              </MenuItem>
              <MenuItem icon="check" onClick={() => (setDlg('cross'), close())}>
                Crosscheck RSVPs & meals
              </MenuItem>
              <MenuItem icon="flower" onClick={() => (setDlg('tags'), close())}>
                Manage tags
              </MenuItem>
              <MenuItem icon="plan" onClick={() => (setDlg('layouts'), close())}>
                Saved floor plans…
              </MenuItem>
              <MenuItem icon="layout" onClick={() => (setDlg('open'), close())}>
                Open layout or backup
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="file" onClick={() => (void saveFile(`${fileBase(project)}-seating-chart.html`, seatingChartHtml(project), 'text/html'), close())}>
                Download seating chart
              </MenuItem>
              <MenuItem icon="download" onClick={() => (void saveFile(`${fileBase(project)}-backup.json`, backupJson(project), 'application/json'), close())}>
                Download backup
              </MenuItem>
              <MenuItem icon="list" onClick={() => (setView('lists'), close())}>
                All exports…
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="undo" onClick={() => (setDlg('reset'), close())}>
                Reset…
              </MenuItem>
              <MenuItem icon="settings" onClick={() => (setDlg('settings'), close())}>
                Settings
              </MenuItem>
            </>
          )}
        </Menu>
      </header>

      {sync.error && <div className="banner">{sync.error}</div>}

      <GuestPanel analysis={analysis} onImport={() => setDlg('import')} />
      {view === 'plan' && <FloorPlan analysis={analysis} />}
      {view === 'guests' && <GuestsView analysis={analysis} />}
      {view === 'network' && <NetworkView analysis={analysis} />}
      {view === 'lists' && <ListsView analysis={analysis} />}
      <Inspector analysis={analysis} onAutoSeat={(tab) => setDlg(tab ?? 'auto')} onSettings={() => setDlg('settings')} />

      <nav className="mobile-tabs" aria-label="Panels">
        <button className="btn ghost" aria-pressed={mpane === 'guests'} onClick={() => ((lastPane.current = 'guests'), setMpane('guests'))}>
          <Icon name="users" size="sm" /> Guests
        </button>
        <button className="btn ghost" aria-pressed={mpane === 'stage'} onClick={() => ((lastPane.current = 'stage'), setMpane('stage'))}>
          <Icon name="plan" size="sm" /> {view === 'plan' ? 'Plan' : view === 'network' ? 'Graph' : view === 'guests' ? 'Table' : 'Lists'}
        </button>
        <button className="btn ghost" aria-pressed={mpane === 'details'} onClick={() => setMpane('details')}>
          <Icon name="info" size="sm" /> Details{selection && mpane !== 'details' && <span className="tab-dot" aria-label="(something selected)" />}
        </button>
      </nav>

      <DragGhost />
      {toastMsg && (
        <div className="toast" key={toastMsg.id} role="status">
          {toastMsg.text}
          {toastMsg.undo && <button onClick={undo}>Undo</button>}
        </div>
      )}
      <ImportDialog open={dlg === 'import'} onClose={() => setDlg('')} />
      <AutoSeatDialog open={dlg === 'auto' || dlg === 'rules' || dlg === 'claude'} initialTab={dlg === 'rules' ? 'rules' : dlg === 'claude' ? 'claude' : 'seat'} onClose={() => setDlg('')} />
      <SettingsDialog open={dlg === 'settings'} onClose={() => setDlg('')} />
      <CrosscheckDialog open={dlg === 'cross'} onClose={() => setDlg('')} />
      <TagManager open={dlg === 'tags'} onClose={() => setDlg('')} />
      <OpenFileDialog open={dlg === 'open'} onClose={() => setDlg('')} />
      <SavedLayoutsDialog open={dlg === 'layouts'} onClose={() => setDlg('')} />
      <ResetDialog open={dlg === 'reset'} onClose={() => setDlg('')} />
      <ConfirmHost />
    </div>
  );
}

function DragGhost() {
  const d = useDrag();
  const project = useStore((s) => s.project);
  if (!d.active) return null;
  let tgt = '';
  if (d.over?.kind === 'seat' || d.over?.kind === 'table') {
    const t = project.tables.find((x) => x.id === (d.over as { tableId: string }).tableId);
    if (t) tgt = d.over.kind === 'seat' ? `→ ${tableName(t)}, seat ${d.over.seat + 1}` : `→ ${tableName(t)}`;
  } else if (d.over?.kind === 'unseat') tgt = '→ unseat';
  else if (d.over?.kind === 'group') tgt = `→ ${d.over.group}`;
  return (
    <div className="drag-ghost" style={{ left: d.x, top: d.y }}>
      {d.label}
      {tgt && <span className="tgt">{tgt}</span>}
    </div>
  );
}
