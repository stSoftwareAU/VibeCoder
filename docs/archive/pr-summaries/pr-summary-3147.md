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
  leading-`/` skips in `namedTestPaths` (`branch_outcomes_gate.ts:210, 237,
  239`), and the three fail-open caps `MAX_ENTRIES`, `MAX_TOKEN_CHARS` and
  `MAX_NAMED_TEST_PATHS`. Each is now covered and confirmed red with its arm
  removed (see Test Plan).
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
- `deno test --allow-all tests/branch_outcomes_gate_test.ts
  tests/completion_phase_branch_outcomes_test.ts
  tests/branch_outcomes_record_3147_test.ts` (final head, after the third
  PR #3160 review round): 52 passed, 0 failed.
- `./quality.sh` (final head): PASSED (with skipped checks — `config
  integration` skipped, deno/`.config.json` unavailable in this
  environment).

## Evidence

**Docs sweep** — grep: `foldInDocsSweep`, `foldInLateSummaryGates`, `branch_outcomes_gate`, `Branch outcomes`, `summary_rule_gate_retry`, `docs_sweep_gate`, `result_placeholder_gate`, `lookupTestsAtHead`, "relative to the repository root", "five summary gates", "all five", "summary-rule gate", "placeholder-token gate"; section: `docs/workflows/issue-processing.md#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147`, plus the docs-sweep gate, degraded-delivery guard, "A summary shortfall after the PR is not a failed run", security-gate-ordering and in-run recovery passages of the same file; updated (third PR #3160 review round): that section now says the `git ls-tree` lookup runs from the repository root, so a named path must itself be repository-root-relative. Reviewed and left unchanged: `docs/CONFIGURATION.md` (its placeholder mention covers the PR-reply chokepoint, which this change does not touch) and `docs/audits/security-sweep-2189-summary-rule-gate-retry.md` (a dated audit of #2189).

**Branch outcomes:** none added — this round's production change
(`worker/deno/lib/branch_outcomes_gate.ts`) only edits message and
doc-comment text (the missing-test problem message, the gate comment's item
5, and `lookupTestsAtHead`'s doc comment); it adds no new condition, match
arm or exit path. The round's substantive work is test coverage for
branches that already existed but that no test reached — see Test Plan.
