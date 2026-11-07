## Summary

Updated stale-summary guidance in the PR freshness report and babysitter repair
prompt so repairs rewrite claims, counts and results for the pushed head instead
of appending a follow-up note. Added regression tests and documented the repair
guidance. Closes #4755.

## Spec

### Intent and Rationale

- Align both repair instructions with the existing rule that PR summaries
  describe the branch's final state.

### Essential Design Decisions

- Change guidance only; freshness detection, repair routing and auto-merge
  behaviour remain unchanged.
- Guidance helps repair agents replace stale claims but does not mechanically
  detect stale claims.

### Undiscoverable Facts

- None.

## Evidence

This is a backend and prompt-guidance change. The two regression tests exercise
the real `formatCiReport` and `buildRepairPrompt` functions.

## Test Plan

- Added
  `worker/deno/tests/pr_summary_ci_test.ts::formatCiReport - stale summaries must be rewritten for the head`.
- Added
  `worker/deno/tests/fleet_pr_babysitter_test.ts::every repair rewrites CI-checked per-PR summary claims for the pushed head`
  for failed-CI, review-change and merge-conflict repairs.
- Red check: restoring the old freshness text made the first test fail; its
  targeted file run reported 36 passed, 1 failed.
- Red check: restoring the old babysitter prompt made the second test fail; its
  targeted file run reported 115 passed, 1 failed.
- Final targeted tests:
  `deno task test:unit tests/pr_summary_ci_test.ts tests/fleet_pr_babysitter_test.ts`
  — 153 passed, 0 failed.
- `deno fmt --check` on the four changed Deno files — passed.
- `deno lint` on the four changed Deno files — passed.
- `deno check --frozen --lock=deno.lock` on the four changed Deno files —
  passed.
- Full quality gate: `./quality.sh < /dev/null` exceeded the 900-second bound in
  the Deno test stage and exited 124. Reported checks before that stage passed;
  config integration and Checkov were skipped by the gate.
  <!-- vibe-quality-gate-skipped reason="full ./quality.sh exceeded its 900s bound in the Deno test stage (exit 124); prior reported stages passed, config integration and Checkov were skipped by the gate; targeted format, lint, type check and affected tests passed" -->
- Removed from `worker/deno/tests/fleet_pr_babysitter_test.ts`:
  `assertStringIncludes(prompt, "in the same fix");`
  - Required by: "replace \"update it to cover your change in the same fix, so
    the pushed commit passes that gate\" with \"rewrite it in the same fix so
    every claim, count and result matches the pushed head, instead of adding a
    follow-up note beside the old text\"."
  - Replaced by:
    `assertStringIncludes(prompt, "rewrite it in the same fix so every claim, count and result matches the pushed head")`
    and
    `assertStringIncludes(prompt, "instead of adding a follow-up note beside the old text")`
    in the same test.
- Deno regression avoided: used the repository's Deno formatter, linter, checker
  and `test:unit` task; no Node tooling or dependencies were added.
- Related guidance checked: `CODING-STANDARDS.md`'s final-state summary rule and
  `prompts/pr_feedback/prompt.md`'s “Keep the PR summary true to the head” rule
  already require rewriting stale claims. Both agree with this change.
- Applied the revised guidance to this PR summary: claims and test results
  describe the committed head, and the summary does not append a follow-up
  block.
