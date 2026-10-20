# PR Summary — Issue #3656

## Summary

Closes #3656

Worker guidance now covers a UI change that the issue confines to one side of a
width breakpoint. Every new rule, class, wrapper and event handler is scoped to
that range. The browser check measures the protected side at the breakpoint
itself and at a device width just past it, and the changed side just inside it.

- `prompts/issue/prompt.md`: new paragraph **Check both sides of a breakpoint
  the issue names.** under Instructions rule 2, directly after **Measure
  overlays and pinned bars open.**
- `CODING-STANDARDS.md`: the same rule at the end of the **Choosing assertions
  → UI / PWA** bullet.
- `prompts/best_practices/buckets/html.md`: new visual anti-pattern check 15,
  **Change leaking past its breakpoint.**, next to check 14. The old checks 15,
  16 and 17 become 16, 17 and 18.
- `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts`: the
  anti-pattern list cap `MAX_CHECKS` goes from 8 to 9 to make room for the new
  check.
- `worker/deno/tests/breakpoint_sides_3656_docs_test.ts`: a new drift test that
  pins all three additions.

## Spec

### Intent and Rationale

- Two fleet PRs, from different issues, leaked a change past the breakpoint the
  issue named. One was a CSS padding rule and wrapper; the other was a pointer
  handler. In both PRs the browser check measured only a far desktop width or
  only the changed side. The rule tells the worker to scope the change in code
  and to measure where a leak first shows, at the boundary widths.
- The wording follows the guidance proposed in the issue. It adds two things
  taken from the issue's evidence: drive the interaction the change adds (hover
  as well as click), and the 767 example for the changed side.

### Essential Design Decisions

- The new html check is inserted as check 15, next to check 14 as the issue
  asks, and the checks below it are renumbered. `bucket_check_numbering_test.ts`
  requires a gapless 1..N list.
- The anti-pattern cap is raised by exactly one, so the "keep it short" guard
  still holds the list to its current length.

### Undiscoverable Facts

- The evidence comes from two private fleet repositories, and the issue keeps it
  in the review host's log. No PR numbers are cited for that reason.

## Evidence

Prompt, standards and docs change only (no UI file touched); verified by the
drift test and the existing bucket-structure tests below.

The widths in the rule (767, 768, 820) are viewport sizes a test sets, not
expected values. The style-literal rule (`prompts/issue/prompt.md` rule 2 and
`CODING-STANDARDS.md` UI / PWA) governs expected values, so the two rules agree.
The rule asks for assertions on behaviour ("the same rows, the same boxes, no
reflow on hover").

Related existing rules checked: **Measure overlays and pinned bars open**
(`prompts/issue/prompt.md` rule 2, an additive set of sizes); **A style literal
is incidental wherever it lives** (rule 2 and `CODING-STANDARDS.md` UI / PWA,
which covers expected values only); the stylesheet-regex rule (the new rule
calls for a rendered browser check, never a stylesheet grep); and
`prompts/test_audit/prompt.md` brittle pixel assertions (no conflict). Applied
the new rule to this PR's own diff and found nothing to fix: the diff touches no
UI file.

**Docs sweep** — grep: "Measure overlays", `390x844`, "breakpoint\w*",
`matchMedia`, "Visual design anti-patterns"; section:
`prompts/best_practices/buckets/html.md#visual-design-anti-patterns`; siblings:
"Open overlay or pinned bar off-screen", "Zoom blocked or layout fixed-width";
updated: `prompts/issue/prompt.md`, `CODING-STANDARDS.md`,
`prompts/best_practices/buckets/html.md`; `prompts/issue/prompt.md:1578` — still
true because the "tablet breakpoint" line is an illustrative closure example,
not a rule.

## Test Plan

- `worker/deno/tests/breakpoint_sides_3656_docs_test.ts` (new) pins the rule in
  `prompts/issue/prompt.md` § Instructions, in `CODING-STANDARDS.md` § Choosing
  assertions, and the new check in `prompts/best_practices/buckets/html.md`
  § Visual design anti-patterns.
  - `deno task drift-pins-on-base origin/milestone/fleet-guidance-ui-breakpoints-and-tap-targets …`
    reported `absent on base` for all 12 pinned phrases in their sections:
    six in Instructions, four in Choosing assertions, two in Visual design
    anti-patterns.
- `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts`: `MAX_CHECKS`
  goes from 8 to 9. The issue asks to "add a matching visual check next to check
  14", which makes 9 checks. No assertion is removed. The length guard still
  goes red when the list grows: at the old cap, the 9 checks fail
  `checks.length <= MAX_CHECKS`, and a tenth check would fail the new cap.
- `deno task test:unit tests/breakpoint_sides_3656_docs_test.ts tests/open_state_viewport_3335_docs_test.ts tests/front_end_design_anti_patterns_2636_test.ts tests/bucket_check_numbering_test.ts`
  ran in `worker/deno`: 21 passed, 0 failed.
- `markdownlint-cli2` on the three edited Markdown files reported 0 issues.
- `./quality.sh` ran on the final head: see the result line below.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
