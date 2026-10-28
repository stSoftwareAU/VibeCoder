## Summary

The closing-keyword guidance now agrees with the #3177 guard. A summary whose `## Acceptance Criteria` block marks a criterion `missing` carries `Part of #N`, so the committed archive and the worker-assembled PR body say the same thing. When every criterion is met the summary still carries `Closes #N`. Closes #4445.

Wording changes only, in three prompts and one standards line:

- `prompts/issue/prompt.md`, "Issue Closure in PR Summary": the unconditional MUST and "Do NOT omit the issue closure reference" are replaced by one conditional rule (`Closes #N` when every criterion is met or none are stated, `Part of #N` when any is `missing`).
- `prompts/issue/prompt.md`, summary-file item 1 and `CODING-STANDARDS.md` item 1: same conditional.
- `prompts/issue/prompt.md`, the "unmet criterion" bullet: the false "raises no PR until every criterion is met" is replaced with what `completion_phase.ts` does since #4234 (an unmet criterion is named on the PR, raised as `Part of #N`).
- `prompts/pr_feedback/prompt.md`, "Stopping the PR from closing its issue": the agent writes `Part of #N` in the summary itself; the body's `## Not closing #N` section is unchanged.

Version bump: not applicable; no `VERSION` change is part of this wording change.

## Spec

### Intent and Rationale

- Three passages told the agent to write `Closes #N` and to rely on the worker for the rest, so a partial PR's archive contradicted its body. Rewording the source removes the contradiction with no new worker step.
- A worker-side rewrite of the archived file was considered and rejected in the issue: it would add a worker commit after the agent's last and change the summary the digest marker and `pr-summary-ci` compare against.

### Essential Design Decisions

- `withholdIssueClose` stays as the body backstop; a summary that follows the new text makes it a no-op.
- The `Part of` case is tied to `missing` entries only, matching `withholdIssueClose` and the `pr_summary_check.ts` "Part of still closes" gate, which passes `Part of #N` only when a `missing` entry parses. The prompt says so.
- No new gate or drift test, as the issue asks for "no new rule, gate or check".

### Undiscoverable Facts

- None.

## Evidence

Prompt and docs wording only; no code path changed. The behaviour the new text relies on was read at:

- `worker/deno/lib/missing_criterion_close_guard.ts` (`withholdIssueClose`, `buildMissingCriteriaPrNote`): rewrites only the body.
- `worker/deno/lib/pr_summary_check.ts` (`partOfStillClosesProblem`): a `Part of` summary passes when `findMissingCriteria` is non-empty.
- `worker/deno/lib/phases/completion_phase.ts` (unmet-criteria block, "raised and armed anyway"): backs the corrected "raises no PR" sentence.

Related existing rules checked: `CODING-STANDARDS.md` "not raised over a `Closes #<n>`" and the #3177/#4304 paragraph below it (both already say `Part of #<n>`), `docs/workflows/issue-processing.md` (describes the body rewrite; still true), `prompts/issue/prompt.md` "`Closes #N` appended automatically when every criterion is met" (consistent). The rule was applied to this PR's own summary: it has no `missing` criterion, so it carries `Closes #4445`.

## Test Plan

- No test added: the issue asks for a rewording with no new check.
- Edited `worker/deno/tests/pr_claims_verified_3058_test.ts` ("issue prompt demands demonstrated criteria and finished deliverables"), which pinned the sentence this change had to reword.
  - Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`: `"An unmet criterion is not a PR"`
    - Replaced by: `"Finish every unmet criterion"`
    - Required by: "An unmet criterion is named on the PR, and the PR is raised as `Part of #N`"
  - Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`: `"The worker raises no PR until every criterion is met"`
    - Replaced by: `"is named on the PR, which the worker raises as"`
    - Required by: "change \"The worker raises no PR until every criterion is met (Issue #4146)\" to match"
  - Red check: with `prompts/issue/prompt.md` restored to the base text, the test fails on `Finish every unmet criterion`; with the change it passes (5 passed, 0 failed).
- Ran `deno task test:unit tests/coding_guidelines_layers_2574_test.ts` (12 passed) and `tests/pr_claims_verified_3058_test.ts` (5 passed).
- Not run: the full `./quality.sh` gate was not run for this wording change; CI runs it on the PR.
