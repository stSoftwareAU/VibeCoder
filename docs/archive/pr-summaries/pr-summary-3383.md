# PR Summary — Issue #3383

## Summary

Closes #3383

Claiming a `CHANGES_REQUESTED` review (`commentType: "pr_review"`) used to
dismiss it at once. A run that then timed out, died or pushed nothing had
already retired the change request, so only base merges followed
(VibeCoder#3308, #3355, GRQ-AutoTrader#2699). Now the claim no longer
dismisses the review. The review is dismissed only when the run **retires**
it, and every other outcome is charged as a failed attempt.

- [x] **Claim is a lease, not a dismissal.** A `pr_review` claim comment
      carries a `<!-- PR_COMMENT_CLAIM_LEASE:<time> -->` line
      (`worker/deno/lib/pr_review_claim_lease.ts`). The processor renews it
      from its heartbeat every 5 minutes by editing the comment, which bumps
      `updated_at`. The lease is live while its last renewal is within the
      15-minute heartbeat live window. The claim race and the stale sweep
      apply the lease rule to lease claims. Ordinary claims keep the
      60-second rule and the claim-time eyes reaction.
- [x] **The scan honours a live lease.** `findPrCommentsToFix` skips a
      review covered by a live, fleet-authored lease
      (`hasLivePrReviewClaim`). A lapsed lease, from a run that timed out,
      crashed or went silent, makes the review actionable again.
- [x] **Dismiss only on retirement.** The review is dismissed after one of
      these: a fix verified on the remote, a gated-head fix pushed to a fix
      branch whose fix PR could not be raised, the agent's rebuttal, the
      escape-hatch hand-off, or the `needs-human` escalation.
- [x] **Every other outcome is charged.** An agent error, a timeout, a push
      the remote does not confirm, or any outcome that settles nothing (for
      example a prompt-build failure or a throw) goes through
      `handlePrCommentFailure`. The first failure posts a "First Attempt"
      reply carrying `<!-- PR_REVIEW_FAILED_ONCE:<reviewId> -->` and leaves
      the review undismissed. The second failure (a fleet-authored marker
      found) dismisses it with "Permanently Failed".
- [x] **No reaction on the wrong resource.** A `pr_review` gets no reaction
      call at all. The old code reacted on `issues/comments/<reviewId>`, which
      is not the review.
- [x] A branch the host could not check out (`branch_held`,
      `checkout_failed`) releases the review uncharged and posts no reply.
- [x] Docs: `docs/workflows/pr-feedback.md`, `docs/INTERNALS.md`,
      `docs/USAGE.md`.

**Docs sweep** — grep: `markCommentProcessed`, `removeProcessedMark`, `checkPrCommentHasFailedOnce`, `markPrCommentAsFailedOnce`, `STALE_CLAIM_MIN_AGE_MS`, `PR_COMMENT_CLAIM`, "dismiss" (case-insensitive), "claim time", "confused", "cannot be undone", "un-dismiss", "Changes have been addressed"; section: `docs/workflows/pr-feedback.md#a-review-is-dismissed-only-once-the-run-retires-it-issue-3383` (read through with the "Feedback is processed once" bullet, happy-path steps 1 and 4 and their flowchart, the #3246 "never answered with no change" section and the summary list at the end), plus the `docs/INTERNALS.md` PR-feedback scan, "Failure handling" and PR-comment claim sections and the `docs/USAGE.md` request-changes section; updated: `docs/workflows/pr-feedback.md`, `docs/INTERNALS.md`, `docs/USAGE.md` (all in the branch's own commits); still true after reading: `docs/INTERNALS.md:2637` (the two-attempt reaction list describes comments, and the `pr_review` paragraph right after it gives the marker-reply variant), `docs/INTERNALS.md:1967` (a review is still retired by its dismissal or by the same reviewer's later review); `docs/audits/security-sweep-2755-lib-delta-12a-12c.md:214` is a dated audit record of the code as it was reviewed then, left as history; the other "claim time" hits (`docs/IDLE-TASK-FRAMEWORK.md`, `docs/CALLBACKS.md`, the scan docs, `docs/AGENT-ACCOUNTABILITY.md`) are about issue claims, and the `docs/SECURITY-SCAN.md` "dismiss" hits are about code-scanning alerts, so they are unrelated.

**PR #3408 review docs sweep** — grep: `retires it`, `rebuttal posted`, `escape-hatch hand-off`, `needs-human.*escalation` (and the surrounding "fix verified on the remote" phrasing) across `docs/`; the `docs/workflows/pr-feedback.md#a-review-is-dismissed-only-once-the-run-retires-it-issue-3383` paragraph was the only hit that stated the five retiring outcomes as unconditional — updated to say each one also requires its own reply/hand-off/label-or-comment to have actually landed on the PR, or it is charged instead (Issue #3408 review); `docs/INTERNALS.md:2035` ("post a reply and dismiss it only once the run retires it") stays true as a high-level step summary and does not claim the five outcomes are unconditional, so it is unchanged; `docs/USAGE.md` has no matching paragraph.

## Test Plan

Removed from existing tests. Each one asserted the claim-time dismissal
that #3383 removes, so the old assertion is now untrue:

- Removed from `worker/deno/tests/claim_pr_comment_eyes_reaction_test.ts`: `assertStringIncludes(error?.message ?? "", "dismiss");` — #3383 removes the claim-time dismissal, so `removeProcessedMark` has no dismissal to report for a `pr_review` and now returns `null` (the test asserts `assertEquals(error, null)`)
- Removed from `worker/deno/tests/claim_pr_comment_review_test.ts`: `` assertEquals( mock.calls.some((c) => c.includes(`PUT repos/org/repo/pulls/42/reviews/${REVIEW_ID}/dismissals`) ), true, ); `` — #3383 requires that a `pr_review` is not dismissed at claim time, so the claim must make no dismissals call (the test now asserts the opposite)
- Removed from `worker/deno/tests/claim_pr_comment_review_test.ts`: `` assertEquals( logged.some((m) => m.includes(REVIEW_ID) && m.includes("processed") && m.includes("422 Unprocessable Entity") ), true, `expected the dismissal failure in the log, got: ${logged.join(" | ")}`, ); `` — #3383 removes the claim-time dismissal, so a claim cannot fail to dismiss and nothing is logged about it. A failed dismissal at retirement is now logged by the processor, covered by `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a failed dismissal after a verified push is logged as an error`
- Removed from `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts`: `assertStringIncludes(reply, "No changes were made.");` — #3383: nothing is dismissed at claim time, so a `branch_held` `pr_review` has nothing to take back. It is released uncharged and posts no direct reply, and the test now asserts `reply` is `undefined`

Tests added (new files `worker/deno/tests/pr_review_claim_lease_test.ts`,
`worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts`,
`worker/deno/tests/pr_maintenance_review_lease_3383_test.ts`, plus new
cases in `worker/deno/tests/pr_comments_test.ts`,
`worker/deno/tests/claim_pr_comment_review_test.ts`,
`worker/deno/tests/marker_comment_pages_test.ts` and
`worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts`) cover the
issue's four required cases:

- A claimed review whose run times out is still actionable on the next
  scan: `pr_review dismissal: timeout charges a failed attempt, never
  dismisses` plus `findPrCommentsToFix - a lapsed lease is actionable
  again, even with a failed-once marker left behind (Issue #3383)`.
- A verified fix dismisses exactly once: `pr_review dismissal: verified
  push dismisses once, after commitAndPushPending`.
- A second failure dismisses with the permanent-failure reply:
  `pr_comments - handlePrCommentFailure pr_review second failure: dismisses
  the review and replies Permanently Failed`.
- No reaction call against `issues/comments/<reviewId>`: `pr_comments -
  markPrCommentAsFailedOnce for pr_review never touches reactions, and the
  reply carries the marker`.

Run: `deno test -A --parallel` over every `claim_pr_comment*`,
`pr_comments*`, `pr_feedback*`, `pr_maintenance*`,
`pr_review_claim_lease*`, `marker_comment_pages*` and `pr_manager*` test
file (40 files), including the cases added with this summary: 486
passed, 0 failed (481 passed before the PR #3408 review round added the
five cases below).

Each flip below was applied to the source on its own, and the related
suite (the 40 files above) was re-run with `--no-check`. The named test
went red, and the source was then restored. A no-op control edit run
through the same harness failed no test, so it is the flips that turn the
tests red.

**Branch outcomes:**

- `worker/deno/lib/claim_pr_comment.ts:197` — lease claim judged by the lease window (a lease renewed 2 minutes ago still contends) — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a sibling's lease claim renewed within the window still wins and survives the sweep` — flipped to the 60-second rule, test went red
- `worker/deno/lib/claim_pr_comment.ts:201` — ordinary claim with an unparseable `createdAt` is not live — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a sibling's ordinary claim with an unparseable createdAt is not a contender` — flipped to live, test went red
- `worker/deno/lib/claim_pr_comment.ts:215` — stale sweep applies the lease rule to a lease claim (a renewed lease is kept) — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a sibling's lease claim renewed within the window still wins and survives the sweep` — flipped to the 60-second rule, test went red
- `worker/deno/lib/claim_pr_comment.ts:221` — lapsed lease is stale and swept — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a sibling's lapsed lease claim is swept and this host wins` — flipped to never stale, test went red
- `worker/deno/lib/claim_pr_comment.ts:221` — fail-closed (no timestamp parses, so not stale and not deleted) — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a sibling's lease claim with no parseable timestamp is neither swept nor a contender` — `anyParses` guard dropped, test went red
- `worker/deno/lib/claim_pr_comment.ts:480` — `pr_review` claim body carries the lease line, other types do not — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - a pr_review with no competitor is claimed without dismissing it` — condition inverted, test went red
- `worker/deno/lib/claim_pr_comment.ts:524` — `dropOwnProcessedMark` returns early for a `pr_review` — exempt (untestable): `removeProcessedMark` already returns `null` for `pr_review` before any `gh` call, so the early return is behaviour-equivalent and no observable outcome differs
- `worker/deno/lib/claim_pr_comment.ts:566` — `pr_review` is not marked (not dismissed) at claim time — `worker/deno/tests/claim_pr_comment_review_test.ts::claim pr comment - the review dismissal endpoint is never called, and claiming still succeeds` — flipped to mark every type, test went red
- `worker/deno/lib/claim_pr_comment.ts:566` — every other type still gets the claim-time eyes reaction — `worker/deno/tests/claim_pr_comment_eyes_reaction_test.ts::claim pr comment - a won claim keeps the eyes reaction` — flipped to mark nothing, test went red
- `worker/deno/lib/claim_pr_comment.ts:721` — empty trusted-author set, so not claimed — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false when trustedAuthors is empty` — flipped to true, test went red
- `worker/deno/lib/claim_pr_comment.ts:726` — comment read fails, so not claimed and logged — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false and logs on a read failure` — flipped to true, test went red
- `worker/deno/lib/claim_pr_comment.ts:739` — claim on a different review is ignored — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false for a claim on a different review` — flipped to true, test went red
- `worker/deno/lib/claim_pr_comment.ts:740` — non-lease claim is ignored — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false for a non-lease claim` — flipped to true, test went red
- `worker/deno/lib/claim_pr_comment.ts:742` — lease posted by a stranger is ignored — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false for a stranger author` — flipped to true, test went red
- `worker/deno/lib/claim_pr_comment.ts:743` — lapsed fleet lease, so not claimed — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is false for a stale lease` — flipped to always live, test went red
- `worker/deno/lib/claim_pr_comment.ts:743` — live fleet lease, so claimed — `worker/deno/tests/pr_review_claim_lease_test.ts::hasLivePrReviewClaim is true for a live fleet lease` — lease window inverted, test went red
- `worker/deno/lib/marker_comment_pages.ts:81` — `updated_at` kept when GitHub supplied it, absent otherwise — `worker/deno/tests/marker_comment_pages_test.ts::parseMarkerCommentPages - keeps updated_at only when GitHub supplied it (Issue #3383)` — flipped to never set, test went red
- `worker/deno/lib/pr_comments.ts:249` — `removeProcessedMark` on a `pr_review` returns `null` with no `gh` call — `worker/deno/tests/claim_pr_comment_eyes_reaction_test.ts::remove processed mark - a pr_review has no mark to take back` — branch disabled, test went red
- `worker/deno/lib/pr_comments.ts:439` — `pr_review` failed-once is read from the PR-thread marker, not reactions (marker found, so failed once) — `worker/deno/tests/pr_comments_test.ts::pr_comments - handlePrCommentFailure pr_review second failure: dismisses the review and replies Permanently Failed` — branch disabled, test went red
- `worker/deno/lib/pr_comments.ts:440` — no PR number, so not failed once and no `gh` call — `worker/deno/tests/pr_comments_test.ts::pr_comments - checkPrCommentHasFailedOnce for pr_review without prNumber returns false and makes no gh call` — guard disabled, test went red
- `worker/deno/lib/pr_comments.ts:456` — marker read fails, so treated as first failure without throwing — `worker/deno/tests/pr_comments_test.ts::pr_comments - handlePrCommentFailure pr_review: a marker read that throws is treated as first failure, without throwing` — flipped to true, test went red
- `worker/deno/lib/pr_comments.ts:468` — marker for a different review id does not count — `worker/deno/tests/pr_comments_test.ts::pr_comments - handlePrCommentFailure pr_review: marker for a different review id is treated as first failure` — id match dropped, test went red
- `worker/deno/lib/pr_comments.ts:469` — marker by a stranger does not count — `worker/deno/tests/pr_comments_test.ts::pr_comments - handlePrCommentFailure pr_review: marker authored by a stranger is treated as first failure` — author check dropped, test went red
- `worker/deno/lib/pr_comments.ts:512` — `pr_review` gets no reaction call — `worker/deno/tests/pr_comments_test.ts::pr_comments - markPrCommentAsFailedOnce for pr_review never touches reactions, and the reply carries the marker` — flipped to react for every type, test went red
- `worker/deno/lib/pr_comments.ts:512` — other types still get the `confused` reaction — `worker/deno/tests/pr_comments_test.ts::pr_comments - markPrCommentAsFailedOnce for issue still adds confused reaction and replies` — flipped to react for none, test went red
- `worker/deno/lib/pr_comments.ts:529` — `pr_review` first-failure reply carries the `PR_REVIEW_FAILED_ONCE` marker — `worker/deno/tests/pr_comments_test.ts::pr_comments - handlePrCommentFailure pr_review first failure: reply carries the marker, no dismissal, no reaction` — condition inverted, test went red
- `worker/deno/lib/pr_comments.ts:532` — `pr_review` reply says the review stays undismissed, others name the reaction — `worker/deno/tests/pr_comments_test.ts::pr_comments - markPrCommentAsFailedOnce tells a pr_review reader the review stays undismissed (Issue #3383)` — condition inverted, test went red
- `worker/deno/commands/pr_manager.ts:470` — `check-pr-comment-failed-once` forwards `--pr-number`, or `undefined` when absent — exempt (untestable): the subcommand calls the real `gh` through the module-level `runGhCommand` and resolves the fleet from host config, with no injection seam a unit test can drive
- `worker/deno/lib/pr_feedback_processor.ts:551` — won `pr_review` claim gets a lease renewer — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: the heartbeat renews the claim's lease, and claiming never dismisses` — flipped to never create, test went red
- `worker/deno/lib/pr_feedback_processor.ts:587` — heartbeat renews the lease when a renewer exists — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: the heartbeat renews the claim's lease, and claiming never dismisses` — recorder left unwrapped, test went red
- `worker/deno/lib/pr_feedback_processor.ts:633` — unsettled `pr_review` run is charged — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: unsettled outcome (prompt build failure) is charged, never dismissed` — catch-all disabled, test went red
- `worker/deno/lib/pr_feedback_processor.ts:633` — settled run is not charged again — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: verified push dismisses once, after commitAndPushPending` — flipped to always charge, test went red
- `worker/deno/lib/pr_feedback_processor.ts:666` — throw before settling is charged once and rethrown — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a throw before the review is settled charges it once and rethrows` — catch charge disabled, test went red
- `worker/deno/lib/pr_feedback_processor.ts:666` — throw after the review was retired is not charged — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a throw after the review is retired is not charged as well` — flipped to always charge, test went red
- `worker/deno/lib/pr_feedback_processor.ts:751` — dismissal at retirement fails, so an error is logged — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a failed dismissal after a verified push is logged as an error` — log branch disabled, test went red
- `worker/deno/lib/pr_feedback_processor.ts:831` — `branch_held` releases the review uncharged with no reply — `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts::processPrFeedback - gated head: pr_review branch_held => releases without a reply or a charge` — release disabled, test went red
- `worker/deno/lib/pr_feedback_processor.ts:831` — `branch_missing` is not released, so it is charged once — `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts::processPrFeedback - pr_review branch_missing => not released, so it is charged once and never dismissed (Issue #3383)` — flipped to release `branch_missing` too, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1124` — agent error is charged once through the settlement — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: agent error charges a failed attempt, never dismisses` — replaced with an unsettled direct charge, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1136` — timeout is charged once through the settlement — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: timeout charges a failed attempt, never dismisses` — replaced with an unsettled direct charge, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1350` — `pr_review` is not marked before the push — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: verified push dismisses once, after commitAndPushPending` — flipped to mark every type, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1350` — other types are still marked before the push — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: an 'issue' comment is unaffected — markCommentProcessed still runs before the push` — flipped to mark none, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1645` — escape-hatch hand-off dismisses the review — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: an escape-hatch hand-off dismisses the review exactly once` — retire removed, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1647` — PR #3408 review: escape-hatch hand-off reply fails to post, so the review is charged, not dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: an escape-hatch hand-off whose reply fails to post charges a failed attempt, never dismisses (Issue #3408 review)` — `if (handOffPosted)` flipped to always true, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1723` — fix PR could not be raised (human asked), so the review is dismissed — `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts::processPrFeedback - gated head: pr_review fix PR creation failure => dismisses the review once (Issue #3383)` — retire removed, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1725` — PR #3408 review: fix-PR-raise-failed hand-off reply fails to post too, so the review is charged, not dismissed — `worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts::processPrFeedback - gated head: pr_review fix PR creation failure, and the hand-off reply itself fails to post => charges, never dismisses (Issue #3408 review)` — `if (posted)` flipped to always true, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1747` — fix verified on the remote, so the review is dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: verified push dismisses once, after commitAndPushPending` — retire removed, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1749` — PR #3408 review: verified-push reply fails to post, so the review is charged, not dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a verified push whose reply fails to post charges a failed attempt, never dismisses (Issue #3408 review)` — `if (posted)` flipped to always true, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1764` — `pr_review` push not landed, so charged and not dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: push not landed charges, does not dismiss` — charge disabled, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1769` — other types still get the push-failed reply — `worker/deno/tests/pr_feedback_processor_test.ts::processPrFeedback - a local commit with a failed push never claims success (Issue #579)` — flipped to charge every type, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1782` — rebuttal posted, so the review is dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: rebuttal with no changes dismisses exactly once` — retire removed, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1784` — PR #3408 review: rebuttal reply fails to post, so the review is charged, not dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: a rebuttal that fails to post charges a failed attempt, never dismisses (Issue #3408 review)` — `if (posted)` flipped to always true, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1833` — `needs-human` escalation dismisses the review — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: no fix, no rebuttal after in-run retry — escalates and dismisses once` — retire removed, test went red
- `worker/deno/lib/pr_feedback_processor.ts:1840` — PR #3408 review: the escalation itself fails (label add and comment post both reject), so the review is charged, not dismissed — `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts::pr_review dismissal: no fix, no rebuttal, and the escalation itself fails (label + comment) — charges, never dismisses (Issue #3408 review)` — `if (escalated.ok)` flipped to always true, test went red
- `worker/deno/lib/pr_maintenance.ts:1072` — live fleet lease, so the review is skipped and the skip logged — `worker/deno/tests/pr_maintenance_review_lease_3383_test.ts::findPrCommentsToFix - a live fleet lease claim hides the review and the skip is logged (Issue #3383)` — check disabled, test went red
- `worker/deno/lib/pr_maintenance.ts:1072` — lapsed lease, so the review stays actionable — `worker/deno/tests/pr_maintenance_review_lease_3383_test.ts::findPrCommentsToFix - a lapsed lease is actionable again, even with a failed-once marker left behind (Issue #3383)` — flipped to always skip, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:56` — existing lease line replaced — `worker/deno/tests/pr_review_claim_lease_test.ts::withRenewedLease replaces an existing lease line` — flipped to always append, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:56` — absent lease line appended — `worker/deno/tests/pr_review_claim_lease_test.ts::withRenewedLease appends a lease line when absent` — flipped to always replace, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:79` — neither timestamp parses, so not live — `worker/deno/tests/pr_review_claim_lease_test.ts::isLeaseLive is false when neither timestamp parses` — flipped to live, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:81` — inside or outside the lease window — `worker/deno/tests/pr_review_claim_lease_test.ts::isLeaseLive respects the lease window boundary` — comparison inverted, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:122` — renewal not yet due, so no PATCH — `worker/deno/tests/pr_review_claim_lease_test.ts::createClaimLeaseRenewer does nothing before the renew interval` — guard removed, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:122` — renewal due, so the claim comment is PATCHed — `worker/deno/tests/pr_review_claim_lease_test.ts::createClaimLeaseRenewer PATCHes the claim comment once due` — flipped to never renew, test went red
- `worker/deno/lib/pr_review_claim_lease.ts:129` — renewal PATCH fails, so it is logged and not thrown — `worker/deno/tests/pr_review_claim_lease_test.ts::createClaimLeaseRenewer never throws when gh rejects, and names the claim id` — flipped to rethrow, test went red
