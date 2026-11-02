# Refresh only ready PRs on strict bases without merge queues

## Summary

Strict, non-queue bases now refresh only an armed PR with satisfied review,
confirmed mergeability and passing required checks on its current head or
verified test merge. A shared GitHub comment owner serialises refreshes across
hosts and updater lanes until merge, closure, required-check failure or bounded
expiry. Conflict repair remains separate. Closes #4613.

## Spec

### Intent and Rationale

- Avoid spending CI minutes refreshing branches that still await review or do
  not otherwise qualify to merge.
- Reuse the required-check evaluator from PR #4666 and the existing distributed
  PR-comment lock so one owner is visible across worker hosts and skill lanes.

### Essential Design Decisions

- Ownership records are keyed by repository and base branch and persist on a
  GitHub PR comment. The oldest repository PR is the stable comment and lock
  anchor, including after it closes; the existing distributed lock protects
  each short ownership read/write transaction. The refresh owner outlives that
  lock and expires after six hours.
- The required-check contract includes ruleset and classic protection checks,
  publisher pins and the verified test merge. Optional pending or skipped jobs
  do not block selection. Unreadable state is logged and retried.
- A ready PR remains the owner while checks are pending. Merge, closure,
  required-check failure or expiry releases it; a later eligible PR can then
  proceed.
- The REST pull-request list sorted by `created` ascending with `per_page=1`
  supplies a stable repository-wide lock anchor. Separate base records can own
  refreshes independently; only their brief lock transactions share the
  anchor.

### Undiscoverable Facts

- A same-backlog behavioural test counted two legacy refresh requests and one
  request while the first ready PR owned the base.
- A read-only ruleset check observed `strict_required_status_checks_policy: true`
  and required context `gate` on this repository's `main` branch.
- `gh api repos/stSoftwareAU/VibeCoder/pulls?state=all&sort=created&direction=asc&per_page=1 --jq '.[].number'`
  returned PR number `6`, confirming the oldest-PR anchor query works with the
  installed `gh` CLI.
- No `deno.lock` dependency changed. Version bump: none; no `VERSION` change
  was needed.

## Evidence

Backend-only change; no visual evidence applies.

- `worker/deno/tests/required_branch_checks_4613_test.ts` exercises current-head
  readiness, review and queue refusal, optional jobs, a two-ready-PR backlog,
  and release after a required-check failure. Refresh requests in that fixture
  fell from 2 to 1 while the owner was active.
- `worker/deno/tests/base_refresh_ownership_4613_test.ts` exercises competing
  host ports, same-base exclusion, release and recovery, expiry, and
  independent repository/base ownership. Removing the active-owner refusal
  made `base refresh owner serialises lanes and releases for the next PR` fail.
- Real ruleset response: `gh api repos/stSoftwareAU/VibeCoder/rules/branches/main --paginate --slurp`
  returned a required-status-check rule with strict mode enabled and context
  `gate`.

## Test Plan

- `deno task test:unit tests/base_refresh_ownership_4613_test.ts tests/required_branch_checks_4613_test.ts tests/pr_branch_update_test.ts tests/auto_merge_sweep_keeps_armed_test.ts tests/review_fleet_prs_backlog_3225_test.ts tests/review_fleet_prs_dependabot_test.ts tests/merge_block_escalation_test.ts` — 132 passed, 0 failed.
- `deno task test:unit tests/review_fleet_prs_dependabot_test.ts` — 15 passed, 0 failed.
- `deno task test:unit tests/fleet_pr_babysitter_test.ts` — 54 passed, 1 failed because the isolated subprocess could not download `https://jsr.io/@std/crypto/meta.json` (`JSR package manifest for '@std/crypto' failed to load`). The same network error repeated on retry.
- Targeted `deno fmt --check`, `deno lint` and `deno check` for the changed TypeScript files — passed.
- `worker/deno/tests/pr_branch_update_test.ts::executePrBranchUpdates - behind refresh uses the shared readiness policy` confirms the branch-maintenance caller uses the shared guard; the adjacent conflict test confirms conflict repair bypasses that behind-only route.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: removed the former expectation that every approved behind PR issues an update. Required by “A behind PR that is awaiting review is not updated.” Replaced by no update requests while rules are unreadable; current-head readiness and approved selection are exercised through the shared-policy tests above.
- `worker/deno/tests/auto_merge_sweep_keeps_armed_test.ts`: replaced the assertion that an armed behind PR always issues `update-branch` with an assertion that it reaches the shared ruleset policy. Required by the ready-only refresh policy.
- Call sites checked: auto-merge sweep, reviewer upkeep and post-approval, PR branch maintenance, fleet PR babysitter, and merge-block escalation. Plain behind refreshes use the shared policy; conflict repair retains its existing path.
- Test files named above exist at the repository head. No test assertion was removed from the Dependabot refusal, per-PR lock, or conflict-repair cases.
- `deno task pr-summary-check --base 18cbb398 --issue-body-file /tmp/issue-4613-body.md --labels enhancement,top-priority,work-on ../../docs/archive/pr-summaries/pr-summary-4613.md` — passed; 0 blocked, 0 not checked.
- The full `./quality.sh` gate has not yet run.

## Deno regression avoided

- Kept tooling, tests and dependency management Deno-native; no Node tooling or lockfile dependency was added.

## Merge verification

- CI: pending on the pull request.
