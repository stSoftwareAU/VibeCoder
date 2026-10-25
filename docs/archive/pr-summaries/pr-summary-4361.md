## Summary

Three routine, self-clearing outcomes were logged at WARNING on every cycle.
A repository leased to another lane, a drift check whose push changed nothing,
and an add/add conflict with no merge-base stage now log at INFO. The add/add
case is named once per sync with a file count, and git's `fatal:` and `hint:`
text is no longer wrapped into that record. A merge-base read that fails for
any other reason stays a per-file warning. Closes #4361.

Version bump: not applicable; no `VERSION` file is touched by this change.

## Spec

### Intent and Rationale

- WARNING means degraded but continuing. A held maintenance lease, an empty
  push, and an add/add conflict with no stage 1 are the ordinary outcome of
  those paths, and logging them as warnings buried real ones.
- Each message stays, at INFO, because no other INFO line already records that
  outcome. The add/add files are still deferred to the AI rung; only the log
  shape changes.

### Essential Design Decisions

- An absent stage 1 is recognised only when git's stdout or stderr contains
  `not at stage 1`. A non-zero `git show :1:` whose text does not contain that
  phrase stays a per-file warning and still quotes git.
- Those files are counted and logged once per `applyDependencyConflictRules`
  call, after the manifest loop. Each deferred reason is the phrase
  `added on both sides, no merge base`, because the merge-conflict processor
  quotes that reason.
- The leased-cleanup and empty-push messages are unchanged apart from the
  level.

### Undiscoverable Facts

- On git 2.54, `git show :1:NOTES.md` during an add/add conflict prints
  `fatal: path 'NOTES.md' is in the index, but not at stage 1` and
  `hint: Did you mean ':2:NOTES.md'?`.
- Before the fix, the three new tests failed: the lease and empty-push lines
  were `warn`, and the add/add deferral reason was that fatal text. After the
  fix the same four Issue #4361 tests passed.

## Evidence

Backend change; no UI files. The tests below were run on this head from
`worker/deno`.

- Before the fix, `deno test -A --filter "Issue #4361" tests/escalated_cleanup_test.ts tests/pr_feedback_drift_check_3143_test.ts tests/dependency_conflict_apply_test.ts` reported `1 passed | 3 failed`. The passing test was the non-stage-1 merge-base failure, already a warning. The three failures were the lease line at `warn`, the empty-push line at `warn`, and the add/add reason equal to git's fatal and hint text.
- After the fix, the same filter reported `ok | 4 passed | 0 failed`.
- `deno test -A tests/escalated_cleanup_test.ts tests/dependency_conflict_apply_test.ts` reported `ok | 25 passed | 0 failed`.
- `deno test -A tests/pr_feedback_drift_check_3143_test.ts` reported `ok | 28 passed | 0 failed`.
- `deno lint` on the six changed TypeScript files reported `Checked 6 files`.

**Docs sweep** — grep: `Escalated cleanup deferred`, `this push changed nothing`, `not at stage 1`, `added on both sides`; section: none — no manual documents these log lines; siblings: none — no existing set gained a member; updated: none.

## Test Plan

- Added `worker/deno/tests/escalated_cleanup_test.ts` test `escalated cleanup - a lease held elsewhere is logged at info (Issue #4361)`. It asserts the deferred lease message is a single `info` line.
- Added `worker/deno/tests/pr_feedback_drift_check_3143_test.ts` test `runPrFeedbackDriftCheck - a push that changed nothing is logged at info (Issue #4361)`. It asserts `Drift check skipped — this push changed nothing` is a single `info` line and that the check stays skipped with no agent call.
- Added `worker/deno/tests/dependency_conflict_apply_test.ts` test `applyDependencyConflictRules - add/add files with no stage 1 are one info line (Issue #4361)`. A real git add/add of `NOTES.md` and `CHANGELOG.md` defers both with the reason `added on both sides, no merge base`, logs one `info` line containing `2`, and leaves the conflict markers in place. No log line contains `fatal:` or `hint:`.
- Added `worker/deno/tests/dependency_conflict_apply_test.ts` test `applyDependencyConflictRules - a merge-base failure that is not an absent stage 1 stays a warning (Issue #4361)`. The injected `fatal: path does not exist` outcome stays `warn` and the reason still quotes that text.
- Result: the filter run above passed, 4 passed and 0 failed, and the three full files passed as recorded under Evidence.

## Reproduction

- **symptom** — every cycle logs a warning when escalated cleanup finds the repository leased elsewhere, when a drift check's push changed nothing, and once per add/add file whose merge base is not at stage 1, wrapping git's fatal and hint text
- **status** — `verified`
- **regression test** — `worker/deno/tests/escalated_cleanup_test.ts` (`escalated cleanup - a lease held elsewhere is logged at info (Issue #4361)`), `worker/deno/tests/pr_feedback_drift_check_3143_test.ts` (`runPrFeedbackDriftCheck - a push that changed nothing is logged at info (Issue #4361)`), `worker/deno/tests/dependency_conflict_apply_test.ts` (`applyDependencyConflictRules - add/add files with no stage 1 are one info line (Issue #4361)`)
- The regression tests were observed failing against the unfixed code and passing after the fix.
