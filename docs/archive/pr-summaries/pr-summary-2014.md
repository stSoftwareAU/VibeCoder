# Merge-conflict PRs must be retried automatically (Issues #2014–#2019)

## Summary

A merge-conflict retry used to wait four hours, spend the same two-attempt
budget against a moved base, and leave a stale `escalated` label plus its
work issue after GitHub called the PR `MERGEABLE` again. A stall watchdog
could file that as work and then leave the PR at the back of the queue.

This change retries on a one-hour cooldown, records the live `base`/`head`
tips on attempt and failure markers, and counts only failures judged against
those tips. Resolve and merge-conflict handlers keep a 24-minute
`agentFloorMs` so an attempt started with just enough budget can finish. A
milestone branch deferred for cycle budget is rotated to the front of the
next sweep, and a moved default tip zeroes its conflict count. When a
labelled PR is `MERGEABLE` the scan (and a successful resolution) clears
`merge-conflict`, closes the work-escalation issue, and removes `escalated`.
`UNKNOWN` is never reconciled. The stall threshold stays at eight hours; a
stalled ordinary head is first on the next drain, and a `milestone/**` head
records `agentDeferredSince`.

Closes #2014. Closes #2015. Closes #2016. Closes #2017. Closes #2018.
Closes #2019.

## Evidence

Targeted Deno tests (from `worker/deno`):

- `tests/pr_merge_conflict_scan_test.ts`
- `tests/pr_merge_conflict_processor_test.ts`
- `tests/escalate_as_work_test.ts`
- `tests/merge_conflict_decision_taxonomy_test.ts`
- `tests/merge_conflict_drain_test.ts`
- `tests/merge_conflict_stall_watchdog_test.ts`
- `tests/milestone_sync_streak_test.ts`
- `tests/milestone_branch_sync_test.ts`
- `tests/agent_run_termination_test.ts`
- `deno task check:manifests`

No UI change; visual evidence does not apply.

## Human verification

1. Open a fleet PR that conflicts with its base. Confirm the attempt comment
   carries `base="<40-hex>" head="<40-hex>"`.
2. After the cooldown (one hour) or a base-tip move, confirm a second
   attempt is selected without waiting four hours.
3. Resolve the conflict outside the worker. Confirm `merge-conflict` and
   `escalated` are cleared and any work-escalation issue is closed.
4. Leave a labelled conflicting PR untouched for eight hours. Confirm the
   stall watchdog files work and the PR is first on the next drain.
