# Sync the milestone inline at completion and arm in the same cycle (Issue #2005)

## Summary

A child PR raised while its milestone branch had fallen behind the default
branch was left unarmed: `decideMilestoneBaseMerge` answered
`defer/milestone-behind`, and both completion and the auto-merge sweeps
waited for the next cycle's 1.72 sync. Every hour of that wait let the
next child, and the default branch, drift further.

Completion, priority 1.65 and the post-scan sweep now run the same inline
pre-sync (same ledger, same conflict budget, same pacing as #1780) once per
milestone per cycle. A clean landing invalidates the compare memo and arms
the PR immediately. A conflicting sync still defers with no side-pick; the
reason is posted on the PR and the 1.72 sweep remains the backstop.

Closes #2005.

## Evidence

Targeted Deno tests (from `worker/deno`):

- `tests/pr_auto_merge_test.ts` — clean sync arms; conflicting sync defers
  and comments once per PR
- `tests/milestone_presync_test.ts` — one sync attempt per milestone until
  the cycle memo resets
- `tests/milestone_children_gate_test.ts` — invalidate forces a fresh compare
- `tests/issue_worker_test.ts` — completion passes the in-cycle sync hook

No UI change; visual evidence does not apply.

## Human verification

1. Raise a child PR while its `milestone/*` base is one cleanly mergeable
   commit behind the default branch. Confirm auto-merge is armed in the
   same cycle (creation log or post-scan sweep), without waiting for 1.72.
2. Repeat with a conflicting sync. Confirm the PR stays unarmed, carries
   the `<!-- vibe-coder:milestone-behind-sync -->` comment, and is not
   side-picked.
