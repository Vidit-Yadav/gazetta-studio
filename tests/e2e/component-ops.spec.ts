import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

function topLevelNames(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="component-tree-draggable"] > .top-level-block')
    .evaluateAll(blocks => blocks.map(block => block.getAttribute('data-component-name') ?? ''))
}

/**
 * Save and wait for the post-save selection reload, not just the Save button.
 * The button is disabled while clean and while saving; it can become disabled
 * again before `selection.reload()` finishes, leaving `effectiveComponents`
 * stale for a move issued in that window.
 */
async function saveAndWaitForReload(page: Page): Promise<void> {
  const savedAndReloaded = new Promise<void>(resolve => {
    let writeSeen = false
    const onResponse = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url())
      if (!url.pathname.endsWith('/api/pages/home')) return
      const method = response.request().method()
      if (method === 'PUT') {
        writeSeen = true
      } else if (writeSeen && method === 'GET') {
        page.off('response', onResponse)
        resolve()
      }
    }
    page.on('response', onResponse)
  })
  await page.click('[data-testid="save-btn"]')
  await savedAndReloaded
  await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 10000 })
}

test.describe('Component operations', () => {
  // These tests mutate page.json on disk via the API. Isolation comes from the
  // worker-scoped testSite fixture — each Playwright worker has its own copy
  // of the starter site. Tests within the file share state; each one uses a
  // unique component name so they don't collide.

  test('add inline component via dialog', async ({ page }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const name = `test-add-${testInfo.testId}`

    const beforeCount = await tree.allRows.count()

    await tree.add(name, 'text-block')

    await expect(tree.row(name)).toBeVisible({ timeout: 10000 })
    expect(await tree.allRows.count()).toBe(beforeCount + 1)
  })

  test('remove component', async ({ page }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const name = `test-remove-${testInfo.testId}`

    // Add a component first so we have something to remove
    await tree.add(name, 'text-block')
    await expect(tree.row(name)).toBeVisible({ timeout: 10000 })

    const beforeCount = await tree.allRows.count()

    await tree.remove(name)

    await expect(tree.row(name)).not.toBeVisible({ timeout: 10000 })
    expect(await tree.allRows.count()).toBe(beforeCount - 1)
  })

  test('move component changes order in the tree (pending until save)', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // hero should be above features in the tree
    const heroBefore = await tree.row('hero').boundingBox()
    const featuresBefore = await tree.row('features').boundingBox()
    expect(heroBefore!.y).toBeLessThan(featuresBefore!.y)

    // Move features up — it should swap with hero in the tree (pending state)
    await tree.moveUp('features')

    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Save flushes the pending reorder to disk
    await saveAndWaitForReload(page)

    // After save, selection.reload() asynchronously re-fetches the page
    // detail; the v-for then re-renders with the saved order. Save-btn-
    // disabled doesn't signal that completion. Wait for the rendered
    // state to match disk before issuing the next move so the new
    // moveDown captures a fresh `topIndex` closure.
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Restore order so subsequent tests see hero above features
    await tree.moveDown('features')
    await saveAndWaitForReload(page)
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(heroAfter!.y).toBeLessThan(featuresAfter!.y)
    }).toPass({ timeout: 10000 })
  })

  // Regression for #106 — reordering must be batched into the pending model
  // alongside content edits. The bug: reorder used to write immediately,
  // so discarding the focused content edit reverted content but not order,
  // breaking authors' "everything pending until save" expectation.
  test('reorder + content edit are both pending until save (#106)', async ({ page, testSite }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const pageJsonPath = join(testSite.projectDir, 'sites/main/targets/local/pages/home/page.json')

    // Snapshot disk state before any edits.
    const beforeJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const beforeNames = (beforeJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )

    // Make a structural pending edit (move features up).
    await tree.moveUp('features')

    // Tree reflects the pending order immediately.
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Disk file has NOT changed — the reorder is only pending.
    const duringJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const duringNames = (duringJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
    expect(duringNames).toEqual(beforeNames)

    // Save button is enabled because there's pending work.
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await expect(saveBtn).toBeEnabled()

    // Save flushes structural change to disk.
    await saveAndWaitForReload(page)
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    const afterJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const afterNames = (afterJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
    expect(afterNames.indexOf('features')).toBeLessThan(afterNames.indexOf('hero'))

    // Wait for the post-save reload to fully render before the cleanup
    // moveDown captures a stale `topIndex` closure. See sibling test
    // for the full rationale.
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Cleanup so subsequent tests in this file see the original order.
    await tree.moveDown('features')
    await saveAndWaitForReload(page)
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    // Mark the test info — useful when this regression is mentioned in the
    // PR / changelog.
    testInfo.annotations.push({ type: 'regression', description: 'github#106' })
  })

  // #105 — drag-handle UX, replaces the legacy move-up/move-down buttons.
  // Tests below cover the things existing move-up/down tests don't:
  //   - The drag handle is rendered + accessible
  //   - Legacy move-up/move-down test ids no longer exist
  //   - Alt+Arrow shortcut works against the focused handle (the POM's
  //     moveUp / moveDown use this shortcut now; this test pins the
  //     direct keyboard interaction so a future change to the POM
  //     doesn't silently break the keyboard path)
  test('drag handles are rendered with accessible labels (#105)', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await expect(tree.row('hero')).toBeVisible({ timeout: 10000 })

    const heroHandle = page.locator('[data-testid="drag-handle-hero"]')
    await expect(heroHandle).toBeVisible()
    await expect(heroHandle).toHaveAttribute('aria-label', /drag hero to reorder/i)

    // Legacy buttons should NOT be present anywhere.
    await expect(page.locator('[data-testid="move-up-hero"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="move-down-hero"]')).toHaveCount(0)

    // Trash button stays — delete is a different action.
    const heroRow = tree.row('hero')
    await heroRow.hover()
    await expect(page.locator('[data-testid="remove-hero"]')).toBeVisible()
  })

  // #45 — component duplication. Two paths: per-row Duplicate button + Cmd/Ctrl+D
  // keyboard shortcut. Both share the same store action (addComponentStructural
  // with insertIndex), so we exercise the button path here as the primary
  // surface and the keyboard path in the unit suite.
  test('duplicate component creates a copy with -copy suffix at index+1 (#45)', async ({
    page,
    testSite,
  }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const name = `dup-source-${testInfo.testId}`
    // Add a fresh component so the test owns a clean source — avoids
    // collisions with other tests in this file that mutate `home`.
    await tree.add(name, 'text-block')
    await expect(tree.row(name)).toBeVisible({ timeout: 10000 })

    await tree.duplicate(name)
    await expect(tree.row(`${name}-copy`)).toBeVisible({ timeout: 10000 })

    // Save flushes both Add + Duplicate. After save, the disk manifest
    // has both entries with the duplicate sitting right after the source.
    await saveAndWaitForReload(page)

    const pageJsonPath = join(testSite.projectDir, 'sites/main/targets/local/pages/home/page.json')
    const json = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const names = (json.components as Array<string | { name: string }>).map(c => (typeof c === 'string' ? c : c.name))
    const sourceIdx = names.indexOf(name)
    const copyIdx = names.indexOf(`${name}-copy`)
    expect(sourceIdx).toBeGreaterThan(-1)
    expect(copyIdx).toBe(sourceIdx + 1)

    // Cleanup: remove both so the file ends in a stable state.
    await tree.remove(`${name}-copy`)
    await tree.remove(name)
    await saveAndWaitForReload(page)
  })

  test('Alt+ArrowDown on the focused handle moves the row one position (#105)', async ({ page, testSite }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await expect(tree.row('hero')).toBeVisible({ timeout: 10000 })

    // Focus hero's drag handle and press Alt+ArrowDown — should move hero
    // below features (its sibling at index 2 in the starter).
    const heroBefore = await tree.row('hero').boundingBox()
    const featuresBefore = await tree.row('features').boundingBox()
    expect(heroBefore!.y).toBeLessThan(featuresBefore!.y)

    await page.locator('[data-testid="drag-handle-hero"]').focus()
    await page.keyboard.press('Alt+ArrowDown')

    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Save + restore so the test is idempotent for the file.
    const pageJsonPath = join(testSite.projectDir, 'sites/main/targets/local/pages/home/page.json')
    await saveAndWaitForReload(page)

    const afterJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const afterNames = (afterJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
    expect(afterNames.indexOf('features')).toBeLessThan(afterNames.indexOf('hero'))

    // Wait for post-save reload to fully render before issuing the
    // restore. saveBtn-disabled is not the same signal as
    // selection.reload()-complete; the v-for needs to re-render with
    // the saved order so the next focus + key press captures a fresh
    // `topIndex` closure on the right block.
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Restore order.
    await page.locator('[data-testid="drag-handle-hero"]').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await saveAndWaitForReload(page)
  })

  test('dragging still works after the tree is emptied and repopulated', async ({ page }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const firstName = `drag-empty-a-${testInfo.testId}`
    const secondName = `drag-empty-b-${testInfo.testId}`

    const blocks = page.locator('[data-testid="component-tree-draggable"] > .top-level-block')
    while ((await blocks.count()) > 0) {
      const block = blocks.first()
      await block.hover()
      await block.locator('[data-testid^="remove-"]').click()
    }
    await expect(page.getByText('No components')).toBeVisible()
    await expect(page.locator('[data-testid="component-tree-draggable"]')).toHaveCount(0)

    await tree.add(firstName, 'text-block')
    await tree.add(secondName, 'text-block')
    await expect(tree.row(secondName)).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="component-tree-draggable"]')).toBeVisible()

    const handle = page.locator(`[data-testid="drag-handle-${secondName}"]`)
    const target = tree.row(firstName)
    const from = (await handle.boundingBox())!
    const to = (await target.boundingBox())!

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 5 })
    await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 20 })
    await page.mouse.up()

    await expect.poll(async () => (await topLevelNames(page)).indexOf(secondName)).toBe(0)
  })

  test('dragging a top-level component by its grip reorders the tree', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await expect(tree.row('hero')).toBeVisible({ timeout: 10000 })

    const before = await topLevelNames(page)
    expect(before.indexOf('banner')).toBeGreaterThan(before.indexOf('hero'))
    await expect(saveBtn).toBeDisabled()

    const handle = page.locator('[data-testid="drag-handle-banner"]')
    const target = tree.row('hero')
    const from = (await handle.boundingBox())!
    const to = (await target.boundingBox())!

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 5 })
    await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 20 })
    await page.mouse.up()

    await expect
      .poll(async () => {
        const names = await topLevelNames(page)
        return names.indexOf('banner') - names.indexOf('hero')
      })
      .toBe(-1)
    await expect(saveBtn).toBeEnabled()
    // The reorder stays pending; this test doesn't save, so the shared
    // on-disk fixture is untouched and the next test starts clean.
  })

  test('Space lift, arrow, Space drop reorders a top-level component', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await expect(tree.row('hero')).toBeVisible({ timeout: 10000 })

    // FormKit's remapNodes warns when its draggable-node count differs from
    // the value count. The insertion line is a child of the same parent, so
    // without the draggable filter it would trigger this while lifted.
    const draggableWarnings: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'warning' && msg.text().includes('number of draggable items')) {
        draggableWarnings.push(msg.text())
      }
    })

    const before = await topLevelNames(page)
    const bannerBefore = before.indexOf('banner')
    expect(bannerBefore).toBeGreaterThan(0)
    await expect(saveBtn).toBeDisabled()

    const handle = page.locator('[data-testid="drag-handle-banner"]')
    await handle.focus()
    await expect(handle).toBeFocused()
    await page.keyboard.press('Space')

    // The lifted row shows where it would land; ArrowUp moves that marker.
    const indicator = page.locator('[data-testid="keyboard-insertion-indicator"]')
    await expect(indicator).toBeVisible()
    expect(await indicator.getAttribute('data-boundary')).toBe(`${bannerBefore}`)
    expect(await indicator.evaluate(el => el.nextElementSibling?.getAttribute('data-component-name'))).toBe('banner')

    await page.keyboard.press('ArrowUp')
    await expect(indicator).toHaveAttribute('data-boundary', `${bannerBefore - 1}`)
    expect(await indicator.evaluate(el => el.nextElementSibling?.getAttribute('data-component-name'))).toBe(
      before[bannerBefore - 1],
    )

    await page.keyboard.press('Space')
    await expect(indicator).toHaveCount(0)
    expect(draggableWarnings).toEqual([])

    await expect
      .poll(async () => {
        const names = await topLevelNames(page)
        return names.indexOf('banner')
      })
      .toBe(bannerBefore - 1)
    await expect(saveBtn).toBeEnabled()
    await expect(handle).toBeFocused()

    // A pointer drag after the insertion line has come and gone must still
    // grab the row under the cursor and land it on the right boundary.
    const target = tree.row('hero')
    const from = (await handle.boundingBox())!
    const to = (await target.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 5 })
    await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 20 })
    await page.mouse.up()

    await expect
      .poll(async () => {
        const names = await topLevelNames(page)
        return names.indexOf('banner') - names.indexOf('hero')
      })
      .toBe(-1)
    // Pending only; leaving the on-disk fixture untouched keeps the
    // next test's baseline order intact.
  })
})
