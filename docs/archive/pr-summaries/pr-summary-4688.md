## Summary

Rewrote the "call the existing owner" guidance from #3084 so it applies to
tests, scripts and components as well as product code, dropped its Rust-only
remedy, and added the reconciliation rule that a test never computes its
expected result by calling the implementation it asserts. Closes #4688.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The old trigger ("something the product already does") and the `pub(crate)` →
  `pub` remedy let fleet PRs copy file-local test helpers, shell functions and
  UI components. The new bullet names product code, scripts and other test
  files, and gives a remedy that works in any language: export it or move it to
  a shared module, and switch the old callers.
- The search procedure ("grep for the domain term") and the trigger list were
  removed, as the issue proposes. The issue-prompt bullet goes from 13 lines to
  12 with the independent-oracle sentence added; the `pr_feedback` paragraph
  grows from 1 line to 8 and `CODING-STANDARDS.md` is +3/-2.

### Essential Design Decisions

- Per the issue's 3 November reconciliation, the rule keeps independent
  regression oracles: production code is the system under test and genuine test
  utilities and fixtures are shared, but an expected result is a literal value
  or an independent behavioural fixture, not a call to the implementation being
  asserted. The sentence is in the issue prompt, the `pr_feedback` prompt and
  `CODING-STANDARDS.md`.
- The two Spec-reviewer sentences (`prompts/issue/prompt.md` Independent Review
  section, `worker/deno/lib/issue_executor_agents.ts`) are unchanged, as the
  issue says.

### Undiscoverable Facts

- None.

## Evidence

- Files changed: `prompts/issue/prompt.md` (step 1 bullet),
  `prompts/pr_feedback/prompt.md` ("Making Changes" paragraph),
  `CODING-STANDARDS.md` (fourth over-engineering departure), `docs/PROMPTS.md`
  (pr_feedback row), `worker/deno/tests/reuse_existing_owner_3084_test.ts`.
- Related existing rules checked: **Change every copy of a twinned rule**, **A
  pin that names a value a module already holds is built from that module**, and
  **Do not hardcode to the tests** (`prompts/issue/prompt.md`,
  `CODING-STANDARDS.md`); the new oracle sentence agrees with each. Grep of
  `existing owner`, `widen its visibility`, `hand-made copy` outside
  `docs/archive` and `docs/audits` finds only the test file's header (history of
  #3084) and an unrelated "PR owner" comment in
  `worker/deno/tests/pr_maintenance_command_test.ts`.
- I applied the rule to this PR's own diff: the new test file copies no helper
  and takes its pins from the doc text it guards; nothing found.

## Test Plan

- Updated `worker/deno/tests/reuse_existing_owner_3084_test.ts` (5 tests kept):
  - issue Instructions: new pins for "call existing code — never copy it", the
    test-file/script scope, the export-or-share remedy, the independent
    expected-value sentence; absence checks for `widen its visibility`,
    `` `pub(crate)` → `pub` `` and the old trigger list.
  - `pr_feedback` Making Changes: same style of pins and absence check.
  - `CODING-STANDARDS.md` Coding Principles: new fourth-departure wording,
    independent-oracle clause and absence check.
  - Spec-reviewer brief and agent-prompt tests unchanged.
- Removed from `worker/deno/tests/reuse_existing_owner_3084_test.ts`: pins on
  "call the existing owner", "formats, orders, ranks, validates or decides",
  "every component or function the issue names", "implementation section",
  "widen its visibility", `` `pub(crate)` → `pub` ``, "replace the copy with a
  call to the owner", "re-implemented by hand instead of called". Required by:
  "This rewrite removes the trigger list that narrowed the prompt rule to
  product behaviour, and the Rust-only example." Replaced by: the new pins
  above, plus `still in …` absence assertions that keep the removed wording from
  returning.
- Red check: with the three docs restored to the base branch and the new test
  kept, `reuse_existing_owner_3084_test.ts` fails (AssertionError on the new
  pins); with the rewritten docs it passes (5 passed, 0 failed).
- Review follow-up red check: removing only the independent-oracle parenthetical
  from `CODING-STANDARDS.md` makes
  `worker/deno/tests/reuse_existing_owner_3084_test.ts::CODING-STANDARDS - the over-engineering checklist flags an in-repo helper copied by hand`
  fail on the missing clause; restoring it passes. The obsolete narrow reuse
  wording remains replaced, while independent expected results remain protected
  by this section-scoped test and the issue and feedback prompt tests above.
- Full `./quality.sh`: the foreground run was terminated by the tool before it
  printed a verdict, so there is no overall result.

<!-- vibe-quality-gate-skipped reason="foreground ./quality.sh was terminated (exit 143) before reporting; targeted test passed; CI runs the same checks" -->
