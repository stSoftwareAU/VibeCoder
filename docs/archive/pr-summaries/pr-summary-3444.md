## Summary

After #3247, fleet UI tests stopped grepping stylesheets but still pinned exact
style values wherever they lived: a chart options callback's `rgba(...)`
gridline colour, or a computed `max-height` compared with the stylesheet's
`calc(...)` string. The guidance now defines an incidental style literal by its
**kind of value**, not by the file it is in, adds a self-review step for every
assertion on one, and has review-fix runs **remove** the literal rather than add
a check beside it. Closes #3444.

- `CODING-STANDARDS.md` § Choosing assertions → UI / PWA, and
  `prompts/issue/prompt.md` Instructions rule 2: "A style literal is incidental
  wherever it lives." An exact colour, length, `calc()`/`min()` expression, font,
  z-index, class name or similar is incidental in a stylesheet, a TS/JS options
  object (chart/theme config, inline `style` prop) or a computed style read
  (`getComputedStyle`, `toHaveCSS`), and is never a test's expected value unless
  the issue names it. Before raising the PR, each such assertion either quotes
  the issue sentence that names the value in the Test Plan, or is replaced by the
  behaviour it stands for (not transparent, differs from the off state, the
  panel's box ends above the bar's top, the element is within the viewport).
- `prompts/pr_feedback/prompt.md` § Making Changes: "A replaced style literal is
  removed, not joined." When a review asks for a style-literal assertion to be
  replaced with a behavioural or geometric check, the push deletes the literal,
  a check added beside it does not fix the finding, and `.pr_response_message`
  cites the removed lines.

## Spec

### Intent and Rationale

- The old wording ("exact CSS values", "exact CSS/DOM assertions") was read as
  "something in a stylesheet", so literals in TS config or computed styles looked
  uncovered; naming the kind of value and the three places it lives closes that
  reading
- The pr_feedback rule targets the re-review failure the issue reports: the
  literal survived a fix push because a geometric check was added next to it

### Essential Design Decisions

- The exception is "the issue names that value"; visual snapshots remain
  allowed where appearance is the contract and the baseline is reviewable
- Semantic state is carved out (an `aria-*` attribute, or the open-only class
  the existing closed-state guidance asserts absent) so the new class-name rule
  does not contradict that guidance a few lines below it

### Undiscoverable Facts

- The two incidents are in private fleet repos; the evidence stays in the
  review-fleet-prs host's log, per the issue

## Evidence

Purely prompt/standards text plus a documentation-drift test; no UI file is
touched.

- `worker/deno/tests/style_literal_assertions_3444_docs_test.ts` pins the new
  rule in each of the three sections (section-scoped `assertPins`).
- Red run against the base text (`git checkout
  origin/milestone/fleet-guidance-issue-and-feedback-prompts -- CODING-STANDARDS.md
  prompts/issue/prompt.md prompts/pr_feedback/prompt.md`): `FAILED | 0 passed |
  3 failed`, e.g. `section is missing pin "A replaced style literal is removed,
  not joined"`. Green at the head.
- Provenance cited in the diff: #3444: Fleet UI tests still pin exact style
  values outside stylesheets: colours in TS chart config, calc() strings from
  computed style (two private fleet PRs, after #3247); #3247: Fleet UI PRs test
  layout by regex over the stylesheet's text instead of a browser check
  (GRQ-AutoTrader2213, 2231, 2596).
- Related existing rules checked: `CODING-STANDARDS.md` Choosing assertions
  (stylesheet-regex sentence and the closed-state `visually-hidden` sentence —
  carved out as semantic state), `prompts/issue/prompt.md` rule 2 (#3247
  stylesheet paragraph, #3335 open-state measuring), `prompts/pr_feedback/prompt.md`
  Making Changes opening paragraph (document a test change and its remaining
  coverage — the new rule defers to it), `prompts/test_audit/prompt.md`
  "Brittle UI assertions" (consistent: it already flags exact CSS values, pixel
  dimensions and class names), `prompts/coding_guidelines/prompt.md` ("Avoid
  pinning incidental CSS, DOM or private code" — consistent).
- Applied the new rule to this PR's own diff: the only test added pins prose
  phrases, not style values; the `rgba(...)`/`calc(...)` mentions are
  descriptions of the anti-pattern, not assertions. Nothing found.

**Docs sweep** — grep: "exact CSS", "CSS/DOM", "class names", "style literal",
`toHaveCSS`, `getComputedStyle`; section: `CODING-STANDARDS.md#choosing-assertions`;
updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`,
`prompts/pr_feedback/prompt.md`; `prompts/test_audit/prompt.md:341` — still true
because it flags exact CSS values, pixel dimensions and class names when a
restyle could change them, which the new rule agrees with; `docs/TEST-AUDIT-SCAN.md:127`
— still true for the same reason (it describes the test-audit scan, which this PR
does not change); `docs/workflows/pr-feedback.md` — documents a subset of the
pr_feedback rules (no subsection for neighbouring rules such as the browser-check
or backtracking ones), so no sentence there is made false

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `CODING-STANDARDS.md` (Choosing assertions → UI / PWA) and `prompts/issue/prompt.md` rule 2: define the rule by the *kind of value*, not by the file it lives in — evidence: `worker/deno/tests/style_literal_assertions_3444_docs_test.ts::CODING-STANDARDS.md Choosing assertions defines a style literal by its kind of value (Issue #3444)` and `::prompts/issue/prompt.md Instructions defines a style literal by its kind of value (Issue #3444)` — reviewer: met
- **met** — Add a self-review step to the same rule: for every new or edited assertion whose expected value is a style literal, either quote the issue sentence that names it, or replace it with the behaviour it stands for — evidence: `CODING-STANDARDS.md` Choosing assertions and `prompts/issue/prompt.md` rule 2, pinned by "quote the issue sentence that names it in the Test Plan" and "replace the literal with the behaviour it stands for" in `worker/deno/tests/style_literal_assertions_3444_docs_test.ts` — reviewer: met
- **met** — `prompts/pr_feedback/prompt.md`: when a review asks for a style-literal assertion to be replaced with a behavioural or geometric check, the fix push removes the literal. A new check added next to the literal does not count, and the reply cites the removed lines — evidence: `worker/deno/tests/style_literal_assertions_3444_docs_test.ts::prompts/pr_feedback/prompt.md Making Changes removes a replaced style literal (Issue #3444)` — reviewer: met
- **unrequested** — semantic-state carve-out (`aria-*` attribute, open-only class) in both rule texts — reviewer: unrequested — reason: keeps the new class-name rule from contradicting the existing closed-state guidance in Choosing assertions, as the conflicting-rules standard requires
- **unrequested** — the two incident examples (`rgba(...)` gridline, computed `max-height` vs `calc(...)`) in `prompts/issue/prompt.md` — reviewer: unrequested — reason: they are the two cases from the issue, showing the agent what "wherever it lives" covers
- **unrequested** — new drift test `worker/deno/tests/style_literal_assertions_3444_docs_test.ts` — reviewer: unrequested — reason: repository convention pins prompt/standards rules with a documentation-drift test so a later edit cannot silently drop them
- **unrequested** — pr_feedback paragraph also asks to document the test change and its remaining coverage, and points to `CODING-STANDARDS.md` — reviewer: unrequested — reason: aligns the new rule with the section's existing opening paragraph rather than adding a second, divergent instruction

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — cross-document agreement of the rule text across the three files; the pr_feedback cross-reference resolves; "closed-state check below" points at the existing open-only-class guidance; consistent with `prompts/test_audit/prompt.md` "Brittle UI assertions"; drift-test conventions (section-scoped pins, no subsumed pins, every pin in added text); Australian English; no named-but-absent test; no stubs; no workflow changes; review-enforced rules checked against the added lines, none breached. Optional notes: `prompts/test_audit/prompt.md:341` and `docs/TEST-AUDIT-SCAN.md:127` do not yet mention TS-config or computed-style literals (a drift risk, not a contradiction; out of this issue's three named files).

## Test Plan

- Added `worker/deno/tests/style_literal_assertions_3444_docs_test.ts` (3 tests).
- `deno task test:unit tests/style_literal_assertions_3444_docs_test.ts tests/stylesheet_regex_layout_3247_docs_test.ts tests/pr_feedback_every_ask_3348_docs_test.ts tests/open_state_viewport_3335_docs_test.ts tests/ui_assertion_closed_state_3250_test.ts` (from `worker/deno`): `ok | 13 passed | 0 failed`.
- Red run: with the three docs restored to the base branch, the new test reports `FAILED | 0 passed | 3 failed`.
- Pinned phrases absent from base: `deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts <doc> <section> <pins…>` printed `absent on base` for every pin in `CODING-STANDARDS.md` § Choosing assertions, `prompts/issue/prompt.md` § Instructions and `prompts/pr_feedback/prompt.md` § Making Changes.
- Removed assertions: none — the diff edits no existing test.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)` — `config integration` SKIPPED, every other stage PASSED.

Branch outcomes: none added
