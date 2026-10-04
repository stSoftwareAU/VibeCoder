## Summary

Adds the rule **"Vet every regex on untrusted text, one hostile case per
pattern"**, and fixes the sibling patterns that had the defect it describes.
Fleet PRs gave a hostile case only to the regex the author had in mind, and a
sibling regex in the same module shipped with the same quadratic backtracking
(VibeCoder#3085, #3160). Closes #3164.

- `CODING-STANDARDS.md` ("Unit tests") and
  `prompts/coding_guidelines/prompt.md` ("Unit Tests vs Benchmarks"): a new
  bullet, word for word identical on both surfaces. Every regex a change adds or
  edits that runs on untrusted or agent-written text is read for two quantifiers
  that can match the same characters with only optional tokens between them
  (`\s*:?\s*$`, `\s*[:\-–—]\s*(.+)$`, an unanchored `[.!\s]+$` or `\s+$`). The
  overlap is removed, and each pattern gets its own hostile case: a long run of
  the shared character followed by a character the pattern rejects.
- `prompts/pr_feedback/prompt.md` (Making Changes): a new **A backtracking
  finding covers every regex in the module** paragraph. Before pushing, check
  every other regex in the same module for the same shape, fix each one, and add
  a hostile case for each.
- `docs/workflows/issue-processing.md`: a paragraph recording the rule and its
  examples, next to the #3093 paragraph.
- Remediation of the instances listed in the issue comment, plus the siblings
  found by applying the new rule to those modules:
  - `\s*:?\s*$` → `\s*(?::\s*)?$` (the same language, with no overlap) in
    `ACCEPTANCE_HEADING_RE` and `ACCEPTED_SCOPE_HEADING_RE`
    (`acceptance_criteria_gate.ts`), `HEADING_RE` (`failure_detection_gate.ts`,
    `failure_detection_repair.ts`), `SPEC_HEADING_RE` and `STANDARDS_HEADING_RE`
    (`independent_review_gate.ts`), and `REPRODUCTION_HEADING_RE`
    (`reproduction_status_gate.ts`).
  - `BOLD_LABEL_RE` in both failure-detection modules had the same shape before
    its closing `**`: `\s*:?\s*\*\*` → `\s*(?::\s*)?\*\*`.
  - `applyFailureDetectionSection` stripped trailing whitespace with an
    unanchored `/\s+$/`, which restarts at every space of a run that a non-space
    then ends (about 17 s on the hostile body). It now calls `trimEnd()`, which
    strips the same characters.

## Spec

### Intent and Rationale

- "Guard super-linearity by behaviour first" explains how to write the test
  once a slow pattern is known. Nothing said to vet every pattern a PR adds, or
  named the shape to look for, so siblings went untested.

### Essential Design Decisions

- The standards bullet and the coding_guidelines bullet must stay word for word
  identical. The drift test asserts this, as it does for the #3093 rule.
- The heading fix keeps the matched language unchanged (`ws* [:]? ws*` before
  the end of the line), so no heading the parsers accepted before is refused
  now.
- The other overlapping-quantifier patterns in `issue_lifecycle.ts`,
  `milestone_partial_rollup.ts` and `planning_processor.ts` are not touched.
  This PR neither adds nor edits them, so the new rule does not cover them.

### Undiscoverable Facts

None.

## Evidence

This change has no UI.

Measured against the unfixed patterns, a heading plus 20 000 spaces plus `x`
cost 120–150 ms per line for each heading and bold-label pattern. At the 199 000
spaces used in the hostile cases, each one takes about a minute.

**Docs sweep** — grep: "Guard super-linearity", "backtrack", "quadratic",
`\s*:?\s*`; section: `docs/workflows/issue-processing.md` (the test-discipline
paragraphs, #3060/#3093/#3162); updated: `docs/workflows/issue-processing.md`.

## Test Plan

- Added `worker/deno/tests/heading_tail_redos_3164_test.ts` (10 tests, one per
  fixed pattern). Each feeds a near-miss line padded with 199 000 spaces and then
  `x`. It asserts that the line is not read as a heading and that a real heading
  after it is still found, and reads no clock.
  - With only the `worker/deno/lib/` changes reverted, each of the 10 tests, run
    alone with `timeout 12`, was killed (exit 124) without finishing.
  - With the changes restored, all 10 passed (`ok | 10 passed | 0 failed`, in
    about 16 ms).
- Added `worker/deno/tests/regex_vetting_rule_3164_docs_test.ts` (2 tests).
  - Before the doc and prompt edits, both failed (`FAILED | 0 passed | 2
    failed`), for example `AssertionError: Making Changes is missing the
    every-other-regex check`.
  - After the edits, both passed.
- The existing suites for the touched modules still pass:
  `acceptance_criteria_gate_test.ts`, `reproduction_status_gate_test.ts`,
  `failure_detection_repair_test.ts`, `failure_detection_repair_label_test.ts`,
  `independent_review_gate_test.ts`, `failure_detection_gate_test.ts`,
  `degraded_delivery_test.ts` and `closure_verdict_test.ts`. So do the related
  drift suites `new_test_must_go_red_3093_test.ts`,
  `coding_guidelines_twin_drift_test.ts` and
  `coding_guidelines_layers_2574_test.ts`. With the two new files, that run
  gave `ok | 199 passed | 0 failed`.
- `deno fmt --check`, `deno lint` and `deno check` on the touched files all
  pass. `markdownlint-cli2` on the touched Markdown reports nothing new. Its
  one finding, `CODING-STANDARDS.md` MD018 at `#1138).**`, is already on
  `main`.
- `./quality.sh`: every step that ran passed except `deno tests` (benchmark
  audit, chokepoints, completeness, source targets, mermaid, release-tag
  ruleset, deno fmt, lint and type check). `config integration`,
  `markdownlint` and `semgrep` were skipped because the tools are not
  installed. The full `deno tests` pass failed in this shared container,
  where several agents' suites ran at once. The full suite is left to CI: it
  gets OOM-killed when run in parallel here, and the real-git suites fail on
  the container's git 2.43.
- The test names avoid the word that the benchmark audit (#583) flags in
  `Deno.test` names. That word is why the first fleet attempt at this issue
  failed the gate.
