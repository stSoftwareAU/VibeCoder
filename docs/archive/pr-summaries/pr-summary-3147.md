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
  the call. The comment (now `completion_phase.ts:2192-2198`, renumbered to
  `2248-2254` after the merge with `main` — see merge note below) is
  rewritten to describe the unconditional call.
- This file's Branch outcomes list is regenerated below from the current
  head, covering every arm in `parseBranchOutcomes`, `scanRegionText` and
  `collectEntries` (the sixth round's own finding: the fifth round's
  enumeration had missed six of them) as well as the other gate functions,
  each with the line it is at today and the flip result seen on this head.

A seventh PR #3160 review round found an invented test could still pass
through two ordinary layouts, several conditions still had no test reaching
them, and the sixth round's own enumeration claim was itself inaccurate —
all now fixed:

- The sixth round's fixed `SECTION_HEADING_MAX_LEVEL` (3) was a universal
  depth, not one relative to the header's own section: a `### path/to/
  file.ts` grouping heading directly under a `## Test Plan` section is only
  one level deeper than that section, so the fixed level-3 cutoff still
  wrongly treated it as a boundary and stopped the scan before the list it
  grouped — the same gap, one heading level shallower than the sixth round's
  own fix. `SECTION_HEADING_MAX_LEVEL` is replaced with
  `sectionBoundaryLevel()` (`branch_outcomes_gate.ts:83-87`): the boundary is
  now the level of the nearest heading above the header (or
  `FALLBACK_SECTION_HEADING_LEVEL` (2) when there is none), threaded through
  `scanRegionText` and `collectEntries` as a `boundaryLevel` parameter in
  place of the constant.
- An honest `**Branch outcomes:** none added.` (a full stop, which
  `NONE_BODY_RE`'s punctuation suffix already matched) followed by a
  refreshed list — the review-fix pattern of re-stating the earlier rounds'
  arms under a `none` header — let an invented test through: the `continue`
  in `parseBranchOutcomes`' none branch (`branch_outcomes_gate.ts:199-207`)
  skipped `scanRegionText` entirely, so the list after the honest `none` was
  never scanned for a named test path. The none branch now calls
  `scanRegionText` unconditionally, same as the non-none branch; an honest
  `none` still has empty `entries`/`body`, so it is never blocked as "names
  no outcomes", but a test path in its trailing region is still
  existence-checked.
- Four conditions had no test that failed when flipped: the header-detection
  `continue` (`branch_outcomes_gate.ts:184-188`), the inline-versus-heading
  `body` ternary (`branch_outcomes_gate.ts:196-198`), and the `bodyParts`
  push in both the none branch (`:200`) and the non-none branch (`:210`).
  Four existing tests (not new ones — the review's own probe found each
  already went red) are now cited against each line (see Branch outcomes
  below). Two further conditions got new cases: the `inlineMatch &&`
  conjunct of the `headerIndent` ternary (`:211-213`) — a header that is
  both a list item and a heading (`- ## Branch outcomes`) must keep
  `headerIndent` at `-1`, not the line's own indent — and the heading-form
  half of `scanRegionText`'s header-stop check (`:258-260`) — a later
  `#### Branch outcomes` heading-form header, deeper than the boundary, must
  still end the first header's own scan.
- The dead `wrapping = false;` after a list-item push in `collectEntries`
  (then line 262) is deleted: `entries.length > 0` already shuts the
  `wrapping`-gated branch below it, so the reset was never observable.
- The sixth round's own Branch outcomes list claimed "every arm of
  `parseBranchOutcomes`, `scanRegionText` and `collectEntries` has its own
  line this round", but five of the arms above had none, the line-216 entry
  (now the `sectionBoundaryLevel` entry) reported only the "stop at any
  heading" flip and missed the level-3-under-level-2 gap this round fixes,
  and the blank-line-reset entry cited `:243` for code that was actually at
  `:250-253` at that head. The list below is regenerated again from this
  head, with every citation re-checked against the current file and every
  flip re-run (see Test Plan and Branch outcomes).

An eighth PR #3160 review round found the seventh round's own fix was
itself a regression, plus one of its own new lines had no test:

- `sectionBoundaryLevel(lastHeadingLevel)` took a heading-form header's
  boundary from the heading *above* it, never from the header's own level.
  So an empty `### Branch outcomes` followed by a sibling `###` section (one
  level deeper than the enclosing `##` section, same depth as the header
  itself) was wrongly skipped as a grouping sub-heading instead of ending
  the scan, letting the sibling section's bullets pass as this header's own
  outcomes — exactly the bug the sixth/seventh rounds fixed for an inline
  header's grouping sub-headings, reappearing for a heading-form header's
  own section boundary. `boundaryLevel` (`branch_outcomes_gate.ts:205-208`)
  is now the header's own level when the header is itself a heading, falling
  back to `sectionBoundaryLevel(lastHeadingLevel)` only for an inline header.
- `if (heading) lastHeadingLevel = ownLevel;` (`:209`) had no test: deleting
  it alone (the own-level boundary fix above left intact) left every
  pre-existing test in `branch_outcomes_gate_test.ts` passing. A
  heading-form header's own level must still propagate forward so a
  *later*, inline header's boundary is relative to it.
- The `:296-298`-era Branch outcomes entry (collectEntries' and
  scanRegionText's own dynamic-boundary stops) claimed two existing tests
  pinned `collectEntries`' stop independently of `scanRegionText`'s copy,
  but reverting either site alone left both tests passing — each site's
  copy of the fix covered for the other. Replaced with one test per site
  that cannot be satisfied by the other (see Branch outcomes).

Closes #3147.

## Merge note

Merging `main` into this branch (PR #3160) brought in two unrelated `main`
additions that touched the same two files as this PR, both now reconciled:

- `docs/audits/lib-sweep-coverage.json`: `main` added top-up slices for
  Issue #3178 (`heavy_build_gate.ts`) and Issue #3172 (`docs_sweep_hits.ts`).
  Both are kept alongside this PR's `top-up-3147` slice — an append-only
  ledger, so all three entries survive.
- `worker/deno/lib/phases/completion_phase.ts`: `main`'s Issue #3172 change
  (re-running the Docs sweep line's own grep terms at the head) and this PR's
  three-way `docsSweepBlocked || placeholderBlocked || branchOutcomesBlocked`
  block both touched the same late-gate `if`. The merged block keeps both:
  the three-way array-based combination from this PR, reading `docsSweepComment`
  (not a freshly-built `buildDocsSweepGateComment(docsSweep)`) so a #3172
  stale-hit comment is not silently dropped when that gate is what actually
  blocked. No other hunk in this file conflicted — the earlier `#3172` and
  `#3147` additions (the `let docsSweepBlocked` term-recheck block,
  `branchOutcomesBlocked`, `foldInLateSummaryGates`) landed at non-overlapping
  locations and merged automatically.

This inserted ~56 lines ahead of the Branch-outcomes-related lines this
summary cites in `completion_phase.ts`; every citation into that file below
is updated to the post-merge line number.

### Second merge (PR #3160 conflicting with `main` again)

`main` had since merged Issue #3131 (the removed-assertion gate), which
generalised the two-verdict fold above into a `LateSummaryVerdict`
interface/array (`docsSweepVerdict`, `removedAssertionsVerdict`,
`placeholderVerdict`) and a cascading chain of standalone gate blocks
(docs sweep → removed assertions → placeholder, each folding the ones after
it). This PR's `branchOutcomesBlocked` verdict and its own
`foldInLateSummaryGates` helper conflicted with that generalisation at the
same lines.

Resolved by extending `main`'s array-based design rather than keeping this
PR's separate three-way `if`: `branchOutcomesVerdict` joins the
`LateSummaryVerdict` array as the fourth entry, and the three call sites that
used this PR's `foldInLateSummaryGates` name now call `main`'s
`foldInLateSummaryVerdicts` instead (same behaviour, one name). The late-gate
chain itself is now four cascading standalone blocks — docs sweep, removed
assertions, result placeholder, branch outcomes, in that order — each
folding every still-blocked gate named after it into its own comment, so a
summary failing more than one still gets told about all of them in one
recovery turn. Both sides' gate logic (and their own `logger.warn` detail
fields) survive; only the two different "collect N verdicts then report
once" mechanisms were unified into one.

`docs/workflows/issue-processing.md` and
`worker/deno/tests/completion_phase_head_reconcile_test.ts` conflicted the
same way: the doc's "six summary gates" became "seven" (closure, independent
review, reproduction status, docs sweep, removed test assertions, the
placeholder-token gate, the branch-outcomes gate) in the three places that
list them, and the test fixture's PR-summary text now carries both main's
`## Test Plan` section and this PR's `**Branch outcomes:** none added` line,
so it still satisfies both gates.

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
- A seventh PR #3160 review round added, to `branch_outcomes_gate_test.ts`:
  `'none added.' with a full stop is an honest negative` and `'none:' with
  a colon is an honest negative` pin `NONE_BODY_RE`'s `[.:;!]*` punctuation
  suffix, confirmed red (`noneDeclared` became `false`) with the suffix
  dropped. `'none added.' followed by a refreshed list still names the
  invented test` reproduces the review's repro (b) directly: confirmed red
  (`valid: true, missingTests: []`) both with the base commit's gate and
  with the none branch's `scanRegionText` call (`:205`) removed from this
  head. `a level-3 grouping heading under a level-2 section still names the
  invented test` reproduces repro (a): confirmed red against the base
  commit. `a level-2 heading under a level-1 section does not end the scan`
  pins that the boundary is the *enclosing* heading's own level, not a
  fixed fallback: confirmed red (`valid` became `true` instead of `false`
  — the invented test's citation was cut off along with the rest of the
  list) by forcing `sectionBoundaryLevel()` to always return the level-2
  fallback regardless of its argument (a level-1 section's correct boundary
  of 1 differs from the forced 2, so the level-2 "## Next" heading wrongly
  ends the scan). `a second level-1 heading ends the scan under a
  level-1 section` exercises the honest-`none` branch's own
  `scanRegionText` call in isolation (`collectEntries` never runs for a
  `none` header): confirmed red (`missingTests` gained the unrelated path)
  with `scanRegionText`'s generic heading-level stop (`:256`) disabled
  outright — the same mutation the pre-existing `...stops at the next
  markdown heading` case also catches.
  `a list-item heading-form header still collects a following top-level entry`
  pins the `inlineMatch &&` conjunct of the `headerIndent` ternary (`:211`):
  confirmed red (`entries` became `[]` instead of `["entry one"]`) with the
  conjunct dropped. `the test-path scan stops at a later heading-form
  header, even when deeper than the boundary` pins the
  `BRANCH_OUTCOMES_HEADING_RE.test(stripped)` half of `scanRegionText`'s
  header stop (`:260`): confirmed red (`scanText` gained the second
  header's own heading text and the marker after it) with that half
  dropped. Four existing tests are cited (not added) against the four
  previously-undocumented arms the review named: `absent header reports not
  present` for the header-detection `continue` (`:184-188`, confirmed red —
  `present` became `true`); `an inline body naming a missing test blocks
  (Issue #3160)` for the inline-versus-heading `body` ternary (`:196-198`,
  confirmed red — `missingTests` became `[]`); `'none added' passes` for the
  none branch's `bodyParts` push (`:200`, confirmed red — `valid` became
  `false`); `a bare placeholder blocks` for the non-none branch's
  `bodyParts` push (`:210`, confirmed red — the problem message lost "bare
  placeholder", reporting "names no outcomes" instead). The dead `wrapping =
  false;` after a list-item push in `collectEntries` (then line 262) is
  deleted rather than given a test, because `entries.length > 0` already
  shuts the branch that reads it, so no input can make it change any output.
  `deno test --allow-all tests/branch_outcomes_gate_test.ts
  tests/completion_phase_branch_outcomes_test.ts
  tests/branch_outcomes_record_3147_test.ts` (final head, seventh PR #3160
  review round): 85 passed, 0 failed.
- Eighth PR #3160 review round: fixed the heading-form header's own-level
  boundary (`branch_outcomes_gate.ts:205-209`) and added 5 tests —
  `validateBranchOutcomes - an empty level-3 heading-form header followed by
  a sibling section still blocks` and `...an empty level-2 heading-form
  header under a level-1 title still blocks` reproduce the review's exact
  repro layouts (a) and (b); `...a later inline header's boundary tracks the
  heading-form header's own level` isolates the `:209`
  `lastHeadingLevel = ownLevel` line (deleting it alone, with the own-level
  boundary fix left intact, is confirmed red: `missingTests` gains the
  invented path); `...a level-3 grouping heading under a level-2 section
  still fills entries` and `...still fills scanText` replace the two
  previously-cited tests that did not actually isolate `collectEntries`'
  (`:311`) and `scanRegionText`'s (`:270`) own dynamic-boundary stops from
  each other — each new test is confirmed red with only its own site
  reverted to the old fixed `lvl <= 3`, and green with the other site
  reverted instead. `deno test --allow-all tests/branch_outcomes_gate_test.ts
  tests/completion_phase_branch_outcomes_test.ts
  tests/branch_outcomes_record_3147_test.ts` (final head, eighth PR #3160
  review round): 90 passed, 0 failed.
- `deno fmt` and `deno lint` on `branch_outcomes_gate.ts` and
  `branch_outcomes_gate_test.ts` (eighth round, re-run): clean.
- `./quality.sh` (final head, eighth PR #3160 review round): PASSED (with
  skipped checks — `config integration` skipped, deno/`.config.json`
  unavailable in this environment).

**Branch outcomes:** regenerated from the head for the eighth PR #3160
review round — every line below gives the current `path:line`, the outcome,
the test that reaches it, and the flip result seen on this head (not
carried over from an earlier round; the sixth round's own enumeration had
five arms with no line at all, one line that reported only half of the gap
it covered, and one stale citation — see Summary). This round: fixed the
heading-form header's own-level boundary bug (`:205-208`, `:209` — see
Summary) and resolved the eighth-round review's finding that the two
`:311`/`:270` tests previously cited for `collectEntries` and
`scanRegionText`'s own dynamic-boundary stops did not actually isolate
either site (both passed with either site reverted alone), by replacing
that one shared pair with a dedicated, isolated test per site. Every
`path:line` citation below is also renumbered from the seventh round's
figures to this head, since the fix shifted the file by 14 lines:

- `worker/deno/lib/phases/completion_phase.ts:2266` — `changedFiles:
  changedFilesKnown ? changedFiles : null` passed into
  `validateBranchOutcomes` —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - an unreadable changed-files diff with a Branch outcomes list naming a missing test blocks PR creation`.
  Flipped this line to always pass the plain `changedFiles` array (never
  `null`): the gate became not-applicable instead of fail-closed, so a named
  test that does not exist at HEAD was never checked.
- `completion_phase.ts:2298-2302` — `branchOutcomesBlocked` folded into an
  earlier gate's comment/reason —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a bug issue missing BOTH the Reproduction block and the Branch outcomes list names both in one block`.
  Flipped the `if (branchOutcomesBlocked)` guard to `if (false)`: the test's
  assertion that the one comment also names "Branch outcomes" failed.
- `completion_phase.ts:2462-2471` — the late-gate block's own
  `branchOutcomesBlocked` arm —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - a code diff with no Branch outcomes list blocks PR creation`.
  Flipped the `if (branchOutcomesBlocked)` guard to `if (false)`: the test
  failed (a downstream retry-prompt builder threw on the now-empty
  `reasons` array).
- `branch_outcomes_gate.ts:190-194` — the header-detection `continue` (and
  `lastHeadingLevel` tracking) when a line matches neither header form —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - absent header reports not present`.
  Removing the `continue`: `record.present` became `true` instead of
  `false` (every line fell through into header handling).
- `branch_outcomes_gate.ts:205-208` — `boundaryLevel`, now the
  heading-form header's own level when it is a heading, falling back to
  `sectionBoundaryLevel(lastHeadingLevel)` only for an inline header
  (eighth round: a heading-form header's boundary used to come from the
  heading *above* it, so an empty `### Branch outcomes` followed by a
  sibling `###` section was swallowed into that section's bullets, passing
  where the previous head blocked it — PR #3160 review) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an empty level-3 heading-form header followed by a sibling section still blocks`
  and
  `...an empty level-2 heading-form header under a level-1 title still blocks`
  (both reproduce the review's exact layouts (a) and (b); confirmed red
  against this head with the own-level branch reverted to the old
  `sectionBoundaryLevel(lastHeadingLevel)`-only formula — `valid` became
  `true` instead of `false` for both).
- `branch_outcomes_gate.ts:209` — `if (heading) lastHeadingLevel =
  ownLevel;`, carrying a heading-form header's own level forward as the
  "nearest heading above" for whichever header comes next (PR #3160
  review, eighth round: had no test) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a later inline header's boundary tracks the heading-form header's own level`.
  Deleting the line alone (the own-level fix above left intact): `missingTests`
  gained the invented path instead of staying empty.
- `branch_outcomes_gate.ts:210-212` — the inline-versus-heading `body`
  ternary —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)`.
  Forcing `body` to always `""`: `missingTests` became `[]` instead of
  naming the invented test.
- `branch_outcomes_gate.ts:213-221` — `isNoneBody(body)` → honest-`none`
  branch, now also scanning the trailing region (seventh round: `continue`
  no longer skips `scanRegionText`) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - 'none added' is recognised as an honest negative`
  (the branch itself; flipped to `if (false)`: `record.noneDeclared` became
  `false`) and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - 'none added.' followed by a refreshed list still names the invented test`
  (the fixed gap; confirmed red both against the base commit and by
  removing only the `:219` `scanRegionText` push from this head — `valid`
  became `true` instead of `false` either way).
- `branch_outcomes_gate.ts:214` — `if (body) bodyParts.push(body);` inside
  the none branch —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - 'none added' passes`.
  Removing the push: `result.valid` became `false` instead of `true` (the
  now-empty `body` tripped the "names no outcomes" block).
- `branch_outcomes_gate.ts:223-224` — `onlyNone = false;` and the non-none
  branch's own `bodyParts.push(body)` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare placeholder blocks`.
  Removing the push: the problem message lost "bare placeholder", reporting
  "names no outcomes" instead — `body` never reached `isBarePlaceholder`.
- `branch_outcomes_gate.ts:225-227` — `headerIndent` ternary, including the
  `inlineMatch &&` conjunct (seventh round: the conjunct had no test) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet`
  (whole ternary; flipped to always `-1`: the sibling bullet was wrongly
  collected as a third entry) and
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - a list-item heading-form header still collects a following top-level entry`
  (the `inlineMatch &&` conjunct alone; dropped it: `record.entries` became
  `[]` instead of `["entry one"]`).
- `branch_outcomes_gate.ts:228-235` — `collectEntries`/`scanRegionText`
  calls, the `MAX_ENTRIES` copy cap, and the `collected.bodyExtra` push —
  see the `MAX_ENTRIES`, deeper-grouping-heading and `bodyExtra` entries
  below.
- `branch_outcomes_gate.ts:270` — `scanRegionText`'s generic
  section-boundary stop, now reading the per-call `boundaryLevel` rather
  than a fixed depth —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - the test-path scan stops at the next markdown heading`
  and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a second level-1 heading ends the scan under a level-1 section`
  (isolates the honest-`none` branch's own call, where `collectEntries`
  never runs), and
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a level-3 grouping heading under a level-2 section still fills scanText`
  (isolates it from `collectEntries`' copy of the same check using a
  markdown table row, which `collectEntries` never turns into an entry;
  eighth round, added because the two "level-3 grouping heading" tests
  below pass with either site reverted alone — see the `:311` entry).
  Disabling the stop outright: all three tests failed (an unrelated later
  mention was swept into `scanText`).
- `branch_outcomes_gate.ts:272-277` — `scanRegionText`'s header stop,
  both the inline (`BRANCH_OUTCOMES_PREFIX_RE`) and heading-form
  (`BRANCH_OUTCOMES_HEADING_RE`) halves —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - the test-path scan stops at a later Branch outcomes header`
  (inline half) and
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - the test-path scan stops at a later heading-form header, even when deeper than the boundary`
  (heading-form half; seventh round: had no test). Dropping the heading-form
  half: `record.scanText` gained the second header's own heading text and
  the marker line after it, instead of stopping before them.
- `branch_outcomes_gate.ts:305-308` — `sawBlank` initial state and reset on
  a blank line (corrects the sixth round's stale `:243` citation) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose after a blank line is not merged into the last entry`
  (exercises the combination with the guard at line 331).
- `branch_outcomes_gate.ts:311` — `collectEntries`' own generic
  section-boundary stop, now reading the per-call `boundaryLevel` rather
  than a fixed depth —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a level-3 grouping heading under a level-2 section still fills entries`
  (eighth round, replaces the two "level-3 grouping heading"/"level-2
  heading" tests previously cited here: those two pass with either this
  line or the `:270` entry's stop reverted alone — confirmed by reverting
  each independently against this head and running
  `branch_outcomes_gate_test.ts` alone, 73 passed/1 failed both times, but
  neither of the two previously-cited tests was the one that failed — so
  neither test actually pinned this line on its own. This test's header
  has an empty body, so "names no outcomes" depends only on `entries`;
  `scanText` finds the same citation here too, but is never consulted once
  `entries` is non-empty). Hardcoding `lvl <= 3` here alone: `entries`
  became `[]` and `result.valid` became `false` instead of `true`.
- `branch_outcomes_gate.ts:312` — the deeper-grouping-heading skip itself —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a heading-form header with a deep grouping sub-heading still finds its list`
  (reverted to stop at any heading: `result.valid` became `false` instead
  of `true`).
- `branch_outcomes_gate.ts:315-316` — the list-item header's own
  `indent <= headerIndent` stop —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet`
  (flipped `<=` to `<`: the sibling bullet at the header's own indent was
  wrongly collected).
- `branch_outcomes_gate.ts:317-325` — the list-marker entry push (seventh
  round: the dead `wrapping = false;` reset here is deleted —
  `entries.length > 0` already shuts the branch that reads `wrapping`, so no
  input could make it change any output) and the entry-reset
  `sawBlank = false;` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - a continuation line after a loose list item joins the newest entry`.
  Removing the `sawBlank` reset: `record.entries` became `["a", "b"]`
  instead of `["a", "b cont"]`.
- `branch_outcomes_gate.ts:331` — the continuation branch's `!sawBlank &&
  entries.length > 0` and `indent > headerIndent` guards —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose after a blank line is not merged into the last entry`
  (`!sawBlank &&`; dropped it: `record.entries` became `["entry one
  trailing prose not part of entry one"]`) and
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - an unindented lazy line is not joined onto a list-item header's entry`
  (`indent > headerIndent`; dropped it: `record.entries` became `["entry
  one lazy sibling text"]`).
- `branch_outcomes_gate.ts:340` — the `entries.length === 0 && wrapping`
  guard —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare heading with blank-separated prose and no list blocks`.
  Dropped `&& wrapping`: `result.valid` became `true` instead of `false`.
- `branch_outcomes_gate.ts:345` — the `entries.length === 0` fallthrough —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - prose between two blank lines does not stop the scan before a later list`.
  Changed `continue` to `break`: `record.entries` became `[]` instead of
  `["entry one"]`.
- `branch_outcomes_gate.ts:233` — `collected.bodyExtra` push —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare header followed by a wrapped prose line naming an existing test passes`
  and
  `...a bare header followed by 'none added' on the next line passes`.
  Removing the push: both became blocked ("names no outcomes") instead of
  valid.
- `branch_outcomes_gate.ts:230` — the `MAX_ENTRIES` copy cap (the one that
  remains after the redundant inner check in `collectEntries` was deleted) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - more than 100 entries are capped at 100`
  and
  `...MAX_ENTRIES caps the combined total across two headers, not just one list`.
  Removed the check: the single-header test's length became 105; the
  two-header test's length became 120.
- `branch_outcomes_gate.ts:382` — `./`-prefix stripped by `normaliseToken` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - a ./-prefixed citation is normalised, dropping the ./`.
  Flipped the strip off: `namedTestPaths` returned `[]` instead of the path.
- `branch_outcomes_gate.ts:418` — post-normalisation absolute-path token
  dropped —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - an absolute-path token is not returned`
  and
  `...a .//-prefixed citation normalises to an absolute path and is dropped`.
  Loosened the guard to `if (!token) continue;`: both tests failed.
- `branch_outcomes_gate.ts:416` — `MAX_TOKEN_CHARS` cap —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - a token over 300 chars is skipped`.
  Flipped `>` to `> 100_000`: the over-length token was returned.
- `branch_outcomes_gate.ts:424` — `MAX_NAMED_TEST_PATHS` cap —
  `worker/deno/tests/branch_outcomes_gate_test.ts::namedTestPaths - more than 50 named test paths are capped at 50`.
  Flipped `>=` to `>= 1_000`: the result length became 60 instead of 50.
- `branch_outcomes_gate.ts:406-407` — `namedTestPaths` scans `record.body`
  and `record.scanText` unconditionally —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)`
  and
  `...an inline body naming an existing test passes (Issue #3160)`.
  Removing either `if` guard: the first test's `missingTests` became `[]`.
- `branch_outcomes_gate.ts:679` — `lookupTestsAtHead` with `paths.length
  === 0` → empty set, no git call —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - empty paths returns an empty set without calling git`.
  Removing the early return: `runGit` is called even for an empty list.
- `branch_outcomes_gate.ts:691` — `!result.ok` or non-zero exit → `null`
  (fail closed) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - a failed git invocation returns null`
  and `...a non-zero exit returns null`.
  Flipped to `if (false)`: both tests' `assertEquals(result, null)` fail.
- `branch_outcomes_gate.ts:693-698` — success → parsed path set —
  `worker/deno/tests/branch_outcomes_gate_test.ts::lookupTestsAtHead - parses stdout lines into the returned set`.
  Returning `new Set()` unconditionally instead: the two expected paths are
  missing from the result.
- `branch_outcomes_gate.ts:526` — `validateBranchOutcomes` with
  `changedFiles === null` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - changedFiles null is applicable (fail closed)`.
  Flipped the guard to `if (false)`: `codeChangingFiles(null)` threw.
- `branch_outcomes_gate.ts:531` — `codeFiles.length === 0` → not
  applicable —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable`.
  Flipped `=== 0` to `>= 0`: `result.applicable` became `false` for a
  code-changing diff too.
- `branch_outcomes_gate.ts:558` — `!record.present` → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - missing list blocks when the diff changes code`.
  Flipped to `if (false)`: `result.valid` became `true` instead of `false`.
- `branch_outcomes_gate.ts:565` — empty entries and empty body → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - an empty list blocks`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:569` — bare placeholder → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare placeholder blocks`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:573` — named tests present, `testsAtHead ===
  null` → problem (fail closed) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)`.
  Flipped the condition to `false`: `result.valid` became `true`.
- `branch_outcomes_gate.ts:579` — a named test missing at HEAD → problem —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests`;
  all present → valid —
  `...all named tests present passes`.
  Flipped `if (!testsAtHead.has(path))` to `if (false)`: the missing-test
  case's `missingTests` became `[]` and `result.valid` became `true`.
- `branch_outcomes_gate.ts:162` — `NONE_BODY_RE`'s `[.:;!]*` punctuation
  suffix (seventh round: had no test) —
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - 'none added.' with a full stop is an honest negative`
  and `...'none:' with a colon is an honest negative`.
  Dropping the suffix: both became `noneDeclared: false` instead of `true`.
  The `NONE_BODY_RE` exact-match requirement itself (not a prefix match) is
  pinned by
  `worker/deno/tests/branch_outcomes_gate_test.ts::parseBranchOutcomes - 'none added this round; ...' is not an honest negative`
  and
  `...'none added; existing <test> covers it' is not an honest negative`
  (confirmed against the base commit directly — see Test Plan).

## Evidence

**Docs sweep** — grep: `foldInDocsSweep`, `foldInLateSummaryGates`, `branch_outcomes_gate`, `Branch outcomes`, `summary_rule_gate_retry`, `docs_sweep_gate`, `result_placeholder_gate`, `lookupTestsAtHead`, "relative to the repository root", "five summary gates", "all five", "summary-rule gate", "placeholder-token gate"; section: `docs/workflows/issue-processing.md#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147`, plus the docs-sweep gate, degraded-delivery guard, "A summary shortfall after the PR is not a failed run", security-gate-ordering and in-run recovery passages of the same file; updated (third PR #3160 review round): that section now says the `git ls-tree` lookup runs from the repository root, so a named path must itself be repository-root-relative. Reviewed and left unchanged: `docs/CONFIGURATION.md` (its placeholder mention covers the PR-reply chokepoint, which this change does not touch) and `docs/audits/security-sweep-2189-summary-rule-gate-retry.md` (a dated audit of #2189). Fifth PR #3160 review round: re-read `docs/workflows/issue-processing.md`'s `#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147` section against this round's change — it states the externally-visible contract (blocks no-list/empty/placeholder/untracked-path) without describing `collectEntries`'/`scanRegionText`'s internal parsing, so that contract is unchanged and the section needed no edit. Seventh PR #3160 review round: re-read the same section again — grepped for `SECTION_HEADING_MAX_LEVEL`, "level 3" and "level-3" across `docs/workflows/issue-processing.md`, `CODING-STANDARDS.md` and every `prompts/*/prompt.md`, no hits — the fixed-versus-relative heading-boundary depth is purely internal to `scanRegionText`/`collectEntries` and was never documented at this level, so this round's fix needed no doc edit either; the section's own externally-visible claim (blocks a list naming a test path not tracked at HEAD) is still true, and the gate now enforces it in two more layouts it previously missed. Eighth PR #3160 review round: re-checked the same section's "blocks ... an empty one" claim against this round's fix — the section already states the externally-visible contract generically (an empty list is blocked), and the bug fixed this round was purely an implementation defect that failed to honour that contract for a heading-form header followed by a sibling section, not a gap in the documented contract itself, so no edit was needed.
