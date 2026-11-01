## Summary

The PR-feedback drift check's mutation-survivor recovery turn no longer tells
the agent to "change no production code". It now matches the sibling
`STEP_TWO_MUTATION_RULE` in `worker/deno/lib/summary_rule_gate_retry.ts`: kill
each survivor with a test; remove or fix a line the mutation shows is dead or
wrong; record `exempt (untestable)` only for a line production can reach but a
test cannot stage. Closes #4594.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The old prompt left an unreachable survivor only one outcome, an exemption,
  which CODING-STANDARDS forbids ("An outcome no input can reach is dead code:
  remove it, never exempt it"). The fix reuses the wording the summary-rule
  prompt already carries rather than adding a new rule.

### Essential Design Decisions

- No code enforces "no production code" after the recovery turn
  (`runPrFeedbackDriftCheck` only re-runs its checks), so rewording the prompt
  is the whole code change.

### Undiscoverable Facts

- None.

## Evidence

Backend prompt text only. `buildDriftRecoveryPrompt` in
`worker/deno/lib/pr_feedback_drift_check.ts` rewrites the two mutation steps
and the `mutationGateComment` doc comment. Docs updated:
`docs/mutation-check.md` (Review-fix runs "Recovery" paragraph and the mermaid
node) and `docs/workflows/pr-feedback.md` (item 6 and the recovery paragraph).
`docs/` (excluding the archive), `README.md`, `CODING-STANDARDS.md`,
`DESIGN-PRINCIPLES.md` and `prompts/` were swept for `no production code`,
`never production code` and `tests only`; remaining hits are unrelated senses.
Related existing rules checked: `STEP_TWO_MUTATION_RULE`
(`summary_rule_gate_retry.ts`), `CODING-STANDARDS.md` dead-code rule,
`prompts/issue/prompt.md` and `prompts/pr_feedback/prompt.md`; the new prompt
agrees with each.

Not changed: `docs/mutation-check.md` L50-55 describes the PR-raise recovery
prompt and says an exemption is "reserved for a line no test can reach"; that
is a different prompt and outside this issue.

## Test Plan

- Edited `worker/deno/tests/pr_feedback_drift_check_3750_test.ts`:
  - Removed from `worker/deno/tests/pr_feedback_drift_check_3750_test.ts`:
    `assertStringIncludes(calls[1]!.prompt, "Change no production code");`
    - Required by: "Replace \"Change no production code\" with the same limit
      the summary-rule prompt uses"
    - Replaced by: `assertStringIncludes(calls[1]!.prompt, "Change production code only where a listed mutation shows the line is dead or wrong")`
  - Removed from `worker/deno/tests/pr_feedback_drift_check_3750_test.ts`:
    `assertStringIncludes(prompt, "Change no production code");`
    - Required by: "Replace \"Change no production code\" with the same limit
      the summary-rule prompt uses"
    - Replaced by: the same four-phrase block (`no input can reach it`,
      `remove or fix that line`, `only for a line production can reach but a test cannot stage`, and the limit above) plus `!prompt.includes("Change no production code")`
  - Removed from `worker/deno/tests/pr_feedback_drift_check_3750_test.ts`:
    `assert(!prompt.includes("Change no production code"));` (no-survivors test)
    - Moved to: same file, now `!prompt.includes("Change production code only")`
      (the old phrase no longer exists, so the old check would be vacuous; the
      survivors test asserts its absence).
  - Test title "test-only wording" renamed to "tests-first wording".
- Red check: with the new assertions and the unfixed lib, the file failed
  (`FAILED | 9 passed | 2 failed`, first failure at L274: prompt lacks "Change
  production code only where a listed mutation shows the line is dead or
  wrong"). After the lib edit:
  `deno task test:unit tests/pr_feedback_drift_check_3750_test.ts`: 11 passed,
  0 failed.
- `deno fmt --check`, `deno lint`, `deno check` on the two `.ts` files: clean.
- Callers of `buildDriftRecoveryPrompt` checked: `runPrFeedbackDriftCheck`
  (passes `mutationGateComment` only when survivors exist; covered by the
  recovery-turn tests in the same file).

<!-- vibe-quality-gate-skipped reason="`./quality.sh` takes about 15 minutes and was not run; targeted checks above passed. CI runs the full gate." -->
