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
- PR #3312 review, round 3: the round-2 fail-closed check compared the real
  parse against an independent re-parse of a separately blanked copy of the
  whole document, and blanking changed those parses' entry/uncaptured-line
  counts for reasons that were never a real line merge — a line that was
  only a whitespace-containing code span (a quoted command or assertion)
  blanked to an empty string and vanished from the blanked scan, and a
  hard-wrapped line starting with a backtick-quoted mention of the header
  phrase read as a genuine header before blanking but not after (verbatim
  shape in `pr-summary-3249.md`). Both false-blocked an honest summary with
  a misleading "merged two lines" message. Fixed by removing the second,
  independent re-parse entirely: `parseBranchOutcomes` now records the raw
  line indices behind each entry, each body contribution, and each
  uncaptured line (`entryLineIndices`, `bodyLineIndexGroups`,
  `uncapturedLineIndices`), and a new `blankedUnitText` blanks test/command
  citations straight from exactly those raw lines — never by re-deriving
  header/entry boundaries from a separately blanked document, so there is
  nothing left that can disagree in shape with the real parse. The two
  fail-closed problem messages ("header could not be re-read", "could not
  be re-read with the same number of entries") are gone.
- **PR #3312 review, round 4**: two shapes of cross-line backtick pairing
  still broke after round 3. (a) Each uncaptured line was blanked on its
  own (`blankedUnitText(lines, [idx])`), so a span opened on one uncaptured
  line and closed on the next re-paired from scratch on the second line,
  reading the entry's own prose after the close as still "inside a span"
  and blanking away a real admission. (b) `blankedUnitText` still ran the
  round-2 `blankTestCitationNames`, which reset pairing at every
  non-indented line, over one entry's own joined lines — so a "lazy"
  (unindented) continuation line the parser folds into an entry (when the
  header is not itself a list item, any continuation line satisfies
  `indent > headerIndent`) was re-paired on its own too. Fixed by two
  changes: `blankedUnitText` is replaced by `blankedUnitLines`, which joins
  a unit's own raw lines with `\n` and calls `blankLineCitationNames`
  directly — no per-line re-grouping, since the caller already isolated
  the text to one entry/body contribution/paragraph, so the cross-item leak
  the old reset guarded against cannot happen; and a new
  `groupUncapturedIndices` groups consecutive uncaptured line indices into
  paragraphs (resetting at an index gap, a list-marker line, or a markdown
  table row — the table-row reset added in PR #3312 review, round 6) before
  `evaluateApplicable` blanks them, instead of blanking each raw line
  alone. `blankTestCitationNames` and its `isContinuation` reset are
  removed entirely — the corpus run below re-confirms no false block.
- **PR #3312 review, round 5**: the inline body was still blanked as TWO
  separate `bodyLineIndexGroups` entries — the header's own line (pushed at
  the old `[i]`) and its wrap lines (pushed separately as
  `[...collected.bodyExtraLines]`) — so a backtick span opened on the header
  line and closed on the wrap line was never recognised as closed:
  `blankedUnitLines` restarts pairing from scratch at the start of each
  group. `parseBranchOutcomes` now records one group per header,
  `[i, ...collected.bodyExtraLines]`, whenever the header carries inline
  text; a heading-form header with no inline text still groups just its wrap
  lines, unchanged. The round-4 Test Plan entry for `blankedUnitLines`
  claiming pairing "never resets partway through a unit's own lines" was
  true for entries and uncaptured paragraphs but not for this one body
  shape — the group itself was wrong, not the pairing function.

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
  header still running the admission check, and a plain-text header still
  running the admission check.
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
  above the header still runs the real admission check; and (at the time)
  a backtick span straddling a line break that merged two lines once
  blanked failed closed on the entry/uncaptured-line count mismatch.
- **PR #3312 review, round 3** — the round-2 count-mismatch check itself was
  the defect (see Summary): it false-blocked an honest summary whenever
  blanking changed the parsed shape for a reason that was never a real line
  merge. Fixed by removing the second independent re-parse; the admission
  check now blanks test citations straight from the raw lines
  `parseBranchOutcomes` already attributed to each entry/body/uncaptured
  line. Two tests whose own premise was that (now-fixed) defect were edited
  rather than only added to, since their expected outcome was wrong once
  the premise was: "a backticked header that disappears under blanking
  blocks instead of skipping the check" is renamed
  "a backticked header still runs the admission check" and now asserts the
  real admission message (not the removed "could not be re-read" one); "a
  blanked span merging two lines fails closed on the entry/uncaptured-line
  count mismatch" is renamed
  "a backtick span straddling a line break no longer falsely blocks" and
  now asserts the input is `valid` (confirmed red against the unfixed code,
  not merely claimed). Three further tests are added (`Deno.test` count:
  115 → 118), each confirmed red against the unfixed code and green with
  the fix: `none added followed by a code-span-only uncaptured line is
  valid`, `a list followed by a backticked command line is valid`, and `a
  wrapped line starting with a backticked Branch-outcomes mention does not
  false-block an honest 'none added'` (the last taken verbatim from
  `pr-summary-3249.md`, the real corpus file this exact defect blocked).
- **PR #3312 review, round 4** — six tests added to
  `worker/deno/tests/branch_outcomes_gate_test.ts` (count: 140 → 146), each
  confirmed red against the pre-round-4 code and green with the fix: an
  admission in wrapped prose after `none added` blocks; an admission in a
  wrapped sibling-bullet span (the header is itself a list item) blocks; an
  admission on a lazy unindented continuation blocks; a stray backtick in
  one uncaptured paragraph does not blank an admission in a later,
  blank-line-separated paragraph; the same, but with the later paragraph an
  immediately-following uncaptured bullet (list-marker reset, rather than a
  blank-line gap); and a wrapped `path::name` test name in uncaptured prose
  after a list, whose wrapped half contains an admission phrase, stays
  valid. The two `groupUncapturedIndices` reset branches (the index-gap
  check and the list-marker check) were each individually disabled and
  confirmed to turn their own dedicated test red, then restored.
- **PR #3312 review, round 5** — one test added to
  `worker/deno/tests/branch_outcomes_gate_test.ts` (count: 146 → 147): an
  admission after a backtick span wrapped across the INLINE body's own line
  break (no list involved) still blocks. Confirmed red against the
  pre-round-5 code — `assertEquals(result.valid, false)` failed with
  `Values are not equal. Actual: true / Expected: false`, because the
  old two-group split let the wrap line's backtick re-open and swallow the
  admission — and green with the fix (reverting only the
  `body ? [i, ...collected.bodyExtraLines] : [...collected.bodyExtraLines]`
  ternary in `parseBranchOutcomes` to the old `[...collected.bodyExtraLines]`
  reproduces the same red failure).
- No existing assertion's *behaviour under correct input* was weakened —
  the two renamed tests pin the SAME inputs, with the outcome corrected to
  match the fix. Two further tests — "a plain-text header still runs the
  admission check" and "a stray backtick in prose above the header still
  runs the real admission check" — each drop their now-obsolete
  `could not be re-read` negative assertion, since the round-2 problem
  variant it checked for no longer exists; every other line in the test
  diffs is an addition.
- `deno test --allow-all` over the three files from `worker/deno`: passed
  (168 passed, 0 failed — 151 + 14 + 3, PR #3312 review round 6 adding 4
  tests to `branch_outcomes_gate_test.ts`).
- **Corpus run (PR #3312 review, round 5, rerun at this head)** —
  CODING-STANDARDS' "Writing a gate over text" rule 2: ran
  `validateBranchOutcomes` over every file in `docs/archive/pr-summaries/`
  (908 files at this head — 4 more than the round-4 run, from PRs merged
  since), with `testsAtHead` populated from each file's own named test paths
  so a missing-test problem never masks the admission-check result. 37 files
  carry a `Branch outcomes` header. Of those, 20 carry a real list or inline
  body (the rest are honest `none added` declarations). The gate blocks 2 of
  the 20: `pr-summary-3257.md` (unchanged from round 4 — 7 true-positive
  units, see below) and `pr-summary-3295.md` (new since round 4), flagging
  one list-entry unit: "the `(?!`)` lookahead only affects how runs of
  backticks pair up. Removing it leaves the suite green." — a genuine
  admission, not a case this round's fix touches (it is a list entry,
  resolved through `entryLineIndices`, not the inline-body
  `bodyLineIndexGroups` this round changed). Re-running the same corpus with
  the round-5 fix reverted gives the identical `{ blocked: 2 }` result with
  the same two files, confirming this round's fix neither introduces nor
  masks a corpus finding — no PR summary in the archive happens to carry an
  inline `Branch outcomes:` body that wraps a backtick span onto a
  continuation line. All 7 flagged units in `pr-summary-3257.md` are true
  positives: 6 name the exact words `no test reaches it`, `unreachable
  through`, or `does not go red when flipped` against real branches
  (`worker/deno/lib/summary_claim_check.ts:391,410,285,607,804` and
  `worker/deno/lib/phases/completion_phase.ts:2468`). The 7th,
  `pr-summary-3257.md:131`, was mis-described in the round-2 write-up as a
  false positive ("a claim that an unmoved branch is covered elsewhere") —
  re-reading the quoted text, "inverting it left the #3143 and #3244 drift
  suites green" says the opposite: it is an honest admission that mutating
  this (pre-existing, not newly-added) branch left both suites green, i.e.
  no test caught it. The gate is correctly flagging a genuine admission.
  Decision: left as-is. The correct remedy there was never to name a test
  whose suite stayed green under the mutation (that proves no coverage, not
  coverage) — it is `exempt (out of scope): pre-existing branch, not added
  by this diff`, which the gate's own exemption clause exists for.
  `pr-summary-3295.md` is left as-is too, for the same reason — it is an
  unrelated PR's archived summary, out of scope for this fix to edit.

**Branch outcomes:**

PR #3312 review, round 7: every citation below is renumbered directly
against this PR's head commit c969d607. The round-6 write-up's "shifted by
+21 / unaffected" note (removed here) was itself wrong — it only accounted
for the `main` merge (#3340) past `:446` and never applied round 6's own
~+12-line shift to the citations above that point, so every citation in the
list was stale at that head. Re-checked line by line against c969d607 below.

- `worker/deno/lib/branch_outcomes_gate.ts:287-290` — a `none added` header's
  trailing lines are all uncaptured — `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission after 'none added.' on a following line blocks`
  — dropping the push turned the test red
- `worker/deno/lib/branch_outcomes_gate.ts:316-317,321` — the header's own
  inline body and/or its wrap lines are folded into the body text and
  marked captured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare header followed by a wrapped prose line naming an existing test passes`
  — flipped to false, test went red
- **PR #3312 review, round 5** — `worker/deno/lib/branch_outcomes_gate.ts:319`
  — the header's own body line and the wrap lines it continues onto are
  recorded as ONE `bodyLineIndexGroups` entry (`[i, ...collected.bodyExtraLines]`)
  when the header carries inline text, instead of two separate groups
  (the earlier defect — see Summary) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission after a backtick span wrapped across the inline body's own line break still blocks`
  — reverting the ternary to the old `[...collected.bodyExtraLines]` turned
  the test red (`valid` was `true`, expected `false`)
- `worker/deno/lib/branch_outcomes_gate.ts:325-328` — a scanned line not
  folded into an entry or body is uncaptured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission in a markdown table row blocks via uncapturedLines`
  — inverted, five tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:384-386` — a non-empty scanned
  line records its index —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - the test-path scan stops at a later heading-form header, even when deeper than the boundary`
  — flipped to true, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:474` — an entry line cut by
  `capEntry` is not counted as captured, so an admission past the cap
  still blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission past the entry-length cap still blocks (capEntry truncation)`
  — always marking it captured, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:485-486` — a continuation line cut
  by `capEntry` is not counted as captured —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission on a continuation line past the entry-length cap still blocks`
  — always pushing the continuation index, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:760-762` — a `path::name` span keeps
  the part before `::` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path::name span with spaces keeps the path and stays valid`
  — swapped to blank-on-whitespace-first, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:763-764` — any other span with
  whitespace is blanked —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backticked whole-admission span is not treated as an admission (documented look-alike)`
  — flipped to false, test went red
- **PR #3312 review, round 4** — `worker/deno/lib/branch_outcomes_gate.ts:647-660`
  (`blankedUnitLines`, replacing the round-3 `blankedUnitText` + round-2
  `blankTestCitationNames` pair the review found still mis-paired a span
  across a unit's own lines — see Summary) operates on exactly the raw
  lines `parseBranchOutcomes` attributed to one entry/body/uncaptured
  group, joined with `\n` and blanked as ONE string — never re-split and
  re-paired per raw line. Two properties, both load-bearing:
  - it never re-derives header/entry boundaries from a separately blanked
    document —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a backtick span straddling a line break no longer falsely blocks (PR #3312 review, round 3)`,
    `...::validateBranchOutcomes - none added followed by a code-span-only uncaptured line is valid`,
    `...::validateBranchOutcomes - a list followed by a backticked command line is valid`, and
    `...::validateBranchOutcomes - a wrapped line starting with a backticked Branch-outcomes mention does not false-block an honest 'none added' (pr-summary-3249.md shape)`
  - backtick pairing never resets partway through a unit's own lines
    (dropping the old per-line re-grouping this replaced) —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission on a lazy unindented continuation blocks (PR #3312 review, round 4)`,
    `...::validateBranchOutcomes - an admission after a backtick span wrapped onto the next line still blocks`, and
    `...::validateBranchOutcomes - a wrapped path::name test name containing an admission phrase is blanked and valid`
  — each confirmed red against the pre-round-4 code, green with the fix. The
    GROUP this function is handed for the inline body was still wrong until
    round 5 (see the round-5 entry above) — the pairing function itself was
    never the defect.
- **PR #3312 review, round 4** — `worker/deno/lib/branch_outcomes_gate.ts:694-720`
  (`groupUncapturedIndices`, new this round) groups consecutive uncaptured
  line indices into paragraphs so `blankedUnitLines` can pair a span across
  a wrapped uncaptured line, resetting on any of the `startsNewGroup`
  disjuncts at `:704-708`, so one paragraph's stray backtick can never
  reach another's:
  - the gap reset (`:705`, `idx !== prevIndex + 1`) —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a stray backtick in one uncaptured paragraph does not blank an admission in a later, blank-line-separated paragraph (PR #3312 review, round 4)`
    — dropping the disjunct, test went red
  - the list-marker reset (`:706`, `LIST_MARKER_RE`) —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a stray backtick in uncaptured prose does not blank an admission in the immediately following uncaptured bullet (PR #3312 review, round 4)`
    — dropping the disjunct, test went red
  - **PR #3312 review, round 6** — the table-row reset (`:703,707-708`,
    `isTableRow || prevWasTableRow`) keeps a markdown table row its own
    paragraph in both directions (the row itself, and the row immediately
    after one), so a neighbouring row's test citation and red flip cannot
    clear a different row's bare admission —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission in one markdown table row still blocks when a neighbouring row carries a test citation (PR #3312 review, round 6)`
    — dropping the `isTableRow || prevWasTableRow` disjunct, test went red
  - the merge-when-consecutive-and-non-list path (`:713`) —
    `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - none added followed by a code-span-only uncaptured line is valid`
- **PR #3312 review, round 4** — `worker/deno/lib/branch_outcomes_gate.ts:1186-1191`
  (`evaluateApplicable`) now groups uncaptured lines into paragraphs before
  blanking, instead of calling `blankedUnitText(lines, [idx])` once per raw
  line —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an admission in wrapped prose after 'none added' blocks (PR #3312 review, round 4)`
  and
  `...::validateBranchOutcomes - an admission in a wrapped sibling-bullet span blocks (PR #3312 review, round 4)`
  — each confirmed red against the pre-round-4 code (per-line blanking hid
  the admission), green with the fix. **PR #3312 review, round 6** — the
  same `.map((idxs) => blankedUnitText(lines, idxs))` call (`:1190`) checks
  each joined paragraph as ONE unit, so an admission a hard wrap splits
  across two physical lines (the words never sharing a single pre-round-6
  per-line unit) still matches —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a strong admission hard-wrapped across a line break in prose after a list blocks (PR #3312 review, round 6)`
  and
  `...::validateBranchOutcomes - a weak admission hard-wrapped across a line break after 'none added.' blocks (PR #3312 review, round 6)`
  — each confirmed red against the pre-round-6 code (per-line blanking split
  the admission's words across two units), green with the fix
- `worker/deno/lib/branch_outcomes_gate.ts:838-843` —
  `OTHER_NEGATED_RED_SOURCES` additionally treats a bare negation adjacent
  to `red`, an "instead of … red" contrast, a "needs/should … red" ask, and
  "red … still to add" as recording no red flip —
  four `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - red-lookalike evasion blocks: *`
  tests (not red / instead of turning it red / never red / a red test is
  still to add) — removing the array from the global strip, all four went
  red (PR #3312 review). `NEGATED_RED_SOURCE` is NOT one of the sources
  the strip is built from (PR #3312 review round 2 — it was unreachable
  dead code there; see Summary)
- `worker/deno/lib/branch_outcomes_gate.ts:862-864` — a unit that mentions red
  records a red flip —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a Rust covered entry with a blanked inline-test-name is valid`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:868-869` — a strong admission
  blocks — `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a GRQ-shape admission blocks and names the label`
  — removed the return, sixteen tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:871` — a named test path or a
  red flip clears a weak admission —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a path-citing entry mentioning an unrelated 'stayed green' is valid`
  — removed the return, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:872-874` — a weak admission with no
  path and no red blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a mixed list of 3 flags exactly the strong and weak entries`
  — removed the return, four tests went red
- `worker/deno/lib/branch_outcomes_gate.ts:909-913` — an exempt clause decides
  the unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — flipped to false, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:912` — an exemption reason of
  three or more words passes —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with a real reason is valid`
  — threshold raised to 100, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:912` — an exemption with a
  shorter reason blocks —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — threshold lowered to 0, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:931-940` (the `continue` skips at
  `:932,934,937,939`) — a `path:<digits>` token becomes the label —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare path:line span stays a label after blanking`
  — each skip forced on, three tests went red (the round-5 summary's `:925`
  and `:927` were themselves already stale at this head; PR #3312 review,
  round 7)
- `worker/deno/lib/branch_outcomes_gate.ts:942-945` — a fallback label longer
  than 80 characters is cut and suffixed `…` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a long admitting entry with no path:line gets an 80-character label ending in '…'`
  — never cutting, test went red (PR #3312 review)
- `worker/deno/lib/branch_outcomes_gate.ts:970-972` — each header's own inline
  body contribution is checked as its own unit —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline-body admission blocks`
  — flipped to false, test went red
- **PR #3312 review, round 6** — `worker/deno/lib/branch_outcomes_gate.ts:1183-1185`
  builds `BlankedUnits.body` as one string PER `bodyLineIndexGroups` entry
  (i.e. per header), rather than joining every header's body into one
  string, so a test citation in one `Branch outcomes:` header cannot clear
  a weak admission in a different header's body — the single-header
  `an inline-body admission blocks` test above stays green even if the
  per-header groups were joined back together (there is only one header in
  play), so it cannot stand in for this property —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a test citation in one Branch-outcomes header does not clear a weak admission in another header (PR #3312 review, round 6)`
  — joining `record.bodyLineIndexGroups.map(...)` into one string before
  blanking turned the test red
- `worker/deno/lib/branch_outcomes_gate.ts:982-987` — an exemption without a
  reason gets its own problem, not the admission one —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one`
  — flipped, test went red
- `worker/deno/lib/branch_outcomes_gate.ts:1163` — a present list is
  checked for admissions (unconditionally — the round-2 fail-closed
  branches this used to gate on were removed in round 3) —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a Branch outcomes entry admitting no test reaches it blocks PR creation (Issue #3288)`
  — flipped to false, twenty-six tests went red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
