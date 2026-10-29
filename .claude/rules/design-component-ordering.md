# Component ordering UX

How authors reorder, add, and remove components inside a page or fragment. Closes [issue #105](https://github.com/gazetta-studio/gazetta-studio/issues/105) — replaces the current move-up/move-down arrow buttons in `ComponentTree.vue` with a drag-and-drop affordance + an explicit keyboard shortcut layer.

**Status**: design + implementation in progress (2026-05).

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **UX check** every new feature design must answer
- [`team-preferences.md`](team-preferences.md) rule 23 (Krug-aligned UX) — guides every choice below
- [`design-scale.md`](design-scale.md) — drives the 200-component-per-page envelope
- [`design-i18n.md`](design-i18n.md) — locale-variant manifests reorder identically (no locale-specific concerns at v1)

**Research**: this design pass synthesizes a 5-CMS comparison (Sanity Studio v3, Payload, Storyblok, Gutenberg, Notion) + a Vue-3 DnD library evaluation (vue-draggable-plus, vue-draggable-next, SortableJS, `@vueuse/integrations` `useSortable`, `@formkit/drag-and-drop`, native HTML5). Findings inline below where they drive decisions.

## Scope

**In v1:**
- Drag-and-drop reorder of top-level components within a single page/fragment
- Always-visible grip handle on every reorderable row
- Thin insertion line as drop indicator
- Keyboard support: `Space`-to-lift + arrow + `Space`-to-drop (WAI-ARIA "grab and drop" pattern) PLUS `Alt+ArrowUp` / `Alt+ArrowDown` direct one-keystroke move
- Library: `@formkit/drag-and-drop` (Vue adapter)
- Reuses the existing `editorStructural` pending-edits pipeline — no new save model
- Replaces the current up-arrow / down-arrow buttons (Q3 lock); trash button stays
- Auto-scroll near edges (library default)
- Touch support (library default — pointer events)

**Out of v1 (future direction):**
- Cross-parent drag (move a component from one page or fragment into another) — different feature; needs multi-item pending-edit design
- Drag from a "template palette" sidebar (block library) — no current palette UI; opens a separate question
- Drag inside the live preview iframe (Storyblok-style visual editor) — separate design pass
- Reordering inside nested inline composite components — today's tree only renders top-level as draggable; lifting that requires walking nested levels in the DnD scope, which expands implementation surface
- Drag between locale variants

**Non-goals:**
- Replacing the explicit-save model (per [team-preferences rule 1](team-preferences.md)) — DnD writes to the structural-pending lane like the existing buttons do
- Cross-component types (drag a fragment ref into a fragment's components list) — would change manifest semantics

## Locked decisions (the seven Qs)

The decisions below are the load-bearing choices. Each was grilled with explicit alternatives; the rationale captures what was rejected so future-me doesn't re-litigate.

### Q1 — DnD library: `@formkit/drag-and-drop`

Built by the FormKit team explicitly to fix the Vue+React DnD-with-a11y gap. Ships drag-and-drop, drop indicators, auto-scroll, ~12.5KB gzipped, MIT, active maintenance. The pinned 0.6.1 build does **not** implement its documented keyboard handler, so Gazetta owns Space-to-lift + arrows + Space-to-drop in `ComponentTree.vue`. The data-first model (mutate the array, DOM follows) composes naturally with Pinia stores.

**Rejected alternatives** (full table in [team-preferences research](team-preferences.md) audit; condensed):

| | Reason rejected |
|---|---|
| `vue-draggable-plus` (SortableJS wrapper) | No keyboard a11y; ~100 LOC of custom focus/ARIA work to add |
| `SortableJS` direct | Same a11y gap; wrapping it ourselves buys nothing |
| `@vueuse/integrations useSortable` | Same a11y gap; pulls VueUse peer-dep cost |
| Native HTML5 DnD | iOS Safari touch broken without polyfill; auto-scroll/keyboard manual |
| `vue-draggable-next` | Stale (Aug 2025); a11y gap |
| `vuedraggable` (original) | **Vue 2 only** |

**Pre-1.0 risk on FormKit DnD (0.6.1 today):** mitigated by pinning the exact version + reading changelogs on bump. The a11y risk on SortableJS is open-ended (issue #1063 has been open since 2014).

### Q2 — Always-visible left grip handle

Each draggable row gains a `pi pi-bars` (or equivalent grip glyph) on the left, always rendered. Replaces the up-arrow + down-arrow buttons that currently occupy the right side.

**Rejected alternatives:**
- **Hover-only handle (Notion-style)** — Krug rule 23 ("when tempted to add a help tooltip, fix the UI"). Hover-only is exactly the thing that needs a help tooltip; always-visible IS the explanation.
- **Whole-row drag (no dedicated handle)** — rows are clickable to select; click vs drag intent must be unambiguous. A pixel-threshold disambiguator feels janky.
- **Keep buttons + add drag** — two affordances for the same action is the bloat the issue scope is calling out. Replace, not augment.

Visual budget today: dirty-dot + label + revert + up + down + trash = 6 elements per row. After: grip + dirty-dot + label + revert + trash = 5.

### Q3 — Replace move-up / move-down buttons

The grip handle subsumes both. Trash button stays (delete is a different action; no DnD analog).

**Rejected alternative — keep both:** redundant interaction paths violate Krug "don't make me think." If a user can drag, the buttons add no value; if a user can't drag (low-mobility, broken touch, etc.), the keyboard shortcuts (Q5) are the canonical path.

### Q4 — Drop indicator: thin insertion line

A 2px colored line renders between rows during drag and while a row is lifted by keyboard, indicating exactly where the dropped item will land. Color: matches `--color-primary` (PrimeVue Aura emerald in our tokens). The keyboard line maps the final array index back to a boundary in the still-rendered order: moving down draws it after the row currently at the destination index, moving up draws it before that row.

**Rejected alternatives:**
- **Reflow / placeholder gap** — ambiguous in nested trees (when hovering near a parent's last child, does the gap mean "after this child" or "after this parent"?). An insertion line at a specific Y-coordinate disambiguates.
- **Highlight target row** — insertion direction unclear; doesn't answer "above or below."
- **Floating preview only** — most libraries combine the dragged-row ghost + an insertion indicator anyway; just specifying the indicator preference here.

`@formkit/drag-and-drop` ships a default insertion-line indicator we style via CSS variables.

### Q5 — Drag scope: within parent only (v1)

The current ComponentTree gates `move` actions on `node.data?.isTopLevel && depth !== -1`. v1 preserves that constraint — drag works on top-level components only. Nested inline composite components, fragment-reference children, cross-page moves all defer to future direction (see "Out of v1" above).

**Rejected alternatives:**
- **Cross-parent within page (nested inline composites)** — meaningful tree-walk + recursion problem; bloats this issue. Lift the constraint as a follow-up when concrete demand surfaces.
- **Cross-page drag** — needs multi-item pending-edit design across pages; not yet specified in `design-publishing.md`. Its own design pass.

The issue's "Scope" line lists these as CONSIDERATIONS, not v1 requirements.

### Q6 — Keyboard interaction: Space-to-lift PLUS Alt+arrow direct move

Two keyboard paths, both documented in the row's tooltip:

1. **Space-to-lift** (app-implemented; the pinned FormKit 0.6.1 keyboard handler is empty) — focus the grip handle, press Space, use ArrowUp/ArrowDown to navigate, press Space again to drop. WAI-ARIA "grab and drop" pattern. One visually hidden polite live region announces pickup, each destination, and the drop (#1161); Escape, mouse drags and Alt+Arrow stay silent.

2. **Alt+ArrowUp / Alt+ArrowDown** — focus any cell on the row, hold Alt, press ArrowUp or ArrowDown, the row moves one position immediately. Power-user one-keystroke shortcut. Custom layer on top of the library (~30 LOC — `@vueuse/core`'s `onKeyStroke` against the row).

**Rejected alternatives:**
- **Space-only** — no one-keystroke speed for power users.
- **Alt+arrow only** — loses screen-reader ergonomics. Space-to-lift is the WAI-ARIA pattern.
- **Move-buttons only (today)** — removes a visible affordance; forces keyboard for what was a click.

**Browser-shortcut conflict check:** `Alt+ArrowUp` is bound to "Up one folder" only when focus is in a Firefox file picker (not in a Vue app). Safari/Chrome don't bind it. Verified safe.

### Q7 — Save model: reuse `editorStructural` pending-edits

Drag drop and keyboard moves both call `editing.moveComponentStructural(key, comps, fromIndex, toIndex)` — the same store action the up/down buttons call today. The structural-edits store already has the pending-edit lane (Cut 8a from `design-offline-implementation.md`); reorder writes flow through it like add/remove.

**Rejected alternatives:**
- **Auto-save on drop** — violates [team-preferences rule 1](team-preferences.md) ("no auto-save in CMS").
- **Per-component undo of structural change** — redundant with page-level revert (existing); no new surface needed.

This is structurally a no-op question — keep what's there.

## Feedback affordances (no toast on reorder)

Today's `addComponent` and `removeComponent` toast. `moveComponent` does not. With DnD, reorders happen rapidly (one drag = one event; arrow press = one event each); toasting every drop = noisy.

**Decision: no toast on reorder.** Three signals already cover the action:

1. **Visual reflow** — the row physically moves to its new position; this IS the feedback.
2. **Dirty dot** — already on the page node in the site tree; signals "pending save."
3. **ARIA live-region announcement** — the tree's polite region announces keyboard pickup, movement and drop (#1161).

Existing `addComponent` / `removeComponent` toasts continue to fire — those change the SET, not just the order, and the toast is the persistence signal for them.

## Surfaces and accessibility

### Row anatomy (after Cut)

```
┌─────────────────────────────────────────────────────────────┐
│ ⋮⋮  ●  hero            ↻       🗑                          │
│ │   │  │               │       │                            │
│ │   │  │               │       └─ trash (delete)            │
│ │   │  │               └─────────  revert (when dirty)      │
│ │   │  └─────────────────────────  label                    │
│ │   └────────────────────────────  dirty dot (when pending) │
│ └────────────────────────────────  drag handle              │
└─────────────────────────────────────────────────────────────┘
```

Visual budget: 5 elements (down from 6).

### Focus management

- Drag handle is a `<button>` (focusable; tab-stop)
- Pressing `Space` on the handle "lifts" the row
- After lift, ArrowUp / ArrowDown moves the thin insertion line from Q4 to the proposed landing slot; the dragged row keeps focus and visual lift styling, and the live region announces the pending destination
- Pressing `Space` again drops; row stays focused at the new position
- Pressing `Esc` cancels the lift (row returns to original position)

### Touch support

Library handles long-press to lift + finger-drag to move + release to drop. Auto-scroll near viewport edges.

### Screen-reader announcements

Implemented in #1161 as one visually hidden, polite live region in `ComponentTree.vue` (`data-testid="component-tree-announcer"`). Positions are 1-based top-level order, matching the insertion line and the committed result:
- "Picked up: hero. Currently at position 1 of 4"
- "Moved to position 2 of 4"
- "Dropped at position 2 of 4"

Escape, mouse drags and Alt+Arrow leave the region's text unchanged.

### Color and theming

- Drop indicator: `var(--color-primary)` (Aura emerald light, brighter dark)
- Drag handle default: `var(--color-muted)`
- Drag handle hover: `var(--color-fg)`
- Picked-up row background: `var(--color-hover-bg)` with a subtle shadow

All driven by the existing token system; light/dark switch automatically.

## Foundational checks

### Multi-instance discipline
- DnD operates entirely client-side. No cross-instance coordination required.
- The structural-edits store is per-browser-tab; reorder lands in the same pending-edits lane that already has the multi-instance-correct save flow (per `design-offline.md`).

### Scale check
- ComponentTree at envelope is 50 components per page (target) / 200 (hard limit). DnD libraries handle 200 rows fine; library benchmarks show smooth drag at 1000+. No virtualization needed for DnD itself; if `design-scale.md` Cut 10's virtualization lands, FormKit DnD composes cleanly.

### Locale check
- Locale-variant manifests reorder identically — DnD operates on the active locale's component array. No per-locale concerns. `design-i18n.md`'s file-suffix model means each locale variant is its own manifest; the active locale is what the tree shows.

### Themes check
- Drop indicator + handle styles use CSS tokens that auto-flip light/dark. No theme-aware DnD logic.

### Auth/RBAC check
- Reorder is gated by the existing `edit:pages` / `edit:fragments` capability (per `design-auth-rbac.md`). The DnD UI hides the grip handle on read-only items (today's behavior — buttons hidden on `editable: false` source target).

### Audit check
- Reorder writes record a save event with the structural-pending diff per the existing pipeline. `design-audit.md`'s `action: 'save'` covers it; no new audit action.

### Hook check
- Reorder triggers the standard `beforeSave` / `afterSave` hooks at save time. No reorder-specific hook (per `design-hooks.md` — hooks fire on the save, not on each in-memory mutation).

### Render check
- Reorder doesn't affect render until save lands. After save, the renderer reads the new component array; nothing render-specific changes.

### Validation check
- Reorder doesn't change ref-existence (same components, same templates, same fragment refs). Save-delta validation runs on the new manifest like any save; no reorder-specific validator.

### Plugin check
- DnD is internal admin UX; no plugin contract surface.

### Cache check
- Reorder doesn't touch the AdminCache — pending edits are per-tab. After save, the page-summary cache invalidates per the existing cache-invalidation flow.

### Offline check
- Drag works offline; reorder writes to pending-edits like any in-memory change. Save queues offline + replays on reconnect (existing flow).

### Collaboration check
- No collaboration concerns at v1. Future: live presence indicators ("Bob is reordering this page") compose with the audit log per `design-collaboration.md`.

## Migration

No migration required. Sites without any DnD-related config continue to work — DnD is a UI-only change in `ComponentTree.vue`. Authors trained on the up/down buttons will see the buttons replaced by a grip handle and discover drag naturally.

## Open implementation questions

1. **Library version pinning.** `@formkit/drag-and-drop` is 0.6.1 (pre-1.0). Pin to exact version; document in `package.json` with a comment. Bump only after reading changelog + smoke-testing the playground.
2. **Touch threshold for long-press.** FormKit's default is 250ms. Verify it doesn't interfere with row-tap-to-select on iPad. If it does, increase to 500ms or add an explicit "touch-drag mode" toggle.
3. **Animation duration for reflow.** Library default ~200ms. Confirm against the dev playground's "feels right" bar.
4. **Drop indicator color in dark mode.** PrimeVue Aura's `--color-primary` is a brighter emerald in dark mode; should be visible against `--color-bg` either way, but verify with a real dark-mode capture.

## Future directions

- **Cross-parent nested-inline drag** — when an author needs to move a component from inside an inline composite into a sibling slot, lift the top-level constraint. Today the tree gates `isTopLevel`; expanding requires walking nested levels in the DnD scope.
- **Cross-page drag** — visible signal of intent ("move hero from /home to /about"). Needs multi-item pending-edit design across pages.
- **Drag from a block-library palette** — if a future "block library" sidebar surfaces (similar to Storyblok's blocks panel), it'd ship its own design.
- **Drag inside the live preview iframe** — Storyblok-style visual editor. Major architectural shift; reserved.
- **Bulk reorder** — select multiple components via shift-click + drag the group. Power-user feature; defer until concrete demand.
