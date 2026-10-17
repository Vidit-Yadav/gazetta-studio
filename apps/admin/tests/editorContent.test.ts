import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEditorContentStore, type EditingTarget } from '../src/client/stores/editorContent.js'

function makeTarget(overrides: Partial<EditingTarget> = {}): EditingTarget {
  return {
    template: 'hero',
    path: 'hero',
    content: { title: 'Hello' },
    schema: { properties: { title: { type: 'string' } } },
    save: async () => {},
    ...overrides,
  }
}

const CUSTOM_EDITOR_URL = 'data:text/javascript,' + encodeURIComponent('export default { mount() {}, unmount() {} }')

function editorTarget(overrides: Partial<EditingTarget> = {}): EditingTarget {
  return makeTarget({ hasEditor: true, editorUrl: CUSTOM_EDITOR_URL, ...overrides })
}

describe('editorContent', () => {
  beforeEach(() => setActivePinia(createPinia()))

  describe('open', () => {
    it('sets target, content, and saved from the editing target', async () => {
      const store = useEditorContentStore()
      const t = makeTarget()
      await store.open(t)
      expect(store.target).toEqual(t)
      expect(store.content).toEqual({ title: 'Hello' })
      expect(store.saved).toEqual({ title: 'Hello' })
      expect(store.dirty).toBe(false)
    })

    it('uses editedContent when provided (restoring from stash)', async () => {
      const store = useEditorContentStore()
      const t = makeTarget({ content: { title: 'Original' } })
      await store.open(t, { title: 'Modified' })
      expect(store.content).toEqual({ title: 'Modified' })
      expect(store.saved).toEqual({ title: 'Original' })
      expect(store.dirty).toBe(true)
    })

    it('deep clones content so mutations are independent', async () => {
      const store = useEditorContentStore()
      const original = { title: 'Hello' }
      await store.open(makeTarget({ content: original }))
      original.title = 'Mutated'
      expect(store.content).toEqual({ title: 'Hello' })
    })

    it('increments mountVersion to trigger editor remount', async () => {
      const store = useEditorContentStore()
      expect(store.mountVersion).toBe(0)
      await store.open(makeTarget())
      expect(store.mountVersion).toBe(1)
      await store.open(makeTarget())
      expect(store.mountVersion).toBe(2)
    })

    it('discards stale custom editor import when a newer open() starts', async () => {
      const store = useEditorContentStore()
      // Simulate two rapid opens — first has a custom editor, second doesn't
      const slowTarget = makeTarget({
        template: 'slow',
        hasEditor: true,
        editorUrl: 'data:text/javascript,export default { mount(){}, unmount(){} }',
      })
      const fastTarget = makeTarget({ template: 'fast' })
      // Start both opens — the second should win
      const p1 = store.open(slowTarget)
      const p2 = store.open(fastTarget)
      await Promise.all([p1, p2])
      // The fast target should be active, custom editor should be null (fast has none)
      expect(store.target?.template).toBe('fast')
      expect(store.customEditorMount).toBeNull()
    })

    it('clears fragmentLink and loadError', async () => {
      const store = useEditorContentStore()
      store.showFragmentLink('header')
      store.setLoadError('broken')
      await store.open(makeTarget())
      expect(store.fragmentLink).toBeNull()
      expect(store.loadError).toBeNull()
    })

    it('mounts the custom editor when the import is not invalidated', async () => {
      const store = useEditorContentStore()
      await store.open(editorTarget())
      expect(store.customEditorMount).not.toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(1)
    })

    it('keeps falling back to the default form when a non-invalidated import fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = useEditorContentStore()
      await store.open(editorTarget({ editorUrl: 'data:text/javascript,throw new Error("boom")' }))
      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(1)
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })
  })

  // A pending custom-editor import must not resurrect state for a target
  // that is no longer open (#921): clear() / setLoadError() / showFragmentLink()
  // advance the generation so the stale completion is discarded.
  describe('stale custom-editor import invalidation', () => {
    it('clear() discards a pending import', async () => {
      const store = useEditorContentStore()
      const pending = store.open(editorTarget())
      expect(store.customEditorLoading).toBe(true)
      const versionBefore = store.mountVersion

      store.clear()
      await pending

      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(versionBefore)
    })

    it('setLoadError() discards a pending import', async () => {
      const store = useEditorContentStore()
      const pending = store.open(editorTarget())
      expect(store.customEditorLoading).toBe(true)
      const versionBefore = store.mountVersion

      store.setLoadError('Template not found')
      await pending

      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(versionBefore)
      expect(store.loadError).toBe('Template not found')
    })

    it('showFragmentLink() discards a pending import', async () => {
      const store = useEditorContentStore()
      const pending = store.open(editorTarget())
      expect(store.customEditorLoading).toBe(true)
      const versionBefore = store.mountVersion

      store.showFragmentLink('footer')
      await pending

      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(versionBefore)
      expect(store.fragmentLink).toBe('footer')
    })

    it('lets a newer open() complete after an older request was invalidated', async () => {
      const store = useEditorContentStore()
      const stale = store.open(editorTarget({ template: 'stale' }))
      store.clear()
      await store.open(makeTarget({ template: 'fresh' }))

      expect(store.target?.template).toBe('fresh')
      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(1)

      await stale

      expect(store.target?.template).toBe('fresh')
      expect(store.customEditorMount).toBeNull()
      expect(store.customEditorLoading).toBe(false)
      expect(store.mountVersion).toBe(1)
    })
  })

  describe('dirty', () => {
    it('is false when content matches saved', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      expect(store.dirty).toBe(false)
    })

    it('is true after markDirty with different content', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      store.markDirty({ title: 'Changed' })
      expect(store.dirty).toBe(true)
    })

    it('is false when no content is loaded', () => {
      const store = useEditorContentStore()
      expect(store.dirty).toBe(false)
    })

    it('uses cached savedJson (one stringify, not two)', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget({ content: { title: 'A' } }))
      store.markDirty({ title: 'B' })
      expect(store.dirty).toBe(true)
      store.markDirty({ title: 'A' })
      expect(store.dirty).toBe(false)
    })
  })

  describe('markSaved', () => {
    it('updates saved baseline to match current content', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      store.markDirty({ title: 'New' })
      expect(store.dirty).toBe(true)
      store.markSaved()
      expect(store.dirty).toBe(false)
      expect(store.saved).toEqual({ title: 'New' })
    })
  })

  describe('discard', () => {
    it('reverts content to saved and bumps mountVersion', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      const versionBefore = store.mountVersion
      store.markDirty({ title: 'Draft' })
      expect(store.dirty).toBe(true)
      store.discard()
      expect(store.content).toEqual({ title: 'Hello' })
      expect(store.dirty).toBe(false)
      expect(store.mountVersion).toBe(versionBefore + 1)
    })

    it('is a no-op when nothing is open', () => {
      const store = useEditorContentStore()
      store.discard()
      expect(store.content).toBeNull()
    })
  })

  describe('showFragmentLink', () => {
    it('clears editor state and sets fragment name', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      store.showFragmentLink('footer')
      expect(store.target).toBeNull()
      expect(store.content).toBeNull()
      expect(store.fragmentLink).toBe('footer')
    })

    it('extracts fragment name from treePath', () => {
      const store = useEditorContentStore()
      store.showFragmentLink('@header/logo')
      expect(store.fragmentLink).toBe('header')
    })
  })

  describe('setLoadError', () => {
    it('clears target and sets error message', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      store.setLoadError('Template not found')
      expect(store.target).toBeNull()
      expect(store.loadError).toBe('Template not found')
    })
  })

  describe('clear', () => {
    it('resets all state to defaults', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget())
      store.markDirty({ title: 'Draft' })
      store.clear()
      expect(store.target).toBeNull()
      expect(store.content).toBeNull()
      expect(store.saved).toBeNull()
      expect(store.dirty).toBe(false)
      expect(store.loadError).toBeNull()
      expect(store.fragmentLink).toBeNull()
    })
  })

  describe('computed properties', () => {
    it('exposes template, path, schema from target', async () => {
      const store = useEditorContentStore()
      await store.open(makeTarget({ template: 'hero', path: 'hero', schema: { type: 'object' } }))
      expect(store.template).toBe('hero')
      expect(store.path).toBe('hero')
      expect(store.schema).toEqual({ type: 'object' })
    })

    it('returns null when no target', () => {
      const store = useEditorContentStore()
      expect(store.template).toBeNull()
      expect(store.path).toBeNull()
      expect(store.schema).toBeNull()
    })
  })
})
