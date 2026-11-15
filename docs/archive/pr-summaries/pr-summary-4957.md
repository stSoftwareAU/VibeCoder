## Summary

TokenEconomizer's learnings now persist across runs in the private repository
named by `token_economizer.learnings_repo`. Each run pulls
`token-economizer/<repo-key>/` into its `TOKENECONOMIZER_HOME`. The pull is
shallow and sparse, with a timeout, and happens after a fresh check that the
store is private. After each spawn that loaded the plugin, the run pushes what
changed. Before each commit, gitleaks scans the staged learnings. A secret or
another repository's state latches the shared #4956 stop. Pull and push faults
are WARNINGs and never change the run's result. Closes #4957.

## Spec

### Intent and Rationale

- Fleet containers are recreated every launch, so without a store each run
  starts with nothing learned and the trial measures nothing.
- A new module, `worker/deno/lib/token_economizer_learnings.ts`, does the git
  work through the worker's chokepoints: git via `runGitCommand`, gitleaks via
  `spawnWithDeadline`, and gh via `runGhCommandRaw`. The launch and the runner
  each gain one call: the pull in `resolveTokenEconomizerLaunch`, and
  `syncTokenEconomizerLearnings` after the hook monitor closes.

### Essential Design Decisions

- **Repository key.** `<repo-key>` is the upstream plugin's own key
  (`<slug(name)>-<sha1(normalised origin)[:10]>`). The normalised origin
  remote has its scheme, user and credential removed. A test checks it against
  the pinned plugin's `paths.py` for seven URL shapes.
- **Visibility.** It is checked before the pull and again before every push
  attempt, including the retry. The store counts as private only when it is
  `private: true` with `visibility: "private"`. A public or unverifiable store
  is `refused`. A clone or validation fault is `unavailable`, never an empty
  store, and nothing is pushed from either state. The plugin still loads.
- **The "rebase" retry.** On a non-fast-forward push, the run fetches the new
  tip and replays its own commit onto it with `cherry-pick --no-commit`. A
  shallow clone has no merge-base for `git rebase`. A conflict drops the later
  run's update and logs it.
- **What syncs.** Only allow-listed regular `.json` files under the key are
  synced, up to 1 MiB per key. The launcher, `errors.log`, `*.jsonl`
  transcripts and `sessions/` never sync. The scratch clone is kept after a
  pushed or unchanged push so later spawns of the same run can push, and is
  removed on every other outcome.

### Undiscoverable Facts

- Observed with gitleaks 8.30.1: `gitleaks git --staged --report-format json
  --report-path - .` exits 1 with `[{"RuleID":"github-pat",…,"Secret":"REDACTED"}]`
  for a planted PAT. A clean scan exits 0 with `[]` and `INF no leaks found`.
- Observed with git: a non-fast-forward push prints
  `! [rejected] HEAD -> master (fetch first)`. A sparse clone of an empty bare
  repository exits 0 with an unborn HEAD. `cherry-pick --no-commit` in a
  shallow clone replays cleanly or reports `CONFLICT (content)`.
- Observed with gh: `gh api repos/stSoftwareAU/VibeCoder` returns
  `{"private":false,"visibility":"public"}`.

## Evidence

This is a backend change, so there is no UI to screenshot.

```mermaid
sequenceDiagram
    participant L as resolveTokenEconomizerLaunch
    participant S as learnings store (private repo)
    participant R as claude_runner (after each spawn)
    L->>L: stop latch clear? visibility private?
    L->>S: shallow sparse clone of token-economizer/<key>/
    S-->>L: restored / empty (else refused / unavailable, WARNING)
    R->>R: monitor closed (hook stop latched first)
    R->>R: isolation check, cap, mirror allow-listed .json, gitleaks --staged
    R->>R: latch + visibility re-check before each push
    R->>S: push (one replay retry on non-fast-forward)
    Note over R: secret or other repo key → stopTokenEconomizerTrial (#4956)
```

Issues cited as provenance: #4957 (this issue: persist TokenEconomizer learnings
to a private git repository, with gitleaks before every push); #4956 (load
TokenEconomizer into Claude runs, which owns the shared stop path); #4958
(record TokenEconomizer's actions and own cost in run stats, still open); #4959
(run the trial to a keep-or-purge verdict, still open).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Integration test (real git, local bare repository as the store): run 1 starts empty and pushes; run 2 on the same repository key starts with run 1's state; a run on another key does not see it. — evidence: `worker/deno/tests/token_economizer_learnings_test.ts::acceptance: a run pushes its state, a later run restores it, and another key stays isolated` — reviewer: partial — reason: the reviewer found that the test did not prove another key's blobs were never fetched. The test now enables server filters on the bare store and asserts that key A's blob is absent from run B's clone, with a positive control in run 2's clone.
- **met** — A public `learnings_repo` is refused, with the reason logged. — evidence: `worker/deno/tests/token_economizer_learnings_test.ts::refused: a public or unverifiable learnings repository is never transferred`, `worker/deno/tests/token_economizer_plugin_wiring_test.ts::a public learnings store is refused: the plugin still loads, the refusal is logged and nothing is pushed (Issue #4957)` — reviewer: met
- **met** — A planted fake secret in the state is caught by gitleaks and never committed. — evidence: `worker/deno/tests/token_economizer_learnings_test.ts::stopped: a planted GitHub PAT, scanned by the real gitleaks, stops the trial and is never recorded` (real binary) and `…::stopped: an injected gitleaks report of the planted PAT stops the trial, is not committed and keeps the token out` — reviewer: met
- **met** — Pull/push failures are WARNINGs that leave the run outcome unchanged (tested). — evidence: `worker/deno/tests/token_economizer_plugin_wiring_test.ts::a failed learnings push leaves the run's result unchanged and is logged as a WARNING (Issue #4957)`, `…::an unreachable learnings store is unavailable, logged as a WARNING, and nothing is pushed (Issue #4957)`, `worker/deno/tests/token_economizer_learnings_test.ts::unavailable: a missing store is a warning carrying the git cause, never an empty store` — reviewer: met
- **met** — `docs/CONFIGURATION.md` describes the store layout and how to purge only this trial's namespace. — evidence: `docs/CONFIGURATION.md` section "TokenEconomizer learnings" — reviewer: met
- **met** — A secret/isolation finding reaches #4956's shared stop path; public or unreadable visibility never permits a push. #4958 records the real persistence/plugin status, and #4959 owns the keep-or-purge outcome. — evidence: `worker/deno/tests/token_economizer_learnings_test.ts::stopped: the real stop record latches, notifies issue 4959 and keeps the token out`, `…::stopped: state for another repository in the home stops the push before anything moves`, `…::refused: a public or unverifiable learnings repository is never transferred`. The status is recorded on `launch.learnings.persistence` for #4958 to report. — reviewer: met
- **unrequested** — `docs/THREAT-MODEL.md`: new control C42 and edits to AP-20, C40, R16 and the Learned-facts row — reviewer: unrequested — reason: those rows said persistence was not delivered yet, so this change made them false. They now describe the shipped controls.
- **unrequested** — `docs/TOKEN-ECONOMIZER-TRIAL.md` stop-rule row narrowed to the pre-commit scan — reviewer: unrequested — reason: reverted. The row is restored to its base wording.
- **unrequested** — Path limits (8 segments, 100-character allow-listed segments). A pull rejects the whole key when the store holds a non-allow-listed entry or is over the cap, and a scanner fault skips the push. — reviewer: unrequested — reason: these follow the issue's rule that untrusted state is never an ordinary empty store, and a scan that did not finish is not clean (fail loud).
- **unrequested** — The scratch clone is kept after a pushed or unchanged push, behind an `isOwnClone` guard — reviewer: unrequested — reason: a re-run or retry spawn shares the launch and must still be able to push. The guard stops `git -C` from reaching a parent repository once the clone is gone.
- **unrequested** — `learningsStoreUrl`, `checkLearningsVisibility` and `scanLearnings` on the launch options — reviewer: unrequested — reason: these are injected seams whose production default is the real store URL, the gh check and gitleaks, so tests reach the real launch and runner paths.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Unit tests self-contained: push tests needed a host `gitleaks` binary — evidence: `worker/deno/tests/token_economizer_learnings_test.ts:256` — reason: fixed in this diff. Clean scans now inject the observed clean output, and only the real-binary secret test is ignored when gitleaks is absent (18 passed, 1 ignored with gitleaks hidden from `PATH`).
- **violation** — Every outcome of a branch needs a test: the scanner-fault outcomes had none — evidence: `worker/deno/lib/token_economizer_learnings.ts:763` — reason: fixed in this diff (`skipped: a scanner fault fails closed (timeout, unreadable report, unexpected exit, a throw), with nothing committed`).
- **violation** — Path Confinement negative tests: `isSafeKey` and the scratch-directory guard had none — evidence: `worker/deno/lib/token_economizer_plugin.ts:590` — reason: fixed in this diff (`refused: an unsafe repository key is refused on pull and push, with nothing cloned or written`, plus `a learnings scratch directory symlinked outside the work root is refused…` with its control).
- **violation** — A refusal test must be refused by the rule it names: the store-validation test asserted only the status — evidence: `worker/deno/tests/token_economizer_learnings_test.ts:826` — reason: fixed in this diff. Each case now asserts its allow-list or cap reason.
- **violation** — Prose about the PR's own change: C42's "Only allow-listed … files are synced" ignored the pulled `config.json` — evidence: `docs/THREAT-MODEL.md:220` — reason: fixed in this diff. C42 now says the settings file is pulled outside the key, uncounted, unscanned and never pushed.
- **violation** — Change every copy of a twinned rule: the key derivation copies upstream with no disagreement test — evidence: `worker/deno/lib/token_economizer_learnings.ts:219` — reason: fixed in this diff (`repo keys: learningsRepoKey matches the upstream plugin for seven URL shapes` runs the pinned plugin).
- **clean** — The reviewer checked fail-loud failure reasons (the first `fatal:`/`remote:`/`ssh:` line is quoted and asserted), secret redaction, log levels, the destructive-operation guard (`isOwnClone`), the required `subject` reaching all five production callers, shallow-history independence, temp-directory and parallel safety, Australian English, and the review-enforced documentation-drift-test and check-where-you-insert rules.

## Test Plan

- New `worker/deno/tests/token_economizer_learnings_test.ts` (19 tests, real git
  with local bare stores). It covers the acceptance round trip and isolation,
  clone reuse, a removed clone inside a parent repository, public and
  unverifiable refusals, and the planted secret, with both the real binary and
  an injected observed report. It also covers the real stop latch (notifying
  4959), the cross-repository stop, a missing store, a failed push, the replay
  (clean and conflicting), the cap, an untrusted store key, the latch, unsafe
  keys, scanner faults and the repository-key goldens with upstream parity.
- `worker/deno/tests/token_economizer_plugin_wiring_test.ts`: seven new tests
  covering the round trip through `resolveTokenEconomizerLaunch` and
  `syncTokenEconomizerLearnings`, and a public store. They also cover an
  unreachable store, and a failed push through `runClaudeWithTimeout`, whose
  `ClaudeResult` equals the baseline. The rest are no learnings repository,
  and the symlinked scratch directory with its control.
- Edited existing tests: `subject` and `runId` were added to fixtures in
  `worker/deno/tests/token_economizer_plugin_test.ts` and the wiring test,
  because the field is now required. The exact-env test in
  `worker/deno/tests/token_economizer_plugin_test.ts` now sets
  `learningsRepo: undefined`, because its checkout has no origin and the pull
  would add a warning. Its expected env and empty-warning assertion are
  unchanged. `BLOCK_LANDED` in
  `worker/deno/tests/token_economizer_trial_docs_test.ts` follows the reworded
  page sentence. No assertion was removed.
- Gitleaks hidden from `PATH`: `deno test -A
  tests/token_economizer_learnings_test.ts` ran 18 passed and 1 ignored (the
  real-binary secret test).
- `./quality.sh < /dev/null` on the final code (`f504ca77`) exited 0 with
  `Result: PASSED (with skipped checks)`. Deno tests passed in both the
  parallel (8m33s) and serial (3m43s) passes. Completeness, markdownlint,
  mermaid, semgrep, gitleaks, lint, type check and fmt also passed. Config
  integration (no `.config.json`) and checkov (no binary) were skipped, and
  these skips are not passes. The first run failed only on the unregistered
  sweep slice, now `docs/audits/lib-sweep-coverage/top-up-4957.json`.
- Callers checked: every production caller of `tokenEconomizerSpawnOptions`
  passes `subject`. Those are `execute_claude_phase.ts`, `phases/execute_phase.ts`,
  `pr_feedback_processor.ts` and `pr_ci_processor.ts` (two sites). `parseReport`
  in `gitleaks_check.ts` is now exported with no behaviour change, and its
  existing tests pass.
- The set/clear pairs checked: the stop latch is the existing #4956 record,
  which a healthy run deliberately does not clear. This change adds no new
  persistent failure record.

## Docs

- `docs/CONFIGURATION.md`: the TokenEconomizer row is updated, and the new "TokenEconomizer learnings"
  section covers the layout, pull, push, scratch clone and purge.
- `docs/TOKEN-ECONOMIZER-TRIAL.md` and `docs/THREAT-MODEL.md` no longer describe persistence as planned.
- The "not read yet" comments in `config.ts`, `config_defaults.ts`,
  `token_economizer_config.ts`, `types.ts` and the config test are reworded.

## Merge verification

Required PR CI, review and the existing automatic merge path are unchanged, and
are pending on this PR.

## Not done or not checked

- Kept scratch clones under `<work>/.token-economizer/store/<runId>` are not
  removed at the end of a run, just as the per-run homes were not before.
- The push outcome is logged but not yet recorded in run stats: #4958 will
  report the persistence status.
- Upstream's `*.jsonl` ledgers and `sessions/` records are not synced, by the
  issue's transcript rule. I did not establish whether a later fold relies on
  them.
- A live push to a real private GitHub store was not exercised. The tests use
  local bare repositories and stubbed visibility.
