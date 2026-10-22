# Publishing Model

Gazetta's CMS is stateless. All content state lives in targets.

## Stateless CMS

The CMS stores nothing. It:
1. Reads structure/pages/fragments from the **active target** (the target the author is focused on)
2. User edits in the browser; form state is transient
3. Saves write directly to the active target (if editable)
4. Publishes copy content between any two targets

There is no "working copy" inside the CMS. Form-state-in-progress is the only transient
state; the moment save runs, content lives on a target. Consequence: the CMS is
disposable. Lose it, spin up a new one, connect to targets.

## Targets

A target is any node that holds a full copy of the site structure.
Each target independently stores templates, fragments, pages, and manifests.

```
target: production
  site.config.ts
  templates/
  fragments/
  pages/

target: staging
  site.config.ts
  templates/
  fragments/
  pages/
```

Targets can diverge — staging may have changes not yet in production.

## Operations

Four verbs. Save and Publish share a write-and-render pipeline — they differ only in
destination. Publish is one verb with an author-chosen direction; it subsumes what other
CMSes call publish, fetch, and promote.

| Operation | Flow | Description |
|-----------|------|-------------|
| Edit | Browser (form state) | Modify content in the form; transient, not persisted |
| Save | Form → active target | Write form-state to active target (+ render if static). Only if active is editable. |
| Publish | Target A → Target B | Copy logical content from any target to any target (+ render if static destination). Direction is author-chosen. |
| Compare | Target A ↔ Target B | Logical diff between two targets. No byte-level / materialized comparison. |

**Publish is unified.** What used to be separate operations map to publish direction:

| Intent | Publish direction |
|--------|-------------------|
| "Publish my edits to staging" | active (editable) → staging |
| "Promote staging to prod" | staging → prod |
| "Fetch hotfix back from prod" | prod → active (editable) |
| "Bootstrap a new target" | any existing target → new target |

Tags drive suggestions (e.g. if `staging` is ahead of `production`, suggest staging → prod)
but never constrain direction. The author picks source and destination explicitly.

## Target Types

Targets come in two flavors depending on whether the site needs server-side dynamic components:

| Target type | Runtime | Serves | Use case |
|-------------|---------|--------|----------|
| **Static** | Edge (Hono on Workers/Deno) | Pre-rendered HTML assembled at request time | Marketing sites, blogs, docs |
| **Dynamic** | Node/Bun server (Hono) | Mix of pre-rendered + SSR'd per request | Apps needing fresh data from DB/API |

Both types use Hono. Both store components in storage. The difference is whether
SSR happens at publish time (static) or request time (dynamic).

### Static target

```
Publish:   CMS → SSR (Node/Bun) → pre-rendered HTML → push to storage
Request:   Browser → Edge → fetch pre-rendered fragments → assemble page → serve
```

### Dynamic target

```
Publish:   CMS → push component source + pre-rendered static components → storage
Request:   Browser → Node/Bun → static from cache, dynamic SSR'd fresh → assemble → serve
```

## Publishing

You can publish a page or a fragment. No full-site rebuilds.

Incremental publish, reverse-dependency queries, and the "N unchanged" admin
summary are all driven by **sidecar files** — zero-byte files whose filenames
encode the hash, fragment references, and template of each item. See
[sidecars.md](../../docs/sidecars.md) for the model.

| Publish | Static target | Dynamic target |
|---------|--------------|----------------|
| A page | CMS SSR's the page's local components, pushes HTML to storage | Pushes source to storage |
| A fragment | CMS SSR's the fragment, pushes HTML to storage. All pages using `@fragment` instantly updated on next request. | Pushes source. Fragment SSR'd fresh per request. |

In both cases, publishing a shared fragment updates all pages that use it — no need to
re-render or re-publish other pages. The runtime (edge or server) composes at request time.

## Bidirectional Sync

Because Publish is direction-neutral, the CMS can move content between any two targets.
Use cases — all the same "Publish A → B" operation with different endpoints:
- Hotfix applied directly to production? Publish prod → local to pull it back
- Bootstrap a new CMS instance from an existing target: Publish prod → new-target
- Migrate between hosts: Publish old-target → new-target

## History

Every target keeps its own history of writes. Save and publish each record a revision on
the target they write to. Undo and rollback restore a prior revision; they reuse the same
write-and-render pipeline as publish.

### Storage shape

History lives inside the target in a reserved `.gazetta/` namespace that the runtime never
reads. Content-addressed blobs are shared across revisions — unchanged items deduplicate.

```
target root/
├── site.config.ts
├── pages/              ← content tree (runtime reads this)
├── fragments/
├── templates/
└── .gazetta/
    └── history/
        ├── index.json              ← cache of the revision list (revisions/ is the source of truth)
        ├── objects/                ← content-addressed blobs
        │   └── ab/cd1234...
        └── revisions/
            └── rev-1792648514738-1-a1b2c3d4.json  ← revision manifest (metadata + item → hash map)
```

Storage providers see history as ordinary read/write bytes at paths. No provider-native
versioning (S3 object versions, git commits) — one uniform approach across all providers
keeps the storage interface minimal.

A revision's id is the writing instance's clock time in milliseconds plus a per-millisecond
sequence and a random suffix (`rev-<ms>-<seq>-<8 hex>`), and history is ordered by
(milliseconds, sequence, suffix). Each revision is its own file, so writers don't overwrite
each other through a shared list
([#1089](https://github.com/gazetta-studio/gazetta-studio/issues/1089)); the random suffix
keeps two writers that list in the same millisecond from picking the same filename, so
concurrent writers can't lose a revision. Ids written before the suffix was introduced
(`rev-<ms>`, `rev-<ms>-<seq>`) still parse and sort with new ones. Revisions written by
instances whose clocks disagree can be listed out of order.

### Revision granularity

One write = one revision. A save of one item creates one revision; a publish of many items
creates one revision. Each revision records: timestamp, operation (`save` / `publish`),
author identifier, source target (for publish), affected items with their content hashes,
optional message.

### Operations

| Operation | What it does |
|-----------|--------------|
| **Undo** | Create new revision restoring the target's immediately prior state |
| **Rollback** | Create new revision restoring any chosen past revision's state |
| **View history** | List a target's revisions |

Undo and rollback are the same mechanism — restore a revision's item→hash map to the
content tree and re-render if static. The difference is entry point: Undo targets the most
recent prior revision; Rollback picks an arbitrary one.

**Soft undo only.** Restoring a revision creates a new forward revision; past history is
never destroyed. Full audit trail preserved.

### Retention

Per-target configurable via the `history` block in `site.config.ts`, default **keep last 50
revisions**. When the limit is hit, the oldest revision is evicted (its manifest deleted
from `revisions/`, removed from `index.json`). Orphaned blobs in `objects/` are
garbage-collected lazily — a future `gazetta gc` command walks all manifests and prunes
unreferenced blobs.

```ts
export default defineSite({
  targets: {
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      history: {
        enabled: true,      // default; set to false to skip .gazetta/history/ entirely
        retention: 100,     // default 50
      },
    },
  },
})
```

Use `enabled: false` to disable history on a target where the storage cost isn't
worth it (ephemeral CI preview targets, for example). Disabling on production
removes the undo safety net — not recommended.

### Conflict handling

The transient "Undo" affordance shown after a save or publish disappears once a newer write
lands on that target — undoing the older action would silently lose the newer one. For
explicit control, the history panel always allows rollback to any revision.

## Storage Providers

Storage is a simple read/write file interface. Adapters handle specifics:

| Provider | Example |
|----------|---------|
| Filesystem | Local folder |
| S3 / Cloud storage | AWS S3, GCS, Azure Blob |
| Git repository | GitHub, GitLab |
| FTP/SFTP | Legacy hosting |

## Runtime

Built on **Hono** — runs on both edge (Cloudflare Workers, Deno) and server (Node, Bun).

### Static target runtime (edge)
1. Receives page request
2. Fetches page manifest from storage
3. Resolves `@` references to fragments
4. Fetches pre-rendered HTML for each component from storage
5. Assembles into complete HTML document (string concatenation, no SSR)
6. For islands: injects hydration script + per-page import map
7. Serves the response

### Dynamic target runtime (Node/Bun server)
1. Receives page request
2. Fetches page manifest from storage
3. Resolves `@` references to fragments
4. Static components: fetched pre-rendered from cache/storage
5. Dynamic components: SSR'd fresh (executes template with React/Vue/Svelte)
6. Islands: SSR'd + hydration script injected
7. Assembles + serves

### Component rendering types

| Type | Rendered | JS to browser | Use case |
|------|---------|---------------|----------|
| **Static** | Pre-rendered at publish time | Zero | Content that rarely changes |
| **Dynamic** | SSR'd at request time (Node/Bun) | Zero | Fresh data from DB/API |
| **Island** | SSR'd + hydrated in browser | Framework + component | Client-side interactivity |

Import maps deduplicate island dependencies across loaded pages. (Design originally
specified per-page maps; current implementation shares a single map — alignment pending.)
