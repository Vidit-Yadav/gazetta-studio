/**
 * Integration tests for `gazetta history`, `gazetta undo`, and
 * `gazetta rollback`. Spawns the CLI against a temp copy of the
 * starter site so we exercise argument parsing, target resolution,
 * env loading, and the actual restore path.
 *
 * Fast-ish: each test runs ~3 subprocess calls + filesystem writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Run the CLI against `cwd` with the given args. CI=true is set so
 * we never hit the interactive site/target picker; all the tests
 * pass the target explicitly.
 */
function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise(done => {
    const child = spawn(tsxBin, [cliPath, ...args], {
      cwd,
      env: { ...process.env, CI: 'true', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => (stdout += d.toString()))
    child.stderr?.on('data', d => (stderr += d.toString()))
    child.on('close', code => done({ stdout, stderr, code: code ?? 0 }))
  })
}

/** Make N saves via the admin-api PUT route to seed history. */
async function seedHistory(projectDir: string, count: number): Promise<void> {
  // Use the history-recorder directly — spinning up a dev server per
  // test is too slow. Mirrors what the PUT /api/pages route does.
  const gazetta = await import('../src/index.js')
  const storage = gazetta.createFilesystemProvider(resolve(projectDir, 'sites/main/targets/local'))
  const history = gazetta.createHistoryProvider({ storage })
  const contentRoot = gazetta.createContentRoot(storage)
  for (let i = 0; i < count; i++) {
    const path = 'pages/home/page.json'
    const content =
      JSON.stringify(
        {
          template: 'page-default',
          content: { title: `Edit ${i + 1}` },
          components: ['@header'],
        },
        null,
        2,
      ) + '\n'
    await gazetta.recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path, content }],
    })
    await storage.writeFile(path, content)
    // Small delay so successive timestamp ids are unique (millisecond
    // resolution means same-ms writes collide and get -<seq> suffixes,
    // which work but make list assertions noisier).
    await new Promise(r => setTimeout(r, 5))
  }
}

// Spawning the CLI per test is slow (tsx cold-import + env load +
// bootstrap). Bump the per-test timeout so the slowest cases (tests
// that do two spawns) have headroom even on CI under load.
describe('gazetta history / undo / rollback', { timeout: 60000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-history-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(projectDir, { recursive: true })
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('`history` lists the revisions on a target newest-first', async () => {
    await seedHistory(projectDir, 2)
    const res = await runCli(projectDir, ['history', 'local', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('History — local')
    // Baseline + 2 saves = 3 revisions.
    expect(res.stdout).toContain('3 revisions')
    expect(res.stdout).toContain('Initial baseline')
    // Newest first: the "Edit 2" state is head; the `Initial baseline`
    // tag should appear AFTER the others in the output.
    const baselineAt = res.stdout.indexOf('Initial baseline')
    const firstSaveAt = res.stdout.search(/rev-\d+(?:-\d+)?(?:-[0-9a-f]{8})?\s+save\s+/)
    // search() returns -1 on no match, which would make the ordering
    // assertion vacuous — require an actual save row first.
    expect(firstSaveAt).toBeGreaterThanOrEqual(0)
    expect(baselineAt).toBeGreaterThan(firstSaveAt)
  })

  it('`history` reports friendly message on a target with no history', async () => {
    const res = await runCli(projectDir, ['history', 'local', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('No revisions')
  })

  it('`undo` restores the previous revision and reports the new head', async () => {
    await seedHistory(projectDir, 2)
    const homePath = resolve(projectDir, 'sites/main/targets/local/pages/home/page.json')
    const beforeUndo = JSON.parse(await readFile(homePath, 'utf-8'))
    expect(beforeUndo.content.title).toBe('Edit 2')

    const res = await runCli(projectDir, ['undo', 'local', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('✓ Undone')

    const afterUndo = JSON.parse(await readFile(homePath, 'utf-8'))
    expect(afterUndo.content.title).toBe('Edit 1')
  })

  it('`undo` errors when there is nothing to undo', async () => {
    const res = await runCli(projectDir, ['undo', 'local', 'sites/main'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('Nothing to undo')
  })

  it('`rollback <rev>` restores an arbitrary revision', async () => {
    await seedHistory(projectDir, 3)
    // Grab the baseline id from the history command output — tests
    // shouldn't depend on internal file layout.
    const listRes = await runCli(projectDir, ['history', 'local', 'sites/main'])
    const baselineMatch = listRes.stdout.match(/(rev-\d+(?:-\d+)?(?:-[0-9a-f]{8})?)\s+save\s+.*Initial baseline/)
    expect(baselineMatch).toBeTruthy()
    const baselineId = baselineMatch![1]

    const res = await runCli(projectDir, ['rollback', baselineId, 'local', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('✓ Rolled back')

    // Baseline captures the pristine starter content.
    const homePath = resolve(projectDir, 'sites/main/targets/local/pages/home/page.json')
    const restored = JSON.parse(await readFile(homePath, 'utf-8'))
    expect(restored.metadata.title).toBe('Gazetta — Composable CMS')
  })

  it('`rollback` without an id errors clearly', async () => {
    const res = await runCli(projectDir, ['rollback', 'local', 'sites/main'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('rollback requires a revision id')
  })

  it('`rollback <unknown-rev>` errors with the revision id', async () => {
    await seedHistory(projectDir, 1)
    const res = await runCli(projectDir, ['rollback', 'rev-9999999999999', 'local', 'sites/main'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('Unknown revision')
  })

  it('`undo` on production in CI requires --yes', async () => {
    // Patch site.config.ts: swap the azure-blob production block for a
    // filesystem target with environment:production + editable:true (so
    // our save-seed can land there) to mirror the e2e fixture.
    //
    // Strategy: locate the `production: {` line, then walk forward to its
    // matching closing brace using a small bracket counter — regex on
    // nested braces is brittle.
    const siteConfigPath = resolve(projectDir, 'sites/main/site.config.ts')
    const ts = await readFile(siteConfigPath, 'utf-8')
    const startIdx = ts.indexOf('production: {')
    if (startIdx === -1) {
      throw new Error('Could not locate `production: {` in starter site.config.ts')
    }
    const openIdx = ts.indexOf('{', startIdx)
    let depth = 1
    let i = openIdx + 1
    while (i < ts.length && depth > 0) {
      const ch = ts[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    if (depth !== 0) {
      throw new Error('Unbalanced braces in starter site.config.ts production block')
    }
    // i is one past the closing `}`; consume the trailing `,` if present.
    let endIdx = i
    if (ts[endIdx] === ',') endIdx++
    const replacement =
      `production: {\n` +
      `      environment: 'production',\n` +
      `      editable: true,\n` +
      `      storage: filesystemStorage({ path: './dist/prod-test' }),\n` +
      `    },`
    await writeFile(siteConfigPath, ts.slice(0, startIdx) + replacement + ts.slice(endIdx))
    // Seed history on production directly.
    const gazetta = await import('../src/index.js')
    const prodDir = resolve(projectDir, 'sites/main/dist/prod-test')
    await mkdir(prodDir, { recursive: true })
    const storage = gazetta.createFilesystemProvider(prodDir)
    const history = gazetta.createHistoryProvider({ storage })
    const contentRoot = gazetta.createContentRoot(storage)
    for (let i = 0; i < 2; i++) {
      await gazetta.recordWrite({
        history,
        contentRoot,
        operation: 'publish',
        items: [{ path: 'pages/home/page.json', content: `{"t":${i}}` }],
      })
      await new Promise(r => setTimeout(r, 5))
    }

    const blocked = await runCli(projectDir, ['undo', 'production', 'sites/main'])
    expect(blocked.code).not.toBe(0)
    expect(blocked.stderr).toContain('--yes')

    const allowed = await runCli(projectDir, ['undo', 'production', 'sites/main', '--yes'])
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain('✓ Undone')
  })
})
