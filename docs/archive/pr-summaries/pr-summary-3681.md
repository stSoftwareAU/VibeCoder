# PR Summary — Issue #3681

## Summary

Closes #3681

Worker guidance now covers a tap control placed inside a row, card or tile that
is itself clickable. The control must sit above the container's link overlay,
and the browser check must tap it through real hit-testing, then assert that the
content was revealed and the URL did not change.

- `prompts/issue/prompt.md`: new paragraph **A control inside a clickable row
  must win the tap.** under Instructions rule 2, directly after **Measure
  overlays and pinned bars open.**
- `prompts/best_practices/buckets/html.md`: new visual anti-pattern check 16,
  **Control buried under a clickable container's overlay.**, next to check 15.
  The old checks 16, 17 and 18 become 17, 18 and 19.
- `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts`: the
  anti-pattern list cap `MAX_CHECKS` goes from 9 to 10 to make room for the new
  check.
- `worker/deno/tests/clickable_row_tap_3681_docs_test.ts`: a new drift test that
  pins both additions.

## Spec

### Intent and Rationale

- Two fleet PRs, from unrelated issues, added a control inside a list row whose
  whole area was a stretched-link overlay. The control had no stacking position
  of its own, so a real tap opened the detail page. Their tests checked only
  React handler bubbling, and a third PR's browser check used `element.click()`,
  which never hit-tests. The rule tells the worker to raise the control and to
  prove the tap lands on it.
- The wording follows the issue's proposed text. It adds two points: Playwright
  `locator.click()`/`tap()` must run without `force: true`, and the test asserts
  the behaviour, never the z-index value.

### Essential Design Decisions

- The new html check is inserted as check 16, next to check 15 as the issue
  asks, and the checks below it are renumbered. `bucket_check_numbering_test.ts`
  requires a gapless 1..N list.
- The anti-pattern cap is raised by exactly one, so the "keep it short" guard
  still holds the list to its current length.
- `CODING-STANDARDS.md` is not changed: the issue names only the two prompt
  files, and the sibling rule **Measure overlays and pinned bars open** has no
  restatement there either.

### Undiscoverable Facts

- The evidence comes from a private fleet repository, and the issue keeps it in
  the review host's log. No PR numbers are cited for that reason.

## Evidence

Prompt and test change only (no UI file touched); verified by the drift test and
the existing bucket-structure tests below.

The `force: true` and real-input claims rest on Playwright's actionability
documentation (<https://playwright.dev/docs/actionability>): `click()` and
`tap()` wait until the element "receives events", meaning it is the hit target
at the action point, and `force: true` skips that check.

Related existing rules checked: **Measure overlays and pinned bars open** and
**Check both sides of a breakpoint the issue names** (`prompts/issue/prompt.md`
rule 2, additive); **A style literal is incidental wherever it lives** (rule 2
and `CODING-STANDARDS.md` UI / PWA). The new rule says to assert the behaviour,
never the z-index value, so the two agree. **Every changed call site needs a
test that goes red without it** (`CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`) asks a UI control's test to invoke its
handler; the new rule says that handler test still stands and adds the
real-input tap on top. `CODING-STANDARDS.md` UI / PWA "never in the same
synchronous `page.evaluate` as the click" agrees with the new rule. Applied the
new rule to this PR's own diff and found nothing to fix: the diff touches no UI
file and adds no control.

**Docs sweep** — grep: "Measure overlays", "stretched\w*", `elementFromPoint`,
`dispatchEvent`, "Visual design anti-patterns", `MAX_CHECKS`; section:
`prompts/best_practices/buckets/html.md#visual-design-anti-patterns`; siblings:
"Open overlay or pinned bar off-screen", "Change leaking past its breakpoint";
updated: `prompts/issue/prompt.md`, `prompts/best_practices/buckets/html.md`; no
other hits outside `docs/archive/`.

## Test Plan

- Added `worker/deno/tests/clickable_row_tap_3681_docs_test.ts` (two tests).
  Each pinned phrase was checked with `deno task drift-pins-on-base
  origin/milestone/fleet-guidance-ui-breakpoints-and-tap-targets <doc> <section>
  <phrase>...`, which reported every one of the nine `Instructions` pins and the
  three `Visual design anti-patterns` pins as "absent on base".
- Edited `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts`:
  `MAX_CHECKS` 9 → 10. No assertion is removed. Red check: run with the cap put
  back to 9, "html bucket - carries a short design anti-pattern list" failed
  with `list must stay short (<= 9), got 10`; at 10 it passes, and an eleventh
  check would turn it red again.
- `deno task test:unit tests/clickable_row_tap_3681_docs_test.ts
  tests/front_end_design_anti_patterns_2636_test.ts
  tests/open_state_viewport_3335_docs_test.ts
  tests/breakpoint_sides_3656_docs_test.ts` — 13 passed, 0 failed.
- Bucket tests (`bucket_check_numbering_test.ts`, `bucket_docs_test.ts`,
  `best_practices_bucket_guides_consumer_test.ts`,
  `best_practices_bucket_picker_test.ts`, the anti-pattern test) — 71 passed, 0
  failed.

<!-- vibe-branch-outcomes -->

Not done: no browser evidence (the change is prompt text), and the issue's "How
to verify" step reads later review rounds, which cannot happen in this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
