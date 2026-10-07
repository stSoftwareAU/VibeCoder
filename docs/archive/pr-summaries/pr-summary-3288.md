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
  break instead of re-pairing from scratch on every raw line, so a span
  opened on one line and closed on an indented continuation line still
  blanks a wrapped test name, and still leaves a wrapped admission readable
  as the entry's own prose (round 2 narrowed the reset points further —
  see below).
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
- PR #3312 review, round 2: `blankTestCitationNames` reset backtick pairing
  only at blank lines, so a tight list (no blank line between items — how
  this repo's own lists are written, including this PR's own) was one
  paragraph; a stray (odd) backtick in one item flipped which segments
  counted as "inside a span" for every later item, letting a genuine
  admission in a later item be blanked away. Pairing now also resets at
  every list-marker line and at any other non-indented line, and an open
  span carries only into an indented continuation line of the same item.
  The gate also now fails closed when blanking changes the parsed entry or
  uncaptured-line count (a span straddling a line break can still remove
  that line break when blanked, merging two lines) instead of trusting a
  blanked re-parse whose shape no longer matches the real list.
- PR #3312 review, round 2: `NEGATED_RED_GLOBAL_RE`'s `NEGATED_RED_SOURCE`
  alternative was unreachable — `admitsUnreached` already returns on any
  match of that source before `recordsRedFlip` ever runs — so it is dropped;
  the strip is built from `OTHER_NEGATED_RED_SOURCES` alone, which the four
  existing red-lookalike tests already cover.

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
- PR #3312 review, round 2 — added to
  `worker/deno/tests/branch_outcomes_gate_test.ts`: a tight list (no blank
  line between items) with a stray backtick in item 1 and a genuine
  admission in item 2 still blocks; a stray backtick in prose directly
  above the header still runs the real admission check instead of the
  misleading "header could not be re-read" message; and a backtick span
  straddling a line break that merges two lines once blanked fails closed
  on the entry/uncaptured-line count mismatch.
- No existing test was edited, and no assertion was removed. The test diffs
  contain only added lines.
- `deno test --allow-all` over the three files from `worker/deno`: passed
  (154 passed, 0 failed).
- **Corpus run (PR #3312 review, round 2)** — CODING-STANDARDS' "Writing a
  gate over text" rule 2: ran `validateBranchOutcomes` over every file in
  `docs/archive/pr-summaries/` (903 files), with `testsAtHead` populated
  from each file's own named test paths so a missing-test problem never
  masks the admission-check result. 32 files carry a `Branch outcomes`
  header (33 files mention the phrase; 1,
  `pr-summary-3238.md`, mentions it only in prose the header regex does not
  match). Of those 32, 18 carry a real list or inline body (the rest are
  honest `none added` declarations). The gate blocks exactly 1 of the 18,
  `pr-summary-3257.md`, flagging 7 units. 6 of the 7 are true positives:
  that PR (merged before this gate existed) names the exact words `no test
  reaches it`, `unreachable through`, or `does not go red when flipped`
  against real branches (`worker/deno/lib/summary_claim_check.ts:391,410,
  285,607,804` and `worker/deno/lib/phases/completion_phase.ts:2468`) — the
  gate retroactively catches genuine pre-existing violations of the rule it
  now enforces. The 7th, `pr-summary-3257.md:131`, is a false positive: "The
  base-ref context line in `buildDriftQuestionPrompt` ... is an existing
  branch that this diff moves ... It is not new, and inverting it left the
  #3143 and #3244 drift suites green" — the weak-admission heuristic reads
  "left ... green" with no named test path as an admission, when it is
  actually a claim that an unmoved branch is covered elsewhere. Decision:
  left as-is. Weak admissions are deliberately narrow (they only fire when
  the unit names no test path and records no red flip), and carving out
  "describes an existing branch" wording would reopen exactly the evasion
  the gate exists to close — any genuinely untested new branch could claim
  the same wording. The correct fix for this false positive is in the PR
  summary's own words: name the actual covering test file
  (e.g. `worker/deno/tests/pr_feedback_drift_check_3244_test.ts`) rather
  than only the issue number, which clears the weak-admission check via the
  named-test-path path it already has.

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
- `worker/deno/lib/branch_outcomes_gate.ts:642` — a `path::name` span keeps
  the part before `::` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path::name span with spaces keeps the path and stays valid`
  — swapped to blank-on-whitespace-first, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:645` — any other span with
  whitespace is blanked —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backticked whole-admission span is not treated as an admission (documented look-alike)`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:624-627` — a line continues the
  current span-pairing group only when it is not a list-marker line and is
  indented (an indented continuation of a bullet or of wrapped prose) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission after a backtick span wrapped onto the next line still blocks`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a wrapped path::name test name containing an admission phrase is blanked and valid`
  pin the TRUE (continues) path still blocking/blanking as before
  (PR #3312 review: VibeCoder#3132-style defect, previously fixed only for
  the single-line case). The FALSE (resets) path — reached at a list-marker
  line or any other non-indented line, PR #3312 review round 2 — is pinned
  by
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a stray backtick in one tight-list item does not blank an admission in a later item`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a stray backtick in prose above the header still runs the real admission check`
  — forcing `isContinuation` to `group.length > 0` (dropping the
  list-marker/indent checks, reverting to the old whole-run grouping) turned
  both new tests red
- `worker/deno/lib/branch_outcomes_gate.ts:720-725,735-738` —
  `OTHER_NEGATED_RED_SOURCES` additionally treats a bare negation adjacent
  to `red`, an "instead of … red" contrast, a "needs/should … red" ask, and
  "red … still to add" as recording no red flip —
  four `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - red-lookalike evasion blocks: *`
  tests (not red / instead of turning it red / never red / a red test is
  still to add) — removing the array from the global strip, all four went
  red (PR #3312 review). `NEGATED_RED_SOURCE` is NOT one of the sources
  the strip is built from (PR #3312 review round 2 — it was unreachable
  dead code there; see Summary)
- `worker/deno/lib/branch_outcomes_gate.ts:745` — a unit that mentions red
  records a red flip —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a Rust covered entry with a blanked inline-test-name is valid`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:751` — a strong admission
  blocks — `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a GRQ-shape admission blocks and names the label`
  — removed the return, sixteen tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:753` — a named test path or a
  red flip clears a weak admission —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path-citing entry mentioning an unrelated 'stayed green' is valid`
  — removed the return, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:755` — a weak admission with no
  path and no red blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a mixed list of 3 flags exactly the strong and weak entries`
  — removed the return, four tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:791` — an exempt clause decides
  the unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:794` — an exemption reason of
  three or more words passes —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with a real reason is valid`
  — threshold raised to 100, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:794` — an exemption with a
  shorter reason blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — threshold lowered to 0, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:820` and `:821` — a
  `path:<digits>` token becomes the label —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare path:line span stays a label after blanking`
  — each skip forced on, three tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:825` — a fallback label longer
  than 80 characters is cut and suffixed `…` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a long admitting entry with no path:line gets an 80-character label ending in '…'`
  — never cutting, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:839` — the record's inline body
  is checked as a unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline-body admission blocks`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:846` and `:849` — an
  exemption without a reason gets its own problem, not the admission one —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — each flipped, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:1043` — the admission check
  fails closed when the header is found in the unblanked parse but vanishes
  under blanking (e.g. a header written entirely inside backticks) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backticked header that disappears under blanking blocks instead of skipping the check`
  — dropping the branch (always falling to the `else if`), test went red;
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a plain-text header still runs the admission check`
  pins the ordinary (non-backticked) header still reaching the normal
  admission check (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:1057-1061` — PR #3312 review
  round 2: the admission check fails closed when blanking changes the
  parsed entry or uncaptured-line count (a backtick span straddling a line
  break can remove that line break when blanked, merging two lines) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a blanked span merging two lines fails closed on the entry/uncaptured-line count mismatch`
  — dropping the branch (forcing the condition to `false`), the input that
  test uses goes from blocked to wrongly `valid: true`
- `worker/deno/lib/branch_outcomes_gate.ts:1074` — a present list (with a
  shape-matching blanked re-parse) is checked for admissions —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a Branch outcomes entry admitting no test reaches it blocks PR creation (Issue #3288)`
  — flipped to false, twenty-six tests went red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
