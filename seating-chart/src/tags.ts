/** Tag management across all guests: rename, merge, delete and colours. */
import type { Project } from './types';
import { toast, update } from './store';
import { hueColor } from './util';

const split = (s: string) => s.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
const lc = (s: string) => s.trim().toLowerCase();

export const TAG_SWATCHES = ['#5b9bd5', '#4cae9c', '#7fb069', '#d9a441', '#e07a5f', '#d16b86', '#9b7fd1', '#6c7a89', '#3d6fb6', '#2f8f6d', '#b5651d', '#8e5572'];

/** Colour for a tag: the couple's pick, else an automatic hue by the tag's rank. */
export function tagColor(p: Project, tag: string, index: number) {
  return p.settings.tagColors?.[lc(tag)] ?? hueColor(index);
}

/** Rename `from` to `to` on every guest; if `to` already exists the two merge. */
export function renameTag(from: string, to: string) {
  const name = to.trim();
  if (!name || lc(from) === lc(name) && from === name) return;
  let n = 0;
  update((d) => {
    for (const g of d.guests) {
      const tags = split(g.group);
      if (!tags.some((t) => lc(t) === lc(from))) continue;
      const next: string[] = [];
      for (const t of tags.map((t) => (lc(t) === lc(from) ? name : t))) if (!next.some((x) => lc(x) === lc(t))) next.push(t);
      g.group = next.join(', ');
      n++;
    }
    for (const t of d.tables) if (lc(t.reservedFor) === lc(from)) t.reservedFor = name;
    const colors = d.settings.tagColors;
    if (colors?.[lc(from)] && lc(from) !== lc(name)) {
      colors[lc(name)] ??= colors[lc(from)];
      delete colors[lc(from)];
    }
  });
  toast(`Renamed "${from}" to "${name}" for ${n} guest${n === 1 ? '' : 's'}`, true);
}

export function deleteTag(tag: string) {
  let n = 0;
  update((d) => {
    for (const g of d.guests) {
      const tags = split(g.group);
      const next = tags.filter((t) => lc(t) !== lc(tag));
      if (next.length !== tags.length) {
        g.group = next.join(', ');
        n++;
      }
    }
    for (const t of d.tables) if (lc(t.reservedFor) === lc(tag)) t.reservedFor = '';
    if (d.settings.tagColors) delete d.settings.tagColors[lc(tag)];
  });
  toast(`Removed "${tag}" from ${n} guest${n === 1 ? '' : 's'}`, true);
}

export function setTagColor(tag: string, color: string | null) {
  update((d) => {
    const c = { ...(d.settings.tagColors ?? {}) };
    if (color) c[lc(tag)] = color;
    else delete c[lc(tag)];
    d.settings.tagColors = c;
  });
}

/** Add a tag to guests (used for "new tag" on a selection). */
export function addTagTo(ids: string[], tag: string) {
  const name = tag.trim();
  if (!name) return;
  update((d) => {
    for (const g of d.guests) {
      if (!ids.includes(g.id)) continue;
      const tags = split(g.group);
      if (!tags.some((t) => lc(t) === lc(name))) g.group = [...tags, name].join(', ');
    }
  });
}
