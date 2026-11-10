## Summary

Workflow-sync no longer treats a request the fleet closed as "not applicable to
this repository" (a public-only spec such as `dependency-review` on a private
repo) as a filing dedup hit, so the request is re-filed once the repository goes
public. Closes #4887.

## Spec

### Intent and Rationale

- `issueExistsByTag` searches `--state all`, so a closed, tagged, fleet-authored
  request suppressed re-filing forever. Only the missing-root-project closure
  could lift that; the private-repo closure carries the same
  `purge-not-applicable` marker but a different phrase and was never read.
- Chosen: widen the existing trusted-closure check rather than retire the body
  tag at close time, so already-closed requests are recovered with no data
  migration.

### Essential Design Decisions

- `hasFleetClosureComment` is the shared core; `hasMissingRootClosure` (reopen
  detection in the purge path) keeps its narrower meaning, and the new
  `hasApplicabilityClosure` (used only by `issueExistsByTag`) accepts both
  phrases.
- A closure still counts only from a fleet-authored comment carrying the
  `purge-not-applicable:<specId>` marker plus the phrase; a human comment or an
  ordinary closure keeps suppressing.

### Undiscoverable Facts

- None.

## Evidence

Backend only. `worker/deno/tests/setup_workflow_sync_test.ts` drives
`syncWorkflowsForRepo` with a closed tagged `dependency-review` issue on a
now-public repo, with the real closing-comment text from `buildClosingComment`.

## Test Plan

- Added four tests in `worker/deno/tests/setup_workflow_sync_test.ts`
  (`dependency-review closed on a private repo, repo now public`: fleet
  not-applicable closure re-files; human comment, ordinary closure, and a fleet
  comment carrying the marker but no applicability phrase do not). Each asserts
  a positive control (gitleaks still filed).
- Mutation check: replacing the `phrases.some(...)` operand at
  `purge_stale_workflow_issues.ts:299` with `true` now turns the
  marker-without-phrase test red (59 passed, 1 failed); restored, 60 pass.
- Red check: with base `purge_stale_workflow_issues.ts` and `workflow_sync.ts`
  restored, the fleet-closure test fails and the other two stay green (they pin
  the guard); with the fix all pass.
- Ran
  `deno task test:unit tests/setup_workflow_sync_test.ts tests/purge_stale_workflow_issues_test.ts`:
  95 passed, 0 failed. `deno fmt --check` on the changed files passed.
- Callers of `hasMissingRootClosure` checked: the purge reopen path still uses
  it unchanged (covered by existing purge tests).
- Docs updated: `docs/SETUP.md`, `docs/EXTENDING.md` (both passages),
  `SECURITY.md` (workflow_sync row).

- Ran `./quality.sh < /dev/null` on the head:
  `Result: PASSED (with skipped checks)` (config integration and checkov skipped
  by the gate itself).
