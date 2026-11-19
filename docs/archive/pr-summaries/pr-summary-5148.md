# PR Summary — Issue #5148

## Summary

Step 5 of the summary-rule recovery prompt (`buildSummaryRuleRetryPrompt` in
`worker/deno/lib/summary_rule_gate_retry.ts`) told the run that findings it
leaves "do not cost another turn". For a CODE FIX item, which is a Standards
`violation` left standing on the branch's own lines, that is false: fleet review
sends the PR back. When the prompt carries CODE FIX items, the sentence now
reads "Findings you leave are posted on the pull request and do not stop it, but
a CODE FIX item left standing sends it back at fleet review." No gate, check or
outcome changes. Closes #5148.

## Spec

### Intent and Rationale

- Eight PRs whose own Standards Review admitted an unfixed own-line breach were sent back at fleet review. The recovery turn had been told that leaving a finding was free, and it followed that sentence rather than the issue prompt's warning.
- Only the wording changes, as the issue asks. #4234's outcome stays: findings never stop the PR, and the PR stays armed.

### Essential Design Decisions

- The issue's replacement sentence is used only when the prompt carries standing violations (`standing.length > 0`, the same condition that builds the CODE FIX section). A prompt with no CODE FIX items gets just the first clause: "Findings you leave are posted on the pull request and do not stop it." Using the issue's sentence in every prompt would mention CODE FIX items to a turn that has none, and would break the #3382 contract that such a prompt never says "CODE FIX" (`worker/deno/tests/summary_rule_gate_retry_test.ts`, "without standing violations the documentary rule is unchanged").
- Neither variant still says "do not cost another turn", because the issue replaces that sentence everywhere.

### Undiscoverable Facts

- #5147 rewords a different sentence of the same prompt (the pre-PR verifier exception in step 2), so the two edits do not overlap.

## Evidence

This is a backend prompt-text change; there is no UI. Proof is
`worker/deno/tests/summary_rule_gate_retry_test.ts::summary-rule retry - step 5 says a standing CODE FIX item is sent back at fleet review, and never that findings are free (Issue #5148)`.
It asserts the new sentence when there are standing violations, the short
sentence when there are none, and that neither prompt says "do not cost another
turn". It failed before the library change (the old sentence was still in the
prompt) and passes after it.

Docs sweep: I grepped `README.md`, `docs/` (excluding `docs/archive/`),
`prompts/` and `worker/deno/` for `cost another turn` and
`do not stop the pull request`. The only hit was the line this PR changes. The
recovery-turn section of `docs/workflows/issue-processing.md` (the
"Issue #3382" paragraph) and `prompts/issue/prompt.md` near
`summary_rule_gate_retry.ts` say nothing the change makes false, so neither was
edited.

Issue numbers the diff adds: #5148: Rewrite the #3761 hand-back sentence
"findings you leave … do not cost another turn".

## Test Plan

- Added `worker/deno/tests/summary_rule_gate_retry_test.ts::summary-rule retry - step 5 says a standing CODE FIX item is sent back at fleet review, and never that findings are free (Issue #5148)`. It was observed red before the library change and green after.
- Existing tests in that file are unchanged and nothing was removed from them. The #3382 no-violation test, which asserts that `CODE FIX` is absent, still runs against the changed template and passes.
- `deno test --allow-all tests/summary_rule_gate_retry_test.ts` (from `worker/deno`): 22 passed, 0 failed.
- `deno fmt --check`, `deno lint` and `deno check` on both changed files: clean.
- `./quality.sh`: the first full run failed one unrelated test, `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`. Its cleared-environment `deno task` child tried to download `npm:commonmark` into an unwarmed cache. After `deno install --frozen` warmed the default cache, that file passed 11/11. The gate result from the re-run on the final head is recorded below.
