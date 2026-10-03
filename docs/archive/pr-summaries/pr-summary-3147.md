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

- Three branches had no test reaching them: the `!changedFilesKnown` arm of
  `branchOutcomesApplicable` (`completion_phase.ts:2145`), the `./`-strip and
  leading-`/` skip in `namedTestPaths` (`branch_outcomes_gate.ts:210, 239`),
  and the three fail-open caps `MAX_ENTRIES`, `MAX_TOKEN_CHARS` and
  `MAX_NAMED_TEST_PATHS`. Each is now covered and confirmed red with its arm
  removed (see Test Plan). A fourth PR #3160 review round found that the raw-
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
  had no test); `MAX_ENTRIES`, `MAX_TOKEN_CHARS` and `MAX_NAMED_TEST_PATHS`
  are each pinned by a case that exceeds the cap; and the missing-test
  problem message and `buildBranchOutcomesGateComment` both now assert they
  name the repository-root requirement. Each new case was confirmed red
  with its arm removed — removing all three normalisation arms, or any one
  of the three caps, failed the corresponding new test while the rest of
  the suite stayed green. To `completion_phase_branch_outcomes_test.ts`: a
  case mocks `diff --name-only <base>...HEAD` failing while the
  changed-workflow gate's own `--diff-filter=ACMR` diff still succeeds,
  with a summary naming an existing test — the one scenario that reaches
  the `!changedFilesKnown` arm of `branchOutcomesApplicable`. Confirmed red
  (status `failure` instead of `continue`) with that arm removed.
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
- `deno test --allow-all tests/branch_outcomes_gate_test.ts
  tests/completion_phase_branch_outcomes_test.ts
  tests/branch_outcomes_record_3147_test.ts` (final head, after the fourth
  PR #3160 review round): 53 passed, 0 failed.
- `deno fmt` and `deno lint` on the two touched files: clean.
- `./quality.sh` (final head, fourth PR #3160 review round): PASSED (with
  skipped checks — `config integration` skipped, deno/`.config.json`
  unavailable in this environment).

**Branch outcomes:** (moved here from the Evidence section per the fourth
PR #3160 review round — the rule puts this list in the Test Plan, and a
diff that adds the enumeration artefact itself must not say it added no
branch). Covers every branch `completion_phase.ts` and
`branch_outcomes_gate.ts` add across this PR, not only this round's commits:

- `worker/deno/lib/phases/completion_phase.ts:2145` — `branchOutcomesApplicable`
  true via `!changedFilesKnown` (diff unreadable) —
  `worker/deno/tests/completion_phase_branch_outcomes_test.ts::completion - an unreadable changed-files diff with a Branch outcomes list naming an existing test still raises the PR`
  — confirmed red with that arm removed (status `failure` instead of
  `continue`; see Test Plan).
- `worker/deno/lib/phases/completion_phase.ts:2146` — applicable via
  `codeChangingFiles(changedFiles).length > 0` —
  `tests/completion_phase_branch_outcomes_test.ts::completion - a code diff with no Branch outcomes list blocks PR creation`.
- `completion_phase.ts:2147-2149` — not applicable → `[]` named tests (no
  git lookup needed) —
  `tests/completion_phase_branch_outcomes_test.ts::completion - a docs-only diff with no Branch outcomes list raises the PR`.
- `completion_phase.ts:2150-2155` — named tests present → `lookupTestsAtHead`
  called, vs none named → `new Set()` with no git call —
  `tests/completion_phase_branch_outcomes_test.ts::completion - 'none added' raises the PR`
  (no-call path) and
  `::completion - a Branch outcomes list naming only an existing test raises the PR`
  (call path).
- `completion_phase.ts:2191-2196` — `branchOutcomesBlocked` folded into an
  earlier gate's comment/reason —
  `tests/completion_phase_branch_outcomes_test.ts::completion - a code diff missing BOTH the Docs sweep line and the Branch outcomes list names both in one block (Issue #3160)`
  — confirmed red against the reviewer's `branchOutcomesBlocked &&
  reasons.length === 0` mutation at `completion_phase.ts:2350` (see Test
  Plan).
- `completion_phase.ts:2350-2358` — the late-gate block's own
  `branchOutcomesBlocked` arm (single-gate failure, no fold) —
  `tests/completion_phase_branch_outcomes_test.ts::completion - a code diff with no Branch outcomes list blocks PR creation`.
- `worker/deno/lib/branch_outcomes_gate.ts:346` —
  `validateBranchOutcomes` with `changedFiles === null` —
  `worker/deno/tests/branch_outcomes_gate_test.ts::validateBranchOutcomes - changedFiles null is applicable (fail closed)`.
- `branch_outcomes_gate.ts:351` — `codeFiles.length === 0` → not
  applicable —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable`.
- `branch_outcomes_gate.ts:378` — `!record.present` → problem —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - missing list blocks when the diff changes code`.
- `branch_outcomes_gate.ts:385` — `record.noneDeclared` → valid —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - 'none added' passes`.
- `branch_outcomes_gate.ts:387` — empty entries and empty body → problem —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - an empty list blocks`.
- `branch_outcomes_gate.ts:391` — bare placeholder → problem —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - a bare placeholder blocks`.
- `branch_outcomes_gate.ts:395` — named tests present, `testsAtHead ===
  null` → problem (fail closed) —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)`.
- `branch_outcomes_gate.ts:399-412` — a named test missing at HEAD →
  problem —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests`;
  all present → valid —
  `::validateBranchOutcomes - all named tests present passes`.
- `branch_outcomes_gate.ts:210` — `./`-prefix stripped by `normaliseToken` —
  `branch_outcomes_gate_test.ts::namedTestPaths - a ./-prefixed citation is normalised, dropping the ./`.
- `branch_outcomes_gate.ts:238` — post-normalisation absolute-path token
  dropped —
  `branch_outcomes_gate_test.ts::namedTestPaths - an absolute-path token is not returned`
  and
  `::namedTestPaths - a .//-prefixed citation normalises to an absolute path and is dropped`
  — confirmed red this round with the guard loosened to `if (!token)
  continue;` (36 passed, 2 failed; see Test Plan). The redundant raw-token
  skip this finding was about (then line 237) is deleted — it was dead code,
  never reached by an input the line-238 guard did not already catch.
- `branch_outcomes_gate.ts:197` / `236` — `MAX_TOKEN_CHARS` cap —
  `branch_outcomes_gate_test.ts::namedTestPaths - a token over 300 chars is skipped`.
- `branch_outcomes_gate.ts:200` / `245` — `MAX_NAMED_TEST_PATHS` cap —
  `branch_outcomes_gate_test.ts::namedTestPaths - more than 50 named test paths are capped at 50`.
- `branch_outcomes_gate.ts` `collectEntries`/`capEntry` — `MAX_ENTRIES` cap —
  `branch_outcomes_gate_test.ts::parseBranchOutcomes - more than 100 entries are capped at 100`.
- `branch_outcomes_gate.ts:227` — the inline body is scanned when
  `!record.noneDeclared && record.body` —
  `branch_outcomes_gate_test.ts::validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)`
  and
  `::validateBranchOutcomes - an inline body naming an existing test passes (Issue #3160)`.
- `branch_outcomes_gate.ts:501` — `lookupTestsAtHead` with `paths.length
  === 0` → empty set, no git call —
  `branch_outcomes_gate_test.ts::lookupTestsAtHead - empty paths returns an empty set without calling git`.
- `branch_outcomes_gate.ts:513` — `!result.ok` or non-zero exit → `null`
  (fail closed) —
  `branch_outcomes_gate_test.ts::lookupTestsAtHead - a failed git invocation returns null`
  and `::lookupTestsAtHead - a non-zero exit returns null`.
- `branch_outcomes_gate.ts:515-520` — success → parsed path set —
  `branch_outcomes_gate_test.ts::lookupTestsAtHead - parses stdout lines into the returned set`.

Each listed outcome was confirmed red with its arm removed or its guard
loosened, as recorded against the corresponding change in the Test Plan
entries above (third and fourth PR #3160 review rounds); the `.//`-prefix
case was reverified this round (see above).

## Evidence

**Docs sweep** — grep: `foldInDocsSweep`, `foldInLateSummaryGates`, `branch_outcomes_gate`, `Branch outcomes`, `summary_rule_gate_retry`, `docs_sweep_gate`, `result_placeholder_gate`, `lookupTestsAtHead`, "relative to the repository root", "five summary gates", "all five", "summary-rule gate", "placeholder-token gate"; section: `docs/workflows/issue-processing.md#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147`, plus the docs-sweep gate, degraded-delivery guard, "A summary shortfall after the PR is not a failed run", security-gate-ordering and in-run recovery passages of the same file; updated (third PR #3160 review round): that section now says the `git ls-tree` lookup runs from the repository root, so a named path must itself be repository-root-relative. Reviewed and left unchanged: `docs/CONFIGURATION.md` (its placeholder mention covers the PR-reply chokepoint, which this change does not touch) and `docs/audits/security-sweep-2189-summary-rule-gate-retry.md` (a dated audit of #2189).
