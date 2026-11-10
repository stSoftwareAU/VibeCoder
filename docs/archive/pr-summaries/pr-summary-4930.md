## Summary

The pre-push gate (agent `pre-push` hook, `commitAndPushPending` final-mile
push, completion-phase whole-branch check) now also runs a targeted `deno test`
over the changed tests before a push. It runs the changed `tests/*_test.ts`
files and the same-named `tests/<name>_test.ts` of each changed `.ts` source,
through the repository's own `deno task test:unit`, so a fix pushed by a
PR-feedback, CI-fix or babysitter round no longer reaches CI with a test it
broke. The whole CI suite is not run on those pushes. Part of #4930.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Before, those push paths ran only `deno fmt`, `deno lint`, markdownlint and
  similar changed-file checks; `deno test` ran only in the issue completion
  phase's full gate. `markdownlint` was already in the changed-file checks
  (`planChangedFileChecks`, `worker/deno/lib/pre_push_gate.ts`), so it needed no
  change.

### Essential Design Decisions

- A root gets the check only when its `deno.json(c)` defines a `test:unit` task:
  that task runs only unit tests, so the integration suites CI's shards exclude
  are not run, and other Deno repositories are unaffected.
- A targeted subset, not the suite: the full suite takes minutes per shard and
  the pre-push gate runs on every push. Tests that pin a changed source from an
  issue-numbered file name are not mapped.
- The check shares the existing runner, so a failure, timeout or missing `deno`
  blocks the push (fail closed).

### Undiscoverable Facts

- The CI logs of the failing shards could not be read
  (`gh run view --log-failed` returned Forbidden), so which tests failed is not
  known; the change closes the push path, not a named test.
- `./quality.sh` on this branch fails six tests that fail identically on the
  base commit `aa964319` (see Test Plan).

## Evidence

Backend-only; no UI files. Tests are in
`worker/deno/tests/pre_push_gate_test.ts`. Docs: `docs/CONFIGURATION.md`
(summary sentence of the changed-file checks and the hook's first-stage list).
New non-test members have production readers: `denoUnitTestRoots` is set in
`runPrePushGate` and read in `planChangedFileChecks`; `loadDenoUnitTestRoots` is
called by `runPrePushGate`.

## Acceptance Criteria

- **partial** — Make the fleet run `deno test, markdownlint` the way CI does,
  and require it to pass, before a PR is raised or a fix is pushed — evidence:
  `worker/deno/tests/pre_push_gate_test.ts::runPrePushGate: a changed test runs the repo's test:unit task, and its failure blocks the push (#4930)`
  — reason: `deno test` runs only for the changed test files and their
  same-named tests, not the whole CI suite; markdownlint was already in the
  pre-push gate

## Test Plan

- Added five tests in `worker/deno/tests/pre_push_gate_test.ts`: sibling
  mapping; sorted and deduplicated list; negatives (unlisted root, untested
  source, deleted test, docs only); `loadDenoUnitTestRoots` (config with and
  without `test:unit`, unparseable config); `runPrePushGate` running the task,
  blocking on a non-zero exit and listing it in `checksRun`.
- Red checks, each with only that behaviour broken: skip the sibling mapping →
  the sibling test red; ignore the `tracked` filter → the negatives test red;
  ignore `denoUnitTestRoots` → the negatives test red; ignore the `test:unit`
  key → the `loadDenoUnitTestRoots` test red; `runPrePushGate` not passing the
  roots → the `runPrePushGate` test red; remove deduplication → three tests red.
- `deno task test:unit tests/pre_push_gate_test.ts tests/pre_push_gate_cli_test.ts tests/pre_push_gate_cargo_deny_test.ts tests/pre_push_gate_retry_test.ts`:
  144 passed, 0 failed.
- `./quality.sh`: every check passed except `deno tests`: 33637 passed, 6 failed
  (`merge_fallback_issue_test.ts`, `pr_maintenance_command_test.ts`). Those two
  files give the same 6 failures at base `aa964319`, so they are not caused by
  this change.
- Related rules checked: the module doc and `docs/CONFIGURATION.md` lists of
  changed-file checks (siblings grepped: `cspell`, `ShellCheck`, `cargo deny`)
  were updated; no other doc lists them as complete.
- Callers of `planChangedFileChecks`: `runPrePushGate` passes the roots; the
  ShellCheck-only call passes no changed files, so it needs none.
