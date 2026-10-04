# PR Summary — Issue #3147

## Summary

The branch-outcome test rule (Issue #3069), "every outcome of a branch you add
needs a test that reaches it", was prose only. Nothing checked it, so fleet PRs
kept shipping a new branch that no test reached. Review-fix rounds added the
test a finding named while their own rework opened new untested branches
(GRQ-AutoTrader#2368). One summary named a test that did not exist
(VibeCoder#3132).

This change makes the enumeration a recorded, checked artefact:

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` now require
  a run that writes or refreshes a PR summary to record the enumeration as a
  `Branch outcomes:` list in its Test Plan. Each line names `path:line`, the
  outcome, the test that reaches it, and that flipping the outcome went red.
  A diff that adds no branch writes `Branch outcomes: none added`.
- `prompts/issue/prompt.md` names that list in the Test Plan step, says the
  worker blocks PR creation without it on the no-PR path (or records the
  shortfall against a PR the run already raised), and adds an example to the
  skeleton summary.
- `prompts/pr_feedback/prompt.md` requires a fix to re-enumerate every branch
  its own commits add and to refresh the list to the head.
- New `worker/deno/lib/branch_outcomes_gate.ts` is a summary-rule gate. It
  uses the docs-sweep gate's applicability test. It blocks a summary with no
  `Branch outcomes:` list, an empty or placeholder one, or one that names a
  test-file path not tracked at HEAD (`git ls-tree`, fail closed).
- `worker/deno/lib/phases/completion_phase.ts` runs the docs-sweep,
  result-placeholder and branch-outcomes gates as one late block.
  `reportSummaryRuleBlock` reports every one that fails in the single
  recovery turn. `foldInDocsSweep` is renamed `foldInLateSummaryGates`, and
  it folds the branch-outcomes verdict into an earlier gate's block too.

A third PR #3160 review round found two classes of gap, both fixed:

- Three branches had no test reaching them: the `!changedFilesKnown` arm (then
  in a `branchOutcomesApplicable` helper, since deleted — see the fifth round
  below), the `./`-strip and leading-`/` skip in `namedTestPaths`
  (`branch_outcomes_gate.ts:210, 239`), and the three fail-open caps that
  existed at the time: `MAX_ENTRIES` (two separate checks), `MAX_TOKEN_CHARS`
  and `MAX_NAMED_TEST_PATHS`. A fourth PR #3160 review round found that the raw-
  token skip at the old line 237 (`if (rawToken.startsWith("/")) continue;`)
  was dead code — `normaliseToken` keeps a leading `/`, so the
  post-normalisation skip at line 239 (now 238) already caught everything it
  did — and that this earlier claim over-stated coverage: deleting line 237
  alone, or loosening line 239 alone, both left the suite green, so neither
  skip was actually pinned on its own. Line 237 is deleted; a new case for a
  `.//`-prefixed citation (which only becomes absolute after the `./` strip)
  pins the sole remaining guard and is confirmed red with it removed (see Test
  Plan).
- `lookupTestsAtHead` resolves every named path relative to the **repository
  root** (it runs from `state.repoPath`), but the guidance it sends agents to
  — **A named test must exist** — checks with `git ls-files <path>`, which
  resolves relative to the current directory; this repo's own test command
  runs from `worker/deno`. `CODING-STANDARDS.md`, `prompts/coding_guidelines/
  prompt.md`, `prompts/pr_feedback/prompt.md` and `prompts/issue/prompt.md`
  now say test paths must be relative to the repository root, and the gate's
  missing-test message and remediation comment (item 5) say so too, so a
  run blocked on this is told why its own `git ls-files` check from
  `worker/deno` passed.

A fifth PR #3160 review round found the reworked parser still let an invented
test slip through, five of this round's own parser arms were untested, and
this file's own Branch outcomes list was stale and un-refreshed. All three are
fixed:

- `evaluateApplicable` only ran `namedTestPaths` over `record.entries` and
  `record.body`. Three ordinary layouts — a header that is itself a Test Plan
  bullet followed by sibling bullets, a header followed by a markdown table,
  and a loose list broken by an indented paragraph — stop `collectEntries`
  before it ever reaches a test path named further down, so a header with
  inline text and zero collected entries passed with `missingTests: []` even
  though the same layouts with an *empty* header body were already blocked.
  New `scanRegionText` (`branch_outcomes_gate.ts:177-192`) scans every line
  from the header to the next heading, the next `Branch outcomes` header, or
  the end of the document — independent of `collectEntries`' list-shaped
  parsing — into a new `BranchOutcomesRecord.scanText` field that
  `namedTestPaths` also reads. Confirmed red against the previous parser for
  all three layouts (see Test Plan); two new tests pin `scanRegionText`'s own
  stopping points (a later header, a markdown heading), both confirmed red
  with the corresponding stop condition removed.
- Five arms this round added to `parseBranchOutcomes`/`collectEntries` had no
  test reaching them: the `entries.length === 0` fallthrough (`continue`, now
  line 244), the `&& wrapping` guard (line 239), the `!sawBlank &&` guard
  (line 230), and the two separate `MAX_ENTRIES` checks (then lines 139 and
  180). Three new `parseBranchOutcomes`/`validateBranchOutcomes` cases pin the
  first three, each confirmed red with its guard removed (see Test Plan). The
  two `MAX_ENTRIES` checks were never independently observable from each
  other: `collectEntries`' own cap (then line 180) only ever ran into
  `parseBranchOutcomes`' copy loop (line 150), which already trims the merged
  result to 100 regardless of how many entries `collectEntries` returns — so
  the inner cap had no case where removing it alone could change any output.
  It is deleted as dead weight; a new two-header test (each list under 100,
  combined over it) isolates and pins the one cap that remains, confirmed red
  with it removed (see Test Plan).
- This file's Branch outcomes list is regenerated below from the current
  head, with the line a reviewer would actually find at that path today, and
  a flip result on every line. The stale `branchOutcomesApplicable` claim
  (that function no longer exists anywhere in the codebase) and the stale
  MAX_ENTRIES-is-one-cap claim above are corrected, and the two test comments
  in `completion_phase_branch_outcomes_test.ts` (lines 151, 487 at the time of
  the finding) that still described the deleted function are rewritten to
  describe the `changedFiles: changedFilesKnown ? changedFiles : null` ternary
  `completion_phase.ts` actually passes into `validateBranchOutcomes`.
  Regenerating that line's flip result surfaced one more untested arm outside
  the five named above: the existing test for it names an *existing* test, so
  it stays green whether or not the ternary runs (an unreadable diff's plain
  `changedFiles` is `[]` either way). A new case naming a *missing* test
  closes that gap and is confirmed red with the ternary removed (see Test
  Plan and Branch outcomes below).

A sixth PR #3160 review round found four problems with the fifth round's
fix, all now fixed:

- An invented test still passed in two more ordinary layouts: a header
  followed by a blank line, a `#### path/to/file.ts` grouping sub-heading,
  and then the list (`scanRegionText` and `collectEntries` both stopped at
  *any* heading, including one nested under the header's own section); and a
  `**Branch outcomes:** none added this round; the earlier rounds' arms:`
  header followed by a list (`startsWithNone` matched any body starting with
  the word `none`, so the header's whole region — list included — was
  skipped). A fixed `isNoneBody` (`branch_outcomes_gate.ts:135-138`) now
  recognises only an exact `none`/`none added` (plus trailing punctuation) as
  an honest negative; everything else, including `none added; existing
  worker/deno/tests/gone_test.ts covers it`, falls through to the normal
  scan. A new `SECTION_HEADING_MAX_LEVEL` (3) lets `scanRegionText`
  (`branch_outcomes_gate.ts:211-227`) and `collectEntries`
  (`branch_outcomes_gate.ts:236-292`) skip over a deeper grouping heading
  instead of stopping there, while a real document-section heading (`##
  Summary`, `## Test Plan` — the levels this repository's own PR summaries
  use) still ends the scan, confirmed against the pre-existing
  `...stops at the next markdown heading` test. The now-dead
  `!record.noneDeclared &&` guards in `namedTestPaths` (then lines 298-299)
  are deleted: once `isNoneBody` only matches an honest negative, `body` and
  `scanText` never hold anything but that negative when `noneDeclared` is
  true, so the guard could never fire differently (see Test Plan).
- Three of this round's own parser arms had no test reaching them: the
  `bodyExtra` push (`branch_outcomes_gate.ts:183`), the entry-reset `sawBlank
  = false;` after a list item (`branch_outcomes_gate.ts:268`), and the
  `indent > headerIndent` continuation guard (`branch_outcomes_gate.ts:273`).
  Four new cases pin them, each confirmed red with its arm mutated (see Test
  Plan and Branch outcomes below).
- `completion_phase.ts:2192-2195` (before this round) said "The HEAD lookup
  only runs when the gate is applicable and the summary actually names a
  test path". Reading the call site (`completion_phase.ts:2204-2208`, where
  `branchOutcomesNamedTests` is computed from `prBody` directly and passed
  to `lookupTestsAtHead` unconditionally): the call happens for whatever
  paths `namedTestPaths` finds in the PR body, regardless of
  `branchOutcomes.applicable` or `changedFilesKnown` — it is
  `lookupTestsAtHead` itself (`branch_outcomes_gate.ts:622`) that skips
  calling `git` when there are zero paths, not the surrounding code skipping
  the call. The comment (now `completion_phase.ts:2192-2198`) is rewritten
  to describe the unconditional call.
- This file's Branch outcomes list is regenerated below from the current
  head, covering every arm in `parseBranchOutcomes`, `scanRegionText` and
  `collectEntries` (the sixth round's own finding: the fifth round's
  enumeration had missed six of them) as well as the other gate functions,
  each with the line it is at today and the flip result seen on this head.

Closes #3147.

## Test Plan

- `worker/deno/tests/branch_outcomes_gate_test.ts`: parsing, validation and
  HEAD lookup of the `Branch outcomes:` list. PR #3160 review added two cases
  for the inline (same-line) body shape, the one form `namedTestPaths`' body
  arm reaches and the only shape with no prior coverage: a missing named test
  blocks and is listed in `missingTests`, and an existing named test passes.
  Confirmed red with the body arm (`branch_outcomes_gate.ts:221`) removed.
  A second PR #3160 review round found two more problems, both now fixed and
  tested: `BRANCH_OUTCOMES_HEADING_RE` had two adjacent `\s*` around the
  optional `:?`, which backtracked quadratically on a heading line with a
  long trailing space run before a non-matching character; the new growth
  test (`## Branch outcomes` + N spaces + `x`) confirmed red against the
  unfixed pattern (25,020 chars took 266 ms, 100,020 chars took 4,213 ms —
  over the 2,125 ms a linear rule allows) and green after dropping the
  trailing `\s*`. `lookupTestsAtHead` had no direct unit test even though
  the Test Plan claimed "HEAD lookup" coverage; five new tests call it
  directly — empty paths give an empty set without invoking `runGit`, a
  failed `runGit` and a non-zero exit each give `null`, stdout lines parse
  into the returned set, and the argv is
  `--literal-pathspecs ls-tree -r --name-only HEAD -- <paths>`. The doc
  comment above `lookupTestsAtHead`, which said empty `paths` returns `null`,
  is corrected to match the code (an empty set, no git call). The new growth
  test uses a real clock, so it is registered in
  `worker/deno/lib/parallel_unsafe_test_manifest.ts`'s `WALL_CLOCK_TEST_FILES`
  (`check:manifests` and the quality gate's `--parallel` pass failed until it
  was).
- `worker/deno/tests/completion_phase_branch_outcomes_test.ts`: the gate
  wired into the completion phase, including the fold into earlier gates'
  blocks. PR #3160 review added a case for a code diff missing BOTH the Docs
  sweep line and the Branch outcomes list, asserting one comment naming both.
  Confirmed red against the reviewer's `branchOutcomesBlocked && reasons.length
  === 0` mutation at `completion_phase.ts:2350`, with the other nine tests in
  the file staying green under that same mutation.
- `worker/deno/tests/branch_outcomes_record_3147_test.ts`: a
  documentation-drift test that pins the rule in `CODING-STANDARDS.md` and in
  the coding_guidelines, issue and pr_feedback prompts. PR #3160 review: the
  pinned phrase for `prompts/issue/prompt.md` was itself wrong on the
  existing-PR path (`reportSummaryRuleBlock` never adds to
  `state.summaryRuleBlocks` there, so `workOnIssueCompletion` never re-asks);
  both the prompt sentence and the pinned phrase now read "the worker blocks
  PR creation without that line" and name the existing-PR outcome.
- Existing completion-phase tests were updated for the new gate's git lookup.
- `docs/audits/lib-sweep-coverage.json` now registers
  `branch_outcomes_gate.ts` as a top-up slice. Without it,
  `lib_sweep_coverage_test.ts` failed. After the change,
  `deno test -A tests/lib_sweep_coverage_test.ts tests/lib_sweep_coverage_prompt_listing_test.ts tests/sweep_drift_command_test.ts`
  gave 45 passed, 0 failed. The tests that read
  `docs/workflows/issue-processing.md` gave 41 passed, 0 failed.
- A third PR #3160 review round added, to `branch_outcomes_gate_test.ts`:
  a `./`-prefixed citation is normalised and an absolute-path token is
  dropped (the `./` strip and the two leading-`/` skips in `namedTestPaths`
  had no test); the then-three fail-open caps `MAX_ENTRIES`, `MAX_TOKEN_CHARS`
  and `MAX_NAMED_TEST_PATHS` were each exercised by a case that exceeds the
  cap; and the missing-test problem message and
  `buildBranchOutcomesGateComment` both now assert they name the
  repository-root requirement. Each new case was confirmed red with its arm
  removed — removing all three normalisation arms, or any one of the three
  caps, failed the corresponding new test while the rest of the suite stayed
  green at the time; the fifth round below found the two `MAX_ENTRIES` cases
  were not actually independent of each other. To
  `completion_phase_branch_outcomes_test.ts`: a case mocks
  `diff --name-only <base>...HEAD` failing while the changed-workflow gate's
  own `--diff-filter=ACMR` diff still succeeds, with a summary naming an
  existing test — the one scenario where `changedFilesKnown` is false and
  `completion_phase.ts` passes `changedFiles: null` into
  `validateBranchOutcomes`. Confirmed red (status `failure` instead of
  `continue`) with that `null` branch removed.
- A fourth PR #3160 review round found the two leading-`/` skips in
  `namedTestPaths` were not each pinned: deleting the raw-token skip (then
  `branch_outcomes_gate.ts:237`) alone, or loosening the post-normalisation
  skip (then `:239`) alone, both left `branch_outcomes_gate_test.ts` green.
  The raw-token skip is dead code (`normaliseToken` keeps a leading `/`, so
  the post-normalisation skip already catches everything it caught) and is
  deleted; a new case feeds a `.//`-prefixed citation, which only becomes
  absolute after the `./` strip, so it reaches the post-normalisation skip
  and nothing else. Confirmed red: with that skip loosened to `if (!token)
  continue;`, both the pre-existing absolute-path test and the new `.//`
  test failed (36 passed, 2 failed); restoring the guard returned the file
  to green.
- A fifth PR #3160 review round added, to `branch_outcomes_gate_test.ts`:
  three `validateBranchOutcomes` cases for the sibling-bullet, markdown-table
  and loose-list layouts that let an invented test slip past the then-current
  parser — `a Test Plan bullet header with sibling bullets...`,
  `a markdown table naming the test...` and
  `a loose list broken by an indented paragraph...`, each expecting the
  invented path in `missingTests`. Confirmed red against the pre-fix parser
  (checked out from the prior commit): 3 failed, 47 passed. Two
  `parseBranchOutcomes` cases pin `scanRegionText`'s own stopping points —
  `...stops at a later Branch outcomes header` and
  `...stops at the next markdown heading` — each confirmed red with its stop
  condition removed. Three cases pin `collectEntries` arms that had no test:
  `...does not stop the scan before a later list` (the `entries.length === 0`
  fallthrough, `branch_outcomes_gate.ts:244`), `a bare heading with
  blank-separated prose and no list blocks` (the `&& wrapping` guard, line
  239), and `...prose after a blank line is not merged into the last entry`
  (the `!sawBlank &&` guard, line 230) — each confirmed red with its arm
  mutated (`continue` → `break`; dropping `&& wrapping`; dropping
  `!sawBlank &&`). One case, `MAX_ENTRIES caps the combined total across two
  headers, not just one list`, isolates the one `MAX_ENTRIES` check that
  remains (`branch_outcomes_gate.ts:150`) from the redundant one inside
  `collectEntries` (then line 180, now deleted) — confirmed red (120 instead
  of 100) with the line-150 check removed; the redundant inner check was
  deleted rather than given its own test, because no input can make it change
  any output `parseBranchOutcomes` returns once the outer copy loop always
  trims to 100. `completion_phase_branch_outcomes_test.ts`'s two stale
  comments naming the deleted `branchOutcomesApplicable` function (then at
  lines 151 and 487) are corrected to describe the `changedFiles:
  changedFilesKnown ? changedFiles : null` ternary `completion_phase.ts`
  actually passes into `validateBranchOutcomes`. One new
  `completion_phase_branch_outcomes_test.ts` case, `an unreadable
  changed-files diff with a Branch outcomes list naming a missing test
  blocks PR creation`, was needed while regenerating the Branch outcomes
  list below: the existing "names an existing test" sibling case stays
  green with that ternary's `null` replaced by the plain `changedFiles`
  array, because an unreadable diff's `changedFiles` is `[]`, which reads as
  not-applicable either way — the new case (naming a *missing* test) is the
  one that actually distinguishes fail-closed from not-applicable, and is
  confirmed red with the ternary removed (see Branch outcomes below).
- A sixth PR #3160 review round added, to `branch_outcomes_gate_test.ts`:
  `a sub-heading grouping between the header and its list still names the
  invented test` and `a 'none added this round' header followed by a list
  still names the invented test` reproduce the review's two repro cases
  directly against `validateBranchOutcomes`; both were confirmed `valid:
  true, missingTests: []` by swapping the base commit's
  `branch_outcomes_gate.ts` (b95abe7) into this tree and running the two
  review repro cases against it directly, and are `valid: false,
  missingTests: [...]` on this head. `a 'none added; existing <test> covers
  it' body naming an invented test blocks` pins the same `isNoneBody` fix
  for the body-citation variant the finding also named. Running the whole
  `branch_outcomes_gate_test.ts` suite against that same base-commit gate
  gave 54 passed, 7 failed — the seven sixth-round cases named in this
  bullet (two `parseBranchOutcomes` `isNoneBody` cases, the three
  `validateBranchOutcomes` repro/body cases above, and the two
  `collectEntries`/`scanRegionText` isolation cases below). `a heading-form
  header with a deep grouping sub-heading
  still finds its list` isolates `collectEntries`' own deeper-heading skip
  (`branch_outcomes_gate.ts:256-257`) from `scanRegionText`'s copy of the
  same fix, using a heading-form header (empty inline body) so the "names
  no outcomes" check depends only on `entries`; confirmed red (blocked
  instead of valid) with that skip reverted to stop at any heading.
  `a sub-heading before a markdown table still names the invented test`
  isolates `scanRegionText`'s own skip (`branch_outcomes_gate.ts:216`) the
  same way, using the fifth round's markdown-table layout (never collected
  into `entries`) so only `scanText` can carry the citation; confirmed red
  with that skip reverted. Two more `parseBranchOutcomes` cases pin two of
  this round's own `collectEntries` arms that had no test: `a continuation
  line after a loose list item joins the newest entry` pins the
  entry-reset `sawBlank = false;` (`branch_outcomes_gate.ts:268`), confirmed
  red (`["a", "b"]` instead of `["a", "b cont"]`) with it removed; `an
  unindented lazy line is not joined onto a list-item header's entry` pins
  the `indent > headerIndent` continuation guard
  (`branch_outcomes_gate.ts:273`), confirmed red (the lazy line merged into
  the entry) with that condition dropped. Two `validateBranchOutcomes`
  cases (`a bare header followed by a wrapped prose line naming an existing
  test passes` and `...followed by 'none added' on the next line passes`)
  pin the `bodyExtra` push (`branch_outcomes_gate.ts:183`): both confirmed
  red (blocked as "names no outcomes" instead of valid) with that push
  removed. To `completion_phase.ts`: the stale "HEAD lookup only runs when
  the gate is applicable" comment (then lines 2192-2195) is rewritten to
  describe the unconditional call (see Summary).
- `deno test --allow-all tests/branch_outcomes_gate_test.ts
  tests/completion_phase_branch_outcomes_test.ts
  tests/branch_outcomes_record_3147_test.ts` (final head, after the sixth
  PR #3160 review round): 77 passed, 0 failed.
- `deno fmt` and `deno lint` on the four touched files: clean.
- `./quality.sh` (final head, sixth PR #3160 review round): PASSED (with
  skipped checks — `config integration` skipped, deno/`.config.json`
  unavailable in this environment).

**Branch outcomes:** regenerated from the head for the sixth PR #3160 review
round — every line below gives the current `path:line`, the outcome, the
test that reaches it, and the flip result seen on this head (not carried
over from an earlier round). Every arm of `parseBranchOutcomes`,
`scanRegionText` and `collectEntries` has its own line this round (the
sixth round's own finding against the fifth round's enumeration):

- `worker/deno/lib/phases/completion_phase.ts:2210` — `changedFiles:
  changedFilesKnown ? changedFiles : null` passed into
  `validateBranchOutcomes` —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - an unreadable changed-files diff with a Branch outcomes list naming a missing test blocks PR creation`.
  The pre-existing sibling test (naming an *existing* test) stays green
  under this line's removal — `changedFiles` defaults to `[]` on an
  unreadable diff, which reads as a code-free diff either way, so it never
  actually pins this line. Flipped this line to always pass the plain
  `changedFiles` array (never `null`): the test's status changed from
  `failure` to `continue` (`prCreateCalls` from 0 to 1) — the gate became
  not-applicable instead of fail-closed, so a named test that does not
  exist at HEAD was never checked.
- `completion_phase.ts:2244-2248` — `branchOutcomesBlocked` folded into an
  earlier (closure/independent-review/reproduction-status) gate's
  comment/reason —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a bug issue missing BOTH the Reproduction block and the Branch outcomes list names both in one block`.
  Flipped the `if (branchOutcomesBlocked)` guard to `if (false)`: the test's
  assertion that the one comment also names "Branch outcomes" failed (only
  the Reproduction-status message was present).
- `completion_phase.ts:2403-2412` — the late-gate block's own
  `branchOutcomesBlocked` arm (single-gate failure, outside the fold) —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a code diff with no Branch outcomes list blocks PR creation`.
  Flipped the `if (branchOutcomesBlocked)` guard to `if (false)`: the test
  failed (a downstream retry-prompt builder threw on the now-empty
  `reasons` array, rather than the summary ever being retried).
- `worker/deno/lib/branch_outcomes_gate.ts:168` — `isNoneBody(body)` (then
  `startsWithNone`) → header's region skipped, treated as an honest
  negative —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - 'none added' is recognised as an honest negative`.
  Flipped to `if (false)`: `record.noneDeclared` became `false` for a bare
  `none added` body.
- `branch_outcomes_gate.ts:135` — `NONE_BODY_RE`'s exact-match requirement
  (sixth round: was `/^none\b/i`, a prefix match) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - 'none added this round; ...' is not an honest negative`
  and
  `...'none added; existing <test> covers it' is not an honest negative`.
  Reverted to `/^none\b/i`: both became `noneDeclared: true` instead of
  `false` (confirmed against the base commit directly — see Test Plan).
- `branch_outcomes_gate.ts:175-177` — `headerIndent` ternary (list-item
  header's own indent, or `-1` for every other header shape) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet`.
  Flipped to always `-1`: the sibling bullet `Docs sweep — section: none`
  was wrongly collected as a third entry instead of ending the scan.
- `branch_outcomes_gate.ts:183` — `collected.bodyExtra` push (sixth round:
  no test reached it) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare header followed by a wrapped prose line naming an existing test passes`
  and
  `...a bare header followed by 'none added' on the next line passes`.
  Removing the push: both became blocked ("names no outcomes") instead of
  valid, because `record.body` stayed empty with no list to populate
  `record.entries` either.
- `branch_outcomes_gate.ts:211-227` — `scanRegionText`, scanned into
  `BranchOutcomesRecord.scanText` and read unconditionally by
  `namedTestPaths` (lines 349-350) — fixes the gap the fifth round's
  finding named: a header with inline text and zero collected entries let
  an invented test slip through in three layouts —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a Test Plan bullet header with sibling bullets still names the invented test`,
  `...a markdown table naming the test still names the invented test`, and
  `...a loose list broken by an indented paragraph still names the invented test`.
  The function's own two stopping points are pinned by
  `...the test-path scan stops at a later Branch outcomes header` and
  `...the test-path scan stops at the next markdown heading`, each confirmed
  red with its stop condition removed.
- `branch_outcomes_gate.ts:216` — `scanRegionText`'s deeper-grouping-heading
  skip (sixth round: a `#### path/to/file.ts` sub-heading used to stop the
  scan like any other heading) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a sub-heading before a markdown table still names the invented test`.
  Reverted to stop at any heading: `result.valid` became `true` instead of
  `false` (the markdown-table row with the invented path is never collected
  into `entries` either, so only `scanText` can carry it — isolates this
  line from `collectEntries`' copy of the same fix below).
- `branch_outcomes_gate.ts:243` — `sawBlank` initial state and reset on a
  blank line —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose after a blank line is not merged into the last entry`
  (exercises the combination with the guard at line 273).
- `branch_outcomes_gate.ts:256-257` — `collectEntries`' own
  deeper-grouping-heading skip (sixth round: same gap as line 216, in the
  sibling function) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a heading-form header with a deep grouping sub-heading still finds its list`.
  Reverted to stop at any heading: `result.valid` became `false` instead of
  `true` — a heading-form header's empty inline body means the "names no
  outcomes" check depends only on `entries`, so `scanText` cannot paper
  over the now-empty list (isolates this line from `scanRegionText`'s copy
  of the same fix above).
- `branch_outcomes_gate.ts:261` — the list-item header's own
  `indent <= headerIndent` stop —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet`
  (same test as line 175-177 above; flipped `<=` to `<` here specifically:
  the sibling bullet at the header's own indent was wrongly collected).
- `branch_outcomes_gate.ts:268` — the entry-reset `sawBlank = false;` after
  a list-marker line (sixth round: no test reached it) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - a continuation line after a loose list item joins the newest entry`.
  Removing the reset: `record.entries` became `["a", "b"]` instead of
  `["a", "b cont"]` — the continuation line after entry `b` was dropped
  because `sawBlank` was still `true` from the earlier blank line.
- `branch_outcomes_gate.ts:273` — the continuation branch's `!sawBlank &&
  entries.length > 0` guard —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose after a blank line is not merged into the last entry`.
  Dropped `!sawBlank &&`: `record.entries` became
  `["entry one trailing prose not part of entry one"]` instead of
  `["entry one"]`.
- `branch_outcomes_gate.ts:273` — the same branch's `indent > headerIndent`
  guard (sixth round: no test reached it) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - an unindented lazy line is not joined onto a list-item header's entry`.
  Dropped the condition: `record.entries` became
  `["entry one lazy sibling text"]` instead of `["entry one"]` — an
  unindented line following a list-item header's nested entry was wrongly
  merged onto it instead of ending the scan.
- `branch_outcomes_gate.ts:282` — the `&& wrapping` guard —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare heading with blank-separated prose and no list blocks`.
  Dropped `&& wrapping`: `result.valid` became `true` instead of `false`.
- `branch_outcomes_gate.ts:287` — the `entries.length === 0` fallthrough —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose between two blank lines does not stop the scan before a later list`.
  Changed `continue` to `break`: `record.entries` became `[]` instead of
  `["entry one"]`.
- `branch_outcomes_gate.ts:324` — `./`-prefix stripped by `normaliseToken` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - a ./-prefixed citation is normalised, dropping the ./`.
  Flipped the strip off: `namedTestPaths` returned `[]` instead of the path.
- `branch_outcomes_gate.ts:361` — post-normalisation absolute-path
  token dropped —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - an absolute-path token is not returned`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - a .//-prefixed citation normalises to an absolute path and is dropped`.
  Loosened the guard to `if (!token) continue;`: both tests failed
  (36 passed, 2 failed, see fourth-round note above).
- `branch_outcomes_gate.ts:359` — `MAX_TOKEN_CHARS` cap —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - a token over 300 chars is skipped`.
  Flipped `>` to `> 100_000`: the over-length token was returned, failing the
  `assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"])`.
- `branch_outcomes_gate.ts:367` — `MAX_NAMED_TEST_PATHS` cap —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - more than 50 named test paths are capped at 50`.
  Flipped `>=` to `>= 1_000`: the result length became 60 instead of 50.
- `branch_outcomes_gate.ts:180` — `MAX_ENTRIES` cap (the one that remains
  after the redundant inner check in `collectEntries` was deleted — see
  fifth-round Summary note) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - more than 100 entries are capped at 100`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - MAX_ENTRIES caps the combined total across two headers, not just one list`.
  Removed the check: the single-header test's length became 105; the
  two-header test's length became 120.
- `branch_outcomes_gate.ts:349-350` — `namedTestPaths` scans `record.body`
  and `record.scanText` unconditionally (sixth round: the
  `!record.noneDeclared &&` guards on both lines were deleted as dead code
  — see Summary) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)`
  and
  `...an inline body naming an existing test passes (Issue #3160)`.
  Removing either `if` guard drops the invented path from `namedTests`, so
  the first test's `missingTests` becomes `[]` instead of naming it.
- `branch_outcomes_gate.ts:622` — `lookupTestsAtHead` with `paths.length
  === 0` → empty set, no git call —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - empty paths returns an empty set without calling git`.
  Removing the early return calls `runGit` even for an empty list: the
  test's `assertEquals(called, false)` fails.
- `branch_outcomes_gate.ts:634` — `!result.ok` or non-zero exit → `null`
  (fail closed) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - a failed git invocation returns null`
  and `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - a non-zero exit returns null`.
  Flipped to `if (false)`: both tests' `assertEquals(result, null)` fail
  (the parse of empty `stdout` runs instead, returning an empty set).
- `branch_outcomes_gate.ts:636-641` — success → parsed path set —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - parses stdout lines into the returned set`.
  Returning `new Set()` unconditionally instead: the test's two expected
  paths are missing from the result.
- `branch_outcomes_gate.ts:469` —
  `validateBranchOutcomes` with `changedFiles === null` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - changedFiles null is applicable (fail closed)`.
  Flipped the guard to `if (false)`: the downstream `codeChangingFiles(null)`
  call threw (`Cannot read properties of null (reading 'filter')`), failing
  the test as a crash rather than a flipped boolean.
- `branch_outcomes_gate.ts:474` — `codeFiles.length === 0` → not
  applicable —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable`.
  Flipped `=== 0` to `>= 0`: `result.applicable` became `false` for a diff
  that does change code too, caught by a second case in the same test file
  that asserts `applicable === true` for a code-changing diff.
- `branch_outcomes_gate.ts:501` — `!record.present` → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - missing list blocks when the diff changes code`.
  Flipped to `if (false)`: `result.valid` became `true` instead of `false`.
- `branch_outcomes_gate.ts:508` — empty entries and empty body → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an empty list blocks`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:512` — bare placeholder → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare placeholder blocks`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:516` — named tests present, `testsAtHead ===
  null` → problem (fail closed) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:520-522` — a named test missing at HEAD →
  problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests`;
  all present → valid —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - all named tests present passes`.
  Flipped `if (!testsAtHead.has(path))` to `if (false)`: the missing-test
  case's `missingTests` became `[]` and `result.valid` became `true`.

## Evidence

**Docs sweep** — grep: `foldInDocsSweep`, `foldInLateSummaryGates`, `branch_outcomes_gate`, `Branch outcomes`, `summary_rule_gate_retry`, `docs_sweep_gate`, `result_placeholder_gate`, `lookupTestsAtHead`, "relative to the repository root", "five summary gates", "all five", "summary-rule gate", "placeholder-token gate"; section: `docs/workflows/issue-processing.md#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147`, plus the docs-sweep gate, degraded-delivery guard, "A summary shortfall after the PR is not a failed run", security-gate-ordering and in-run recovery passages of the same file; updated (third PR #3160 review round): that section now says the `git ls-tree` lookup runs from the repository root, so a named path must itself be repository-root-relative. Reviewed and left unchanged: `docs/CONFIGURATION.md` (its placeholder mention covers the PR-reply chokepoint, which this change does not touch) and `docs/audits/security-sweep-2189-summary-rule-gate-retry.md` (a dated audit of #2189). Fifth PR #3160 review round: re-read `docs/workflows/issue-processing.md`'s `#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147` section against this round's change — it states the externally-visible contract (blocks no-list/empty/placeholder/untracked-path) without describing `collectEntries`'/`scanRegionText`'s internal parsing, so that contract is unchanged and the section needed no edit.
