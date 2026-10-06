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
     that is not tracked at the head also blocks. A reference stripped of a
     `::test` or `:line` suffix or a leading `./` resolves as written; a
     reference to a directory (trailing `/`), a glob (`*?[`) or a directory
     prefix of tracked paths is not a file and is recorded as not checked,
     never as a missing file.
- If a check cannot run, it is recorded in `notChecked` and never blocks.
  That covers an unresolvable base ref, a question that fails to launch, an
  unreadable verdict, an ambiguous, unreadable or oversized test file, a
  directory, glob or directory-prefix reference, a file with no recognised
  test declaration, and the 50-claim cap.
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
- `worker/deno/lib/summary_claim_check.ts:111` — error (flag-shaped base ref) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a flag-shaped base ref` — only goes red when both the pattern check and the leading-`-` check on line 113 are removed, because either one rejects `--output=/tmp/x`
- `worker/deno/lib/summary_claim_check.ts:113` — error (leading `-`, which the pattern alone accepts) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a base ref with a leading '-' that the pattern alone accepts` — removed the check, test went red
- `worker/deno/lib/summary_claim_check.ts:114` — error (leading `/`, which the pattern alone accepts) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on an absolute-path base ref that the pattern alone accepts` — removed the check, test went red
- `worker/deno/lib/summary_claim_check.ts:112` — error (base ref containing `..`) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a base ref containing '..'` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:120` — error (unrecognised summary path) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on an unrecognised summary path` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — error (zero issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a zero issue number` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — error (non-integer issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - throws on a non-integer issue number` — flipped to accepted, test went red
- `worker/deno/lib/summary_claim_check.ts:125` — success (valid issue number) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - the same args with a valid issue number do not throw` — flipped to error, test went red
- `worker/deno/lib/summary_claim_check.ts:131` — pinned nonce (valid `boundaryId`) — `worker/deno/tests/summary_claim_check_test.ts::buildSummaryClaimQuestionPrompt - builds a well-formed question` — flipped to a freshly minted nonce, test went red
- `worker/deno/lib/summary_claim_check.ts:320` — absent (no recognised test declaration) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a tracked test file with no recognised test declaration is notChecked, no problem` — flipped to one empty segment, test went red
- `worker/deno/lib/summary_claim_check.ts:388` — strip a `::test` suffix — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a path::test reference resolves to the tracked file` — removed the strip, test went red
- `worker/deno/lib/summary_claim_check.ts:389` — strip a `:line` suffix — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a path:line reference resolves to the tracked file` — removed the strip, test went red
- `worker/deno/lib/summary_claim_check.ts:390` — strip a leading `./` — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a ./-prefixed reference resolves to the tracked file and is checked` — red at the review head before the strip was added (the reference was a missing-file problem), green after
- `worker/deno/lib/summary_claim_check.ts:391` — reject a span containing whitespace — no test reaches it: removing the check left the suite green
- `worker/deno/lib/summary_claim_check.ts:396` — file-shaped vs directory/glob reference — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a directory reference is notChecked, not a missing-file problem` and `findTestPlanClaimProblems - a glob reference is notChecked, not a missing-file problem` — red at the review head before `isFileShaped` existed (each was a missing-file problem), green after
- `worker/deno/lib/summary_claim_check.ts:410` — no span between (adjacent positions) — no test reaches it: flipping the early return left the suite green
- `worker/deno/lib/summary_claim_check.ts:433` — preceding reference with an intervening backtick span is not attached — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an error message across an intervening backtick span must not attach to the preceding test file (pr-summary-3178-shaped)` — flipped to attach regardless, test went red
- `worker/deno/lib/summary_claim_check.ts:433` — attached to the preceding reference — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` (and the other backstop tests) — flipped to never attach, test went red
- `worker/deno/lib/summary_claim_check.ts:443` — attached to the following reference — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a quote before its only test-file reference is checked against that file and blocks when uncovered` — flipped to never attach, test went red
- `worker/deno/lib/summary_claim_check.ts:443` — following reference with an intervening backtick span is not attached — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a quote with a backtick span between it and the following reference is not attached` — flipped to attach regardless, test went red
- `worker/deno/lib/summary_claim_check.ts:465` — resolved (exact tracked path) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` — flipped to unresolved, test went red
- `worker/deno/lib/summary_claim_check.ts:468` — resolved (unique basename suffix) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a bare basename resolves by unique suffix` — flipped to unresolved, test went red
- `worker/deno/lib/summary_claim_check.ts:469` — ambiguous basename → not checked — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an ambiguous basename is notChecked, no problem` — flipped to missing, test went red
- `worker/deno/lib/summary_claim_check.ts:474` — directory prefix of tracked paths → not checked — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a reference that is a directory prefix of tracked paths is notChecked, not a missing-file problem` — red at the review head before the directory outcome existed (it was a missing-file problem), green after
- `worker/deno/lib/summary_claim_check.ts:474` — absent (untracked file → missing-file problem) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a missing file is a missing-file problem` — flipped to ambiguous, test went red
- `worker/deno/lib/summary_claim_check.ts:508` — absent (block names no test file) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a block with no test path is ignored` — flipped to a problem, test went red
- `worker/deno/lib/summary_claim_check.ts:512` — empty quote skipped — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an empty (whitespace-only) quote is skipped` — goes red only when this skip and the fewer-than-two-words guard on line 515 are both removed (the file is then read); removing this skip alone leaves it green, because the guard on 515 also skips an empty quote
- `worker/deno/lib/summary_claim_check.ts:515` — ignored (fewer than two significant words) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a one-significant-word quote is ignored` — flipped to checked, test went red
- `worker/deno/lib/summary_claim_check.ts:520` — not a coverage claim (no qualifying reference) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - an error message across an intervening backtick span must not attach to the preceding test file (pr-summary-3178-shaped)` — flipped to a problem, test went red
- `worker/deno/lib/summary_claim_check.ts:522`, `:595` — cap reached → skipped claims reported as not checked — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a cap of 50 claims reports the unchecked count` — flipped each guard off, test went red
- `worker/deno/lib/summary_claim_check.ts:559` — error (unreadable file → not checked) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - readFile returning undefined for a tracked file is notChecked, no problem` — flipped to read through, test went red
- `worker/deno/lib/summary_claim_check.ts:559` — error (file over the size cap → not checked) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a test file over MAX_TEST_FILE_CHARS is notChecked, no problem` — flipped to read through, test went red
- `worker/deno/lib/summary_claim_check.ts:579` — skipped (file not checkable) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - readFile returning undefined for a tracked file is notChecked, no problem` (with the oversized and no-declaration tests) — flipped to a problem, those tests went red
- `worker/deno/lib/summary_claim_check.ts:583` — covered by the preamble (shared fixture) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a shared fixture in the file's preamble confirms the claim (pr-summary-1549/3222-shaped)` — flipped to segments only, test went red
- `worker/deno/lib/summary_claim_check.ts:584` — no-matching-test problem — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:584` — covered (no problem) — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a matching Deno.test name confirms the claim, no problem` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:293` — covered at exactly half the quote's words — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - exactly half of the quote's significant words matching is covered` — flipped to require every word, test went red
- `worker/deno/lib/summary_claim_check.ts:293` — not covered under half — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - fewer than half of the quote's significant words matching is a no-matching-test problem` — flipped to one word enough, test went red
- `worker/deno/lib/summary_claim_check.ts:247` — stemming — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a stemmed variant of each test word is covered (rejecting/rejects, parsed/parses, header/headers)` — flipped to no stemming, test went red
- `worker/deno/lib/summary_claim_check.ts:276` — ≥4-char prefix match — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a 4+-char prefix of each test word is covered (config/configuration, validat/validation)` — flipped to exact match only, test went red
- `worker/deno/lib/summary_claim_check.ts:265` — stopword drop — `worker/deno/tests/summary_claim_check_test.ts::findTestPlanClaimProblems - a quote sharing only stopwords with the test is a no-matching-test problem` — flipped to keep stopwords, test went red
- `worker/deno/lib/summary_claim_check.ts:285` — empty quote counts as covered — unreachable through `findTestPlanClaimProblems`, which skips a quote with fewer than two significant words before calling `quoteCoveredBy`; flipping it left the suite green
- `worker/deno/lib/summary_claim_check.ts:607` — wording (missing-file vs no-matching-test description) — no test reaches the missing-file wording: swapping the two descriptions left the suite green
- `worker/deno/lib/summary_claim_check.ts:633` — blocked (confirmed model finding) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - #3252-shaped confirmed finding blocks` — flipped to Test Plan problems only, test went red
- `worker/deno/lib/summary_claim_check.ts:633` — blocked (Test Plan problem) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a Test Plan bullet citing a behaviour no test covers blocks; the recovery quotes a covered behaviour and the PR is raised` — flipped to findings only, test went red
- `worker/deno/lib/summary_claim_check.ts:681` — error (git could not run → backstop skipped, question still asked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - runGit returning null skips the Test Plan backstop but still asks the model question` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:681` — error (non-zero `ls-files` exit) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a non-zero ls-files exit code skips the Test Plan backstop but still asks the model question` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:681` — success (backstop runs) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - contrast: ls-files succeeding yields the missing-file problem the above two tests skip` — flipped to always skip, test went red
- `worker/deno/lib/summary_claim_check.ts:708` — backstop not-checked reasons forwarded into the result — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - an ambiguous test-file reference reaches result.notChecked` and `runSummaryClaimCheck - an unreadable tracked test file reaches result.notChecked` — dropped the forwarding, both went red
- `worker/deno/lib/summary_claim_check.ts:720` — absent (null base ref → question never asked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a null baseRef never calls askQuestion` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:734` — error (prompt could not be built → not checked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a base ref that fails validation is notChecked, does not throw, and never calls askQuestion` — removed the try/catch, test went red (the build error escaped)
- `worker/deno/lib/summary_claim_check.ts:742` — error (question failed → not checked, no block) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - askQuestion error is notChecked, not blocked` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:755` — error (no verdict block → not checked) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a reply with no verdict block is notChecked` — flipped, test went red
- `worker/deno/lib/summary_claim_check.ts:766` — unconfirmed (finding names another file) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a finding naming another file is unconfirmed` — flipped to confirmed, test went red
- `worker/deno/lib/summary_claim_check.ts:767` — unconfirmed (sentence not in the summary) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a misquoted sentence is unconfirmed, not blocked` — flipped to confirmed, test went red
- `worker/deno/lib/summary_claim_check.ts:768` — confirmed finding — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - #3252-shaped confirmed finding blocks` — inverted, test went red
- `worker/deno/lib/summary_claim_check.ts:804` — reason from the first finding, else the first Test Plan quote — no test reaches the fallbacks: `summaryClaimBlockReason - starts with the expected prefix` checks only the prefix, and dropping either source left the suite green
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
- Review-fix tests in `worker/deno/tests/summary_claim_check_test.ts`: a
  directory, a glob and a directory-prefix reference are each not checked
  rather than a missing file, and a `./`-prefixed, a `path:line` and a
  `path::test` reference each resolve to the tracked file; the claim-match
  rule at exactly half, under half, a stemmed variant, a prefix variant, a
  stopword-only overlap and an empty quote; a quote before its only reference
  attaches and blocks when uncovered, and does not attach across an
  intervening backtick span; `buildSummaryClaimQuestionPrompt` rejects `-x`
  and `/etc/x`; `runSummaryClaimCheck` records a base ref that fails
  validation as not checked without calling the model, and forwards an
  ambiguous or unreadable test file into `notChecked`.
- `deno test -A` over those two files and
  `worker/deno/tests/pr_feedback_drift_check_3143_test.ts` and
  `worker/deno/tests/pr_feedback_drift_check_3244_test.ts` passed on the
  head of this branch.
- Each outcome in **Branch outcomes** above was flipped by hand on the head
  and the named test run, and the source was restored afterwards. The
  outcomes listed as unreached stayed green when flipped. They are recorded
  as coverage gaps, not claimed as covered.
- No assertion was removed from any existing test. Both test files are new,
  and the only change to `worker/deno/lib/test_plan_recount.ts` exports
  `logicalBlocks` and rewords its doc comment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
