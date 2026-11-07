## Summary

Removed the claim that CI covers a gate skipped for budget from the text the
worker hands the agent, and from the docs it is drawn from. The skip note stays
mandatory and still says the worker runs the gate again before the PR is raised.
Wording only; no worker logic changed. Closes #4777.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- "CI runs the full gate on this PR" is true of VibeCoder's CI, not of every
  fleet repo; agents repeated it in their skip marker and reviewers sent PRs
  back. Removing the sentence (adding nothing in its place) is what the issue
  asks.

### Essential Design Decisions

- The `the worker runs the gate again before the PR is raised` half is kept: it
  is true of every repo (`phases/quality_gate_remediation_phase.ts`).
- Unrelated "left to CI" wording for milestone merge gates
  (`docs/CONFIGURATION.md` ~148, ~167, ~5178) describes different behaviour and
  is untouched.

### Undiscoverable Facts

- The issue's line numbers were stale; I located each sentence by text.

## Evidence

Backend wording and docs only; no UI. Changed:
`worker/deno/lib/quality_gate_budget.ts` (`formatQualityGateSkipNote`,
`buildQualityGateBudgetLines`, module comment), `prompts/issue/prompt.md`,
`prompts/spelling_fix/prompt.md`, `CODING-STANDARDS.md`, `docs/CONFIGURATION.md`
(including the mermaid node).
The configuration link in `CODING-STANDARDS.md` remains on one line so the
cross-file anchor sweep continues to check its target.

## Test Plan

- Added `worker/deno/tests/quality_gate_budget_test.ts` — "the skip note and
  prompt lines name no CI coverage (Issue #4777)": asserts neither text matches
  `\bCI\b` and both say the worker runs the gate again. Red with the old phrase
  restored in `formatQualityGateSkipNote`, green after.
- Edited expectation in the same file: "the skip note carries the marker and
  both figures" — `assertStringIncludes(note, "CI")` →
  `assertStringIncludes(note, "the worker runs the full gate again")`. Required
  by the issue ("drop 'CI runs the full gate on this PR, and'"); the new
  assertion goes red if the worker-gate sentence is dropped.
  - Removed from `worker/deno/tests/quality_gate_budget_test.ts`:
    `assertStringIncludes(note, "CI")`
    - Required by: "drop \"CI runs the full gate on this PR, and\""
    - Replaced by:
      `assertStringIncludes(note, "the worker runs the full gate again")`
- Run:
  `deno task test:unit tests/quality_gate_budget_test.ts tests/prompt_gate_instruction_check_test.ts tests/repo_config_test.ts tests/config_docs_consistency_test.ts`
  from `worker/deno` — 93 passed, 0 failed. Docs/anchor suites
  (`markdown_anchors_test.ts`, `cross_file_anchors_test.ts`,
  `markdown_code_spans_test.ts`, `markdown_logical_units_3356_test.ts`,
  `quality_gate_docs_consistency_test.ts`,
  `coding_standards_model_agnostic_test.ts`) — 105 passed, 0 failed.
  `deno fmt --check` and `deno lint` clean on the two changed `.ts` files.
- Related existing rules checked: `prompt_gate_instruction_check.ts` (no prompt
  hard-codes "run the gate before you push") — still passes.
- `worker/deno/tests/cross_file_anchors_test.ts` checks that the restored
  one-line configuration link resolves; `crossFileAnchorLinks` also finds the
  link in `CODING-STANDARDS.md`.

<!-- vibe-quality-gate-skipped required="186s" remaining="n/a" -->

Full `./quality.sh` was started in the foreground and killed by the 560 s tool
timeout before reporting, so it gave no verdict; the targeted checks above were
run instead and the worker runs the full gate again before the PR is raised.
