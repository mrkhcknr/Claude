# Wedding Seating Planner

An interactive seating chart: draw the venue, import the guest list, map who knows whom, and let auto-seat (tuned by your own rules, or by asking Claude) do the first pass.

## What it does

- **Floor plan**: walls, columns, doors, windows and areas (dance floor, bar, stage…). Tables in round, banquet, square, oval and one-sided shapes. Drag to move, square handles to resize, round handle to rotate, exact sizes in the side panel. Spacing checks flag tables that are too close.
- **Guests**: import a Joy export (or any CSV / pasted list). Households (Joy "Party") stay together. Re-importing updates RSVPs and meals without moving anyone. Drag guests or whole households onto seats or tables.
- **Social graph**: drag between guests to draw relationships (*partner*, *family*, *friend*, *introduce* — people you want to meet, *tension*), tag each with how they know each other ("Fire Island", "Google" — also added to both guests' tags), add optional seating rules (*next to*, *same table*, *never same table*), drop guests into group bubbles, lasso clusters into new groups.
- **Auto-seat**: table tags first, then connections, then swaps seats to maximise *happiness points* (partner / family / friend / introduce / shared tag / tension × next to / across from / same table, editable under Rules). Couples always sit side by side.
- **Group placements**: give tables an Area ("Top room") and assign groups to an area or table; auto-seat pulls them there.
- **Search & filters**: one filter bar (RSVP, side, table, meal, tags, dietary needs, "no ties yet"…) that highlights the same people on the list, the plan and the graph.
- **Auto-seat**: simulated annealing over households and ties, with every heuristic adjustable under *Rules* (presets included). Pinned guests and locked tables never move.
- **Ask Claude** (inside claude.ai only): describe what you want in plain words. Claude proposes rule changes, ties and tags for you to approve, and can review a finished seating and suggest swaps.
- **Tables named after flowers** (or anything), with numbers kept for venue staff.
- **Exports**: print-ready seating chart page, floor plan PNG/SVG, guest list with tables and meals (CSV), table lists, caterer meal counts, full backup and layout-only files.

## Where data lives

- Published on claude.ai: a database attached to the page, shared with whoever the page is shared with. Only names, households, tags, RSVPs, meals and dietary notes are stored (no emails, phones or addresses).
- Anywhere else: the browser's local storage. Use *Download backup* to keep a copy.

## Develop

```bash
npm install
npm run dev            # local dev server
npm run build          # static site in dist/
npm run build:artifact # single-file page for claude.ai in dist-single/artifact.html
```

`layouts/family-style-dinner.layout.json` is a first-pass venue layout converted from the planner's PDF; open it with *More → Open layout or backup*.
