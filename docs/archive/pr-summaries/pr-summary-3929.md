## Summary

Rewords the gate-over-text rule so it covers matchers over config and CI
workflow files, not only Markdown corpora, and makes the issue prompt's bullet
usable in fleet repos that have no `CODING-STANDARDS.md` section of that name.
Documentation and prompt text only; no worker code changed. Closes #3929.

- `CODING-STANDARDS.md` → **Writing a gate over text**: the trigger now reads
  "any text a matcher reads", including config or CI workflow files (YAML, JSON,
  TOML); the evasion table gains the YAML layouts (`run: |` block, multi-line
  comment block, `- name:` before `uses:`); the corpus run names the policed
  files, at base and at head, as the first corpus.
- `prompts/issue/prompt.md` → the gate-over-text bullet links VibeCoder's
  section by URL and inlines the "re-wrapped across lines" variant and the
  base-branch corpus run.
- `worker/deno/tests/text_gate_matcher_3149_test.ts`: two new pin tests for the
  reworded text, and the file's header comment extended to mention Issue #3929.

Version bump: no `VERSION` change; the change is documentation and prompt text.

## Test Plan

- Removed from `worker/deno/tests/text_gate_matcher_3149_test.ts`: no assertion.
  The only removed line is the header comment fragment ` * neutralisation.`, which
  was reworded into a longer sentence that continues the same paragraph (the
  paragraph now ends "...than VibeCoder."). No `assert*` call, test or fixture was
  removed, weakened or skipped.
- Added: `CODING-STANDARDS.md Writing a gate over text covers config and CI workflow files and the policed-files corpus (Issue #3929)` and `issue prompt gate-over-text bullet is self-contained for repos other than VibeCoder (Issue #3929)`, which pin the new wording in both files.
- `deno test -A tests/text_gate_matcher_3149_test.ts`: 8 passed, 0 failed.
