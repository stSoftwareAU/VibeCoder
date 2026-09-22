# PR Summary: Issue #2459 — One in-run agent rebase-and-fix pass

## Summary

Implements agent-based conflict resolution in the completion phase (Issue #2459, child of milestone #2442). When `ensureBranchCurrent` returns `declined` due to a rebase conflict, the system now invokes exactly one agent pass via `deps.claude.runClaudeWithRetry` to attempt automatic conflict resolution. On agent success with behind===0, the PR is raised cleanly without comment. On agent failure or deadline exceeded, the PR is raised with exactly one comment identifying conflicting file paths and noting that the merge-conflict ladder owns the PR from that point.

Closes #2459

## Implementation Details

- **Module**: `worker/deno/lib/branch_conflict_pass.ts` (352 lines, already exists and wired)
- **Call site**: `worker/deno/lib/phases/completion_phase.ts` lines 1193–1226 (agent pass) and 2291–2294 (comment posting)
- **Test file**: `worker/deno/tests/completion_phase_branch_conflict_test.ts` (new, 320 lines)

The conflict resolution flow:
1. `ensureBranchCurrent` measures drift; if behind>0, attempts rebase via cherry-pick
2. On cherry-pick failure (exit code 1), returns `BranchCurrencyOutcome.declined`
3. Completion phase detects declined and invokes `runDeclinedRebasePass` with agent seam
4. Agent runs once within deadline budget (MIN_REBASE_PASS_RUNWAY_SECONDS = 180s)
5. On agent success: re-measure drift; if behind===0, return resolved (no comment)
6. On agent failure or timeout: compute conflicting file paths and post exactly one comment

## Test Plan

Two new test cases in `completion_phase_branch_conflict_test.ts`:

1. **Success case**: Agent resolves conflict (behind→0)
   - Verifies: no conflict comment posted, PR created, status=continue
   - Uses fake rev-list call counter to simulate first call behind=2, second call behind=0
   - Simulates cherry-pick conflict and agent success

2. **Failure case**: Agent fails or times out
   - Verifies: exactly one conflict comment posted, PR created, status=continue
   - Comment includes "This PR was raised behind" heading and "merge-conflict ladder owns" text
   - Comment lists conflicting file paths (src/file.ts, lib/helper.ts)
   - Uses same rev-list counter pattern; no second measurement after failure

All tests pass locally with `deno test --allow-write --allow-env`.

## Acceptance Criteria

- ✅ **Spec**: Exactly one agent pass invoked when declined rebase detected
- ✅ **Spec**: PR raised cleanly (no comment) when agent resolves (behind===0)
- ✅ **Spec**: PR raised with exactly one conflict comment when agent fails/timeout
- ✅ **Spec**: Comment includes heading, explanation, file paths list, and ladder ownership note
- ✅ **Spec**: Runs bounded by cycle deadline (MIN_REBASE_PASS_RUNWAY_SECONDS)

## Standards Review

- ✅ Australian English (behaviour, organisation, favour) throughout
- ✅ Type-safe TypeScript with no `any` or assertion silencing
- ✅ Comprehensive test coverage (success and failure paths)
- ✅ Git fake dispatch pattern follows existing tests
- ✅ No hidden files or secrets committed
- ✅ Deno native: no Node.js regressions
- ✅ Quality gate passes (deno fmt, deno lint, deno check, deno test)

## Evidence

Test output from `deno test --allow-write --allow-env`:
```
running 2 tests from ./tests/completion_phase_branch_conflict_test.ts
completion - on declined rebase, exactly one agent pass is invoked and on success no conflict comment is posted ... ok (7ms)
completion - on agent failure, exactly one conflict comment is posted naming conflicting paths ... ok (1ms)

ok | 2 passed | 0 failed (11ms)
```

Full quality gate passes all checks (deno fmt, lint, type check, tests).
