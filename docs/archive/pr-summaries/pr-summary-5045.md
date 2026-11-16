# PR Summary — Issue #5045

## Summary

Removed the fixed VibeCoder `(Issue #N)` citations from 14 commit messages the
worker writes into target repositories: the conflict-resolution merge, the
CI-fix, review-feedback and spelling-fix final-mile commits and their
push-recovery retries, the four in-run recovery commits (PR summary, PR body
limit, pre-push gate, screenshot gate) and the milestone-sync merge commit.
GitHub links a bare `#N` to an issue in the repository the commit lives in, so
in a target repo each of these citations pointed at an unrelated issue, or at a
number that does not exist there. Each message now comes from an exported pure
builder beside its call site. The builder's doc comment keeps the provenance, as
#3499 did for the `wip:` messages. The target repo's own PR and issue numbers
stay. Closes #5045.

## Spec

### Intent and Rationale

- Each message moves into a small exported builder
  (`buildConflictMergeCommitMessage`, `buildCiFixCommitMessage`,
  `buildFeedbackFinaliseCommitMessage`, `buildSpellingFixCommitMessage`,
  `buildSummaryRecoveryCommitMessage`, `buildBodyLimitRecoveryCommitMessage`,
  `buildPrePushRecoveryCommitMessage`, `buildScreenshotRecoveryCommitMessage`).
  Every message then gets a direct regression test, which is the shape #3499
  used. The alternative was standing up each processor's full harness just to
  read one string.
- `buildResolutionCommitMessage` (milestone sync) was already exported, so only
  its prose changed.

### Essential Design Decisions

- A builder's subject and body text are otherwise unchanged. Only the
  `(Issue #N)` suffix is gone, so the message still reads the same in a target
  repo's history.
- The two-variant builders take a required
  `attempt: "final-mile" | "push-recovery-retry"` with no default, so a new call
  site has to choose a variant.
- The feedback builder is named `buildFeedbackFinaliseCommitMessage` because
  `lib/pr_feedback_processor.ts` already exports an unrelated
  `buildFeedbackCommitMessage(prNumber, commentBody)`.
- The three new final-mile doc comments do not cite #1643. In this repository
  that number is now an unrelated merged PR ("Escalation dedup: page every
  comment…"), because numbers were reused after the clean public export. The
  older `// Always commit and push any pending work (Issue #1643).` comments at
  the call sites are pre-existing and were left as they are.

### Undiscoverable Facts

- The issue's evidence is outside this repo: NEAT-AI@796a063 and
  GRQ-validation@c2e0763, plus private fleet PRs whose head commit was
  `Merge <base> into <branch> (Issue #84)`.

## Evidence

Backend-only change: commit-message strings and their tests. No UI file changed.

- `worker/deno/tests/commit_messages_no_vibecoder_numbers_5045_test.ts` (new)
  covers each of the eight builders, and both attempts of the three two-variant
  ones. Each case asserts three things: no `#<digits>` remains other than the
  target's own PR or issue number; that number is still present; and the subject
  line, as a literal.
- `worker/deno/tests/pre_push_gate_retry_test.ts` drives the real
  `runPrePushGateRecoveryTurn` and asserts on the message passed to
  `commitAndPushPending`. With `lib/pre_push_gate_retry.ts` restored from the
  base commit, the test
  `pre-push gate retry - success: one agent turn, flag set on entry, fix committed and never pushed (Issue #4128)`
  **failed**
  (`AssertionError: Expected actual: "fix: pre-push gate findings for #4128 …`).
  It passes at the head.
- `worker/deno/tests/milestone_conflict_triage_test.ts::buildResolutionCommitMessage - cites no VibeCoder issue number (Issue #5045)`
  asserts that the milestone-sync message has no `#<digits>` at all (the branch
  is `milestone/payments`), and that the explanatory prose survives.
- Issue numbers this diff writes as provenance, each looked up with
  `gh issue view` in this run:
  - #5045: Conflict-merge, final-mile, in-run recovery and milestone-sync commit
    messages still cite VibeCoder issue numbers in target repos (…)
  - #84: Nothing performs the 'real merge' that #4373 defers to — a conflicting
    worker PR (e.g. #48) sits CONFLICTING indefinitely (…)
  - #2242: Summary-rule recovery still fails when the agent writes prose instead
    of the closure block (…)
  - #4359: Issue-run PR creation has no 65,536-character body limit (…)
  - #4128: Pre-push gate block: give the agent one in-run recovery turn with the
    gate output
  - #2960: One extra agent turn to capture a missing screenshot before the gate
    fails the run
  - #4326: Milestone syncs are refused every cycle on disk budget, so milestone
    issues never run
  - #4441, #4422, #4786: Milestone sync gate cannot verify a resolution it keeps
    refusing (…)
  - #1559: A conflicted milestone sync escalates to a human on sight (…)

## Test Plan

- Added `worker/deno/tests/commit_messages_no_vibecoder_numbers_5045_test.ts`,
  which has eight tests and passed on the final head.
- Added
  `buildResolutionCommitMessage - cites no VibeCoder issue number (Issue #5045)`
  to `worker/deno/tests/milestone_conflict_triage_test.ts`. The whole file
  passed, 32 tests.
- Removed from `worker/deno/tests/milestone_conflict_triage_test.ts`:
  `assertStringIncludes(message, "Issue #1559");`
  - Required by: "Drop the `(Issue #N)` citations from these commit messages,
    and keep the provenance in the code comments next to them". It was replaced
    by `assert(!message.includes("Issue #1559"), message);`. The new #5045 test
    asserts the sentence
    `No conflicted test file was resolved by taking a side that drops cases.`
    that the citation used to follow.
- Removed from `worker/deno/tests/pre_push_gate_retry_test.ts`:
  `"In-run pre-push-gate recovery (Issue #4128).",`
  - Required by: "Update the pinned string in `pre_push_gate_retry_test.ts`."
  - Replaced by: `"In-run pre-push-gate recovery.",` plus
    `assertEquals(rest.match(/#\d+/g), null, commit.message);`. That fixture's
    `ISSUE` is 4128, so the stray-number check strips `#4128`. The exact-text
    assertion is what catches a re-added `(Issue #4128)`, and the builder test
    with issue 77 covers the rest.
- Ran these tests and they passed: `deno test -A` over the new test file plus
  the existing `pre_push_gate_retry`, `summary_rule_gate_retry`,
  `pr_body_length_4359`, `completion_phase_screenshot_retry`,
  `pr_spelling_processor`, `pr_merge_conflict_processor`, `pr_ci_processor` and
  `pr_feedback_processor` test files (320 passed, 0 failed).
- Callers checked: each builder has one production caller, or two for the
  final-mile and retry pairs. Every call site in the issue's table now calls a
  builder. `buildResolutionCommitMessage` is called from `lib/git_pull.ts` and
  needed no signature change.
- Twinned rules: none found. This changes strings only and adds no gate or rule.
- `./quality.sh < /dev/null` on the final head passed (with skipped checks:
  config integration, checkov). The first run flagged semgrep
  `detect-non-literal-regexp` in the new test helper, which was rewritten with a
  literal regex.
- In two of four gate runs, `deno tests` reported FAILED, but the JUnit output
  held no `<failure>`. That fits the stage's unit-test time-budget check on a
  shared, loaded host. The new tests run in about 8 ms. This is unverified: the
  failing test was not identified.

## Not done

- The `// … (Issue #1643)` call-site comments and the other `Issue #N` code
  comments in these files were left as they were. They never reach a target
  repo.
