# PR Summary — Issue #3335

## Summary

Closes #3335

Worker guidance now says to measure popovers, menus, in-place confirm panels and
sticky or fixed bars **in their open state**, at both a phone portrait size and a
short landscape size, against all four viewport edges and every fixed bar.

- `prompts/issue/prompt.md` — new paragraph **Measure overlays and pinned bars
  open.** under Instructions item 2 (testing rule 2, the headless-browser
  "rendered boxes" paragraph).
- `prompts/best_practices/buckets/html.md` — new visual anti-pattern check 15
  **Open overlay or pinned bar off-screen.**, next to the reflow check; the old
  checks 15 and 16 become 16 and 17.
- `worker/deno/tests/open_state_viewport_3335_docs_test.ts` — drift test that
  pins both additions.

## Spec

### Intent and Rationale

UI PRs kept passing review with a closed-state or single-size layout check while
the open content ran off-screen. The guidance now names the open state, both
sizes, all four edges and the fixed bars, so the check that runs is the one that
would have caught those faults.

### Essential Design Decisions

- One paragraph in the existing testing rule 2, not a new rule — it narrows how
  that rule's browser check is run, so it belongs beside it.
- The html bucket stays at the anti-pattern cap of 8 checks
  (`MAX_CHECKS` in `front_end_design_anti_patterns_2636_test.ts`), so the new
  check follows the reflow check and later checks are renumbered rather than
  added past the cap.
- WCAG 2.2 Reflow (1.4.10) and Focus Not Obscured (Minimum) (2.4.11) are cited
  as the bar, so the rule rests on a public standard, not on taste.

### Undiscoverable Facts

The three faults behind the issue (GRQ-AutoTrader#2231, #2729, #2596): a
`text-nowrap` popover about 545px wide reached x=674 at a 390px viewport; a
sticky header holding a confirm panel grew to 486px at 844x390; and a check
measured only the top and bottom edges.

## Evidence

The change touches Markdown prompts and a Deno test only — no rendered surface,
so there is no screenshot.

Docs sweep: grepped `rendered boxes`, `visually-hidden`, `Reflow`, `reflow` and
`checks 10` across `prompts/`, `docs/`, `CODING-STANDARDS.md` and `README.md`.
Remaining hits stay true: `CODING-STANDARDS.md:695` (Choosing assertions —
headless-browser check of rendered boxes, consistent with the new paragraph);
`prompts/test_audit/prompt.md:368` (layout assertions belong in a browser check —
consistent); `docs/archive/pr-summaries/pr-summary-2636.md` ("checks 10–16" is a
historical archive and true for its time).

## Test Plan

- [x] `deno task test:unit tests/open_state_viewport_3335_docs_test.ts
  tests/front_end_design_anti_patterns_2636_test.ts` plus the 3247 and
  bucket-check-numbering tests — 22 passed, 0 failed.
- [x] Each pinned phrase is absent from the base section
  (`deno task drift-pins-on-base origin/main <doc> <section> <phrases…>`, all
  reported "absent on base"), so the new test goes red without the change:
  - `prompts/issue/prompt.md` § Instructions: "Measure overlays and pinned bars
    open", "at a short landscape height", "on all four edges", "clear of every
    fixed bar", "must unpin while open".
  - `prompts/best_practices/buckets/html.md` § Visual design anti-patterns:
    "Open overlay or pinned bar off-screen", "focus-not-obscured-minimum".
- [x] `deno fmt --check` and markdownlint clean.
- [x] `./quality.sh < /dev/null` passes.

Branch outcomes: none added

## Related existing rules checked

None conflict with the new rule:

- `CODING-STANDARDS.md:695` — Choosing assertions (headless-browser check that
  measures rendered boxes; the closed-state `visually-hidden` rule).
- `prompts/test_audit/prompt.md:368` — layout belongs in a browser check.
- `prompts/issue/prompt.md` testing rule 2 paragraph (the new paragraph extends
  it) and the UI-changes screenshot section.

Applied the new rule to this PR's own diff: the diff changes no popover, panel
or pinned bar (Markdown and a Deno test only), so it flags nothing.
