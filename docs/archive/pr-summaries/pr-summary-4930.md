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
also select the tests for that prompt type. PR-feedback and CI-fix final pushes
with `shellcheckOnly` specs now run these tests and configured markdownlint;
formatting policy is retained. Dynamic dependencies can still be missed.

Version bump: `VERSION` is not touched by this change.

Closes #4930.

## Spec

### Intent and Rationale

- Before, those push paths ran only `deno fmt`, `deno lint`, markdownlint and
  similar changed-file checks; `deno test` ran only in the issue completion
  phase's full gate. `markdownlint` was already in the changed-file checks
  (`planChangedFileChecks`, `worker/deno/lib/pre_push_gate.ts`); repair specs now
  pass their pushed Markdown paths to it too.

### Essential Design Decisions

- A root gets the check only when its `deno.json(c)` defines a `test:unit` task:
  that task runs only unit tests, so the integration suites CI's shards exclude
  are not run, and other Deno repositories are unaffected.
- Dependency-selected, not the whole suite: a doc or prompt change selects
  roughly 20 to 300 tests, while a change to a widely imported `lib/` module
  selects most of the unit suite (about 1,870 of 2,300 test files for
  `lib/jsonc.ts`), the same tests CI would run for it. The selection
  over-approximates on purpose: running an unrelated test costs time, missing a
  reader lets a break reach CI.
- Only files under `tests/` are read for names. A source that merely quotes a
  doc path in a message depends on nothing; one that reads it has a test that
  names it. Changed integration suites are not passed to the runner: CI's unit
  shards exclude them, and the runner exits 1 on a list with no unit suite.
- Not followed: import-map, `jsr:` / `npm:` specifiers and computed dynamic
  imports; a path built piecewise with `join()` for a non-unique base name; a
  `_test.ts` outside `tests/`.
- The check shares the existing runner, so a failure, timeout or missing `deno`
  blocks the push (fail closed).

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
are called by `runPrePushGate`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Make the fleet run `deno test, markdownlint` the way CI does, and
  require it to pass, before a PR is raised or a fix is pushed — evidence:
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a changed test runs the repo's test:unit task, and its failure blocks the push (#4930)`,
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a changed doc runs the differently named test that reads it (#4930)`,
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a deleted source runs the differently named test that imports it (#4930)`
  — reviewer: met (markdownlint was already in the pre-push gate; `deno test`
  now runs the unit tests a push can affect, found by name and by import, and
  its failure blocks the push). Known residual gaps, judged unrealistic or rare
  by the reviewer: a path built piecewise with `join()` for a non-unique base
  name, import-map / `jsr:` / `npm:` specifiers, and a `_test.ts` outside
  `tests/`.

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
  were updated; no other doc lists them as complete.
- `runPrePushGate` passes the Deno roots and referenced tests to the planner.
  Repair specs retain their formatter policy while passing changed paths for
  unit-test selection and configured Markdown validation.

### PR #5034 review revision

- Recognise literal `loadPrompt` types, including the repository's separate
  `PROMPTS_DIR` / `new URL("../../../prompts", import.meta.url)` pattern.
- Repair pushes run affected unit tests and markdownlint without enabling their
  skipped formatters. Each failing check blocks; the successful control passes.
- Both regressions fail before these fixes. All 113 pre-push gate tests pass.
- Corrected the docs and summary to state the scan's heuristics and remaining
  dynamic-dependency limits rather than promising every broken test is selected.
- Formatting, lint and diff checks pass. Tests use integrity-verified local
  copies of locked dependencies. Full quality gate not rerun here.
