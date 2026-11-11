## Summary

The pre-push gate (agent `pre-push` hook, `commitAndPushPending` final-mile
push, completion-phase whole-branch check) now also runs `deno test` before a
push, through the repository's own `deno task test:unit`. It runs the changed
`tests/*_test.ts` files, the same-named `tests/<name>_test.ts` of each changed
`.ts` source, and the `tests/` tests selected by a dependency scan: a test or
test helper whose text names it (path, unique base name, directory, or a
templated directory), or that imports it directly or through other files
(relative `.ts` specifiers). Deleted and renamed-away paths count, so a push
that removes a file still named by a test is checked. Literal `loadPrompt` calls
also select the tests for that prompt type. A change under a `prompts/`
directory, or to a root's `deno.json`, `deno.jsonc` or `deno.lock`, has readers
no name scan can find (a prompt builder, the lock file), so it runs that root's
whole `test:unit` suite instead (`needsFullUnitSuite`). A failing `deno test`
check is judged by `lib/deno_test_baseline.ts`: a module-fetch failure is a
`PrePushGateInfrastructureError`, and a test that fails the same way (same name,
same file) at the commit the push forked from is a `[PRE_PUSH_WARNING]` line,
not a block, but only when every failure of the run is accounted for: a test
module that failed outside a test (`(uncaught error)`) blocks, and a serial pass
the runner skipped after a failed parallel pass is run and judged too. The fork
is the merge-base with the PR's base when the gate knows it (the completion
phase, CI-fix, review-feedback and spelling pushes with a known PR base, and the
merge-conflict repair), or with the checkout's default branch for the agent's
own `git push`, not the PR's own previous head. A shallow clone is deepened
before the merge-base is looked up. PR-feedback and CI-fix final pushes with
`shellcheckOnly` specs now run these tests and configured markdownlint;
formatting policy is retained. Dynamic dependencies in a push that touches no
prompt or lock file can still be missed.

Version bump: `VERSION` is not touched by this change.

Part of #4930.

## Spec

### Intent and Rationale

- Before, those push paths ran only `deno fmt`, `deno lint`, markdownlint and
  similar changed-file checks; `deno test` ran only in the issue completion
  phase's full gate. `markdownlint` was already in the changed-file checks
  (`planChangedFileChecks`, `worker/deno/lib/pre_push_gate.ts`); repair specs
  now pass their pushed Markdown paths to it too.

### Essential Design Decisions

- A root gets the check only when its `deno.json(c)` defines a `test:unit` task:
  that task runs only unit tests, so the integration suites CI's shards exclude
  are not run, and other Deno repositories are unaffected.
- Dependency-selected, not the whole suite, except where readers cannot be
  resolved: a doc change selects roughly 20 to 300 tests, a change to a widely
  imported `lib/` module selects most of the unit suite (about 1,870 of 2,300
  test files for `lib/jsonc.ts`), the same tests CI would run for it, and a
  prompt, `deno.json` or `deno.lock` change runs the whole suite (a prompt
  reaches its tests through `buildIssuePrompt`-style builders and wrappers,
  which no token names). The selection over-approximates on purpose: running an
  unrelated test costs time, missing a reader lets a break reach CI.
- Only files under `tests/` are read for names. A source that merely quotes a
  doc path in a message depends on nothing; one that reads it has a test that
  names it. Changed integration suites are not passed to the runner: CI's unit
  shards exclude them, and the runner exits 1 on a list with no unit suite.
- Not followed: import-map, `jsr:` / `npm:` specifiers and computed dynamic
  imports; a path built piecewise with `join()` for a non-unique base name; a
  `_test.ts` outside `tests/`.
- The check shares the existing runner, so a failure or timeout blocks the push
  (fail closed). Not every failure is the branch's: a missing `deno` or a
  module-fetch failure with no failed test in the output is infrastructure
  (`PrePushGateInfrastructureError`; a 404 `JSR package not found` is not), and
  a failed test that is also red at the fork commit (a throwaway `git worktree`
  re-run of the failed files) is a warning. The fork is `git merge-base` of the
  pushed head and the PR's base (`baseRef`, or `origin/<syncBaseBranch>` or
  `origin/<gateBaseBranch>` for a repair push), so a repair that leaves a test
  red is compared with the PR's base, not its own previous head; with neither it
  is the parent of the oldest commit not yet on a remote. The agent's own
  `git push` runs through the pre-push hook, which passes the checkout's default
  branch (`origin/HEAD`, `resolveLocalDefaultBranch`) as the baseline. A shallow
  clone is deepened with `ensureHistoryDepth` first, a deepen that fails leaves
  the baseline unavailable. The downgrade needs every failure accounted for: an
  `(uncaught error)` module (a top-level throw, a dangling promise, a missing
  named export, which `--no-check` only surfaces at run time) names no test to
  compare and blocks. `deno task test:unit` stops after a failed parallel pass,
  so a downgraded run that never reached its serial pass gets `--serial-only`
  run and judged the same way (`judgeDenoTestCheck`). A push-added test file, a
  base that passes, a base that cannot be checked out (a deepen that failed, so
  no merge-base is found) and output naming no failed test stay blocks. A
  timeout stays a block.
- Not covered: the runner's time budget over a failed parallel pass (it runs
  only after every pass succeeded, and is not re-run); a repo whose `test:unit`
  runner prints no `=== <label> pass:` lines is judged as one pass; the agent's
  own `git push` compares at the default branch, so a PR that targets another
  branch is compared at an older commit.

### Undiscoverable Facts

- The CI logs of the failing shards could not be read
  (`gh run view --log-failed` returned Forbidden), so which tests failed is not
  known; the change closes the push path, not a named test.
- An earlier PR for this issue (#5014) was closed on a gitleaks `private-key`
  finding in a WIP checkpoint commit that had added a Deno transpile cache
  (`worker/deno/gen/...github_app_auth.ts.js`); the final tree never held it.
  This branch is the same change re-applied as one clean commit on `main`, so no
  history carries that file.
- `./quality.sh` on this branch fails five `pr_maintenance_command_test.ts`
  tests that fail identically on `origin/main` at `73d1964a` (see Test Plan).

## Evidence

Backend-only; no UI files. Tests are in
`worker/deno/tests/pre_push_gate_test.ts`. Docs: `docs/CONFIGURATION.md`
(summary sentence of the changed-file checks and the hook's first-stage list).
New non-test members have production readers: `denoUnitTestRoots` and
`denoReferencedTests` are set in `runPrePushGate` and read in
`planChangedFileChecks`; `loadDenoUnitTestRoots` and `loadReferencedUnitTests`
are called by `runPrePushGate`; `denoFullUnitRoots` and `denoTestRoot` are set
from `needsFullUnitSuite` and read by `planChangedFileChecks` and the
`runPrePushGate` loop; `judgeDenoTestCheck`, `unitTestCommand` and
`worktreeBaseline` (`lib/deno_test_baseline.ts`) are called by `runPrePushGate`;
`baselineBranch` is set by `gateUnpushedCommits` (from `commitAndPushPending`'s
`syncBaseBranch`) and read by `runPrePushGate`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — Make the fleet run `deno test, markdownlint` the way CI
  does, and require it to pass, before a PR is raised or a fix is pushed —
  evidence:
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a changed test runs the repo's test:unit task, and its failure blocks the push (#4930)`,
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a changed doc runs the differently named test that reads it (#4930)`,
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a deleted source runs the differently named test that imports it (#4930)`
  — reviewer: partially met (markdownlint was already in the pre-push gate;
  `deno test` now runs the unit tests selected by name and by import, or the
  whole suite for a prompt or lock change, and a failure the branch caused
  blocks the push; a base-only failure or a download outage does not). Three PR
  #5034 review cases are now closed and tested: base-red named failures beside
  an `(uncaught error)` file block, a skipped serial pass is run and judged, and
  a repair push whose PR base is known is compared at that base. Known open
  fail-open cases, so the check does not pass-gate every push: outside a prompt
  or lock change the check runs the dependency-selected subset, not the whole
  suite CI runs (dynamic loader types, computed paths, import-map aliases,
  `jsr:` / `npm:` specifiers and a `_test.ts` outside `tests/` can be missed);
  the runner's time budget over a failed parallel pass is not re-run; a repair
  whose PR base is unknown, or whose checkout has no `origin/HEAD`, compares at
  the parent of its oldest unpushed commit, and the agent's own `git push` for a
  PR that targets a non-default branch is compared at the merge-base with the
  default branch, which can be older than the PR's base. — reason: the cases
  above still reach CI and the dependency-selected subset is not the whole
  suite CI runs.

## Test Plan

- Tests in `worker/deno/tests/pre_push_gate_test.ts`: sibling mapping; sorted
  and deduplicated list; negatives (unlisted root, untested source, deleted
  test, docs only); what counts as a test and as a source (`_test.ts` outside
  `tests/`, a `tests/` helper, a non-`.ts` file); `denoReferencedTests` merged,
  filtered by `tracked`; changed integration suites left out;
  `loadDenoUnitTestRoots` (config with and without `test:unit`, unparseable
  config, a `null` or array document, and a missing, `null`, array or string
  `tasks`); `loadReferencedUnitTests` (import, transitive import through a
  wrapper and a cycle, doc read through a helper, templated prompt path,
  ambiguous base name, directory listing, a source that only quotes a doc, a
  deleted source, changed tests excluded); `runPrePushGate` running the task and
  blocking on a non-zero exit, running a differently named test for a changed
  doc, and for a deleted source.
- Mutation survivors from the first completion check, each now killed:
  `plannedUnitTestFiles` operands (a `lib/x_test.ts`, a `tests/helper.ts`, a
  `.md` / `.js` source, a source named `x_test.ts`) and the `test:unit` task
  probe (`null`, array, `{}`, `{"tasks": null}`, an unreadable config: the probe
  no longer swallows a `null` text, so a dropped `null` check throws). Red
  checks run by hand: `startsWith("tests/")` dropped, `endsWith(".ts")` dropped,
  `tasks !== null` dropped, ancestor tokens on `.ts` files, `..` resolution, the
  `.` skip, the visited check, the seed set, the changed-test exclusion, the
  tests-only text scan and the integration filter: each turns a test red.
- Mutation survivors from the second completion check: `pre_push_gate.ts` line
  1354 (the path itself as a reference token) was dead, since the base name or
  last two segments are always a substring of the path, so the token is removed;
  line 1404 (the base-name count) is now pinned by `namesBareBase`, a test that
  names only the bare base name, which turns red when the count is not recorded.
- `deno task test:unit tests/pre_push_gate_test.ts tests/pre_push_gate_cli_test.ts tests/pre_push_gate_cargo_deny_test.ts tests/pre_push_gate_retry_test.ts`:
  all passed (148 before the last additions; the 111-test
  `pre_push_gate_test.ts` passes after them).
- `./quality.sh < /dev/null` on the final head: every check passed except
  `deno tests`, whose only failures are five tests in
  `worker/deno/tests/pr_maintenance_command_test.ts` (update-open-pr-branches:
  merge-queue read, strict-base refresh, three base-owner cases). The same five
  fail on `origin/main` (`deno test -A tests/pr_maintenance_command_test.ts` in
  a clean worktree of `73d1964a`: 23 passed, 5 failed), so they are not caused
  by this change. Config integration and checkov were skipped by the gate.
- gitleaks run locally over `origin/main..HEAD` of this branch: no findings.
- Related rules checked: the module doc and `docs/CONFIGURATION.md` lists of
  changed-file checks (siblings grepped: `cspell`, `ShellCheck`, `cargo deny`)
  were updated. The PR #5034 review found more: the `git_push.ts` doc comments
  of `PreFlightGateSpec`, `shellcheckOnly` and `resolveRepairPreFlightSpec`, the
  `commitAndPushPending` parameter doc, and the `docs/CONFIGURATION.md` push
  guarantee paragraph said a repair ran no more than ShellCheck and cargo deny;
  all now name the unit tests and markdownlint. The agent-facing push-guarantee
  strings in `worker/deno/lib/quality_gate_budget.ts` (`pre-flight-only` and
  `ci-fix`, which said a repair "runs no checks") were reworded the same way,
  with their pins in `quality_gate_budget_test.ts` and `repo_config_test.ts`.
- `runPrePushGate` passes the Deno roots and referenced tests to the planner.
  Repair specs retain their formatter policy while passing changed paths for
  unit-test selection and configured Markdown validation.

### PR #5034 review revision

- Recognise literal `loadPrompt` types, including the repository's separate
  `PROMPTS_DIR` / `new URL("../../../prompts", import.meta.url)` pattern.
- Repair pushes run affected unit tests and markdownlint without enabling their
  skipped formatters. Each failing check blocks; the successful control passes.
- Both regressions fail before these fixes. All 113 pre-push gate tests passed
  at that revision.
- Corrected the docs and summary to state the scan's heuristics and remaining
  dynamic-dependency limits rather than promising every broken test is selected.
- Formatting, lint and diff checks pass. Tests use integrity-verified local
  copies of locked dependencies. Full quality gate not rerun here.

### PR #5034 review, second and third rounds

- Baseline and outage: `lib/deno_test_baseline.ts` judges a failed `deno test`
  check. Observed from the real `deno test` 2.9.8: failed tests print
  `name => ./file_test.ts:L:C` under FAILURES; a test module that fails outside
  a test (a missing named export, a top-level throw) prints
  `./b_test.ts (uncaught error)` under ERRORS and FAILURES and
  `Uncaught error from ./b_test.ts FAILED` while running, and names no test; the
  runner prints `=== parallel pass: FAILED in 3.2s` and stops. A JSR outage
  prints
  `error: JSR package manifest for '@std/path' failed to load. Import
  '...' failed.`,
  an `https:` import `error: Import '...' failed.` with
  `error sending request for url`, an npm outage
  `error: Failed loading ... for package`; a missing package prints
  `error: JSR package not found` (a 404, so a verdict).
- Whole suite for unresolvable readers: `needsFullUnitSuite` (prompts, and a
  root's `deno.json` / `deno.jsonc` / `deno.lock`), passed to the planner as
  `denoFullUnitRoots`.
- Third round (this head): `hasUncaughtError` makes an `(uncaught error)` run a
  verdict; `judgeDenoTestCheck` runs `--serial-only` after a base-only run whose
  serial pass never ran (`serialPassSkipped`) and judges it; the fork is the
  merge-base with the PR's base (`baselineBranch`, threaded from
  `commitAndPushPending`'s `syncBaseBranch` through `gateUnpushedCommits`). The
  `worktreeBaseline` tests now run against a real temporary git repository (fork
  commit holding some of the files, a runner that reads a marker file from its
  cwd) and assert the outcome: `ranFiles`, the error, the fork checkout and that
  `git worktree list` shows only the main worktree afterwards. The judge tests
  assert only the returned outcome. The two pins that the second round replaced
  (`Configured pre-flight commands enable changed-file checks`) are restored in
  `quality_gate_budget_test.ts` and `repo_config_test.ts` beside the new clause.
- Tests at the head: `worker/deno/tests/deno_test_baseline_test.ts` (17 tests at
  head), `worker/deno/tests/pre_push_gate_test.ts` (124 tests at head) and
  `worker/deno/tests/git_push_preflight_test.ts` (22 tests at head), including
  `runPrePushGate` cases for a test red at the fork (warning, worktree removed),
  a base that passes, a different test red at the base, a push-added test file,
  a fetch outage, a 404, a mixed output, a builder-based reader reached by the
  whole suite for a prompt and a lock change, base-red named failures plus an
  `(uncaught error)` file (blocked), a base-red parallel failure plus a failing
  serial pass (blocked; a passing serial pass is only a warning), and a repair
  push compared at the PR's base (blocked) against the previous head (waved
  through); and `commitAndPushPending` with `syncBaseBranch`, with
  `gateBaseBranch` alone and with neither. The merge-conflict repair passes its
  `baseBranch` as `gateBaseBranch` (a new `PushLineageOptions` field that only
  places the baseline and never merges; `syncBaseBranch` would merge a second
  time), pinned by `worker/deno/tests/pr_merge_conflict_processor_test.ts`.
- Red checks run by hand on this head (each change made, the test run, then
  restored): `hasUncaughtError` return removed → `deno_test_baseline_test.ts`
  and `pre_push_gate_test.ts` red (2 failed); the `--serial-only` rerun removed
  → the same two files red (2 failed); `baselineBranch` ignored in
  `runPrePushGate` → `pre_push_gate_test.ts` "a repair push compares a failing
  test at the PR's base" red; `options.syncBaseBranch` dropped from the
  `gateUnpushedCommits` call in `commitAndPushPending` →
  `git_push_preflight_test.ts` "a repair push compares a failing unit test at
  the PR's base" red; the merge-conflict repair's `gateBaseBranch` dropped (and
  the `gateBaseBranch ??` fallback removed from `commitAndPushPending`) →
  `pr_merge_conflict_processor_test.ts` "the push gate compares a failing unit
  test at the PR's base" and `git_push_preflight_test.ts` "a repair push
  compares a failing unit test at the PR's base" red (2 failed).
- Earlier red checks (second round): fetch classification off; `fresh`
  comparison dropped; `ranFiles` guard dropped; safe-path guard dropped;
  `needsFullUnitSuite` call replaced by `false`; the `prompts/` operand replaced
  by `false`; a timeout is neither an outage nor base-only.
- `pre_push_gate_test.ts` injects `findMarkdownlint` for its Markdown prompt
  case so it does not depend on the host's install.
- `docs/audits/lib-sweep-coverage/top-up-4930.json` claims
  `worker/deno/lib/deno_test_baseline.ts` for the sweep-coverage audit.
- Docs: `docs/CONFIGURATION.md` (the `deno test` bullet: fork choice,
  `(uncaught error)`, the skipped serial pass), the module doc of
  `pre_push_gate.ts`, `runPrePushGate` and `gateUnpushedCommits` doc comments.
- Run on this head:
  `deno task test:unit tests/deno_test_baseline_test.ts tests/pre_push_gate_test.ts tests/pre_push_gate_cli_test.ts tests/pre_push_gate_retry_test.ts tests/git_push_preflight_test.ts tests/git_push_test.ts tests/issue_worker_test.ts tests/pr_merge_conflict_processor_test.ts tests/quality_gate_budget_test.ts tests/repo_config_test.ts`
  (528 passed, 0 failed at that revision). Formatter, lint and `deno check` of the changed files
  pass.

### PR #5034 review, fourth round

- Shallow clones: `pushForkCommit` (`lib/pre_push_gate.ts`) calls
  `ensureHistoryDepth([compareRef, ...heads])` before `git merge-base`
  (a no-op on a full clone); a failed deepen leaves the baseline unavailable, so
  the failure blocks. Test: `runPrePushGate: a repair push on a --depth=1 clone
  is deepened to find the PR's base, so a base-red test is a warning` in
  `worker/deno/tests/pre_push_gate_test.ts`, on a real `--depth=1
  --no-single-branch` clone whose base moved on after the PR branch left it
  (control: `merge-base` fails there before the gate runs); the same clone with a
  base that passes still blocks. Red check: the deepen replaced by a no-op → that
  test red (`deno task test:unit` blocked on `tests/foo_test.ts`).
- The agent's own `git push`: `pre_push_gate_cli.ts` now passes the checkout's
  default branch (`resolveLocalDefaultBranch`, moved unchanged to
  `lib/local_default_branch.ts` so the standalone hook needs no `git_push.ts`
  imports; `git_push.ts` re-exports it for its callers) as `baselineBranch`.
  Test: `pre-push cli: the checkout's default branch is the gate's baseline;
  unknown leaves it unset` in `worker/deno/tests/pre_push_gate_cli_test.ts`.
- Tests that asserted how fakes were called: the `runPrePushGate` runners in
  `pre_push_gate_test.ts` now answer by the checkout's `lib/foo.ts` (`atHead`),
  and the call count and worktree path pins were dropped. In
  `deno_test_baseline_test.ts` the `worktreeBaseline` runner answers by a marker
  file (`fork`, `fork-nested`), so a run at the wrong commit or in the wrong
  root changes the returned outcome; the zero-call assertions, the `/tree`
  path pins and the `vibe_deno_test_base_` prefix pin are gone (a stray run
  would show as an error in the result, and the default temp checkout is shown
  removed). The `judgeDenoTestCheck` fakes answer by command, and the throwing
  "must not be run" fakes are gone.
- The safe-path case in `deno_test_baseline_test.ts` is no longer vacuous: its
  base reports `./../evil_test.ts` as run and failed the same way, beside a
  control with a plain path that is base-only. Red checks run on this head: the
  `SAFE_TEST_PATH` guard removed → "base-only needs every failed test red at the
  base" red; the worktree added at `HEAD` instead of the fork → the nested-root
  and top-level `worktreeBaseline` tests red (`marker=head`); the
  `--serial-only` suffix changed → the serial-pass test red.
- Closing keyword: the summary says `Part of #4930`; the criterion stays
  partially met.
- Docs: `docs/CONFIGURATION.md` (fork choice for the agent's own push, the
  deepen), this summary; `docs/audits/lib-sweep-coverage/top-up-4930.json` also
  claims the new `lib/local_default_branch.ts`.
- Run on this head:
  `deno task test:unit tests/deno_test_baseline_test.ts tests/pre_push_gate_test.ts tests/pre_push_gate_cli_test.ts tests/pre_push_gate_retry_test.ts tests/git_push_preflight_test.ts tests/git_push_test.ts tests/issue_worker_test.ts tests/pr_merge_conflict_processor_test.ts tests/quality_gate_budget_test.ts tests/repo_config_test.ts tests/run_bootstrap_test.ts`
  (551 passed, 0 failed). `./quality.sh` was not rerun on this head.
