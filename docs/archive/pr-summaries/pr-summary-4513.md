## Summary

`buildClosureGateComment` and three completion-phase log messages still
described the acceptance-criteria closure gate and the independent-review gate
as blocking, although since Issue #4234 both are advice and the PR is raised and
armed anyway. The reviewer note therefore read "They did not block this pull
request" directly above text saying the review half is printed because the next
gate "blocks" a criteria block raised without it. This PR rewords that text to
the post-#4234 flow. Closes #4513.

## Spec

### Intent and Rationale

- Sibling of the #4469 fix for the unmet-criteria note: the closure comment is
  posted under the same "did not block" sentence, so it must not claim the PR is
  withheld.
- Only the wording changes; the gates' behaviour and the printed template
  (`REVIEW_BLOCK_TEMPLATE`) are untouched.

### Essential Design Decisions

- The comment says the summary "should" close each criterion and that any left
  unclosed is named on the pull request, "which is raised anyway".
- Only the three log messages the issue names were reworded to "reported
  findings". The reproduction-status, result-placeholder, mutation, coverage
  carry-over and pre-PR verifier "blocked PR creation" messages are advisory too
  (they report through `reportSummaryRuleBlock`, which "neither fails the run
  nor stops the pull request"); they were left out only because the issue named
  three. Only the security-fix and changed-workflow gates still end the run.

### Undiscoverable Facts

- None.

## Evidence

Backend-only text change; no UI files touched. Verified by unit tests (below).
`worker/deno/lib/acceptance_criteria_gate.ts` (`buildClosureGateComment` and its
JSDoc) and `worker/deno/lib/phases/completion_phase.ts` (three `logger.warn`
messages) changed.

## Test Plan

- Added
  `worker/deno/tests/acceptance_criteria_gate_test.ts::buildClosureGateComment - does not claim the PR is withheld or that a gate blocks`:
  asserts "raised anyway" and no withheld-PR or "blocks a criteria block" claim.
  Red check: with the old wording restored the test fails; with the new wording
  it passes.
- `deno task test:unit tests/acceptance_criteria_gate_test.ts tests/review_block_template_test.ts tests/unmet_criteria_gate_test.ts`:
  48 passed, 0 failed. `deno fmt --check`, `deno lint` and `deno check` on the
  three edited files: clean.
- No existing test asserts the old log strings or comment wording (grepped
  `worker/deno` and `docs/`, excluding `docs/archive/`); no assertion was
  removed or edited.
- Not changed, noted for reviewers: `prompts/issue/prompt.md` still has a few
  lines (around 906 and 1048) saying a gate "blocks PR creation"; they are
  outside this issue's named scope.
