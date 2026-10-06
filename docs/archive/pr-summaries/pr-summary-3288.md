## Summary

The branch-outcomes gate checked only the shape of a `Branch outcomes:`
entry, never its words. An entry could therefore name `path:line` and an
outcome while admitting that no test reaches it, and the PR was still raised
(GRQ-AutoTrader#2682, VibeCoder#3282). The gate now also blocks an entry
that admits its outcome is unreached. The only exception is an entry written
`exempt (out of scope): <reason>` or `exempt (untestable): <reason>` with a
reason of at least three words. The rule is added to `CODING-STANDARDS.md`,
the coding guidelines, and the issue and pr_feedback prompts. Closes #3288.

- Strong admissions block whatever else the entry says: "no test reaches",
  "covers" or "exercises" it, "not reached by any test", and a negation
  directly governing a go/turn verb ("never went red", "did not go red").
- Weak admissions ("unreached", "untested", "unreachable", "stayed green",
  "left … the suite green") block only when the entry names no test-file
  path and records no red flip.
- Text inside backticks is not read as the entry's own prose. A span with
  `::` is kept only up to the `::`, and any other span containing
  whitespace is blanked, so a quoted test name or command cannot trip the
  check.
- Lines the list parser skips (table rows, prose after the list, entries
  past the 100-entry cap, text cut by the entry-length cap) are collected as
  `uncapturedLines` and checked as well.
- PR #3312 review: backtick pairing now carries across a hard-wrapped line
  break (resetting at blank lines) instead of re-pairing from scratch on
  every raw line, so a span opened on one line and closed on the next still
  blanks a wrapped test name, and still leaves a wrapped admission readable
  as the entry's own prose.
- PR #3312 review: a red flip is no longer credited from a bare `red`
  elsewhere in the sentence. A direct negation with no verb between ("not
  red", "never red"), an "instead of … red" contrast, a "needs/should … red"
  ask, and a stated future obligation ("red is still to add") are now also
  treated as recording no red flip.
- PR #3312 review: a `` `Branch outcomes:` `` header written entirely inside
  backticks is found by the unblanked parse (which tolerates decoration) but
  vanishes once code spans are blanked for the admission check (the span
  contains a space). The gate now fails closed on that mismatch instead of
  silently skipping the admission check.

**Docs sweep** — grep: `branch-outcomes gate`, `Branch outcomes`,
`branch_outcomes_gate`, `scanRegionText`, `uncapturedLines`,
`unreachedEntries`, `BranchOutcomesGateResult`; section:
`docs/workflows/issue-processing.md` ("The gate." paragraph of the
branch-outcomes gate section); updated: `docs/workflows/issue-processing.md`,
`CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`,
`prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`. The other
hits in `docs/workflows/issue-processing.md` (lines 1549, 1853, 1917, 2030,
2126 and 2326) only list the gate among the summary-rule gates or describe
the pr_feedback refresh. I read each one, and each is still true.
`README.md`, `DESIGN-PRINCIPLES.md`, `SECURITY.md`, the other `docs/`
manuals and every `*/README.md` have no hits. `scanRegionText` is a private
helper renamed to `scanRegion`, and no doc names it.

## Test Plan

- Added to `worker/deno/tests/branch_outcomes_gate_test.ts`: the GRQ-shape
  admission (blocks and names the label), the same input with the admission
  replaced (valid), a mixed list, 13 evasion variants, the continuation-line,
  table-row, after-`none added.`, inline-body and 101st-entry admissions,
  corpus look-alikes from `docs/archive/pr-summaries/` (valid), code-span
  blanking cases, the four exemption cases, the gate-comment exempt clause,
  and six linear-scaling tests over hostile input.
- PR #3312 review — added to `worker/deno/tests/branch_outcomes_gate_test.ts`:
  an admission past the entry-length cap on a single-line entry and on a
  continuation line (each still blocks), a `path::name` span whose name has
  spaces staying valid, an 80-character fallback label ending `…`, a
  backtick span wrapped onto the next line (admission after it still
  blocks; a wrapped test name containing an admission phrase still blanks
  and stays valid), four red-lookalike evasions ("not red", "instead of …
  red", "never red", "a red test is still to add") each still blocking, an
  unrelated negation beside a genuine red flip staying valid, a backticked
  header that disappears under blanking now blocking instead of being
  skipped, and a plain-text header still running the admission check.
- Added to `worker/deno/tests/completion_phase_branch_outcomes_test.ts`: an
  admitting entry blocks PR creation, and a recovery that cites a covered
  test raises the PR.
- Added `worker/deno/tests/branch_outcomes_admission_3288_test.ts`, which
  pins the rule's wording in `CODING-STANDARDS.md`, the coding guidelines,
  and the issue and pr_feedback prompts.
- No existing test was edited, and no assertion was removed. The test diffs
  contain only added lines.
- `deno test --allow-all` over the three files from `worker/deno`: passed
  (151 passed, 0 failed).

**Branch outcomes:**

- `worker/deno/lib/branch_outcomes_gate.ts:250` — a `none added` header's
  trailing lines are all uncaptured — `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission after 'none added.' on a following line blocks`
  — dropping the push turned the test red
- `worker/deno/lib/branch_outcomes_gate.ts:268` — wrapped inline-body
  lines are folded into the body and marked captured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare header followed by a wrapped prose line naming an existing test passes`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:275` — a scanned line not folded
  into an entry is uncaptured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission in a markdown table row blocks via uncapturedLines`
  — inverted, five tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:329` — a non-empty scanned line
  records its index —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - the test-path scan stops at a later heading-form header, even when deeper than the boundary`
  — flipped to true, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:398` — an entry line cut by
  `capEntry` is not counted as captured, so an admission past the cap
  still blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission past the entry-length cap still blocks (capEntry truncation)`
  — always marking it captured, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:409` — a continuation line cut
  by `capEntry` is not counted as captured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission on a continuation line past the entry-length cap still blocks`
  — always pushing the continuation index, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:622` — a `path::name` span keeps
  the part before `::` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path::name span with spaces keeps the path and stays valid`
  — swapped to blank-on-whitespace-first, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:624` — any other span with
  whitespace is blanked —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backticked whole-admission span is not treated as an admission (documented look-alike)`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:581-600` — backtick pairing
  carries an open span across a line break within one paragraph (resetting
  at blank lines), so a wrapped span still reads as one span —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission after a backtick span wrapped onto the next line still blocks`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a wrapped path::name test name containing an admission phrase is blanked and valid`
  — reverting to the old per-raw-line split, both tests went red
  (PR #3312 review: VibeCoder#3132-style defect, previously fixed only for
  the single-line case)
- `worker/deno/lib/branch_outcomes_gate.ts:700-716` — `OTHER_NEGATED_RED_SOURCES`
  additionally treats a bare negation adjacent to `red`, an "instead of …
  red" contrast, a "needs/should … red" ask, and "red … still to add" as
  recording no red flip —
  four `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - red-lookalike evasion blocks: *`
  tests (not red / instead of turning it red / never red / a red test is
  still to add) — removing the array from the global strip, all four went
  red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:722` — negated-red phrases are
  stripped before the red check — exempt (untestable): `admitsUnreached`
  runs the strong regex, built from the same `NEGATED_RED_SOURCE`, before
  `recordsRedFlip`, so any unit carrying a negated-red phrase has already
  returned and the strip can never change a verdict
- `worker/deno/lib/branch_outcomes_gate.ts:722` — a unit that mentions red
  records a red flip —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a Rust covered entry with a blanked inline-test-name is valid`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:727` — a strong admission
  blocks — `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a GRQ-shape admission blocks and names the label`
  — removed the return, sixteen tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:730` — a named test path or a
  red flip clears a weak admission —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path-citing entry mentioning an unrelated 'stayed green' is valid`
  — removed the return, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:731` — a weak admission with no
  path and no red blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a mixed list of 3 flags exactly the strong and weak entries`
  — removed the return, four tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:768` — an exempt clause decides
  the unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:771` — an exemption reason of
  three or more words passes —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with a real reason is valid`
  — threshold raised to 100, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:771` — an exemption with a
  shorter reason blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — threshold lowered to 0, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:793` and `:798` — a
  `path:<digits>` token becomes the label —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare path:line span stays a label after blanking`
  — each skip forced on, three tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:802` — a fallback label longer
  than 80 characters is cut and suffixed `…` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a long admitting entry with no path:line gets an 80-character label ending in '…'`
  — never cutting, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:816` — the record's inline body
  is checked as a unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline-body admission blocks`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:823` and `:825` — an
  exemption without a reason gets its own problem, not the admission one —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — each flipped, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:1015` — the admission check
  fails closed when the header is found in the unblanked parse but vanishes
  under blanking (e.g. a header written entirely inside backticks) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backticked header that disappears under blanking blocks instead of skipping the check`
  — dropping the branch (always falling to the `else if`), test went red;
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a plain-text header still runs the admission check`
  pins the ordinary (non-backticked) header still reaching the normal
  admission check (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:1029` — a present list is
  checked for admissions —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a Branch outcomes entry admitting no test reaches it blocks PR creation (Issue #3288)`
  — flipped to false, twenty-six tests went red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
