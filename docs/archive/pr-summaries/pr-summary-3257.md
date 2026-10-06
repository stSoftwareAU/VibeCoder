## Summary

Adds a claim check to the completion phase that runs on a **first-run** PR
summary before the PR is raised. Until now the #3143 drift check
(`pr_feedback_drift_check.ts`) was the only check that compared summary
sentences with the code, and it runs only on review-fix pushes. Closes #3257.

- **New module `worker/deno/lib/summary_claim_check.ts`.** It runs two
  independent checks and returns one result:
  1. One constrained, read-only model question
     (`buildSummaryClaimQuestionPrompt`, built on the drift check's shared
     `renderDriftVerdictQuestion`). It asks the model to run
     `git diff <base>...HEAD` and to quote every sentence in the summary file
     that names a function, file, test, regex or pattern and is false about
     it at the head. An illustrative "for example `X`" counts as a claim. A
     finding blocks only when its `file` is the summary path and
     `sentenceFoundIn` finds its sentence in the summary's own text. Any other
     finding is logged as unconfirmed and ignored.
  2. A deterministic Test Plan backstop (`findTestPlanClaimProblems`). In
     `## Test Plan`, a quoted behaviour attached to a backticked test-file
     reference must share at least half of its significant words with a test
     declaration in that file, or with the file's preamble. A named test file
     that is not tracked at the head also blocks.
- If a check cannot run, it is recorded in `notChecked` and never blocks.
  That covers an unresolvable base ref, a question that fails to launch, an
  unreadable verdict, an ambiguous, unreadable or oversized test file, a file
  with no recognised test declaration, and the 50-claim cap.
- **Completion phase (`worker/deno/lib/phases/completion_phase.ts`).** When a
  summary file with content was loaded, `completionBody` runs
  `runSummaryClaimCheck`. Its verdict is the fifth late-summary verdict, after
  branch outcomes. It folds into whichever summary gate blocks first. On its
  own it blocks through `reportSummaryRuleBlock`, which gives the existing one
  recovery turn. The branch-outcomes gate now folds the claim-check verdict
  into its own block.
- **Seam (`worker/deno/lib/issue_worker_wiring.ts`).**
  `ClaudeDeps.runSummaryClaimQuestion` is wired to `runClaudeWithRetry` in
  production. In `createMockDeps` it fails by default, so tests that say
  nothing about the claim check are unaffected.
- **Shared code.** `pr_feedback_drift_check.ts` now builds
  `buildDriftQuestionPrompt` through the new `renderDriftVerdictQuestion` and
  exports `sentenceFoundIn`. `test_plan_recount.ts` exports `logicalBlocks`.
  The review-fix drift question renders exactly as before.
- **Prompt and standards.** `prompts/issue/prompt.md` and `CODING-STANDARDS.md`
  now say that an illustrative example is a claim too. They also say that a
  Test Plan bullet quoting a behaviour must name the covering test, and that
  the worker checks these claims before raising the PR.
- **Registration.** `summary_claim_check.ts` is added to the
  lib-sweep ledger (`docs/audits/lib-sweep-coverage/top-up-3257.json`), and
  `tests/summary_claim_check_test.ts` is added to `WALL_CLOCK_TEST_FILES`
  because it carries hostile-input growth checks.

## Evidence

**Docs sweep** — grep: `summary_claim_check`, `renderDriftVerdictQuestion`, `sentenceFoundIn`, `logicalBlocks`, `runSummaryClaimQuestion`, `pr_feedback_drift_check`, "seven summary", "summary gates", "summary-rule gate", "late-summary", "drift check"; section: `docs/workflows/issue-processing.md#-a-summary-that-describes-named-code-wrongly-blocks-the-pr-issue-3257` (new), plus the docs-sweep, degraded-delivery, summary-shortfall and in-run-recovery sections of the same manual that count the summary gates; updated: `docs/workflows/issue-processing.md`, `docs/INTERNALS.md`, `CODING-STANDARDS.md`, `prompts/issue/prompt.md`; `docs/workflows/pr-feedback.md#the-workers-drift-check-issue-3143` — still true because the review-fix question's wording is unchanged; `DESIGN-PRINCIPLES.md` "A finished PR with an unfinished summary is not a failed run" — still true because its "all three" counts the closure, review and reproduction gates the security gate precedes, which this diff does not change

**Branch outcomes:**
- `worker/deno/lib/summary_claim_check.ts:80` — accepted (`.pr_summary` path) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - the same args with a valid issue number do not throw` — flipped to rejected, test went red
- `worker/deno/lib/summary_claim_check.ts:111` — error (flag-shaped base ref) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a flag-shaped base ref` — only goes red when both the pattern check and the leading-`-` check on line 113 are removed, because either one rejects `--output=/tmp/x`. The leading-`-` and leading-`/` checks (lines 113–114) are each unreached on their own: removing either alone left the suite green
- `worker/deno/lib/summary_claim_check.ts:112` — error (base ref containing `..`) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a base ref containing '..'` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:120` — error (unrecognised summary path) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on an unrecognised summary path` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — error (zero issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a zero issue number` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — error (non-integer issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a non-integer issue number` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — success (valid issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - the same args with a valid issue number do not throw` — flipped to error, test went red
- `worker/deno/lib/summary_claim_check.ts:131` — pinned nonce (valid `boundaryId`) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - builds a well-formed question` — flipped to a freshly minted nonce, test went red
- `worker/deno/lib/summary_claim_check.ts:320` — absent (no recognised test declaration) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a tracked test file with no recognised test declaration is notChecked, no problem` — flipped to one empty segment, test went red
- `worker/deno/lib/summary_claim_check.ts:376`, `:377`, `:378` — reference cleanup (strip a `::test` suffix, strip a `:line` suffix, reject a span containing whitespace) — no test reaches these: removing each one left the suite green
- `worker/deno/lib/summary_claim_check.ts:392` — no span between (adjacent positions) — no test reaches it: flipping the early return left the suite green
- `worker/deno/lib/summary_claim_check.ts:415` — preceding reference with an intervening backtick span is not attached — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an error message across an intervening backtick span must not attach to the preceding test file (pr-summary-3178-shaped)` — flipped to attach regardless, test went red
- `worker/deno/lib/summary_claim_check.ts:415` — attached to the preceding reference — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` (and the other backstop tests) — flipped to never attach, test went red
- `worker/deno/lib/summary_claim_check.ts:425` — attached to the following reference, with or without an intervening span — no test reaches it: the pr-summary-599-shaped test asserts only on the preceding file, and both flips (never attach, attach regardless) left the suite green
- `worker/deno/lib/summary_claim_check.ts:442` — resolved (exact tracked path) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` — flipped to unresolved, test went red
- `worker/deno/lib/summary_claim_check.ts:445` — resolved (unique basename suffix) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a bare basename resolves by unique suffix` — flipped to unresolved, test went red
- `worker/deno/lib/summary_claim_check.ts:446` — absent (untracked file → missing-file problem) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a missing file is a missing-file problem` — flipped to ambiguous, test went red
- `worker/deno/lib/summary_claim_check.ts:447` — ambiguous basename → not checked — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an ambiguous basename is notChecked, no problem` — flipped to missing, test went red
- `worker/deno/lib/summary_claim_check.ts:474` — absent (block names no test file) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a block with no test path is ignored` — flipped to a problem, test went red
- `worker/deno/lib/summary_claim_check.ts:478` — empty quote — no test reaches it: removing the skip left the suite green
- `worker/deno/lib/summary_claim_check.ts:481` — ignored (fewer than two significant words) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a one-significant-word quote is ignored` — flipped to checked, test went red
- `worker/deno/lib/summary_claim_check.ts:486` — not a coverage claim (no qualifying reference) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an error message across an intervening backtick span must not attach to the preceding test file (pr-summary-3178-shaped)` — flipped to a problem, test went red
- `worker/deno/lib/summary_claim_check.ts:488`, `:552` — cap reached → skipped claims reported as not checked — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a cap of 50 claims reports the unchecked count` — flipped each guard off, test went red
- `worker/deno/lib/summary_claim_check.ts:516` — error (unreadable file → not checked) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - readFile returning undefined for a tracked file is notChecked, no problem` — flipped to read through, test went red
- `worker/deno/lib/summary_claim_check.ts:516` — error (file over the size cap → not checked) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a test file over MAX_TEST_FILE_CHARS is notChecked, no problem` — flipped to read through, test went red
- `worker/deno/lib/summary_claim_check.ts:536` — skipped (file not checkable) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - readFile returning undefined for a tracked file is notChecked, no problem` (with the oversized and no-declaration tests) — flipped to a problem, those tests went red
- `worker/deno/lib/summary_claim_check.ts:540` — covered by the preamble (shared fixture) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a shared fixture in the file's preamble confirms the claim (pr-summary-1549/3222-shaped)` — flipped to segments only, test went red
- `worker/deno/lib/summary_claim_check.ts:541` — no-matching-test problem — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:541` — covered (no problem) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a matching Deno.test name confirms the claim, no problem` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:276`, `:285`, `:293`, `:247`, `:265` — word matching (≥4-char prefix match, empty quote counts as covered, half-the-words threshold, stemming, stopword drop) — no test reaches these: each flip (no prefix match, empty → uncovered, all words required, no stemming, keep stopwords) left the suite green
- `worker/deno/lib/summary_claim_check.ts:564` — wording (missing-file vs no-matching-test description) — no test reaches the missing-file wording: swapping the two descriptions left the suite green
- `worker/deno/lib/summary_claim_check.ts:590` — blocked (confirmed model finding) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - #3252-shaped confirmed finding blocks` — flipped to Test Plan problems only, test went red
- `worker/deno/lib/summary_claim_check.ts:590` — blocked (Test Plan problem) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a Test Plan bullet citing a behaviour no test covers blocks; the recovery quotes a covered behaviour and the PR is raised` — flipped to findings only, test went red
- `worker/deno/lib/summary_claim_check.ts:638` — error (git could not run → backstop skipped, question still asked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - runGit returning null skips the Test Plan backstop but still asks the model question` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:638` — error (non-zero `ls-files` exit) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a non-zero ls-files exit code skips the Test Plan backstop but still asks the model question` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:638` — success (backstop runs) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - contrast: ls-files succeeding yields the missing-file problem the above two tests skip` — flipped to always skip, test went red
- `worker/deno/lib/summary_claim_check.ts:665` — backstop not-checked reasons forwarded into the result — no test reaches it through `runSummaryClaimCheck`: dropping the forwarding left the suite green
- `worker/deno/lib/summary_claim_check.ts:677` — absent (null base ref → question never asked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a null baseRef never calls askQuestion` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:691` — error (prompt could not be built → not checked) — no test reaches it: dropping the `notChecked` entry left the suite green
- `worker/deno/lib/summary_claim_check.ts:699` — error (question failed → not checked, no block) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - askQuestion error is notChecked, not blocked` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:712` — error (no verdict block → not checked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a reply with no verdict block is notChecked` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:723` — unconfirmed (finding names another file) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a finding naming another file is unconfirmed` — flipped to confirmed, test went red
- `worker/deno/lib/summary_claim_check.ts:724` — unconfirmed (sentence not in the summary) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a misquoted sentence is unconfirmed, not blocked` — flipped to confirmed, test went red
- `worker/deno/lib/summary_claim_check.ts:725` — confirmed finding — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - #3252-shaped confirmed finding blocks` — inverted, test went red
- `worker/deno/lib/summary_claim_check.ts:761` — reason from the first finding, else the first Test Plan quote — no test reaches the fallbacks: `summaryClaimBlockReason - starts with the expected prefix` checks only the prefix, and dropping either source left the suite green
- `worker/deno/lib/phases/completion_phase.ts:2468` — summary loaded → check runs — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a wrong claim about named code blocks; the recovery removes it and the PR is raised` — flipped to always skip, test went red
- `worker/deno/lib/phases/completion_phase.ts:2468` — absent (no summary file → check skipped) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - no summary file at all never calls the summary claim question` — does not go red when flipped: with the guard removed, the null path is rejected by `buildSummaryClaimQuestionPrompt`, so the question is still never asked
- `worker/deno/lib/phases/completion_phase.ts:2473` — base ref passed when resolved — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a clean summary raises the PR; the question runs once, read-only, naming the base and the summary path` — flipped to null, test went red
- `worker/deno/lib/phases/completion_phase.ts:2498` — error (question failed to launch → not blocking) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - the question failing to launch does not block the PR` — flipped to throw, test went red
- `worker/deno/lib/phases/completion_phase.ts:2548` — blocked — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a wrong claim about named code blocks; the recovery removes it and the PR is raised`, `completion - a wrong claim the recovery does not fix fails the run after one recovery turn`, `completion - a Test Plan bullet citing a behaviour no test covers blocks; the recovery quotes a covered behaviour and the PR is raised` — flipped to never blocked, each went red
- `worker/deno/lib/phases/completion_phase.ts:2548` — not blocked (clean summary / unchecked) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a clean summary raises the PR; the question runs once, read-only, naming the base and the summary path` and `completion - the question failing to launch does not block the PR` — flipped to blocked whenever the check ran, each went red
- `worker/deno/lib/phases/completion_phase.ts:2834` — branch-outcomes block folds in the claim check — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a code diff with no Branch outcomes list AND a wrong claim folds into one comment, one recovery turn` — flipped to skip the claim verdict, test went red
- `worker/deno/lib/phases/completion_phase.ts:2862` — claim check blocks on its own — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a wrong claim about named code blocks; the recovery removes it and the PR is raised` and `completion - a wrong claim the recovery does not fix fails the run after one recovery turn` — flipped off, each went red
- `worker/deno/lib/pr_feedback_drift_check.ts:279`, `:395` — change request fenced only when given — `worker/deno/tests/pr_feedback_drift_check_3244_test.ts::buildDriftQuestionPrompt - fences the change request only when given, and always carries the internal-contradiction clause` — flipped each, test went red
- `worker/deno/lib/pr_feedback_drift_check.ts:375` — change-request instruction only when given — `worker/deno/tests/pr_feedback_drift_check_3244_test.ts::buildDriftQuestionPrompt - fences the change request only when given, and always carries the internal-contradiction clause` — inverted, test went red

The base-ref context line in `buildDriftQuestionPrompt` (`if (opts.baseRef)`) is an existing branch that this diff moves into the shared renderer's `intro`. It is not new, and inverting it left the #3143 and #3244 drift suites green.

## Test Plan

- New tests in `worker/deno/tests/summary_claim_check_test.ts` cover the
  backstop, the prompt builder's guards, `runSummaryClaimCheck`'s
  confirmed, unconfirmed and not-checked outcomes, the gate comment and
  reason, and hostile-input growth checks for each untrusted-text regex.
- New tests in
  `worker/deno/tests/completion_phase_summary_claim_check_test.ts` drive
  `workOnIssueCompletion` end to end. They cover a wrong claim that blocks and
  then passes after one recovery turn, a wrong claim the recovery does not
  fix, a Test Plan bullet citing an uncovered behaviour, a clean summary, a
  question that fails to launch, the fold into the branch-outcomes block, and
  a run with no summary file.
- `deno test -A` over those two files and
  `worker/deno/tests/pr_feedback_drift_check_3143_test.ts` and
  `worker/deno/tests/pr_feedback_drift_check_3244_test.ts` passed on the head
  (`3776b5aa`).
- Each outcome in **Branch outcomes** above was flipped by hand on the head
  and the named test run, and the source was restored afterwards. The
  outcomes listed as unreached stayed green when flipped. They are recorded
  as coverage gaps, not claimed as covered.
- No assertion was removed from any existing test. Both test files are new,
  and the only change to `worker/deno/lib/test_plan_recount.ts` exports
  `logicalBlocks` and rewords its doc comment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
