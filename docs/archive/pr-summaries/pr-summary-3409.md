# PR Summary — Issue #3409: dismiss a review with a message that matches its outcome

## Summary

`markCommentProcessed` dismissed every `pr_review` with "Changes have been addressed by the
automated worker.", including a review that failed twice, was rebutted, was escalated or was
handed off. The caller now passes a `ReviewDismissalOutcome`. Only a verified pushed fix keeps
the "addressed" wording, and each other outcome gets its own accurate message. Closes #3409.

## Spec

### Intent and Rationale

- A dismissal cannot be undone, and its message is what a human sees on the review. A
  permanently-failed review labelled "addressed" hides the fact that the requested change never
  landed.
- The outcome is a **required** parameter with no default. The type checker therefore names every
  caller, so none can quietly keep the old wording.

### Essential Design Decisions

- `REVIEW_DISMISSAL_MESSAGES` (`worker/deno/lib/pr_comments.ts`) is the single source of truth.
  It maps `addressed`, `permanently_failed`, `rebuttal`, `escalated`, `handed_off` and
  `fix_pr_pending` to their messages.
- Each `retireReview(outcome)` site in `_processFeedbackWithHeartbeat` passes the outcome it
  settles. `markPrCommentAsFailed` passes `permanently_failed`.
- `review` and `issue` comments receive only an `eyes` reaction, so the outcome has no effect for
  those types. Their callers pass `"addressed"`, with a one-line comment saying it is unused.
- The `pr_manager mark-comment-processed` CLI takes `--outcome`. It refuses an unknown value, and
  it refuses a `pr_review` without one rather than guessing "addressed". No script, prompt or doc
  calls this CLI; only its tests do.

### Undiscoverable Facts

- The `fix_pr_pending` outcome exists because a fix can be pushed while the fix PR itself fails
  to open (the gated-head milestone path). "Addressed" would overstate that case.

## Evidence

This is a backend-only change, with no UI files. Tests:

- `worker/deno/tests/pr_comments_test.ts`
  - "markCommentProcessed dismisses a PR review with the '<outcome>' message (Issue #3409)", one
    test per outcome.
  - "only the 'addressed' dismissal claims the changes were made".
  - "markPrCommentAsFailed dismisses a pr_review with the permanently-failed wording".
  - Against the unfixed code, the file cannot load (the new exports are missing). A temporary
    copy with the new imports removed gave 10 assertion failures, including the
    `markPrCommentAsFailed` test, which received the "addressed" wording. That copy was deleted.
- `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts` and
  `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts` assert the outcome for each
  settlement path. Seven of these tests fail against the unfixed code.
- `worker/deno/tests/pr_manager_command_test.ts` covers both CLI refusals.
- After the fix, the targeted run gives 142 passed and 0 failed.

```mermaid
flowchart TD
    R["pr_review settled"] --> P{"Outcome"}
    P -- "verified push" --> A["addressed"]
    P -- "pushed, fix PR not opened" --> F["fix_pr_pending"]
    P -- "rebuttal" --> B["rebuttal"]
    P -- "escalation" --> E["escalated"]
    P -- "escape-hatch hand-off" --> H["handed_off"]
    P -- "second failure" --> X["permanently_failed"]
```

Issues cited as provenance:

- #3409: A permanently failed CHANGES_REQUESTED review is dismissed with 'Changes have been
  addressed by the automated worker.'
- #3383: PR feedback dismisses a CHANGES_REQUESTED review at claim time, so a timed-out or
  silent run loses it and only base merges follow (VibeCoder#3308, #3355, GRQ-AutoTrader#2699)

**Docs sweep**

- Grep terms: `addressed by the automated worker`, `dismiss\w*`, `markCommentProcessed`,
  `mark-comment-processed`.
- Updated:
  - `docs/workflows/pr-feedback.md:311` adds a paragraph listing the outcome messages.
  - `docs/USAGE.md:744` changes "addressed it" to "settled it" and adds a sentence on the
    message.
  - `docs/INTERNALS.md:2694` says the second-failure dismissal carries the "Not addressed after
    two automated attempts" message.
  - The `markCommentProcessed`, `reviewSettlement` and `retireReview` doc comments, and the
    `pr_manager.ts` header.
- Hits read and left in place, because they describe *when* the review is dismissed, not the
  message:
  - `docs/workflows/pr-feedback.md:119-125, 154, 174, 189-190, 231-232, 274-308, 868`
  - `docs/USAGE.md:755`
  - `docs/INTERNALS.md:1991, 2000, 2019, 2068-2069, 2692, 3674, 5306`
- Unrelated hits: `docs/SECURITY-SCAN.md:464` and
  `docs/audits/security-sweep-2755-lib-delta-12a-12c.md:214`.
- No hits in `README.md` or `*/README.md`.

A raw `deno fmt --check` on these three markdown files already reports them as unformatted at
base (the `INTERNALS.md` file table). The gate's `deno fmt` step passes, and this change adds no
new formatting failure.

## Test Plan

**Changed assertion:** in `pr_feedback_review_dismissal_3383_test.ts`, the spy event string now
includes the outcome. The issue-comment ordering check changed from
`indexOf("markCommentProcessed:issue:123")` to
`indexOf("markCommentProcessed:issue:123:addressed")`. The assertion is the same, in the new
format. No assertion was removed.

**Branch outcomes:** each value was flipped on its own, the tests were run, and the value was
restored.

- `worker/deno/lib/pr_feedback_processor.ts:1722` `handed_off` is reached by
  `pr_feedback_review_dismissal_3383_test.ts` "an escape-hatch hand-off dismisses the review
  exactly once". Flipped → red.
- `worker/deno/lib/pr_feedback_processor.ts:1800` `fix_pr_pending` is reached by
  `pr_feedback_processor_milestone_fix_test.ts` "gated head: pr_review fix PR creation failure
  => dismisses the review once". Flipped → red.
- `worker/deno/lib/pr_feedback_processor.ts:1824` `addressed` is reached by
  `pr_feedback_review_dismissal_3383_test.ts` "verified push dismisses once, after
  commitAndPushPending". Flipped → red.
- `worker/deno/lib/pr_feedback_processor.ts:1859` `rebuttal` is reached by
  `pr_feedback_review_dismissal_3383_test.ts` "rebuttal with no changes dismisses exactly once".
  Flipped → red.
- `worker/deno/lib/pr_feedback_processor.ts:1910` `escalated` is reached by
  `pr_feedback_review_dismissal_3383_test.ts` "no fix, no rebuttal after in-run retry —
  escalates and dismisses once". Flipped → red.
- `worker/deno/lib/pr_feedback_processor.ts:1427` (non-`pr_review` mark) is reached by
  `pr_feedback_review_dismissal_3383_test.ts` "an 'issue' comment is unaffected —
  markCommentProcessed still runs before the push". Flipped → red, through the spy.
- `worker/deno/lib/pr_comments.ts:615` `permanently_failed` is reached by `pr_comments_test.ts`
  "markPrCommentAsFailed dismisses a pr_review with the permanently-failed wording". Flipped →
  red.
- `worker/deno/lib/pr_comments.ts:161` (message lookup by outcome) is reached by
  `pr_comments_test.ts`, the per-outcome message tests. Flipped to always `.addressed` → red,
  with 6 failures.
- `worker/deno/commands/pr_manager.ts:395` (unknown `--outcome` refused) is reached by
  `pr_manager_command_test.ts` "mark-comment-processed refuses an unknown --outcome (Issue
  #3409)". Flipped → red.
- `worker/deno/commands/pr_manager.ts:403` (`pr_review` without `--outcome` refused) is reached
  by `pr_manager_command_test.ts` "mark-comment-processed refuses a pr_review without --outcome
  (Issue #3409)". Flipped → red.
- `worker/deno/lib/claim_pr_comment.ts:574` `"addressed"` is exempt (untestable). This branch
  only handles `review` and `issue` comments, and `markCommentProcessed` ignores the outcome for
  those types (they get an `eyes` reaction). Flipping it changes no observable behaviour.
- `worker/deno/commands/pr_manager.ts`, passing a valid `--outcome` through to `gh`, is exempt
  (untestable). `gh` is not injectable in this command, so a success-path test would call the
  real GitHub API.

**Callers checked (`markCommentProcessed`):**

- The five `retireReview` sites and the non-`pr_review` early mark in
  `worker/deno/lib/pr_feedback_processor.ts`.
- `worker/deno/lib/claim_pr_comment.ts`.
- `markPrCommentAsFailed` in `worker/deno/lib/pr_comments.ts`.
- The `pr_manager mark-comment-processed` CLI. It has no script, prompt or doc callers.
- `worker/deno/lib/issue_worker_wiring.ts`, which uses only `typeof markCommentProcessed`, so no
  change was needed.

**Gate:** `./quality.sh < /dev/null` from the repo root: `Result: PASSED (with skipped checks)`,
exit 0. Deno tests, lint, type check, fmt, markdownlint, mermaid and semgrep all passed.
