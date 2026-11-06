# PR feedback body sync on interrupted exits

## Summary

PR feedback refreshes the body from the summary committed at the confirmed
remote head before recording a turn-limit failure, including a push within the
first invocation. A later local commit or uncommitted rewrite cannot leak into
the published body. Agent-error, timeout and scheduled-release exits also
refresh a landed summary before returning. Closes #4851.

Version bump: No version change was made for this fix.

## Spec

### Intent and Rationale

- An agent can push a rewritten summary and then fail in the same invocation, or
  leave more local work during a later invocation. The live description should
  reflect the summary that reached the PR branch in either case.

### Essential Design Decisions

- Initial and later turn-limit failures share the sync-aware handler. It
  preserves the original error and charges the attempt after the refresh. Other
  early agent exits preserve their existing failure or release outcome.
- The failure path uses the push verifier's confirmed `remoteSha`, even when
  `landed` is false because local HEAD has advanced. `committedHeadSha` pins
  summary reads, digest and image resolution to that remote commit.
- Feedback opts into `allowLocalHeadAhead`: local HEAD must equal or descend
  from the pinned commit, and a fresh `ls-remote` must still report that commit
  just before publication. Other callers retain their existing strict check.
- The unused attempt latch and redundant inner gated-head guard were removed.
  Each sync call is on a mutually exclusive return path; caller guards still
  exclude gated-head fix branches. Sync failures are logged without replacing
  the agent outcome.

### Undiscoverable Facts

- The claim comment names host `vibe-coder-10923`, but its run log was not
  available in this workspace. The incident's historical return path remains
  unconfirmed; the regressions reproduce the reported Git states locally.

## Evidence

Backend-only change; no browser check applies. The regressions use a temporary
bare Git remote and production `verifyPushLanded` and `syncPrBodyFromSummary`.
They capture the actual `gh pr edit` body and require one edit before failure
accounting, with the pushed summary's digest and canonical run ID. Different
unpushed committed and uncommitted summaries must never appear in that body.

Against the pre-fix head, the initial turn-limit and later-local-commit cases
both failed with zero body edits instead of one. The agent-error, timeout and
scheduled-release cases reproduced the same missed refresh. All six scenarios
pass with the fix. Removing `committedHeadSha` forwarding publishes the dirty
summary and fails the strengthened regression.

Read `docs/USAGE.md`'s PR Summary File section and
`docs/workflows/pr-feedback.md`'s summary-refresh explanation; both now describe
the interrupted exits and exclusion of local-only content. The shared body-sync
contract comments also describe the opt-in descendant check. The existing
normal-push, no-change and held-review entry points retain their guards.

## Test Plan

- `worker/deno/tests/pr_feedback_processor_test.ts` — 50 tests passed. Six
  real-push cases cover later and initial turn limits, a subsequent local-only
  commit, agent error, scheduled release and timeout. Every case leaves a
  different uncommitted summary and checks body content, digest, run ID, edit
  count and outcome. The turn-limit cases preserve the original error object.
- The new failure-path safety test covers gated heads, unreachable remotes,
  thrown verification, unsuccessful sync results and thrown sync errors. It
  checks sync exclusion, warning output and exactly one failure charge.
- `worker/deno/tests/pr_body_sync_test.ts` — 60 tests passed, including the new
  opted-in local-lineage rejection and the existing strict adoption and moved
  remote-head protections.
- `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts` — 31 tests
  passed, retaining review settlement and held-review zero-unpushed guards.
- The combined focused run passed all 141 tests. The expanded real-push test
  retains every original assertion and strengthens the failure assertion to
  preserve the original error; no existing assertion was weakened or removed.
- Targeted mutation checks failed with assertions for all eight changes tested:
  removing `runId`, negating the committed-head forwarding condition, removing
  `committedHeadSha` forwarding, removing the failure-path gated-head guard,
  requiring the current local tip to have landed, removing the local-head-ahead
  allowance, bypassing the initial turn-limit handler, and removing lineage
  rejection. Each mutation was reverted after its test.
- For REQUIRED ITEM 1's original `pr_feedback_processor.ts:1275–1276` mutations,
  `bodySyncAttempted` was never read after being set: every caller returns
  before any other sync site. The inner `fixBranch` check also duplicated all
  callers' guards. These dead checks and the assignment were removed rather than
  exempted. The reachable failure-path gated-head guard is mutation-pinned by
  the new safety test; ordinary gated-head exclusion remains covered too.
- `deno lint` and `deno fmt --check` on the four changed TypeScript files
  passed. The focused test command also type-checked all three test files and
  imports.
- `deno task check:manifests` passed: 847 tests, 1 ignored.
- `./quality.sh < /dev/null` — both parallel and serial test passes succeeded,
  but the unit-test time-budget audit failed: both tests in unchanged
  `tests/launcher_harness_reclaim_stub_test.ts` exceeded one second (3.18s). The
  audit reported 90 slow tests overall. That file is unchanged from
  `origin/main`. All other executed quality checks passed, including lint,
  type-check, formatting, Markdown and security scans. Configuration integration
  and Checkov were skipped because their prerequisites were absent.
- The complete mutation campaign was not rerun; the eight targeted checks do not
  claim coverage of mutants the earlier budget never tested.

## Deno regression avoided

- Kept implementation, tests and validation on the repository's Deno tooling;
  added no Node tooling or dependencies.
