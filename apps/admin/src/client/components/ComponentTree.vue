<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { tearDown } from '@formkit/drag-and-drop'
import { dragAndDrop } from '@formkit/drag-and-drop/vue'
import Button from 'primevue/button'
import { useSelectionStore } from '../stores/selection.js'
import { useEditingStore } from '../stores/editing.js'
import { useToastStore } from '../stores/toast.js'
import { useComponentFocusStore } from '../stores/componentFocus.js'
import { useFragmentsApi } from '../composables/api.js'
import { hashToSelection, selectionToHash, type EditorSelection } from '../composables/editorSelection.js'
import { useUiModeStore } from '../stores/uiMode.js'
import { useLocaleStore } from '../stores/locale.js'
import { useEditorStructuralStore } from '../stores/editorStructural.js'
import AddComponentDialog from './AddComponentDialog.vue'

const fragmentsApi = useFragmentsApi()
const route = useRoute()
const router = useRouter()
const uiMode = useUiModeStore()

/** FNV-1a hash — same function as in packages/gazetta/src/scope.ts */
function hashPath(path: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface NodeData {
  treePath?: string
  path?: string
  template?: string
  isFragment?: boolean
  isPage?: boolean
  fragName?: string
  index?: number
  isTopLevel?: boolean
  error?: string
}

interface ComponentNode {
  key: string
  label: string
  data: NodeData
  children: ComponentNode[]
}

const selection = useSelectionStore()
const editing = useEditingStore()
const toast = useToastStore()
const focus = useComponentFocusStore()
const structural = useEditorStructuralStore()
const selectedNodeKey = ref<string | null>(null)
const keyboardLift = ref<{ from: number; to: number } | null>(null)
const announcerText = ref('')
const announcerVersion = ref(0)
const hoveredNodeKey = ref<string | null>(null)
const componentNodes = ref<ComponentNode[]>([])
const showAddDialog = ref(false)

const detail = computed(() => selection.detail)
/**
 * Effective components — pending structural override when present, otherwise
 * the disk-loaded array. The tree binds to this so move/add/remove are
 * reflected immediately without waiting for save.
 */
const effectiveComponents = computed(() => {
  const sel = selection.selection
  const d = detail.value
  if (!sel || !d) return null
  const locale = useLocaleStore().effectiveLocale ?? undefined
  const pending = structural.pendingFor(
    locale ? { kind: sel.type, name: sel.name, locale } : { kind: sel.type, name: sel.name },
  )
  return pending ?? d.components ?? []
})
const componentCount = computed(() => effectiveComponents.value?.length ?? 0)

// Map from data-gz hash → component info (built during tree construction)
type GzEntry = { path: string; template: string } | { isFragment: true; fragName: string }
const gzMap = ref(new Map<string, GzEntry>())

async function buildComponentNode(
  entry: import('../api/client.js').ComponentEntry,
  index: number,
  parentTreePath: string,
  map: Map<string, GzEntry>,
  fragmentCounts: Map<string, number>,
): Promise<ComponentNode> {
  // Fragment reference
  if (typeof entry === 'string') {
    const fragName = entry.slice(1)
    const occurrence = fragmentCounts.get(fragName) ?? 0
    fragmentCounts.set(fragName, occurrence + 1)
    const treePath = parentTreePath ? `${parentTreePath}/${entry}` : entry
    const gzId = hashPath(treePath)
    map.set(gzId, { isFragment: true, fragName })
    try {
      const frag = await fragmentsApi.getFragment(fragName)
      const childCounts = new Map<string, number>()
      const children = frag.components
        ? await Promise.all(frag.components.map((c, i) => buildComponentNode(c, i, treePath, map, childCounts)))
        : []
      return {
        // The same fragment can be referenced from different sibling groups,
        // so occurrence alone is not tree-unique. Include the full path
        // (parent path + @frag) to keep keys globally distinct; occurrence
        // still separates repeated refs to one fragment in a single group.
        key: `frag:${treePath}:${occurrence}`,
        label: entry,
        data: {
          isFragment: true,
          fragName,
          treePath,
          path: treePath,
          template: frag.template,
          index,
          isTopLevel: true,
        },
        children,
      }
    } catch (err) {
      return {
        key: `frag:${treePath}:${occurrence}`,
        label: entry,
        data: { isFragment: true, fragName, treePath, index, isTopLevel: true, error: (err as Error).message },
        children: [],
      }
    }
  }

  // Inline component
  const treePath = parentTreePath ? `${parentTreePath}/${entry.name}` : entry.name
  const gzId = hashPath(treePath)
  const childCounts = new Map<string, number>()
  const children: ComponentNode[] = entry.components
    ? await Promise.all(entry.components.map((c, i) => buildComponentNode(c, i, treePath, map, childCounts)))
    : []

  map.set(gzId, { path: treePath, template: entry.template })

  return {
    key: `comp:${treePath}`,
    label: entry.name,
    data: { path: treePath, template: entry.template, treePath, isFragment: false, index, isTopLevel: true },
    children: children.map(c => ({ ...c, data: { ...c.data, isTopLevel: false } })),
  }
}

watch(
  [detail, effectiveComponents],
  async ([d, comps]) => {
    // A rebuilt tree invalidates the index-based keyboard lift.
    keyboardLift.value = null
    if (!d) {
      componentNodes.value = []
      gzMap.value = new Map()
      return
    }

    const map = new Map<string, GzEntry>()
    const rootPath = selection.type === 'fragment' ? `@${selection.name}` : ''
    const fragmentCounts = new Map<string, number>()
    const children = comps
      ? await Promise.all(comps.map((entry, i) => buildComponentNode(entry, i, rootPath, map, fragmentCounts)))
      : []

    const rootNode: ComponentNode = {
      key: `root:${selection.name}`,
      label: selection.name ?? '',
      data: { isPage: true, path: d.dir, template: d.template, treePath: rootPath },
      children,
    }
    // Fragment root has data-gz in host-page preview — add to gzMap for click-to-select
    if (rootPath && selection.type === 'fragment' && selection.name) {
      map.set(hashPath(rootPath), { isFragment: true, fragName: selection.name })
    }
    componentNodes.value = [rootNode]
    gzMap.value = map
    selectedNodeKey.value = null

    // Process pending selection if tree just built and a gzId is waiting
    consumePending()
    // Hash-based restore is handled by the route.hash watcher below.
    // Trigger it now in case the hash was already set before the tree built.
    if (!focus.pendingGzId) applyHashSelection()
  },
  { immediate: true },
)

function consumePending() {
  if (focus.pendingGzId && gzMap.value.size > 0) {
    selectByGzId(focus.pendingGzId)
    focus.clearPending()
  }
}

/**
 * Read the current route hash and open the corresponding editor.
 * This is the SINGLE place that translates a URL hash into editor state.
 * Called from:
 * - the detail watcher (after tree builds — handles page refresh)
 * - the route.hash watcher (handles click-driven hash changes)
 */
function applyHashSelection() {
  if (componentNodes.value.length === 0) return
  const onFragmentPage = selection.type === 'fragment'
  const sel = hashToSelection(route.hash, onFragmentPage)
  if (!sel) return

  // Find and highlight the tree node
  const prefix = onFragmentPage && selection.name ? `@${selection.name}/` : ''
  switch (sel.kind) {
    case 'root': {
      const rootNode = componentNodes.value[0]
      if (rootNode) selectedNodeKey.value = rootNode.key
      break
    }
    case 'component': {
      const fullPath = prefix + sel.path
      const found = findNodeByKey(componentNodes.value, d => d.path === fullPath || d.path === sel.path)
      if (found) {
        selectedNodeKey.value = found.key
        sel.template = found.data?.template ?? ''
      }
      break
    }
    case 'fragmentLink': {
      const found = sel.childPath
        ? findNodeByKey(componentNodes.value, d => d.path === sel.treePath)
        : findNodeByKey(componentNodes.value, d => d.fragName === sel.fragmentName)
      if (found) selectedNodeKey.value = found.key
      break
    }
    case 'fragmentEdit': {
      const found = findNodeByKey(componentNodes.value, d => d.fragName === sel.fragmentName)
      if (found) selectedNodeKey.value = found.key
      break
    }
  }

  // Open the editor — NO hash write here (URL is already correct)
  switch (sel.kind) {
    case 'root':
      editing.openPageRoot()
      break
    case 'component':
      editing.openComponent(sel.path, sel.template)
      break
    case 'fragmentLink':
      editing.showFragmentLink(sel.treePath)
      break
    case 'fragmentEdit':
      editing.openFragment(sel.fragmentName)
      break
  }
}

// React to hash changes — this is the single driver of editor state from URL.
// Fires on: click (onSelect writes hash), goToFragment (router.push with hash),
// page refresh (hash already in URL), browser back/forward.
watch(
  () => route.hash,
  () => applyHashSelection(),
)

// Also react to pendingGzId changes when tree is already built (edit mode click-to-select)
watch(
  () => focus.pendingGzId,
  () => consumePending(),
)

// Highlight tree node when component is hovered in preview
watch(
  () => focus.previewHoverGzId,
  gzId => {
    if (!gzId) {
      hoveredNodeKey.value = null
      return
    }
    const found = findNodeByKey(componentNodes.value, d => (d.treePath ? hashPath(d.treePath) === gzId : false))
    hoveredNodeKey.value = found?.key ?? null
  },
)

// Flat list for rendering — walk tree and produce { node, depth } pairs.
// Used by the existing test helpers that walk by-index; v1 of #105
// (component-reorder DnD) restructures the template into a root row +
// per-top-level draggable blocks (each block carries its own nested
// rows). flatNodes stays for backward compatibility with anything that
// still walks the full flattened ordering.
const flatNodes = computed(() => {
  const result: { node: ComponentNode; depth: number }[] = []
  function walk(nodes: ComponentNode[], depth: number) {
    for (const node of nodes) {
      result.push({ node, depth })
      if (node.children.length) walk(node.children, depth + 1)
    }
  }
  if (componentNodes.value[0]) {
    result.push({ node: componentNodes.value[0], depth: -1 })
    walk(componentNodes.value[0].children, 0)
  }
  return result
})

// The root node (the page or fragment itself). Rendered separately
// from the draggable list so it isn't a drop target.
const rootNode = computed<ComponentNode | null>(() => componentNodes.value[0] ?? null)

// Top-level draggable children of the root, in their declared order.
// This is the array the DnD library reorders. Per design-component-
// ordering.md Q5, drag scope is top-level only at v1.
const topLevelNodes = computed<ComponentNode[]>(() => rootNode.value?.children ?? [])

// Per-top-level node, the flattened nested rows (depth-first, as in
// `flatNodes`). Each top-level block renders its own nested rows
// inside it so they ride along when the block is dragged.
function flattenNested(node: ComponentNode): { node: ComponentNode; depth: number }[] {
  const out: { node: ComponentNode; depth: number }[] = []
  function walk(children: ComponentNode[], depth: number) {
    for (const child of children) {
      out.push({ node: child, depth })
      if (child.children.length) walk(child.children, depth + 1)
    }
  }
  walk(node.children, 1)
  return out
}

function nodeIcon(node: ComponentNode, depth: number): string {
  if (depth === -1) return selection.type === 'page' ? 'pi pi-file' : 'pi pi-share-alt'
  if (node.data.isFragment) return 'pi pi-share-alt'
  return 'pi pi-box'
}

function nodeStyle(depth: number): Record<string, string> | undefined {
  if (depth <= 0) return undefined
  return { paddingLeft: depth * 10 + 'px' }
}

// --- Editing helpers — delegated to editing store ---

function revertComponent(componentPath: string) {
  editing.revertComponent(componentPath)
}

// The page row's dot: edits in the page row's own editor, whose path is
// '_root' (the row's node path is the page directory), and the page's
// metadata, whose form is part of that editor.
const rootDirty = computed(
  () => editing.hasPendingEdit('_root') || (editing.dirty && editing.path === '_root') || editing.hasPendingMetadata,
)

// --- Hover highlight ---

function onHover(node: ComponentNode) {
  if (!node.data.treePath) return
  focus.highlight(hashPath(node.data.treePath!))
}

function onHoverEnd() {
  focus.highlight(null)
}

// --- Node selection ---

/** Strip the @fragName/ prefix from a component path on fragment pages. */
function stripFragmentPrefix(path: string): string {
  const prefix = selection.type === 'fragment' && selection.name ? `@${selection.name}/` : ''
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Derive a typed selection from a clicked tree node. */
function nodeToSelection(node: ComponentNode): EditorSelection | null {
  if (!node.data) return null
  if (node.data.isPage) return { kind: 'root' }
  if (node.data.isFragment && node.data.fragName) {
    if (selection.type === 'page') {
      return {
        kind: 'fragmentLink',
        fragmentName: node.data.fragName,
        treePath: `@${node.data.fragName}`,
        childPath: null,
      }
    }
    return { kind: 'fragmentEdit', fragmentName: node.data.fragName }
  }
  if (!node.data.path) return null
  if (selection.type === 'page' && node.data.path.startsWith('@')) {
    const parts = node.data.path.slice(1).split('/')
    return {
      kind: 'fragmentLink',
      fragmentName: parts[0],
      treePath: node.data.path,
      childPath: parts.length > 1 ? parts.slice(1).join('/') : null,
    }
  }
  return { kind: 'component', path: stripFragmentPrefix(node.data.path), template: node.data.template ?? '' }
}

async function onSelect(node: ComponentNode) {
  if (!node.data) return
  keyboardLift.value = null
  selectedNodeKey.value = node.key
  focus.clearPending()
  const treePath = node.data.treePath
  focus.select(treePath ? hashPath(treePath) : null)
  const sel = nodeToSelection(node)
  if (!sel) return
  if (uiMode.mode === 'edit') {
    // Write the hash — the route.hash watcher will open the editor.
    const hash = selectionToHash(sel)
    if (route.hash !== hash) {
      router.push({ hash, replace: true })
    } else {
      // Hash unchanged (e.g. clicking same component) — apply directly
      applyHashSelection()
    }
  } else {
    // Browse mode — clicking a component enters edit mode.
    // Write the hash and navigate to the edit URL.
    const hash = selectionToHash(sel)
    const prefix = selection.type === 'page' ? '/pages' : '/fragments'
    router.push({ path: `${prefix}/${selection.name}/edit`, hash })
  }
}

// Find a node by walking the tree
function findNodeByKey(nodes: ComponentNode[], predicate: (data: NodeData) => boolean): ComponentNode | null {
  for (const node of nodes) {
    if (node.data && predicate(node.data)) return node
    if (node.children.length) {
      const found = findNodeByKey(node.children, predicate)
      if (found) return found
    }
  }
  return null
}

// Select a component by its data-gz hash (called from PreviewPanel)
function selectByGzId(gzId: string) {
  const entry = gzMap.value.get(gzId)
  if (!entry) return
  focus.select(gzId)
  let sel: EditorSelection
  if ('isFragment' in entry) {
    const found = findNodeByKey(componentNodes.value, d => d.fragName === entry.fragName)
    if (found) selectedNodeKey.value = found.key
    sel =
      selection.type === 'page'
        ? { kind: 'fragmentLink', fragmentName: entry.fragName, treePath: `@${entry.fragName}`, childPath: null }
        : { kind: 'fragmentEdit', fragmentName: entry.fragName }
  } else {
    const found = findNodeByKey(componentNodes.value, d => d.path === entry.path)
    if (found) selectedNodeKey.value = found.key
    if (selection.type === 'page' && entry.path.startsWith('@')) {
      const parts = entry.path.slice(1).split('/')
      sel = {
        kind: 'fragmentLink',
        fragmentName: parts[0],
        treePath: entry.path,
        childPath: parts.length > 1 ? parts.slice(1).join('/') : null,
      }
    } else {
      sel = { kind: 'component', path: stripFragmentPrefix(entry.path), template: entry.template }
    }
  }
  // Write hash — the watcher opens the editor
  const hash = selectionToHash(sel)
  if (route.hash !== hash) {
    router.push({ hash, replace: true })
  } else {
    applyHashSelection()
  }
}

// --- Component operations ---

/**
 * Manifest key for the currently-selected page or fragment.
 * Returns null when nothing is selected — callers no-op in that case.
 */
function currentManifestKey(): import('gazetta/types').ManifestKey | null {
  const sel = selection.selection
  if (!sel) return null
  return { kind: sel.type, name: sel.name }
}

/**
 * Move a top-level component by `direction` (one position up or down).
 * Bounded — no-op when already at the top/bottom. Used by:
 *   - the legacy buttons (now only in screen-reader-fallback mode; visual
 *     buttons replaced by the grip handle in #105)
 *   - the Alt+ArrowUp / Alt+ArrowDown keyboard shortcut (Q6)
 */
function moveComponentTo(index: number, toIndex: number) {
  const comps = effectiveComponents.value
  if (!comps) return
  if (index < 0 || index >= comps.length || toIndex < 0 || toIndex >= comps.length || index === toIndex) return
  const key = currentManifestKey()
  if (!key) return
  editing.moveComponentStructural(key, comps, index, toIndex)
}

function moveComponent(index: number, direction: -1 | 1) {
  moveComponentTo(index, index + direction)
}

// --- Drag-and-drop reorder (#105) ---
//
// `@formkit/drag-and-drop` operates on a ref of values and mutates it on
// every live sort while the pointer crosses rows. 0.6.1 remaps node
// identities during a drag, but the intermediate sort events still describe
// transient positions. We ignore them so one gesture commits exactly one
// structural move, on `onDragend`, using the pointer's release point over the
// target block rather than a live index.
//
// `dragHandle: '.drag-handle'` restricts pointer drag to clicks on the
// grip element (not the row body — preserves click-to-select).
//
// The library's `handleNodeFocus` disables native drag when focus moves
// into a child during pointerdown. The grip is itself a focusable button,
// so that guard would disable the block before a drag could start. Keep
// the guard for the row's other focusable children, but exempt the grip.
// 0.6.1 still has this behavior (verified against the installed build and
// the mouse-drag e2e tests); removing the override makes grip drags fail
// whenever the grip was not already focused.
// (The library's keyboard handler is still empty in 0.6.1; the app handles
// Space-to-lift in `onTopLevelKeydown` below.)

const dragParentRef = ref<HTMLElement | null>(null)
const dragValues = ref<import('../api/client.js').ComponentEntry[]>([])
const dragSourceIndex = ref<number | null>(null)
/**
 * Boundary in the rendered list where a lifted row will land: 0 is above the
 * first row, `topLevelNodes.length` is below the last. `keyboardLift.to` is
 * the final array index after the source is spliced out, so a downward move
 * lands after the row currently at `to`, and an upward move before it.
 */
const keyboardInsertionBoundary = computed<number | null>(() => {
  const lift = keyboardLift.value
  if (!lift) return null
  if (lift.to === lift.from) return lift.from
  return lift.to < lift.from ? lift.to : lift.to + 1
})

watch(
  effectiveComponents,
  comps => {
    dragValues.value = comps ? [...comps] : []
  },
  { immediate: true },
)

let dragBoundEl: HTMLElement | null = null
let dragAbort: AbortController | null = null
let dragDropped = false
let synthDrag = false
let dropPoint: { blockIndex: number; after: boolean } | null = null

function setupDrag(el: HTMLElement | null) {
  if (el === dragBoundEl) return
  // The draggable list is behind `v-if="topLevelNodes.length"`. When the last
  // component is removed and a later add recreates the element, the old
  // listeners belong to a detached node and the library has no parent for the
  // new one. Tear down the old binding before initializing the new element.
  if (dragBoundEl) {
    dragAbort?.abort()
    dragAbort = null
    tearDown(dragBoundEl)
  }
  dragBoundEl = el
  if (!el) return
  dragAbort = new AbortController()
  const { signal } = dragAbort
  // Native drops fire `drop`; synthetic (touch) drops fire `pointerup`.
  // `onDragend` also fires for canceled drags, so require one of these
  // before committing the last hovered position. Capture the release
  // point too: the library's `incomingDirection` is entry direction,
  // not the drop half, so it can't distinguish before/after a block.
  const recordDrop = (e: DragEvent | PointerEvent) => {
    // Touch drags use implicit pointer capture, so `e.target` can stay on the
    // source grip even when the finger is released over another row. Resolve
    // the row under the release coordinates first and fall back to the event
    // target only when the point does not land inside this tree.
    const blockAt = (target: Element | null): HTMLElement | null => {
      const block = target?.closest('.top-level-block')
      return block instanceof HTMLElement && el.contains(block) ? block : null
    }
    const fromPoint =
      Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? document.elementFromPoint(e.clientX, e.clientY) : null
    const block = blockAt(fromPoint) ?? blockAt(e.target instanceof Element ? e.target : null)
    if (!block) return
    const blocks = [...el.querySelectorAll<HTMLElement>(':scope > .top-level-block')]
    const blockIndex = blocks.indexOf(block)
    if (blockIndex === -1) return
    const rect = block.getBoundingClientRect()
    dropPoint = { blockIndex, after: e.clientY > rect.top + rect.height / 2 }
    dragDropped = true
  }
  el.addEventListener('drop', recordDrop, { capture: true, signal })
  // Synthetic drags (touch/pen) skip the library's `onDragstart`, so capture
  // the source row on pointerdown and treat the pointerup as a drop. Native
  // mouse drags overwrite this in `onDragstart` before any drop can land.
  el.addEventListener(
    'pointerdown',
    e => {
      const handle = e.target instanceof Element ? e.target.closest('.drag-handle') : null
      const block = handle?.closest('.top-level-block')
      if (!(block instanceof HTMLElement) || !el.contains(block)) return
      const blocks = [...el.querySelectorAll<HTMLElement>(':scope > .top-level-block')]
      const blockIndex = blocks.indexOf(block)
      if (blockIndex === -1) return
      keyboardLift.value = null
      dragSourceIndex.value = blockIndex
      synthDrag = true
      dragDropped = false
      dropPoint = null
    },
    { capture: true, signal },
  )
  el.addEventListener(
    'pointerup',
    e => {
      if (synthDrag) recordDrop(e)
    },
    { capture: true, signal },
  )
  dragAndDrop({
    parent: el,
    values: dragValues,
    dragHandle: '.drag-handle',
    // Only actual rows are draggable nodes. The keyboard insertion line is
    // also a direct child; 0.6.1's remapNodes counts every node child, warns
    // on the value mismatch, and skips the remap, leaving rows after the line
    // mapped to the wrong value.
    draggable: child => child.classList.contains('top-level-block'),
    handleNodeFocus: (data, state) => {
      if (data.e.target === data.e.currentTarget || !state.pointerDown) return
      if (data.e.target instanceof Element && data.e.target.closest('.drag-handle')) return
      state.pointerDown.node.el.draggable = false
    },
    onDragstart: data => {
      keyboardLift.value = null
      dragSourceIndex.value = data.position
      synthDrag = 'clonedDraggedNode' in data.state
      dragDropped = false
      dropPoint = null
    },
    onDragend: data => {
      const from = dragSourceIndex.value
      const dropped = dragDropped
      const point = dropPoint
      const state = data.state as { targetIndex?: number; incomingDirection?: string }
      dragSourceIndex.value = null
      dragDropped = false
      synthDrag = false
      dropPoint = null
      if (dropped && from !== null) {
        // Prefer the release-point block. Fall back to the library's
        // target for synthetic drags that didn't expose a DOM target.
        const insertAt = point
          ? point.blockIndex + (point.after ? 1 : 0)
          : state.targetIndex !== undefined
            ? state.targetIndex + (state.incomingDirection === 'below' ? 1 : 0)
            : undefined
        if (insertAt !== undefined) {
          const to = from < insertAt ? insertAt - 1 : insertAt
          if (to !== from) moveComponentTo(from, to)
        }
      }
      // The library mutates `dragValues` on every live sort; reset it to
      // the store's authoritative order whether or not the drop moved.
      const comps = effectiveComponents.value
      dragValues.value = comps ? [...comps] : []
    },
  })
}

watch(dragParentRef, el => setupDrag(el))

onBeforeUnmount(() => {
  dragAbort?.abort()
  dragAbort = null
  if (dragBoundEl) tearDown(dragBoundEl)
  dragBoundEl = null
})

/**
 * Set the tree's single polite live region. Re-keying the message span makes
 * assistive tech re-announce a repeated message (for example, lifting the same
 * row again after Escape) instead of treating the unchanged text as a no-op.
 */
function announce(message: string): void {
  announcerText.value = message
  announcerVersion.value++
}

/**
 * Keyboard shortcuts on a focused top-level row:
 *   - Space, ArrowUp/Down, Space — lift, move, drop (#105 Q6).
 *   - Escape — cancel a lifted row.
 *   - Alt+ArrowUp / Alt+ArrowDown — move the row one position (#105 Q6).
 *   - Cmd+D (Mac) / Ctrl+D — duplicate the row (#45). Same modifier
 *     pattern as Notion / Figma / Pages.
 *
 * Shortcut-collision check:
 *   - Alt+ArrowUp is bound to "Up one folder" only in Firefox file
 *     pickers (not in apps); Safari/Chrome don't bind it at all.
 *   - Cmd+D is bound to "Bookmark this page" in browsers; we
 *     `preventDefault()` to suppress the bookmark prompt.
 */
function onTopLevelKeydown(ev: KeyboardEvent, index: number): void {
  // Cmd+D (mac) / Ctrl+D — duplicate. Modifier-only check: only the
  // primary modifier may be set (no Shift / Alt) so we don't shadow
  // platform shortcuts like Cmd+Shift+D.
  const primaryMod = ev.metaKey || ev.ctrlKey
  if (primaryMod && !ev.altKey && !ev.shiftKey && (ev.key === 'd' || ev.key === 'D')) {
    ev.preventDefault()
    duplicateComponent(index)
    return
  }

  // Space-to-lift / Space-to-drop on the grip (WAI-ARIA grab pattern).
  // The handler lives on the block, so ignore Space from action buttons.
  const handle = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.drag-handle') : null
  const noModifiers = !ev.altKey && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey
  if (handle && noModifiers && (ev.key === ' ' || ev.key === 'Spacebar')) {
    ev.preventDefault()
    if (keyboardLift.value && keyboardLift.value.from === index) {
      const { from, to } = keyboardLift.value
      const total = topLevelNodes.value.length
      keyboardLift.value = null
      if (from !== to) {
        pendingFocusLabel.value = topLevelNodes.value[index]?.label ?? null
        moveComponentTo(from, to)
        void nextTick(() => handle.focus())
      }
      announce(`Dropped at position ${to + 1} of ${total}`)
    } else {
      keyboardLift.value = { from: index, to: index }
      announce(
        `Picked up: ${topLevelNodes.value[index]?.label ?? ''}. Currently at position ${index + 1} of ${topLevelNodes.value.length}`,
      )
    }
    return
  }

  if (keyboardLift.value && ev.key === 'Escape') {
    ev.preventDefault()
    keyboardLift.value = null
    return
  }

  if (keyboardLift.value && keyboardLift.value.from === index && noModifiers) {
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault()
      const delta = ev.key === 'ArrowUp' ? -1 : 1
      const lastIndex = topLevelNodes.value.length - 1
      const next = Math.max(0, Math.min(lastIndex, keyboardLift.value.to + delta))
      if (next === keyboardLift.value.to) return
      keyboardLift.value.to = next
      announce(`Moved to position ${next + 1} of ${topLevelNodes.value.length}`)
      return
    }
  }

  // Alt+ArrowUp / Alt+ArrowDown — move. Modifier-only check (Alt only).
  if (!ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey) return
  keyboardLift.value = null
  if (ev.key === 'ArrowUp') {
    if (index === 0) return
    ev.preventDefault()
    moveComponent(index, -1)
  } else if (ev.key === 'ArrowDown') {
    if (index >= topLevelNodes.value.length - 1) return
    ev.preventDefault()
    moveComponent(index, 1)
  }
}

const pendingFocusLabel = ref<string | null>(null)

watch(
  componentNodes,
  () => {
    const label = pendingFocusLabel.value
    if (!label || !dragParentRef.value) return
    pendingFocusLabel.value = null
    const handle = Array.from(dragParentRef.value.querySelectorAll<HTMLElement>('.drag-handle')).find(
      el => el.dataset.testid === `drag-handle-${label}`,
    )
    handle?.focus()
  },
  { flush: 'post' },
)

function removeComponent(index: number) {
  const comps = effectiveComponents.value
  if (!comps) return
  const key = currentManifestKey()
  if (!key) return

  const removed = comps[index]
  if (!removed) return
  const removedName = typeof removed === 'string' ? removed : removed.name

  // The path is about to disappear from the manifest — drop any open editor
  // or stash entry under it so save never persists orphan content. Other
  // pending state (sibling components' edits, the page's structural lane) is
  // preserved — only the removed component's slot is cleared.
  editing.clearEditorForRemovedPath(removedName)
  editing.removeComponentStructural(key, comps, index)
  toast.show(`Removed "${removedName}"`)
}

function addComponent(name: string, template: string) {
  const comps = effectiveComponents.value
  if (!comps) return
  const key = currentManifestKey()
  if (!key) return
  const entry: import('../api/client.js').InlineComponent = { name, template, content: {} }
  editing.addComponentStructural(key, comps, entry)
  toast.show(`Added "${name}"`)
}

/**
 * Duplicate a top-level component (#45). Clones the entry — including
 * nested children for inline composites — generates a unique name in
 * the `<original>-copy[-N]` shape, and inserts it at index+1 so the
 * duplicate sits right after the source.
 *
 * Fragment refs (e.g., `@header`) duplicate as another reference to
 * the same fragment; the fragment's content is shared. Inline
 * components clone deeply; the duplicate's edits are independent.
 *
 * Insert pre-pending: the duplicate goes through editorStructural,
 * just like Add and Move — explicit save commits to disk.
 */
function duplicateComponent(index: number) {
  const comps = effectiveComponents.value
  if (!comps) return
  const key = currentManifestKey()
  if (!key) return
  const source = comps[index]
  if (source === undefined) return

  let newEntry: import('../api/client.js').ComponentEntry
  let displayName: string
  if (typeof source === 'string') {
    // Fragment ref — same `@name` pointer. Two refs to one fragment is
    // valid; the renderer composes the fragment twice.
    newEntry = source
    displayName = source
  } else {
    // Inline component — deep clone so the duplicate's content edits
    // don't bleed back into the source. JSON round-trip is sufficient
    // (manifests are JSON-shaped per design-publishing.md).
    const cloned = JSON.parse(JSON.stringify(source)) as import('../api/client.js').InlineComponent
    cloned.name = nextDuplicateName(source.name, comps)
    newEntry = cloned
    displayName = cloned.name
  }

  editing.addComponentStructural(key, comps, newEntry, index + 1)
  toast.show(`Duplicated "${displayName}"`)
}

/**
 * Pick a unique name for a duplicate of `originalName` against the
 * existing siblings. `<original>-copy` if available; else
 * `<original>-copy-2`, `<original>-copy-3`, ... matches the Notion /
 * Figma / macOS Finder convention.
 *
 * Sibling check considers BOTH inline components (by `.name`) and
 * fragment refs (by string after stripping `@`) so collisions across
 * the two shapes are caught.
 */
function nextDuplicateName(
  originalName: string,
  siblings: readonly import('../api/client.js').ComponentEntry[],
): string {
  const taken = new Set<string>()
  for (const entry of siblings) {
    if (typeof entry === 'string') taken.add(entry.replace(/^@/, ''))
    else taken.add(entry.name)
  }
  // Strip an existing `-copy[-N]` suffix from the original so duplicating
  // a duplicate produces `hero-copy-2`, not `hero-copy-copy`.
  const base = originalName.replace(/-copy(-\d+)?$/, '')
  const candidate = `${base}-copy`
  if (!taken.has(candidate)) return candidate
  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}-${n}`
    if (!taken.has(next)) return next
  }
  // Pathological — a thousand duplicates already exist. Fall back to
  // a timestamp suffix; user can rename.
  return `${candidate}-${Date.now()}`
}
</script>

<template>
  <div v-if="detail" class="component-tree">
    <!-- One polite live region for the keyboard lift/move/drop path. The
         keyed span re-announces repeated messages without changing the
         announced text. Kept in the accessibility tree by the CSS below. -->
    <div
      class="component-tree-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="component-tree-announcer">
      <span :key="announcerVersion">{{ announcerText }}</span>
    </div>

    <!-- Root row (the page or fragment itself). Rendered outside the
         draggable list so it isn't a drop target. -->
    <div v-if="rootNode"
      :class="['node-item', 'node-root', { selected: selectedNodeKey === rootNode.key, hovered: hoveredNodeKey === rootNode.key }]"
      :data-testid="`component-${rootNode.label}`"
      @click="onSelect(rootNode)"
      @mouseenter="onHover(rootNode)"
      @mouseleave="onHoverEnd()">
      <i :class="nodeIcon(rootNode, -1)" class="node-icon" />
      <span v-if="rootDirty" class="node-dirty-dot" />
      <span class="node-label">{{ rootNode.label }}</span>
      <Button v-if="rootDirty"
        icon="pi pi-undo" text rounded size="small" class="node-revert"
        title="Discard changes" @click.stop="revertComponent('_root')" />
    </div>

    <!-- Draggable list of top-level components. Each block contains the
         top-level row (with grip handle) + its flattened nested rows.
         The library reorders these blocks; nested rows ride along.
         Per design-component-ordering.md Q5, drag scope is top-level
         only at v1; nested rows render as static (non-draggable) inside
         the block. -->
    <div v-if="topLevelNodes.length" ref="dragParentRef" class="top-level-list" data-testid="component-tree-draggable">
      <template v-for="(topNode, topIndex) in topLevelNodes" :key="topNode.key">
        <!-- Keyboard lift destination. The line sits at the boundary where
             the lifted row will land if Space drops it now. -->
        <div v-if="keyboardInsertionBoundary === topIndex"
          class="keyboard-insertion-line"
          data-testid="keyboard-insertion-indicator"
          :data-boundary="topIndex" />
        <div
          :data-component-name="topNode.label"
          :class="['top-level-block', { 'keyboard-lifted': keyboardLift?.from === topIndex }]"
          @keydown="onTopLevelKeydown($event, topIndex)">
          <!-- The top-level row itself — draggable via the grip handle. -->
          <div
            :class="['node-item', 'top-level-row', { selected: selectedNodeKey === topNode.key, hovered: hoveredNodeKey === topNode.key }]"
            :data-testid="`component-${topNode.data?.isFragment ? topNode.data.fragName : topNode.label}`"
            @click="onSelect(topNode)"
            @mouseenter="onHover(topNode)"
            @mouseleave="onHoverEnd()">
            <button
              type="button"
              class="drag-handle"
              :data-testid="`drag-handle-${topNode.label}`"
              :aria-label="`Drag ${topNode.label} to reorder, or press Space then Arrow Up/Down, then Space again. Alt+Arrow moves immediately.`"
              :title="`Drag to reorder, or press Space + Arrow Up/Down + Space`"
              tabindex="0"
              @click.stop>
              <i class="pi pi-bars" aria-hidden="true" />
            </button>
            <i v-if="topNode.data?.error" class="pi pi-exclamation-triangle node-icon node-error-icon"
              :title="topNode.data.error" />
            <i v-else :class="nodeIcon(topNode, 0)" class="node-icon" />
            <span v-if="topNode.data?.path && (editing.hasPendingEdit(topNode.data.path) || (editing.dirty && editing.path === topNode.data.path))" class="node-dirty-dot" />
            <span class="node-label">{{ topNode.label }}</span>
            <Button v-if="topNode.data?.path && (editing.hasPendingEdit(topNode.data.path) || (editing.dirty && editing.path === topNode.data.path))"
              icon="pi pi-undo" text rounded size="small" class="node-revert"
              title="Discard changes" @click.stop="revertComponent(topNode.data.path!)" />
            <span class="node-actions">
              <Button icon="pi pi-clone" text rounded size="small"
                :data-testid="`duplicate-${topNode.label}`"
                :aria-label="`Duplicate ${topNode.label}`"
                :title="`Duplicate (Cmd/Ctrl+D)`"
                @click.stop="duplicateComponent(topIndex)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger"
                :data-testid="`remove-${topNode.label}`"
                :aria-label="`Remove ${topNode.label}`"
                @click.stop="removeComponent(topIndex)" />
            </span>
          </div>

          <!-- Nested rows belonging to this top-level block. Rendered
               inside the block so they ride along on drag. Not
               individually draggable (no drag-handle). -->
          <div v-for="{ node: nestedNode, depth } in flattenNested(topNode)"
            :key="nestedNode.key"
            :class="['node-item', 'nested-row', { selected: selectedNodeKey === nestedNode.key, hovered: hoveredNodeKey === nestedNode.key }]"
            :style="nodeStyle(depth)"
            :data-testid="`component-${nestedNode.data?.isFragment ? nestedNode.data.fragName : nestedNode.label}`"
            @click="onSelect(nestedNode)"
            @mouseenter="onHover(nestedNode)"
            @mouseleave="onHoverEnd()">
            <i v-if="nestedNode.data?.error" class="pi pi-exclamation-triangle node-icon node-error-icon"
              :title="nestedNode.data.error" />
            <i v-else :class="nodeIcon(nestedNode, depth)" class="node-icon" />
            <span v-if="nestedNode.data?.path && (editing.hasPendingEdit(nestedNode.data.path) || (editing.dirty && editing.path === nestedNode.data.path))" class="node-dirty-dot" />
            <span class="node-label">{{ nestedNode.label }}</span>
            <Button v-if="nestedNode.data?.path && (editing.hasPendingEdit(nestedNode.data.path) || (editing.dirty && editing.path === nestedNode.data.path))"
              icon="pi pi-undo" text rounded size="small" class="node-revert"
              title="Discard changes" @click.stop="revertComponent(nestedNode.data.path!)" />
          </div>
        </div>
      </template>
      <div v-if="keyboardInsertionBoundary === topLevelNodes.length"
        class="keyboard-insertion-line"
        data-testid="keyboard-insertion-indicator"
        :data-boundary="topLevelNodes.length" />
    </div>
    <p v-else class="empty">No components</p>

    <Button icon="pi pi-plus" label="Add component" text size="small" class="add-btn"
      data-testid="add-component" @click="showAddDialog = true" />

    <AddComponentDialog v-if="showAddDialog" :visible="showAddDialog"
      @close="showAddDialog = false" @add="addComponent" />
  </div>
</template>

<style scoped>
.component-tree { font-size: 13px; line-height: 22px; }
/* Visually hidden but still exposed to assistive technology. No display:none,
   visibility:hidden or [hidden] — those remove the live region from the
   accessibility tree. */
.component-tree-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.empty { color: var(--color-muted); }
.node-item { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; margin: 0 2px; cursor: pointer; border-radius: 3px; }
.node-item:hover, .node-item.hovered { background: var(--color-hover-bg); }
.node-item.selected { background: rgba(167, 139, 250, 0.15); box-shadow: inset 2px 0 0 var(--p-violet-400); }
.node-root { font-weight: 600; padding: 0 6px; height: 26px; line-height: 26px; border-radius: 0; margin: 0 0 2px 0; border-bottom: 1px solid var(--color-border); }
.node-root.selected { background: rgba(167, 139, 250, 0.1); box-shadow: none; border-bottom-color: var(--p-violet-400); }
.node-icon { width: 16px; text-align: center; font-size: 10px; color: var(--color-muted); flex-shrink: 0; }
.node-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-muted); }
.node-item.selected .node-label,
.node-item:hover .node-label,
.node-item.hovered .node-label,
.node-root .node-label { color: var(--color-fg); }
.node-error-icon { color: var(--color-danger-fg); }
.node-dirty-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning-fg); flex-shrink: 0; }
.node-revert { opacity: 0; transition: opacity 0.1s; width: 18px; height: 18px; flex-shrink: 0; }
.node-item:hover .node-revert { opacity: 1; }
.node-actions { display: flex; gap: 0; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
.node-item:hover .node-actions { opacity: 1; }
.add-btn { margin-top: 6px; }

/* #105 — DnD reorder. The grip handle is always visible (not hover-
   gated) per design-component-ordering.md Q2. The handle is a button
   so it's keyboard-focusable and screen-reader-discoverable. */
.top-level-list { display: flex; flex-direction: column; gap: 0; }
.top-level-block { display: flex; flex-direction: column; }
.top-level-block.keyboard-lifted > .top-level-row {
  background: var(--color-hover-bg);
  outline: 1px dashed var(--p-violet-400);
  outline-offset: -1px;
}
/* Keyboard lift destination. Negative vertical margins keep the line from
   shifting rows as it moves between boundaries. */
.keyboard-insertion-line {
  position: relative;
  z-index: 1;
  height: 2px;
  margin: -1px 2px;
  background: var(--color-primary);
  border-radius: 1px;
  flex-shrink: 0;
  pointer-events: none;
}
.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--color-muted);
  cursor: grab;
  flex-shrink: 0;
}
.drag-handle:hover {
  color: var(--color-fg);
  background: var(--color-hover-bg);
}
.drag-handle:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}
.drag-handle .pi-bars {
  font-size: 10px;
}
.drag-handle:active {
  cursor: grabbing;
}

/* The dragged row gets a subtle lift (FormKit DnD adds a class to the
   dragged element by default; we style it conservatively to match
   the existing selection chrome). */
.top-level-row[draggable='true'] {
  /* Pointer drag attribute — set by FormKit DnD. */
}
.top-level-block.dragging .top-level-row {
  opacity: 0.5;
}
</style>
