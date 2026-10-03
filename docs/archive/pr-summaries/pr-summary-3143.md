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

**Docs sweep** — grep: `pr_feedback_processor`, `pr_feedback_drift_check`, `test_plan_recount`, "drift check", "review-fix", "Test Plan", "recount", "PR feedback" across `README.md`, `docs/` (excluding `docs/archive/`) and `*/README.md`; section: `docs/workflows/pr-feedback.md#the-workers-drift-check-issue-3143` (plus the Process step and `#recount-the-test-plan-after-a-review-fix-issue-3117`); updated: `docs/workflows/pr-feedback.md`, `docs/INTERNALS.md`, `prompts/pr_feedback/prompt.md`. Reviewed and left unchanged: `docs/PROMPTS.md` (pr_feedback row), `docs/INTERNALS.md` migration notes, `docs/REPO-CONTEXT-TRIAL.md` §1.2, `README.md`, `DESIGN-PRINCIPLES.md`. `docs/audits/lib-sweep-coverage.json` gained the `top-up-3143` entry (not "left unchanged") to claim the two new lib modules.
