## Summary

Fleet UI PRs kept backing layout claims with a unit test that regex-matches
the text of `app.css`. The guidance now says, in each place the worker and
reviewers read, that such a test is a source-text grep and not a layout test,
and that a layout, cascade, overflow, clipping or position claim needs a
headless-browser check that measures rendered boxes. Closes #3247.

- `prompts/issue/prompt.md` rule 2 (UI/PWA sentence): a test that reads a
  `.css`/`.scss` file and matches selectors or property values is a
  source-text grep, even where appearance is the stated contract. A layout
  claim needs a browser check that measures rendered boxes, and that check
  must itself be run, per the existing Error Recovery rule. Where there is no
  browser harness, the Test Plan names the gap.
- The PR-summary skeleton's Reproduction example now uses a browser-measured
  regression test (`e2e/buttons.spec.ts::the buttons' rects share one row at
  375px`), so a CSS-text flip no longer reads as the model red run.
- `CODING-STANDARDS.md` § Choosing assertions, UI / PWA bullet: one sentence
  stating the same rule, cross-referencing TDD rule 5.
- `prompts/test_audit/prompt.md` check 2: a "Stylesheets are source code"
  paragraph so the idle audit flags existing CSS-text tests.
  `docs/TEST-AUDIT-SCAN.md` row 2 mirrors it.

## Spec

### Intent and Rationale

- The existing rules ("avoid exact CSS/DOM assertions", the TypeScript-grep
  "Bad" example) never said a stylesheet regex *is* a source grep, so agents
  treated CSS as behaviour and the regex as a test of it.
- Guidance, not a gate: whether a test proves layout depends on the claim it
  backs, which a text matcher cannot judge.

### Essential Design Decisions

- The rule applies "even where appearance is the stated contract", so the
  existing "unless explicitly required" / "unless … a stated contract"
  carve-outs cannot be read as licensing a stylesheet regex.
- No-harness repos record the gap in the Test Plan rather than substituting a
  regex, keeping the failure visible.

### Undiscoverable Facts

- The three cited PRs are GRQ-AutoTrader#2213, #2231 and #2596; in #2231 the
  real bugs were found only by rendering in headless Chromium.

## Evidence

Docs/prompt-only change plus a documentation-drift test; no UI file touched.

**Docs sweep** — grep: "avoid exact CSS", "Avoid exact CSS values",
"Source-text grep\w*", "source-text grep\w*", `button.test.js`, `flex-wrap`,
"Brittle UI"; section: `docs/TEST-AUDIT-SCAN.md` (audit-check table, row 2);
updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`,
`prompts/test_audit/prompt.md`, `docs/TEST-AUDIT-SCAN.md`;
`DESIGN-PRINCIPLES.md:1709` — still true because it only names check 2 by
title; `prompts/test_audit/prompt.md:341` (Brittle UI assertions, check 1) —
still true because it covers CSS values asserted in rendered UI, while
stylesheet text is now flagged under check 2;
`prompts/coding_guidelines/prompt.md:1113` — still true because "avoid pinning
incidental CSS" agrees with the new rule; `prompts/issue/prompt.md` Docs sweep
example line (`flex-wrap` grep) — still true because it is the example's own
docs sweep, not a test.

Related existing rules checked: issue prompt rule 1 (no source-grep tests),
rule 2 ("avoid exact CSS/DOM assertions unless explicitly required"), Error
Recovery 3 ("A browser check you did not run is not a safety net");
CODING-STANDARDS TDD rule 5 and § Documentation-drift tests, § Choosing
assertions UI / PWA bullet ("unless … a stated contract"); test_audit check 1
(Brittle UI assertions) and the check 2 documentation-drift exemption. The new
rule agrees with each; the "explicitly required" carve-outs are addressed by
"even where appearance is the stated contract".

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `prompts/issue/prompt.md` rule 2 (UI/PWA sentence): add that a test which reads a `.css`/`.scss` file and matches selectors or property values is a source-text grep, not a layout test — evidence: `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` — reviewer: met — reason: the reviewer's wording defect ("run as … under Error Recovery says") was reworded in this diff
- **met** — CODING-STANDARDS.md § Choosing assertions, UI bullet: say the same in one sentence, so the reviewer and the worker share the rule — evidence: `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` — reviewer: met
- **met** — `prompts/test_audit/prompt.md` check 2 (Source-text greps used as assertions): name stylesheets explicitly, so the idle audit flags existing CSS-text tests — evidence: `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` — reviewer: met
- **met** — Optionally, make the Reproduction example's regression test plainly a browser-measured one — evidence: `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` — reviewer: met
- **unrequested** — `docs/TEST-AUDIT-SCAN.md` row 2 mentions stylesheets — reviewer: unrequested — reason: the manual documents check 2, so the docs-sweep rule requires it to match the prompt change
- **unrequested** — new documentation-drift test pinning the four surfaces — reviewer: unrequested — reason: the reviewer noted it is standard repo practice; it keeps the guidance from being silently dropped

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no violations; checked named-test existence, Documentation-drift test conditions 1–4 (section-scoped `flat(section(...))`, review-only rule against local whitespace helpers, pins absent on base), Extend a module's existing imports (review-only), Check where you insert (review-only; both insertion points), Australian English, cross-reference accuracy (TDD rule 5, Error Recovery rule). Optional note on the garbled Error Recovery clause was reworded in this diff. No assertions removed from existing tests.

## Test Plan

- Added `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` — four
  section-scoped drift pins (issue prompt Instructions and PR Summary File,
  CODING-STANDARDS Choosing assertions, test_audit check 2). Passes on head
  (`deno test -A tests/stylesheet_regex_layout_3247_docs_test.ts`: 4 passed).
- Every pinned phrase reported `absent on base` by
  `deno task drift-pins-on-base origin/main <doc> <section> <phrase>...`, so
  each pin goes red against the base text.
- Re-ran neighbouring docs tests
  (`ui_assertion_closed_state_3250_test.ts`, `documentation_drift_policy_test.ts`,
  `issue_prompt_spec_section_docs_test.ts`, `test_audit_template_test.ts`,
  `test_audit_prompt_v12_test.ts`): 39 passed.
- No existing test edited; no assertions removed.
- `./quality.sh` — QUALITY_RESULT

**Branch outcomes:** none added
