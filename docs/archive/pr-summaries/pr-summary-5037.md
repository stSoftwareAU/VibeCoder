## Summary

`workOnIssueExecuteClaude` skipped the bounded #1550 in-process retry whenever
the failure reason contained `USAGE_LIMIT_HEADING` anywhere. Killed and
interrupted reasons quote the agent's own output. A killed run whose output
quoted the heading therefore lost its one retry, and the log claimed the
subscription window was spent when it was not.

The check now requires category `rate_limit` and a reason that **starts with**
the heading. That is the shape of the only reason the worker writes for a spent
window (`formatDetailedFailureMessage(heading + …)` in the exit-2 branch of
`executeClaudeBody`). The `USAGE_LIMIT_HEADING` doc comment now says so.

Closes #5037.

## Spec

### Intent and Rationale

- Match only text the worker writes, as the issue suggests. This mirrors the
  existing turn-limit check (`TURN_LIMIT_REASON_PREFIX` with `startsWith`).
- A structured `usageLimit` flag on the phase result was the alternative. It
  would widen `PhaseResult` for one reader, while the category and the prefix
  already identify the reason.

### Essential Design Decisions

- Both conditions are required. The category alone would match the other exit-2
  reason ("Claude rate limit — retries exhausted"), which is not a spent window.
  The prefix alone would trust the start of a reason from any category.

### Undiscoverable Facts

- The defect was found while reviewing PR #5025, as the issue body states.

## Evidence

Backend only; no UI file is touched.

- Callers checked: `USAGE_LIMIT_HEADING` has two uses, both in
  `worker/deno/lib/phases/execute_phase.ts`: the reason it writes, and the retry
  check changed here.
- Docs: `docs/TROUBLESHOOTING.md` § "Where the work goes when a window runs out
  mid-issue" (Issue #1670) describes parking and the infrastructure
  classification, not how the retry check matches. It is still true and is
  unchanged.
- Issue numbers this diff adds: #5037 (Execute phase skips the bounded
  in-process retry when agent output quotes the usage-limit heading).

## Test Plan

- Added `worker/deno/tests/execute_phase_killed_test.ts` test "execute_phase - a
  killed run whose output quotes the usage-limit heading keeps its single retry
  (Issue #5037)".
  - Its killed run's output ends with the heading.
  - It asserts that the heading reaches the reason (positive control), that the
    reason classifies as `killed`, that the runner is called twice, that the
    retry is logged, and that the usage-limit skip never fires.
  - Red against the unfixed check: runner calls were 1, expected 2.
  - Green after the fix.
- The skip still fires for a genuine spent window. In
  `worker/deno/tests/execute_phase_usage_limit_test.ts`, "execute #1670 - with
  no eligible credential the run parks on the branch and stops" drives
  `workOnIssueExecuteClaude` and asserts exactly two invocations and a
  `rate_limit` reason. An unwanted in-process retry would add invocations.
- No existing test was edited.
- `deno task test:unit` on `worker/deno/tests/execute_phase_killed_test.ts`,
  `worker/deno/tests/execute_phase_usage_limit_test.ts` and
  `worker/deno/tests/execute_phase_turn_limit_4949_test.ts`: 28 passed, 0
  failed.
- Full `./quality.sh` after the code commit: PASSED with skipped checks. Config
  integration was skipped (no `.config.json`), and so was checkov (not installed
  on this host; CI runs it).
- Not covered: the interrupted empty-failure path that also quotes output has no
  test of its own. It reaches the same check, which now requires category
  `rate_limit` and so cannot match an `interrupted` reason.
