## Summary

The issue prompt and `docs/SPEC-KIT-COMPARISON.md` no longer say the
independent-review, reproduction, result-placeholder and mutation gates block PR
creation. They now describe the flow Issue #4234 made: the gate's findings go to
the agent once in the same session, and whatever remains is one comment on the
pull request, which is still raised and armed. The rules stay requirements the
run must meet. Closes #4574.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- An agent reading the old wording expects a remediation comment on the issue
  and assumes any raised PR passed these rules; neither is true after #4234.

### Essential Design Decisions

- Reworded the five passages the issue names (`prompts/issue/prompt.md`
  Standards Review, Reproduction Status and Test Plan item 7, plus
  `docs/SPEC-KIT-COMPARISON.md`) and two same-section siblings with the same
  claim: "an own-line breach left standing blocks the PR", "a mutation the
  tests do not catch blocks the PR" and, in Independent Review, a missing
  `reviewer:` field being "the single most common way this gate stops a finished
  run" (now "the single most common finding this gate reports on a finished
  run"). The guard regex also matches "gate stops a finished run", with the
  wording added to the positive control.
- Left "A violation this diff introduced blocks the PR — you enforce this one,
  not the gate": it is the agent's own rule and
  `pr_claims_verified_3058_test.ts` pins it.
- Added a section-scoped guard beside the existing one in
  `unmet_criteria_gate_test.ts`, as the issue suggested.

### Undiscoverable Facts

- None.

## Evidence

Backend/docs only, no UI. Code read before writing the claims:
`worker/deno/lib/phases/completion_phase.ts` (`reportSummaryRuleBlock`, the
#4234 comment: first report to the agent once, remainder one PR comment, neither
fails the run) and `worker/deno/lib/summary_rule_gate_retry.ts` (module doc:
findings are advice, the PR is still raised).

Other docs checked: `docs/workflows/issue-processing.md` already calls the
reproduction status "advisory at completion (Issue #4234)". `grep` of
`prompts/issue/prompt.md` for `blocks PR creation|blocks the PR` after the edit
leaves only the pinned "A violation this diff introduced blocks the PR"
paragraph. Issue numbers cited as provenance: #4234 (summary-rule gates
advisory), #3761 (existing citation, kept).

## Test Plan

- Added to `worker/deno/tests/unmet_criteria_gate_test.ts`: the section-scoped
  guard "no section says a summary-rule gate stops PR creation (Issue #4574)"
  and the positive control "summary-rule stop pattern - matches the old wordings
  and not the carve-out (Issue #4574)".
- Red check: restoring "a gate blocks PR creation" into the Reproduction Status
  passage turned the guard red
  (`prompts/issue/prompt.md § Reproduction
  Status`); restored afterwards. Restoring "the single most common way this gate stops a finished run" in Independent Review also turned it red.
- Ran `deno task test:unit` over `unmet_criteria_gate_test.ts`,
  `pr_claims_verified_3058_test.ts` and
  `issue_prompt_v39_independent_review_test.ts`: 19 passed, 0 failed.
- No existing assertion was removed.
