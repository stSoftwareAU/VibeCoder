## Summary

Review-fix verification now reads the description rebuilt from the branch's
summary and facts. Previously it judged the old GitHub description and blocked
before the corrected description could be published, repeatedly rejecting a
summary-only repair.

Closes #4218. Closes #4219. Closes #4220. Addresses the loop reported in #3982.

## Spec

### Intent and Rationale

- Verify the description that the worker prepares for publication so correcting
  the archived summary can clear a stale-description finding in the same run.
- Keep all verification, failure accounting and merge holds intact.

### Essential Design Decisions

- Extract one read-only candidate builder from the existing publisher. Both
  paths share worker ownership, own-branch adoption, summary loading, structured
  facts, metadata and body assembly. Only publication finalises image paths.
- Verification rebuilds even when the live digest has not changed. Publication
  retains its digest/legacy staleness checks and remote-head guard.
- A blocked review still refreshes its description when the measured unpushed
  count is exactly zero. Outstanding commits and failed measurements skip sync.
- Candidate errors carry the PR number and branch. Ineligible descriptions use
  the live body and log why. A sync failure cannot suppress the review hold.

### Undiscoverable Facts

- Fleet comments on six PRs described a corrected archived summary while
  rejecting the old supplied body. The worker's verifier ran before body sync.

## Evidence

- Before implementation, both worker-marker and own-branch adoption regressions
  failed because the verifier received the stale live description.
- Before the hold-path repair, the zero-unpushed regression failed because the
  body-sync call was missing. The same tests passed after the changes.
- Four focused suites: 126 passed, zero failed. Repository completeness checks:
  805 passed, zero failed, one ignored.
- Deno lint, format, type checking and Markdown lint passed. The full quality gate has not finished and is not a pass; its test
  stage is still running. Checkov, Semgrep, config integration and release-tag
  ruleset checks were skipped by that run.

**Docs sweep** — grep: `Review-fix`, `body sync`, `feedback-verifier`, `runPrBodySync`, `verifyFeedbackFix`; section: `docs/INTERNALS.md` (Feedback processing flow), `docs/workflows/pr-feedback.md` (Recount the Test Plan after a review fix); siblings: none — no registry or provider gains a member; updated: `docs/INTERNALS.md`, `docs/workflows/pr-feedback.md` and the shared builder's source documentation. Existing publication skip/error log text still describes the publisher's unchanged guards.

## Test Plan

- `worker/deno/tests/pr_body_sync_test.ts`: 52 tests; the original 47 tests are
  unchanged. Five additions exercise marker ownership, own-branch adoption,
  foreign and missing summaries, unchanged relative image references, and exact
  candidate/publication parity including structured facts.
- `worker/deno/tests/pr_feedback_verifier_3784_test.ts`: five tests. New cases
  verify repaired candidates replace stale claims in both verifier inputs and
  builder errors prevent verification. Existing assertions are retained;
  fixtures now provide the required head-branch metadata.
- `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts`: 26 tests.
  Four additions cover zero and outstanding unpushed commits, an error result
  and a thrown measurement; every case retains the outstanding review, failed
  attempt, standing-violation label and disabled auto-merge.
- `worker/deno/tests/pr_feedback_processor_test.ts`: 43 existing tests pass,
  including ordinary feedback, post-push sync, gated branches and turn limits.
- Twinned-rule search: candidate construction is now shared with publication;
  no second ownership/adoption rule was introduced. CI and conflict processors
  continue to use the same publisher with its existing signature.
- No existing assertion was removed or weakened. No UI or persisted schema
  changes are involved.

**Branch outcomes:**

- `worker/deno/lib/pr_feedback_verifier.ts:74` — an eligible body is rebuilt before verification — test `worker/deno/tests/pr_feedback_verifier_3784_test.ts` (`feedback verifier - marker summary repair replaces stale live claims before publication`) — flip: before implementation the test failed because it received Stale live claims instead of the corrected branch summary.
- `worker/deno/lib/pr_feedback_verifier.ts:74` — own-branch adoption uses the same rebuilt candidate — test `worker/deno/tests/pr_feedback_verifier_3784_test.ts` (`feedback verifier - own-branch summary repair replaces stale live claims before publication`) — flip: before implementation the test failed because the live body was supplied.
- `worker/deno/lib/pr_feedback_processor.ts:1670` — exactly zero unpushed commits permits sync before recording the hold — test `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts` (`review-fix hold - body sync requires measured zero unpushed commits: 0`) — flip: before implementation the sync count was zero and the expected one call failed.

Not checked: model-based review and live fleet behaviour after deployment.
