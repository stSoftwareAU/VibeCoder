## Summary

Review-fix (PR feedback) runs now get a worker-run **drift check** on their
push (Issue #3143). After the agent's turn and the result-placeholder reply
retry, and before the comment is marked processed and the commit-and-push,
`pr_feedback_processor.ts` calls `runPrFeedbackDriftCheck`
(`worker/deno/lib/pr_feedback_drift_check.ts`). It runs three checks:

- a read-only model pass over the PR summary and the docs/prompts the PR
  touches, run only when the push changes code;
- a deterministic Test Plan recount (`worker/deno/lib/test_plan_recount.ts`),
  run whenever the PR carries a summary;
- a re-run of the Issue #3073 docs-sweep gate.

Any hit gets one recovery turn. Whatever is still left is appended to
`.pr_response_message` under `### Drift check (Issue #3143)`. The check is
wrapped so a throw never aborts an otherwise-successful run.

## Changes

- `worker/deno/lib/pr_feedback_drift_check.ts` — new: the drift check, its
  read-only question, recovery turn and residual reply note.
- `worker/deno/lib/test_plan_recount.ts` — new: counts `Deno.test(` / `it(`
  declarations at the head and flags stale Test Plan counts.
- `worker/deno/lib/pr_feedback_processor.ts` — wires the drift check in before
  the commit-and-push; `driftCheckFn` dependency for tests.
- `prompts/pr_feedback/prompt.md` — tells the agent the worker runs the drift
  check after its turn.
- `docs/workflows/pr-feedback.md` — new section "The worker's drift check
  (Issue #3143)", plus the Process step and the Issue #3117 recount section.
- `docs/INTERNALS.md` — module table rows for the two new modules.
- Tests: `worker/deno/tests/pr_feedback_drift_check_3143_test.ts`,
  `worker/deno/tests/pr_feedback_processor_drift_check_3143_test.ts`,
  `worker/deno/tests/test_plan_recount_3143_test.ts`.
- `docs/audits/lib-sweep-coverage.json` — top-up slice `top-up-3143`: claims
  the two new `worker/deno/lib/` modules
  (`pr_feedback_drift_check.ts`, `test_plan_recount.ts`) so the sweep
  coverage ledger test stays green.

**Docs sweep** — grep: `pr_feedback_processor`, `pr_feedback_drift_check`, `test_plan_recount`, "drift check", "review-fix", "Test Plan", "recount", "PR feedback" across `README.md`, `docs/` (excluding `docs/archive/`) and `*/README.md`; section: `docs/workflows/pr-feedback.md#the-workers-drift-check-issue-3143` (plus the Process step and `#recount-the-test-plan-after-a-review-fix-issue-3117`); updated: `docs/workflows/pr-feedback.md`, `docs/INTERNALS.md`, `prompts/pr_feedback/prompt.md`. Reviewed and left unchanged: `docs/PROMPTS.md` (pr_feedback row), `docs/INTERNALS.md` migration notes, `docs/REPO-CONTEXT-TRIAL.md` §1.2, `README.md`, `DESIGN-PRINCIPLES.md`. `docs/audits/lib-sweep-coverage.json` gained the `top-up-3143` entry (not "left unchanged") to claim the two new lib modules. A later pass updated the recount bullet in `docs/workflows/pr-feedback.md#the-workers-drift-check-issue-3143` so a loop, a wrapped command, an issue number, and an "added to" line are not treated as a whole-file count.

## Spec

### Intent and Rationale

A review-fix push was leaving a stale test count in the summary, and the prose rule that said to recount it was never checked. The worker now recounts the Test Plan itself and says so on the PR when the count is still wrong.

### Essential Design Decisions

- A file is left out of the recount when a declaration is inside a block, parentheses, or a loop, or the scan ends inside a literal or unbalanced. A wrong count is worse than skipping the line.
- Nested template literals, and plain braces inside `${...}`, are scanned so a later real declaration is still counted.
- A wrapped list item or a slash-continued command is one claim. `Issue #3143` is not a count. `added to`, `extended`, and `with N tests` describe an addition to an existing file, not the file's whole count.

### Undiscoverable Facts

- `deno test` registers a loop body once per iteration. The source contains the call once, so the file is skipped rather than reported as a stale count.

## Evidence

- **Docs sweep:** section `docs/workflows/pr-feedback.md#the-workers-drift-check-issue-3143`. The recount bullet now names the skip rules above.

## Test Plan

- `worker/deno/tests/test_plan_recount_3143_test.ts` — 38 passed. Includes a loop-generated `Deno.test` (file skipped), a nested template followed by two real declarations (counted), an unclosed template (file skipped), an `Issue #3143` line, the wrapped `pr-summary-2112` command shape (`35 passed` across three files), and `added to` / `extended` / `with N tests`.
- `worker/deno/tests/pr_feedback_drift_check_3143_test.ts` — 26 passed.
- `worker/deno/tests/pr_feedback_processor_drift_check_3143_test.ts` — 4 passed.

```bash
deno test --frozen --lock=deno.lock --allow-read --allow-env tests/test_plan_recount_3143_test.ts
deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-write --allow-run tests/pr_feedback_drift_check_3143_test.ts tests/pr_feedback_processor_drift_check_3143_test.ts
```
