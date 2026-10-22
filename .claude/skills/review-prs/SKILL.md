---
name: review-prs
description: Walk the open-PR queue end-to-end. For each PR, read the diff + linked issue, fact-check load-bearing claims, run/monitor CI, and recommend merge / close / changes. Asks before merging.
disable-model-invocation: true
allowed-tools: Bash Read Grep Glob Edit Write AskUserQuestion
argument-hint: [optional PR number to start with]
---

Walk every open PR. For each, do a real review (not a summary). Always ask before merging.

## Loop

1. **List open PRs** — `gh pr list --json number,title,author,isDraft,createdAt,mergeable,reviewDecision,statusCheckRollup` and present a table sorted oldest-first.

2. **For each PR**, in order:
   - **Read PR metadata** — `gh pr view <N> --json title,body,baseRefName,headRefName,additions,deletions,changedFiles,files,commits`
   - **Read the linked issue** if one exists — `gh issue view <N>` (look for `Closes #X` in body)
   - **Read the diff** — `gh pr diff <N>` (or use Read on changed files for big diffs)
   - **Fact-check load-bearing claims** — see the "Fact-check" section below
   - **Read the AI reviewers' comments** — see "AI reviewer comments" below
   - **Check CI** — if green, note it; if no checks, diagnose (see "CI not firing"); if running, monitor or note pending
   - **Detect stacked PRs** — see "Stacked-PR detection"
   - **Recommend** — merge / close / push back / wait for CI — with reasoning
   - **Ask the user** before merging — `AskUserQuestion` or wait for confirmation

3. **After all PRs reviewed**, summarize what was done + what's outstanding.

## Reading bot-authored PRs

Some PRs are opened by autonomous bots (fix-bot, feature-bot, dead-code-watcher). They carry structured body sections you should read explicitly — these are the bot's proof-of-work, and the maintainer's job is to verify the bot's claims match the diff.

### Detect bot authorship

Bot-authored PRs end with an HTML-comment marker:

| Marker | Bot |
|---|---|
| `<!-- fix-bot: issue=N run=R -->` | fix-bot |
| `<!-- feature-bot: issue=N run=R -->` | feature-bot |
| `<!-- dead-code-watcher: ... -->` | dead-code-watcher |

PRs without a bot marker are maintainer-authored or external — read the PR body as prose.

### What the bot's PR body contains

After the bot identifier, both fix-bot and feature-bot inject Agent A's verbatim SUMMARY block under `## What Agent A did`. The SUMMARY contains:

```
<2-4 sentence prose>

Mode: behavioral | structural | mixed         (fix-bot only — feature-bot cuts are always behavioral by design)

Runtime exercise:
<per-bullet, per-path input + actual output>

Wider suite: <pass>/<total> pass; exit code <N>

Discovered: (optional; omit when empty)
- <one-line description of adjacent pre-existing bug observed during exercise>
```

### What to check in each section

**Mode** (fix-bot): cross-check the declared mode against the diff:
- `behavioral` → diff should change runtime behavior (logic, conditions, return values, status codes). Pure extraction / rename / comment-rot = mode is wrong.
- `structural` → diff should have NO behavior change. Any changed return value, conditional, or status code = mode is wrong.
- `mixed` → diff has both; verify each part.

Agent B already does this check; you're the second pair of eyes. If you see a mismatch, that's grounds to push back even when Agent B approved.

**Runtime exercise**: for `behavioral` / `mixed` modes, verify:
- Repro path output matches what the linked issue says should happen
- Wider suite shows zero failures (`/<N> pass; exit code 0`)
- If the fix touches symmetric surfaces (page+fragment kinds, etc.), both are exercised

For `structural` mode, the line reads `Runtime exercise: N/A — <reason>`. That's expected. The failing test pins the structural invariant; no behavioral surface to exercise.

**Test-only PRs** (tests or test fixtures, no product code): the bot's red-then-green shows only that the new test needs what the PR adds. Put back the bug the test exists for and confirm the test fails. (2026-10-20, #1021: the e2e spec failed without its new fixture field; undoing #981's fix showed it also catches the bug it was written for.) If the PR changes a fixture every e2e test uses, also search the other tests for waits on what it adds, per `testing-plan.md`: #1021 passed that check above and its own CI, and was still reverted (#1031) for breaking other tests' waits.

**Tests that something still works** (green before and after the fix): the bot's red-then-green says nothing about them, and they can pass when nothing happened. On #1103 a test checked that `save()` returned true, which it also does with nothing pending, so it passed without the draft being written. On #1104, "the cleanup list grew" passed even when the wrong folder was added. Break the code path such a test covers (skip the write, add the wrong folder) and confirm it fails. If it still passes, ask for a check on the result itself: the write made, the folder gone.

**Discovered**: each entry is a candidate follow-up issue. The bot intentionally surfaces these instead of widening scope. Treat them as input to the "Follow-up issues" workflow below.

### Anti-patterns to catch

These are reasons to push back on a bot PR even if Agent B approved:

- **Tests-double-as-exercise**: SUMMARY's `Runtime exercise:` cites unit tests instead of a real runtime exercise. The exercise must be throwaway proof (`node -e`, `tmp-` script, CLI invocation). Tests are the TDD contract; the exercise is comprehension-grounding; mixing them defeats the anti-tautology purpose.
- **Mode-vs-diff mismatch**: declared `structural` but the diff changes behavior, OR declared `behavioral` but the diff is pure refactor. Either direction is a real problem; push back.
- **Discovered items that are load-bearing**: a `Discovered:` entry that's actually the incomplete-fix case the bot should have addressed in-scope. Push back with "this isn't a follow-up; finish the fix."
- **Leftover `tmp-*` files**: the runtime exercise's scratch script appears in the diff. Bot was supposed to delete before commit. Push back.

## Pruning proof-of-work tests in bot PRs

Bot-authored PRs with `Mode: structural` sometimes include tests that exist only to prove the bot DID the structural work — not to assert ongoing invariants the codebase needs. These are "proof-of-work" tests: they read production source files with `readFile` / `readdir` and regex-match the source text. Useful at TDD-contract time (Agent A's failing-test commit had to fail before the fix landed); operationally redundant once the diff is on main.

### Detection criterion

A test is a proof-of-work candidate when ALL its `it()` blocks have assertions matching the shape:

```ts
const source = await readFile(join(__dirname, '..', 'src', '...'), 'utf8')
expect(source).toMatch(/.../)
// or:
expect(matchCount).toBe(N)
```

— reading a path under `src/` (or any production source dir) and regex-asserting its content. Test files that ONLY do this can be deleted; the production diff itself is the load-bearing proof.

Mixed test files — where SOME `it()` blocks read source files but OTHERS import the symbol and call it with real inputs (`await import(...)` + `expect(fn(arg)).toBe(...)`) — keep the behavior tests, drop only the file-content `it()` blocks.

### What to keep

- **Behavior tests**: import the symbol from the production module, call it with real inputs, assert on outputs. These exercise runtime branches and catch real regressions.
- **Structural invariant tests the compiler CANNOT catch**: "no inline copies of `lookupManifest` remain in route files" — the compiler allows shadow definitions; this test is the load-bearing rule-15 enforcement. Note: this IS a file-content test, BUT it pins an invariant TypeScript can't enforce. Keep it.

The distinction — **drift PROBABILITY through normal work, not drift POSSIBILITY in principle** (per team-preferences rule 41):
- File-content test that pins something the codebase's CURRENT state already proves (imports resolve, exports exist, symbols are defined) → **proof-of-work; drop**
- File-content test that pins something a developer could RE-INTRODUCE WITHOUT NOTICING during normal edits ("no `console.log` in production", "no calls to deprecated `oldApi()` remain" — every careless add re-breaks it) → **keep, or better, make it a lint rule**
- File-content test that pins something that only drifts via a DELIBERATE, against-the-grain action ("no inline copy of `lookupManifest` shadows the import we also kept") → **drop**. Nobody re-adds a shadow definition by accident; the production diff is the proof the extraction happened, and the bot's 4-step revert+rerun already validated the cut. Re-asserting on every CI run via brittle regex (blind to renames / arrow-fn rewrites / reformatting) is proof-of-work redundancy.

The sharper test: "would the compiler or a lint rule be the right home for this, AND is the drift it guards against something a developer would do without noticing?" If a developer would never accidentally do it → **prune the block, keep the behavior tests**. If it's genuinely drift-prone → file a follow-up to replace the regex-over-source assertion with an ESLint `no-restricted-syntax` rule (string-matching source enforces the *spelling*, not the *invariant*).

**`Mode: structural` one-shot extraction cuts are the canonical prune case.** rule-15 extractions, dead-code removals, and rename-the-helper refactors all produce file-content tests whose only job was to be red-before-green. Once the bot validated the cut, that job is done. (Reference: PR #474, 2026-05-31 — the skill's earlier "keep compiler-invisible invariants" phrasing kept a proof-of-work block the maintainer correctly flagged for pruning. Rule 41 was the retrospective fix.)

### Process

**Default to an additive commit, not a rebase-and-amend (per team-preferences rule 42).** When the maintainer confirms pruning, the lighter path is usually right: edit the test file, commit the change as a NEW commit on top of the bot's untouched commits, plain `git push`. This leaves the bot's commits byte-identical, fires the `synchronize` CI event normally (your account identity, not `GITHUB_TOKEN`), and keeps the bot's transcript-referenced SHAs valid. Verify the trimmed test file still fails red-before-green (move the production module aside, confirm the remaining tests fail; restore) — the contract must survive the prune.

**The amend/force-push path below is the EXCEPTION** — reach for it only when the edit must live INSIDE the bot's failing-test commit for the TDD contract to hold (e.g. the test file is commit 1 of 2 and you're removing a block that was part of what made commit 1 red). For "drop a redundant block" the additive commit is simpler and non-destructive. (If you START additive and later amend YOUR OWN top commit — not the bot's — `--force-with-lease` is fine; you're rewriting your commit, not the bot's history.)

The rest of this section covers the destructive amend path. This workflow EDITS a bot's PR branch + force-pushes — destructive and irreversible from the maintainer's review surface. **Every step requires explicit human confirmation, not a default-yes prompt.**

When you spot a proof-of-work candidate:

1. **Surface the candidates inline** — list each proof-of-work test in your review output with file path + line numbers + per-test rationale ("test on `tests/foo.test.ts:42` reads `src/admin-api/lookup-manifest.ts` and regex-matches the export; the compiler already enforces this; safe to drop"). Do NOT propose action yet.
2. **AskUserQuestion: "Do you want me to prune these tests from PR #N?"** with options "Yes, proceed with pruning" / "No, leave the PR as-is" / "Skip specific tests". If the user picks No or Skip, do NOT touch the branch. Default behavior on uncertainty is leave-as-is.
3. **On explicit Yes**: confirm a SECOND time before running destructive commands. State exactly what you're about to do: "I will checkout `fix/issue-NNN`, delete tests X/Y/Z from `<file>`, amend the failing-test commit, force-push to the bot's branch. The fix commit will be rebased on top unchanged. Proceed?" Wait for an explicit "yes" / "go" / "proceed" — not just "ok" (too ambiguous given this is destructive).
4. **On second confirm**: `gh pr checkout <N>` to switch to the bot's branch.
5. Edit the test file to delete the confirmed tests.
6. **Re-verify the TDD contract.** Run `git revert HEAD --no-edit` to revert the fix commit, then `npx vitest run <test-file>` — must FAIL. Then `git reset --hard origin/<branch>` to restore, then `npx vitest run <test-file>` — must PASS. If the contract no longer holds (test commit doesn't fail in isolation), the dropped tests WERE load-bearing; abort, restore the branch (`git reset --hard origin/<branch>`), and report to the maintainer.
7. **Amend the failing-test commit, not main.** The test commit (commit 1 of 2) needs the edit; the fix commit (commit 2) stays untouched. Shape:
   ```bash
   git rebase -i HEAD~2          # mark commit 1 (test) as `edit`
   # edit the test file; remove the proof-of-work it() blocks
   git add <test-file>
   git commit --amend --no-edit
   git rebase --continue          # re-applies commit 2 on top
   ```
8. Re-run the 4-step tautology check on the rebased branch to confirm: test commit fails in isolation, fix commit turns it green.
9. **Third confirmation before force-pushing.** "Tautology check passed on the rebased branch. Force-push to `<branch>`?" Wait for explicit yes.
10. `git push --force-with-lease` to the bot's branch. The PR auto-updates.
11. Verify CI re-runs green before recommending merge.

### Why three confirmation gates

Force-pushing to a PR branch is destructive: it rewrites history the bot's transcripts reference + invalidates any in-flight CI runs + can confuse future bot retries that expect a specific commit SHA. The three gates correspond to three irreversible thresholds:

- **Gate 1 (AskUserQuestion)**: maintainer learns about the pruning candidates and chooses whether to engage at all. Default-no.
- **Gate 2 (second confirm before checkout)**: maintainer reviews the exact commands the skill will run. Last chance before the working tree changes.
- **Gate 3 (third confirm before force-push)**: maintainer reviews the rebased state + the tautology-check evidence. Last chance before the remote branch changes.

If the maintainer says "ok" at gate 1 but doesn't explicitly authorize the force-push, you've still done useful work (local branch edited + verified) but the remote PR is untouched. They can inspect the local result, then explicitly confirm or roll back.

### When NOT to prune

- The bot PR has only ONE test file and ALL its `it()` blocks are file-content checks → don't delete the whole file; the failing-test contract requires SOMETHING red-before-fix. Either keep one minimal structural assertion OR open a follow-up to fix the prompt that produced this shape (fix-bot's per-issue.md sub-case 3d should already steer it correctly).
- Mode: behavioral or mixed → behavioral fixes shouldn't have proof-of-work tests in the first place; if you see them, that's a signal the bot misclassified Mode. Push back on the PR with a Note rather than editing.

## Fact-check load-bearing claims (rule 20)

Don't trust the PR body's root-cause description without verifying it. For every claim that drives the fix, check it against actual code:

- **Race condition claims** → trace the actual event sequence in the code. "X happens before Y" — is that synchronous or asynchronous? Sync handlers (DOM `addEventListener`, Vue `@click`)? Or scheduled (Promise microtask, Vue scheduler, browser event loop)?
- **"This was the root cause" claims** → can you find code that supports it? Or is the PR description guessing? If guessing, the fix may not address the real cause.
- **API/library behavior claims** → check the source if it's in `node_modules/` or via WebFetch to official docs for external services.
- **"X is sync" / "X is async" claims** → grep the implementation. Vue listeners are sync (`addEventListener`). React's setState is async. `localStorage.setItem` is sync. `EventSource` callbacks are async.

When a claim doesn't survive fact-check, say so explicitly. Don't just accept the PR body. Phrase: *"PR claims X. Checked against `path/to/file.ts:42` — actually Y. The fix [does/doesn't] address the real cause."*

If the PR's fix is right but the explanation is wrong, that's still a smell — file a follow-up explaining the real cause so future readers don't inherit the wrong mental model.

## AI reviewer comments

Sourcery reviews every PR, drafts included; Sentry Seer reviews a PR once it's marked ready, and after each later commit (see `docs/audits/ai-code-review-tools.md`). Read both on every PR: inline comments with `gh api repos/{owner}/{repo}/pulls/<N>/comments`, reviews with `.../pulls/<N>/reviews`. Check each finding against the code, like a bot's claim.

- **A finding about code the diff doesn't touch is a follow-up candidate, not noise.** On #1017, Sourcery said translated pages are published with the default page's cache headers, in code #1017 didn't change. Reproducing it showed their title, description and ESI component list were wrong too (#1024).
- **Compare a finding about the fix with the linked issue's Expected section.** If the issue asked for it, the fix is incomplete (see "Anti-patterns to catch"). If the issue's own notes left it out, file a follow-up. Seer showed #1016's Discard missed drafts restored after a reload, which #980's notes hadn't mentioned (#1025).
- **Check a finding against the PR's head, not the commit it's attached to.** Seer's comment on #1101 was attached to the commit that moved the cache out of `/tmp`, but it described the `/tmp` code from the commit before. Before replying, check whether the head still has the problem; if not, reply with the commit that fixed it.
- **Record the outcome.** React 👍 or 👎 (Sourcery learns from reactions), reply with what you did or the follow-up issue, and add a row to the audit doc's trial log while the trial runs.

## Stacked-PR detection

A "stacked PR" is one whose branch was cut from another open PR's branch, not from main. Symptoms:
- `gh pr diff <N>` shows commits/files that belong to another open PR
- `git log origin/main..origin/<branch> --oneline` shows more commits than the PR's "commits" list claims

To verify:
```bash
git fetch origin <branch> && git log origin/main..origin/<branch> --oneline
```

Recovery sequence (do NOT merge the stacked PR first):
0. **If the stacked PR's base is the parent's branch** (not `main`), retarget it first: `gh pr edit <stacked> --base main`. Merging the parent with `--delete-branch` deletes that base, and GitHub then *sometimes* retargets the stacked PR to `main` and sometimes **closes** it, and a closed PR's base can't be changed (`Cannot change the base branch of a closed pull request`). Both happened on 2026-10-18: #946 was retargeted when #945 merged, #953 was closed when #952 merged and had to be reopened as #954. Retargeting first makes it one behaviour.
1. **Land the parent PR first** (rebase-merge to main)
2. **Rebase the stacked PR onto fresh main**:
   ```bash
   git fetch origin && git checkout <stacked-branch> && git rebase origin/main
   ```
   Git auto-drops the parent's commits (cherry-pick equivalence detection).
3. **Force-push**: `git push --force-with-lease`
4. **Flip to ready / monitor CI**

Never merge a stacked PR via `--squash` thinking it'll subsume the parent — you'll lose the parent's PR discussion and history.

## CI not firing

If `gh pr checks <N>` returns "no checks reported," diagnose:

| Symptom | Cause | Fix |
|---|---|---|
| PR opened by `GITHUB_TOKEN` (Actions bot author) | GitHub anti-recursion: events triggered by `GITHUB_TOKEN` do NOT create new workflow runs ([docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow)) | **User account** close+reopen via `gh pr close <N> && gh pr reopen <N>` — actor identity becomes the user, not the bot, so `reopened` fires. (Close+reopen done by the bot itself stays suppressed.) Permanent fix: switch the bot to a GitHub App installation token or PAT. |
| Draft flipped to ready, no checks | Workflow's `pull_request:` trigger doesn't list `ready_for_review` (default types are only `[opened, synchronize, reopened]`) | Fix the workflow: `types: [opened, synchronize, reopened, ready_for_review]`. Short-term unblock: close+reopen, or push an empty commit. |
| All PRs cold | Workflow disabled / file syntax error | `gh api repos/:owner/:repo/actions/workflows/ci.yml --jq .state` should return `active` |
| PR from a fork (outside contributor), no checks | GitHub holds fork runs until a maintainer approves them (`action_required`) | See "Fork PRs" below. |

### Fork PRs (outside contributors)

1. **Read the diff before approving any run.** Approving runs the contributor's code on our runners. A `pull_request` run from a fork gets no secrets and a read-only token, but it still executes. Refuse or ask first if it touches `.github/workflows/**`, `package.json` scripts, install hooks (`prepare`, `postinstall`), or the lockfile without a stated reason.
2. **The run created when the PR was opened tests a stale base.** Its merge commit is fixed at that moment, and a re-run reuses the same `GITHUB_SHA` and `GITHUB_REF` ([docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs)), so "re-run failed jobs" never picks up fixes merged since. If main moved, close and reopen the PR, then approve the new run (`gh api -X POST repos/{owner}/{repo}/actions/runs/{id}/approve`). (2026-10-18: #925's first run predated #926 and failed on the MinIO flake #926 had fixed; a fresh run passed.)
3. **Read the whole diff before running it locally, too.** `git fetch origin pull/<N>/head:pr-<N>` and a local `vitest run` execute the contributor's code on your machine, with your files, credentials and network, and none of CI's sandbox. Apply the red flags from step 1 before the first run, and delete the local branch and any copied files afterwards.
4. **Check its claims like a bot's.** Confirm the new tests fail on main and pass on the branch before merging. For mutation-test PRs, break the code the way the PR says its tests catch, and check that the ones it calls uncatchable really survive.
5. **Write the review for the contributor.** They don't know `.claude/rules`, our bots or our history. Open with what you verified and how. Quote the convention you're asking for in plain words instead of citing a rule number. When the thing you're asking them to change copies something already in the repo, say so: the ask comes from our precedent, not their mistake. Then write that convention down in the same pass, so the next contributor and the bots don't copy the precedent too. End with what gets it merged. A review is public, so ask the maintainer before posting it. Request changes with `gh pr review <N> --request-changes`; don't push to their branch (see "Recommend" below). (2026-10-18: #957 copied `publish-rendered-mutation-*`'s naming and line-number headers; the review asked for behaviour-based names, and #990 wrote the convention into `testing-plan.md`.)
6. **A partial fix of a queued issue needs the issue updated.** When an outside PR covers part of a `ready-for-agent` issue ("Part of #N"), comment on the issue after merge with what's left, and edit any listed items the PR covered out of its body. Otherwise fix-bot reads the original list and redoes the merged work. (2026-10-18: #935 lists 8 of its 62 mutants, all in the ESI loop #957 covers.)

### Reading mixed-run CI status

After a force-push, `gh pr checks <N>` lists ALL recent workflow runs' jobs together — including jobs from the previous run that the concurrency rule cancelled mid-flight. A `smoke fail` row from an older `runs/XXXXX` URL is usually a cancelled job whose `needs:` dependency was cancelled, not a real test failure.

To filter to the current run only:

```bash
gh pr view <N> --json statusCheckRollup --jq '.statusCheckRollup
  | group_by(.detailsUrl | capture("runs/(?<id>[0-9]+)").id)
  | map({runId: (.[0].detailsUrl | capture("runs/(?<id>[0-9]+)").id),
         checks: [.[] | {name, status, conclusion}]})'
```

The newest run's `runId` will be the highest number. If all of its jobs show `SUCCESS`, the PR is genuinely green even if older-run rows show `CANCELLED` / `fail`.

**Monitor scripts that aggregate "all pass" can produce false-failure signals from cancelled-run artifacts.** When this happens, manually verify with the `runId` grouping above before assuming the PR is broken.

**A green aggregate is not a green gate — verify the fast jobs completed, not just that the slow ones passed.** The `format` job (Biome, ~seconds) is far faster than `test` / `e2e` (minutes). A monitor whose exit condition is "all jobs non-pending" can fire the instant the *slow* jobs settle green — while `format` either hasn't reported yet or has already failed and scrolled past. This bit us: #705 (2026-08) merged with its `format` job red, landing an unformatted file on **main**, which then failed the `format` gate on *every* subsequent PR until a fix-forward (#713) caught it a session later. Before merging a bot PR, confirm the current run's `format` job specifically shows `SUCCESS` — not just that the run has no pending jobs. A red `format` on main is especially costly because it's silent: nothing re-runs main's CI, so it stays red (and blocks every open PR's `format` check) until someone notices. **If several open PRs all show an identical single-job failure, suspect a red gate on main before suspecting the PRs** — check whether that job fails on a fresh `main` checkout (`npm run format:check`), and if so fix-forward on main (via PR) rather than chasing each PR. **Distinguish a red-gate-on-main from an infra flake by reading the actual failure, not just the job name.** A whole batch failing the *same* job can be either (a) a real red gate on main (deterministic — the job fails identically every run, e.g. a `format` violation) or (b) a shared infra flake hitting every runner in a window (non-deterministic — e.g. a container-registry image-pull failure). Read the failing job's log and get the failing test + line: a deterministic assertion/format failure at the same spot every PR = red main (fix-forward); an image-pull / network / hook-timeout at a container-setup line (e.g. `docker.test.ts:44` `.up()`) = infra flake (admin-merge over it, the PRs are innocent). The tell: infra flakes fail *before* the code under test runs (setup hooks, image pulls), leave the rest of the suite green (78/79 files pass), and cite no assertion.

**A "known flake" that fails on every PR is a bug on main.** Check main's own CI runs (`gh run list --workflow ci.yml --branch main`) before re-running PRs: nothing alerts on a red main. Then run the spec five times on CI with the e2e repeat workflow, against main and against a branch with the suspected fix (`gh workflow run e2e-repeat.yml --ref <branch> -f spec=<spec>`); a flake fails some repeats, a bug fails all of them. (2026-10-21: main had been red for a day on `component-ops.spec.ts:43` and `:218`, filed as flake #288 and failing on all seven fix-bot PRs. Repeats on main failed 10 of 35, and with the save-order fix all 35 passed: #1051.)

### Triggering CI in batches

Two mechanics bit this workflow when triggering CI across many PRs at once; both cost real time.

**Cap `gh pr close && gh pr reopen` loops at ~8-10 PRs per Bash call.** Each close+reopen is ~2 API round-trips plus the `sleep` between them; a loop over 13 PRs blew the Bash 2-minute timeout mid-run and left the *last* PR **closed** (the reopen never fired) — a verified PR silently dropped from the queue until caught. When triggering more than ~10, split into separate Bash calls, and after any batch-trigger loop **re-list the PRs and confirm none is stuck `CLOSED`** before trusting the batch. (2026-09.)

**Rebase a bot branch from `origin/<branch>`, never from a lingering local ref.** When resolving a conflict on a bot PR (e.g. several PRs serializing through one `skip-list.json`), `git checkout -B fixbranch origin/<branch>` to rebase from the *true remote state*. A local branch left over from an earlier attempt can be behind what you (or a prior force-push) already pushed; rebasing it and force-pushing either no-ops (`already up to date` while the remote stays conflicted) or clobbers a good remote state. The symptom is a force-push that "succeeds" yet the PR stays `dirty`/`behind`. Always re-fetch the remote branch into a fresh local ref before the rebase. (2026-09.)

## Recommend merge / close / changes

Before recommending, consider:

- **Is the fix structurally right?** Per rule 18 — patches vs. structural corrections. If the PR's fix is a patch around a deeper bug, push back or file a follow-up.
- **Does it match the project's conventions?** Per the project's CLAUDE.md and `.claude/rules/team-preferences.md`.
- **Does CI catch what matters?** Green CI is necessary but not sufficient — flake-fix PRs especially can pass CI by luck. Per rule 35, flake-fix PRs need `--repeat-each=5` durability proof.
- **Is there a stacked PR?** Don't recommend merging if there's a parent that should land first.
- **Would a newcomer understand it?** Read the file names, comments and test names as someone who arrives later to learn what the code guarantees. Each should say what the code does, not which issue, tool run or line number produced it: `-mutation-935.test.ts`, "kills the always-push mutant" and Stryker line maps fail this, and the line numbers go stale after the first edit above them. A test name should cover everything its test checks; a default checked inside a test named for something else fails under the wrong name. Applies to bot and outside PRs alike, and outside contributors copy whatever precedent they find. (2026-10-18, #957.)

For bot-authored PRs (see "Reading bot-authored PRs" above), also:

- **Does the declared `Mode:` match the diff?** Pure refactors must be `structural`; behavior-changing fixes must be `behavioral` or `mixed`. Agent B already checked this; you're the second pair of eyes.
- **Does the runtime exercise actually prove the fix works?** For `behavioral` / `mixed` modes, the repro path's actual output must match the linked issue's expected behavior.
- **Are `Discovered:` items genuinely adjacent (not incomplete-fix dodges)?** If a discovered item is what the bot should have fixed in-scope, push back instead of accepting + filing follow-up.
- **Are there leftover `tmp-*` files in the diff?** The runtime exercise's scratch should never appear in commits.
- **Does another open PR fix the same thing?** Bots work issue by issue, so two issues with one root cause become two PRs. Before reviewing bot PRs one by one, look for PRs that change the same files or name the same cause in their summaries. When two overlap, merge the cleaner fix and close the other with a pointer — but first check whether the closed one has something the winner lacks (usually a test), and carry it over as your own commit on top of the winner's branch (rule 42). Confirm the carried test fails on main and passes with the winner before pushing. Merging both stacks two fixes for one failure mode (rule 37). (2026-10-17: #908 and #912 both fixed the hero custom editor remounting with a fresh undo history, filed as two flakes, #886 and #909. #912 had the cleaner fix and #908 the only test that reproduced the race every run; #912 merged with that test added.)
- **Is one of the overlapping PRs from an outside contributor?** If it's correct, merge theirs as written and close the bot's with a note. Make style changes (e.g. a rule-15 helper the bot's version had) in your own follow-up PR, not by pushing to their branch, even when `maintainerCanModify` allows it. Their commit lands untouched with full credit. (2026-10-18: #925 from Vidit-Yadav and fix-bot's #929 both fixed #921; #925 merged, the helper landed as #939.) fix-bot and feature-bot now skip an issue that has an assignee or another open PR referencing it (`bots/_lib/issue-claim.ts`, added after the second duplicate, #992 next to #957). To keep a bot off an issue someone has offered to take, assign it to them. An outside contributor can be assigned only after they've commented on the issue, and then only through REST: `gh api -X POST repos/{owner}/{repo}/issues/<N>/assignees -f 'assignees[]=<login>'`. `gh issue edit --add-assignee` still refuses them. Until they comment, label the issue `ready-for-human` so the bots skip it. (2026-10-19, #1001.)
- **Does an outside PR close a feature cut?** Make sure its **title** contains `#N` before merging. A cut counts as landed only through `#N` in the title, a `feat/cut-N` branch or feature-bot's marker (`bots/_lib/cut-landing.ts`); "Closes #N" in the body isn't enough, and the next cut would escalate as `dep-unverified`.

## Merge protocol

Default: **always ask before merging**. Even with admin bypass available.

When merging:
- **Rebase-merge only** per rule 16 (`gh pr merge <N> --rebase --delete-branch`)
- Solo maintainer with branch protection requiring 1 review: add `--admin` after explicit user confirmation
- After merge, `git checkout main && git pull --rebase origin main`

Bot-authored PRs (fix-bot, feature-bot) open as **draft** by design. Before merging:
- Verify the bot-PR checks above pass (Mode-vs-diff, runtime-exercise output, no `tmp-*` leakage)
- Mark ready with `gh pr ready <N>` — this triggers any workflows gated on `ready_for_review`
- Wait for CI on the now-ready PR before merging

If two PRs are both green and unrelated:
- Merge sequentially, not batched — keeps blame attribution clean if main breaks
- After first merge, second PR may need rebase; check `gh pr view <N> --json mergeable`

If several PRs edit the same file, check they pass together before merging the first: GitHub's rebase merge stacks them on `main` without running CI on the result. Apply them in merge order on `main` in a temporary worktree (symlink `node_modules`) and run that package's tests. (2026-10-20: #1016, #1018 and #1019 all edited `useEditorActions.ts`; stacked, the admin suite passed.) Unit tests run fine in a worktree; e2e doesn't, see `testing-plan.md`.

Doc-only PRs (per memory: `*.md`-only diffs by the maintainer) may admin-rebase-merge immediately without CI wait. Bot doc-only PRs still go through CI — the bot's PR-body claims need verification.

## Follow-up issues

Two sources feed this workflow:

1. **PR-driven** — a PR mitigates but doesn't fix the underlying cause; file a follow-up so the real fix doesn't get lost.
2. **Bot-discovered** — a bot-authored PR's `Discovered:` block names adjacent pre-existing bugs the bot observed while exercising its fix. The bot deliberately surfaced these instead of widening scope. Harvest each entry as a candidate follow-up.

For each candidate (either source), decide whether it warrants an issue. Skip if the discovered item is too vague to act on or already covered by an open issue (`gh issue list --search "<term>"` first).

### Routing the new issue (rule 40)

Pick labels by **task shape**, not by the source bot's domain:

- **One-shot** (refactor, hygiene, SOLID/DRY fix, missing-test backfill, small enhancement without a design doc) → `bug + ready-for-agent` → fix-bot picks it up
- **Cut of designed feature** (references a `design-{feature}.md`, depends on other cuts, under a tracking issue) → `enhancement + ready-for-agent` → feature-bot picks it up. **Exception:** if the feature has a cut-planner **planner issue**, don't file a cut — add the work to that planner issue's `## Suggested plan` instead. A directly filed cut gets no spec refinement on failure, and cut-planner treats it as in flight, so the feature's queue stalls until it closes. See `feature-design-process.md` Phase 4 "One cut filed directly".

**Bots cannot deliver changes to `.github/workflows/**`.** Their `GITHUB_TOKEN` can't push workflow files under any permission (#840); an approved fix that needs one fails at delivery. If the fix needs CI wiring, route it through a package script the workflow already calls (e.g. chain a check into the package's `test` script), or keep the workflow edit for a maintainer PR. Say so in the issue. (#872 was first filed asking fix-bot to edit `ci.yml` — corrected before it ran.)

Don't default to `flake` — that label is for tests intermittently failing, not for every test-adjacent issue. Apply `flake` only when the discovered behavior actually IS a CI flake.

### Issue body template

**The body schema depends on which bot the issue routes to — they are NOT interchangeable.** fix-bot reads free-form prose; feature-bot's parser REJECTS a body that lacks the cut-sub-issue schema (it applies `needs-info` + a `body-error` comment, and the issue silently drops out of the queue). Pick the template that matches the routing above.

**fix-bot** (`bug + ready-for-agent` — one-shot fixes):

```bash
gh issue create --title "..." --label bug,ready-for-agent --body "$(cat <<'EOF'
## Context
<PR # exercised; the real cause / adjacent finding is below>

## Why this needs a separate fix
<the fact-checked race / behavior / structural gap>

## Recommended fix
<the structurally right approach; cite team-preferences rule if applicable>

## Acceptance criteria
<what the fix must demonstrate>

## Bot disclosure
> *This was generated by AI during PR review.*
EOF
)"
```

**feature-bot** (`enhancement + ready-for-agent` — cut of a designed feature): the body MUST follow the **cut-sub-issue schema** (per `design-feature-bot.md` Q2 + `feature-design-process.md` Phase 4), NOT the fix-bot template above. Required: a `**Feature**:` line, a `**Depends on**:` line (or `none`), and `## Spec` / `## Acceptance` / `## Tests` sections (plus `## SOLID` when the cut introduces a new interface/module/abstraction):

```bash
gh issue create --title "..." --label enhancement,ready-for-agent --body "$(cat <<'EOF'
**Feature**: <slug matching a design-{slug}.md>
**Depends on**: none   (or #N, #M)

## Spec
<narrative — what to build, linking design-{feature}.md>

## Acceptance
- <testable outcome>

## SOLID
<which lenses are load-bearing (SRP/OCP/LSP/ISP/DIP); omit only for pure-data/pure-docs cuts>

## Tests
- <specific test file path(s) + the behavior each pins>

## Bot disclosure
> *This was generated by AI during PR review.*
EOF
)"
```

Filing a feature-bot issue with the fix-bot template (`## Context`/`## Recommended fix`/`## Acceptance criteria`) is the failure mode that blocked #729 (2026-08): feature-bot's next cron rejected it with a `body-error`, applied `needs-info`, and it sat un-queued until reformatted. When in doubt about the exact required sections, read `design-feature-bot.md` Q2 before filing — don't guess the schema.

**Label hygiene reminder** (gazetta-specific): fix-bot picks up `bug + ready-for-agent`; feature-bot picks up `enhancement + ready-for-agent`. If neither, triage-bot looks first (input is "no classification labels yet"). Don't apply `bug` without `ready-for-agent` — lands the issue in limbo (triage-bot ignores it; fix-bot won't either). Per rule 40, the load-bearing axis is task shape, not the source bot.

## Self-improvement (pass-end)

This skill improves the same way the bots do — by feeding review
outcomes back into the guidance that shapes the next pass — but with
a substrate suited to running locally under human review, not on a
cron. The bots write a `reviewer-log.jsonl`, compact it monthly into
a `lessons-learned.md`, and front-load that file into the next run.
The analog here: **when a pass surfaces a durable insight, propose an
edit to this SKILL.md at pass-end.** SKILL.md *is* the front-loaded
guidance (it's read at the start of every `/review-prs`), and its git
history *is* the raw log — every insight-driven edit is a commit,
auditable and reversible. No separate log file: for prose insights
with no counts to aggregate, the commit history is the durable record
(this is how rules 41/42 landed — a pass discovered the proof-of-work
pruning nuance, it went into SKILL.md, committed).

### What counts as a durable insight

Not every pass produces one — most are "merged N clean PRs, learned
nothing," and those get no edit (absence-as-state, per Krug rule 23).
Propose a SKILL.md edit only when the pass surfaced something that
would change how a *future* pass reviews:

- **A new anti-pattern to catch** (e.g. a bot-PR shape that looked fine
  but wasn't — the mode-vs-diff mismatch class).
- **A refined heuristic** (e.g. rule 41's drift-*probability*-not-
  *possibility* sharpening of proof-of-work pruning).
- **A CI / GitHub gotcha** that cost time and would recur (the kind
  that lands in team-preferences rule 34 — cross-link it here if it's
  review-specific).
- **A fact-check that changed a verdict** — if the PR body's claim was
  wrong in an instructive way, capture the check so the next reviewer
  runs it.

Do NOT propose an edit for: a one-off insight specific to a single PR
that won't recur; a restatement of guidance already in SKILL.md; or a
project-fact that belongs in `team-preferences.md` / `CLAUDE.md`
instead (propose it *there* — route by where the guidance is consumed,
per the same task-shape logic as rule 40).

### How to propose it

1. At pass-end, if a durable insight surfaced, state it plainly and
   name where in SKILL.md it belongs (which section, why).
2. Draft the exact edit (diff-shaped) and surface it for approval —
   **never self-commit a SKILL.md change without the maintainer's ok**
   (same human-gate discipline as every other change; rule 33 —
   branch + PR, no direct-to-main).
3. On approval, land it as a `docs:` change to SKILL.md (branch + PR),
   commit message naming the pass/insight that produced it — so the
   git history stays a legible log of *why* each heuristic exists.

This is the human-review layer's version of the bots' durable-memory
loop: the reviewer that gates every bot PR now also compounds what it
learns, instead of re-deriving heuristics each session and losing them
when the conversation ends.

## Output discipline

- One PR at a time. Don't batch multiple recommendations into one long message.
- State results, not your thought process. "Verdict: merge with caveat X" beats "Let me think about whether to merge..."
- Use the file_path:line_number format for code references so the user can click through.
- When CI is running, use Monitor to track it in background — don't block the conversation.
