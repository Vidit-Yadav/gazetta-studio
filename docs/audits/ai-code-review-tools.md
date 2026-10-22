# AI code-review tools for gazetta-studio

Researched 2026-10-19. Question: which third-party AI reviewer can a public repo on GitHub's free organisation plan connect for free, and how good are they?

**How we review.** The maintainer reviews every PR locally with Claude in VS Code (`/review-prs`). The `review-on-comment` workflow (`@claude review`) exists but isn't used. Before the trial, a PR got its first review only when that local session ran, so outside contributors waited for it. Since 2026-10-19, Sourcery also reviews every PR when it opens and on each push, drafts included, except dependency-bot PRs. Since 2026-10-20, Sentry Seer reviews too: when a PR is marked ready, and on each later commit.

**Decision (updated 2026-10-20).** Trial **Sourcery** for 3–4 weeks on real PRs, with **Sentry Seer** alongside it from 2026-10-20. CodeRabbit was tried first and dropped: its free plan allows one review an hour (see "Seeded-bug results"). The reviewer's comments are an input to the local review, which checks each claim before relying on it.

## Free options (checked against official pricing pages, 2026-10-19)

| Tool | Free for us? | Our API key? | Notes |
|---|---|---|---|
| **CodeRabbit** | "free reviews forever for public repositories" ([pricing](https://www.coderabbit.ai/pricing)) | No (GitHub App) | Summary, inline comments, chat. Skips drafts by default; bots ignored by username. "never uses customer code for training" ([FAQ](https://docs.coderabbit.ai/faq)). |
| **Sourcery** | "Code review for public repos — Free forever" ([pricing](https://sourcery.ai/pricing)) | No | Skips dependency bots and drafts by default. Doesn't train on code. Limit seen 2026-10-22, not on the pricing page: 250,000 diff characters per 7 days for the account that triggers a review: the PR's author, or whoever pushes a commit or asks for a re-review. |
| Codacy | Team plan "Free forever for open-source projects", includes "AI Reviewer" ([pricing](https://www.codacy.com/pricing)) | No | Mostly static analysis |
| SonarQube Cloud + Gitar | Free for public, OSI-licensed repos ([pricing](https://www.sonarsource.com/plans-and-pricing/sonarcloud/)) | No | Static analysis plus an AI reviewer |
| Greptile | 50 credits/month, or an OSS programme with instant approval at 50+ stars ([OSS](https://www.greptile.com/pricing/open-source)) | No | Too limited at 0 stars |
| PR-Agent ([repo](https://github.com/The-PR-Agent/pr-agent)), Kodus | Free software | Yes | We'd pay the model |

Not free for us: GitHub Copilot code review (organisations need a paid plan, [plans](https://docs.github.com/en/copilot/get-started/plans)), Gemini Code Assist on GitHub (consumer version shut down 2026-07-17, [notice](https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review)), hosted Qodo Merge, Graphite (personal-account repos only on Hobby), DeepSource AI review (pay-as-you-go), Bito, Cubic.

Who uses CodeRabbit (a `.coderabbit.yaml` in the repo): TanStack/query, trpc/trpc, biomejs/biome, and two CMSes, payloadcms/payload and strapi/strapi.

### Second search (2026-10-19)

Only two more were free for us:

| Service | Free terms | Notes |
|---|---|---|
| **Gemini CLI GitHub Action** ([run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)) with a free Gemini API key | Free AI Studio tier; limits per project, not published as a table | We write the workflow, so we choose the triggers. On the free tier Google uses submitted content to improve its models and "human reviewers may read" it ([terms](https://ai.google.dev/gemini-api/terms)); fine for public MIT code. Pre-1.0. **Tried and dropped (2026-10-19):** too slow for a reviewer on every PR. Also, `run-gemini-cli` uses actions by tag, which this repo's SHA-pinning rule refuses, so it had to run the CLI directly. |
| **Amazon Q Developer for GitHub** (preview) | Free GitHub App without an AWS account; "limited invocations per month… limited number of lines for code reviews per month", numbers unpublished ([docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.html)) | Reviews when a PR opens or is reopened, not on new commits. Also brings a development agent that writes PRs from labelled issues. Not adopted. |

Not free for us: OpenAI Codex review and Cursor Bugbot (paid plans), Augment (paid add-on; its open-source offer seems gone), Windsurf (paid seats), Kilo (pay-per-token credits), Aikido (pricing page excludes PR review from the free plan, while another page promises free open-source review; unresolved), Baz, Panto, Entelligence, Tabnine, Semgrep Assistant, LinearB. GitHub Models' free tier was retired on 2026-07-30. 
### Third search (2026-10-19)

| Service | Free for us? | Notes |
|---|---|---|
| **Sentry Seer AI Code Review** | By application: the open-source sponsorship includes "Seer for 5 active contributors", "no term limit", for projects under "a friendly license like Apache or MIT" ([sponsorship](https://sentry.io/for/open-source/)) | Skips drafts; reviews when marked ready, on each later commit, and on `@sentry review` ([docs](https://docs.sentry.io/product/ai-in-sentry/ai-code-review/)). Needs a Sentry organisation. **Adopted** as the second reviewer: sponsorship approved 2026-10-20. Its docs say it "cannot approve or block merges", and only "file names, code diffs, and PR descriptions" go to the AI. |
| Aikido | By application only; the free plan excludes PR review ([pricing](https://www.aikido.dev/pricing)) | No published terms |
| Snyk Secure Developer Program | By application; README and website link required; "not backed by any corporate entity" ([programme](https://snyk.io/open-source/)) | Security fixes, not general review |
| OpenHands, Cline PR-review Actions | Free software, but need a paid model key | Cline's split into a read-only review job and a write-only posting job is the safest design seen |

Not free or gone: Mergify (no AI review), Corgea (PR scanning paid), Tenki and GitZoid (paid), Roo Code (shut down 2026-05), Aider (no maintained review Action). Unreachable: CodePeer, Callstack.ai.

## Quality evidence

| Tool | Evidence | Kind |
|---|---|---|
| CodeRabbit | 31,073 comments on 10,191 PRs in 239 repos: 36.4% accepted, 7.3% discussed, 56.3% rejected, mostly false positives, redundancy or out of scope ([Lin et al., arXiv 2607.03316](https://arxiv.org/abs/2607.03316)) | Independent |
| CodeRabbit | Highest recall on Martian's online benchmark (0.54); Martian sells no coding tools and calls its numbers preliminary ([post](https://withmartian.com/post/code-review-bench-v0)) | Independent |
| CodeRabbit | One maintainer's month: 28 PRs, 35% quality improvements, 21% nitpicks, 15% useless, 13% wrong assumptions, 3% security ([Lychee](https://lycheeorg.dev/2025-09-13-code-rabbit/)) | Anecdote |
| PR-Agent | 73.8% of comments resolved in an industrial deployment, but PRs took longer to close; 2024 data ([ICSE-SEIP 2025](https://arxiv.org/abs/2412.18531)) | Independent |
| Sourcery | Two 2025 teams: one turned it off (about 50% noise, caught 2 of 4 seeded bugs, [post](https://piware.de/post/2025-08-09-sourcery)), one kept it ([Pulp](https://pulpproject.org/blog/2025/06/18/my-experience-with-sourcery-ai-in-pulp-service-development/)) | Anecdote |
| Codacy AI Reviewer, Gitar, Kodus | No independent numbers found | — |

General findings, all independent:
- Noise is the main failure mode: 12 of 13 review agents had under 60% useful comments ([arXiv 2604.03196](https://arxiv.org/abs/2604.03196)).
- Finding more issues costs precision; no tool found more than 63% of known issues on Martian's set.
- Every vendor benchmark (Greptile, Qodo, CodeAnt) ranks its own author first.
- No study measures a tool next to an existing Claude reviewer, which is our case.

Checked first-hand by the maintainer's session: CodeRabbit's pricing wording, the Gemini shutdown notice, the Lin et al. abstract and Martian's post. The rest is from two research passes that cited official pages; their unverified points are listed under "Unknown".

## Seeded-bug results (2026-10-19)

Four PRs (#1007–#1010) each undid the source part of one fix from that week, with tests and docs left in place and neutral titles. Each fix's own tests failed on its branch, so each bug was really back.

| Bug brought back | CodeRabbit | Sourcery |
|---|---|---|
| #979: restored reorders act on any page | Found half (`clear()` drops other pages' drafts), plus a stale-etag point. Took the other half as "update the test". | Found both halves, with the right fix |
| #971: previewing an archived page returns 500 | Not reviewed (rate limit) | Found, with the right fix |
| #984: edits made during a save get lost | Not reviewed (rate limit) | Found every part, as five findings |
| #983: metadata missing from the publish hash | Not reviewed (rate limit) | Found, including "absent and empty stay equal" |

- **CodeRabbit's limit:** after the first review, "Your plan provides up to 1 included review per hour". The next PRs got "Review limit reached" and aren't retried by themselves. Fix-bot can open several PRs a night, so this doesn't fit our volume.
- **Sourcery:** all four reviewed within minutes, no limit hit. One weak comment: on #1007 it suggested updating the failing tests to match the code, the same mistake CodeRabbit made.
- **Caveat:** these were easy targets. Each PR deleted protective code that is visible in the diff. Bugs written fresh, with no removed guard to see, are harder; the real-PR trial is what tests that.
- **Not tried:** Codacy AI Reviewer (its automatic review runs once at PR open and skips drafts, so fix-bot's draft PRs would need a manual run each time; it also adds static analysis and a status check to every PR). Gitar (needs an application, write access to Actions and workflows, and pushes its own commits to PR branches, which our reviewed-PR workflow rules out; budgets unpublished).

## Trial plan

1. **Installed:** the Sourcery GitHub App, on all org repos. Settings live in Sourcery's web settings, not in a repo file. Draft reviews are on (turned on 2026-10-19), because fix-bot and feature-bot open drafts once their work is done. Dependency-bot PRs are still skipped. **Auto-approve is off** (2026-10-19): Sourcery's approvals are real GitHub approvals, and branch protection needs one approving review, so a bot approval passed the gate meant for a person. CodeRabbit was uninstalled.
   Settings for the trial, kept fixed until it ends:
   - General: review comments on, review profile **Balanced**, review guide and sequence diagrams on (useful to people reading a PR), PR summary **off** (it edits the PR description; bodies are written on purpose and a stray "Fixes #N" would close an issue), tips-and-commands comment off, approval off, path filter `package-lock.json`.
   - Auto-review: no title, label or branch filters; drafts reviewed.
   - Security scanning on. Review rules empty; add targeted rules only after the trial, if the same misses repeat.
   - **Sentry Seer:** the Sentry GitHub integration, on all org repos, with Code Review turned on 2026-10-20. Its check, `Seer Code Review`, ends `neutral` when it has findings and `success` when it has none. It isn't a required check; its docs say it "cannot approve or block merges".
2. **Seeded bugs:** done, see above. Still open: a local review of the same four changes, in a fresh session that doesn't know the answers. `/review-prs` lists only open PRs and the seeded PRs are closed, so review each commit's revert directly (`git diff <sha> <sha>^ -- '*/src/*'` for `6e87c8f1`, `7adfced3`, `03757410`, `bbd678ab`) or reopen the PRs for it.
3. **Real PRs, 3–4 weeks from 2026-10-19.** For each Sourcery or Seer comment, record accepted, discussed or rejected (the Lin et al. categories), whether the local review had already found it, and any limit message.
4. **Decide.** Keep it if it catches bugs the local review misses, at a noise level the local review filters without much cost. If kept, add the Sourcery badge to the README. Otherwise uninstall it.

## Trial log

One row per PR and reviewer, using the categories in item 3. "Local first" says whether the local review had found it before the reviewer did.

| Date | PR | Reviewer | Comments | Outcome | Local first |
|---|---|---|---|---|---|
| 10-19 | #1011 | Sourcery | 3 | 3 accepted | not recorded |
| 10-19 | #1012 | Sourcery | 16 over two pushes, 8 distinct | 7 valid, 1 wrong. All on the Gemini workflow, which was then dropped | not recorded |
| 10-19 | #1014 | Sourcery | 2 | 2 rejected: both wrong about GitHub's API | – |
| 10-20 | #1016 | Seer | 1 | Accepted: "Discard my changes" misses drafts restored after a reload → #1025 | No |
| 10-20 | #1016 | Sourcery | 0 | Posted its review guide when the draft opened, but no review. No reason given | – |
| 10-20 | #1017 | Sourcery | 1 | Accepted: a translated page is published with the default page's cache headers. Following it up showed its title, description and (on ESI) component list are the default page's too → #1024 | No |
| 10-20 | #1017 | Seer | 1 | Discussed, not acted on: `cache` isn't checked on save. The admin never sends it, and a bad value falls back to the target's cache | No |
| 10-20 | #1022 | Seer | 1 | Accepted: the sibling test needs the same wait; added to the PR | Yes (the bot's own note) |
| 10-20 | #1018–#1021 | both | 0 | No findings | – |
| 10-20 | #1037 | Sourcery | 1 | Rejected: said a locale variant's archive state can differ from the default page's. In our design, variants share it, and archiving only one locale is deferred | Yes |
| 10-20 | #1037 | Seer | 0 | No findings | – |
| 10-21 | #1042 | Sourcery | 1 | Rejected: wanted a deterministic test for a teardown race; the e2e repeat run (5 of 5) is how we check flake fixes | – |
| 10-21 | #1043 | Sourcery | 1 | Accepted, outside the diff: translations' `noindex` comes from the default page, so the sitemap is wrong for them → #1048 | No |
| 10-21 | #1046 | Sourcery | 2 | 2 accepted: the design doc still credited the library with keyboard reordering (fixed in the PR); a lifted row shows no target position (asked for in our review) | No |
| 10-21 | #1046 | Seer | 1 | Accepted: drag stopped working after the tree was emptied and refilled; fixed in the PR | No |
| 10-21 | #1047 | Seer | 1 | Accepted, outside the diff: static targets miss changes to a fragment's locale variant → #1049 | No |
| 10-21 | #1039–#1041, #1044, #1045 | both | 0 | No findings | – |
| 10-21 | #1051 | Seer | 1 | Accepted: moving the reload before `markWritten` let a second save start during the reload; fixed in a second commit, which Seer didn't review | No |
| 10-21 | #1051 | Sourcery | 0 | No findings | – |
| 10-21 | #1072 | Sourcery | 2 | Accepted both, posted after a doc-only merge: a public R2 bucket bypasses the worker; the `curl` check tested a folder, which hosts can refuse while serving its files → #1073 | No |
| 10-21 | #1073 | Sourcery | 1 | Accepted: a host that answers missing paths with a 200 fallback page makes the status-only check a false alarm; doc now says to read the body | No |
| 10-21 | #1073 | Sourcery (re-review on request) | 1 | Accepted: the `curl` check did not follow redirects, so a redirect to a URL serving the file looked blocked; added `-L` | No |
| 10-21 | #1073 | Seer (on `@sentry review`) | 1 | Accepted: the doc said the index has `nextId`; the index is only `{ revisions }`, `nextId` survives in a stale header comment in `history-provider.ts` | No |
| 10-21 | #1076 | Sourcery | 2 | Accepted both: some CDNs reject a `/*` purge; secret rotation covered only page content, not assets | No |
| 10-21 | #1076 | Seer (on `@sentry review`) | 0 | No findings | – |
| 10-21 | #1069 (design doc) | Sourcery | 9 | 8 accepted, 1 partly (credentials sent to an arbitrary `siteUrl`: the config is code, but headers now go only to its origin). Accepted: status-only passes on dynamic routes, cache views indistinguishable when the CDN ignores query strings, redirects hidden by auto-follow, stripped markers, report name collisions, crashed runs leaving no report, crashes swallowing alerts, public reports (already an open question) | No |
| 10-21 | #1069 (design doc) | Seer, 6 rounds | 11 | All accepted. Exit code of `gazetta check`; target indices built from the source site (#1077); running reports clearing the warning; post-deploy check missing changed items; 403 for missing files on S3; `Revision.items` lists the whole snapshot (#1078); CLI publishes write no history (#1079); legacy pages skipped by incremental republish; deferred reports clearing the warning; `Location` compared with its query string; 410 expected on hosts without `gone-status`. Later rounds found implementation details rather than design gaps | No |
| 10-21 | #1082 (fork, first-time contributor) | Seer | 1 | Accepted: the CLI's history revision described manifests the target never received; the contributor added the manifest copy | No |
| 10-21 | #1082 (fork, first-time contributor) | Sourcery | 9 | 2 accepted (undo doesn't re-render, filed as #1084; history on public storage, covered by #1083); 7 discussed as existing behaviour of the admin route (two on failed publishes staying in history, concurrent revisions, hung history write, asset-only publishes, retention 1, history content drift) | No |
| 10-21 | #1083 (design doc) | Sourcery | 18 | All accepted, 3 in part: `.nojekyll` (adapters add host markers themselves), `r2.dev` (operator lists extra URLs; Gazetta can't discover them), per-item sidecars (accepted as public, with reasons). Main changes: defaults no longer use `environment`, the lock fires only on sensitive files, the probe is per folder and independent of `liveCheck: false` | No |
| 10-21 | #1083 (design doc) | Seer | 1 | Accepted: copy-deploy targets defaulted to public, contradicting Q2 | No |
| 10-21 | #1086 (design doc) | Seer | 3 | All accepted: head check after writes; history and the target can drift; first snapshot misses translations (#1088) | No |
| 10-21 | #1086 (design doc) | Sourcery | 10 | 9 accepted, 1 in part (undo of the latest publish still skips approval). Also found the history-index race (#1089) | No |
| 10-21 | #1087 (design doc) | Seer | 1 | Accepted: the dot-prefix convention contradicted the manifest rule | No |
| 10-21 | #1087 (design doc) | Sourcery | 3 | All accepted. Critical: public targets received manifests that a direct host serves regardless of `isPublicSitePath` | No |
| 10-21 | #1091 (sidecars decision) | Sourcery | 9 | All accepted; changed the mechanism from diffing the target's previous manifest to replacing edges from a forward record | No |
| 10-21 | #1091 (sidecars decision) | Seer | 0 | No findings | – |
| 10-21 | #1095 (trial log) | Sourcery | 4 | All accepted: stale totals, an uncounted comment, mixed attribution, conflicting status in the undo design (after merge; fixed in a follow-up) | No |
| 10-22 | #1097 | Seer | 1 | Accepted: `gazetta admin` behind a proxy needs every interface, so it now binds by auth trust | No |
| 10-22 | #1097 | Sourcery | 2 | 1 accepted (`--host` on other commands is now an error); 1 a real bug the PR doesn't touch, already #1071 | No |
| 10-22 | #1099 | Sourcery | 4 | 3 accepted: composed hashes ignored locale variants and archive aliases; two comments. 1 rejected: a fragment cycle can't render | No |
| 10-22 | #1100 | Seer | 1 | Rejected: described the version before the contributor's fix | – |
| 10-22 | #1098 (contributor) | Sourcery | 3 | Not classified: no replies | – |
| 10-22 | #1105 (contributor) | Sourcery | 1 | Not classified: no replies | – |
| 10-22 | #1106 (contributor) | Seer | 1 | Not classified: no replies; the contributor addressed it before review | – |
| 10-22 | #1107 (contributor) | Sourcery | 8 | Not classified: no replies; the contributor addressed them before review | – |
| 10-22 | #1107 (contributor) | Seer | 2 | Not classified: no replies; the contributor addressed them before review | – |
| 10-22 | #1101 | Sourcery | 7 over two pushes | 4 accepted: a predictable `/tmp` cache path another account could plant modules in, temp cleaners, stale caches, a stale testing-plan note; fixed by moving the cache into the project. 3 rejected: edge cases (one site, two dev servers at once) | Yes: fix-bot's reviewer flagged the `/tmp` path as a NIT |
| 10-22 | #1101 | Seer | 1 | Accepted (the `/tmp` path), already fixed by then | Yes |
| 10-22 | #1102 | Sourcery, Seer | 0 | No findings | – |
| 10-22 | #1103 | Sourcery | 7 | 3 accepted: drafts made on different versions (#1109), an existing fragment-draft bug (#1108, also in fix-bot's Discovered list), a test that passed with nothing written. 4 rejected: one described a flow the code doesn't allow; three were existing behaviour or not worth handling | Partly: #1108 |
| 10-22 | #1103 | Seer | 1 | Accepted: reverting a restored draft gave a false conflict (#1109) | No |
| 10-22 | #1104 | Sourcery | 3 over two pushes | All accepted: the test checked that a list grew, not that no folder was left; then my replacement read `readdir` errors as clean and counted another test process's copies as leaks | No |
| 10-22 | #1104 | Seer | 0 | No findings | – |
| 10-22 | #1111 (docs) | Sourcery | 4 | 3 accepted: a race left in #1107's history fix (#1112), a row merging four PRs, a stale history layout in `design-media.md`. 1 rejected: its total counted only its own rows | No |
| 10-22 | #1111 (docs) | Seer | 0 | No findings | – |
| 10-22 | #1113 (docs) | Sourcery | 0 | No review: the account's weekly review budget was used up. An independent `review-architecture` pass found 13 issues instead (on #1094) | – |
| 10-22 | #1116 (contributor) | Sourcery | 3 | 2 accepted, both fixed by the contributor before review: the first scanner revision was still quadratic on many invalid openings before one `-->`, and nested head markers changed how pages assembled. 1 rejected: the list of markers grows with the page, which is already in memory | No |
| 10-22 | #1116 (contributor) | Seer | 1 | Accepted: the same quadratic case, fixed before review | No |
| 10-22 | #1118 (contributor) | Sourcery | 9 | 9 accepted. 7 fixed by the contributor before review: an open redirect through alias names, `Location` encoding, aliases too long for the 200-byte marker, direct `/pages/…/index.html` requests, the static fallback, archived fragments in ESI pages, an archived 404 page. 2 described one cache race that affects every publish, filed as #1125 | No |
| 10-22 | #1118 (contributor) | Seer | 1 | Accepted: non-Latin-1 alias names made the `Location` header throw; fixed before review | No |
| 10-22 | #1119 (contributor) | Sourcery | 5 | 2 accepted, fixed before review: the admin history test rejected the new ids, and an ordering check passed with no rows. 3 not acted on: older versions can't read the new ids (accepted before 1.0), ordering between old and new versions in one millisecond, and a retention edge older than the PR | No |
| 10-22 | #1119 (contributor) | Seer | 1 | Accepted: the same admin test; fixed before review | No |

Until #1037, every wrong comment was on a CI-workflow PR (#1012, #1014). On the seven fix-bot PRs of 10-20, neither reviewer raised a false finding, and two accepted findings were bugs the local review had missed. #1037's wrong comment came from a rule only our design docs state, which the reviewer can't see. On 10-21, 80 findings were accepted, 5 partly, and 7 discussed as existing behaviour. On code PRs: the first six included four bugs the local review hadn't found, two of them in code the PR didn't touch; on a first-time contributor's PR (#1082), 3 accepted and 7 discussed. The rest were on docs PRs: 7 on the `.gazetta/` exposure docs (#1072, #1073, #1076), 20 on the live-check design (#1069), 49 across the public-storage, publish-undo and target-index designs and their follow-ups (#1083, #1086, #1087, #1091, #1095). The design reviews also found bugs in existing code: #1077, #1078, #1079, #1088, #1089. On 10-22, the four fix-bot PRs (#1101–#1104) had 12 findings accepted and 7 rejected across Sourcery and Seer. The accepted ones included a predictable `/tmp` cache path, two bugs reproduced on main and filed (#1108, #1109), and weak checks in the PRs' tests. Of the rejected ones, one described a flow the code doesn't allow; the rest were edge cases or existing behaviour. Reviewing this log's own PR (#1111), Sourcery found a race left in #1107's history fix (#1112). Later that day Sourcery stopped reviewing for the maintainer's account: "you've used your own review budget of 250,000 diff characters for the last 7 days". The first refusal came on fix-bot's #1103, after the maintainer pushed a commit there; small pushes and PRs by the same account were still reviewed afterwards, so a review seems to be refused only when it doesn't fit in what's left. The large design PRs (#1113, #1120) got only Sourcery's summary. Other contributors' PRs were still reviewed (#1116, #1118, #1119). #1113 got an independent `review-architecture` pass instead; its 13 findings are on #1094, with fixes proposed in #1120. On the three contributor PRs that followed (#1116, #1118, #1119), the contributors fixed or answered every finding before review; the one that wasn't theirs to fix, a cache race on every publish, predates #1118 and is filed as #1125.

## Unknown

- Why Sourcery posted a guide but no review on #1016.
- Why Seer didn't review #1051's second commit, when it reviews later commits on other PRs.
- Why Seer often doesn't start on a push: it skipped #1073 (opened ready), #1076, and several #1069 pushes until asked with `@sentry review`, and cancelled #1072 when the PR was merged mid-review. It ignored `@sentry review` on a merged PR.
- Sourcery stops automatic re-reviews after 5 per PR ("Auto re-review limit reached", #1069); `@sourcery-ai review` asks for one more. Whether a requested re-review covers the whole PR or only new commits isn't stated.
- Sourcery's limits for public repos (not published; paid plans list "higher review limits"), and whether it reviews fork PRs.
- Bot and fork-PR behaviour, training policy and quality for Codacy, Gitar, Kodus and CodeAnt.
- How much any tool overlaps with a Claude review of the same PR.
