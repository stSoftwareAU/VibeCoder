# Operational stabilisation baseline — 18 October 2026

This baseline does **not establish a throughput improvement**. The reproducible
report has no collected live host ledgers. Its zero observed deliveries is not
zero fleet deliveries; cost, delivery latency, first-pass results, complete review
rounds and actual deployed builds/configuration remain unknown. The eight repairs
in #3980 must be measured after deployment before attributing a benefit to them.

## Observation window and reproduction

The historical window is **7 October 2026 00:00:00 UTC through 14 October 2026
23:59:59.999 UTC**, matching the public [#3690 overhead baseline](https://github.com/stSoftwareAU/VibeCoder/blob/milestone/manager-worker-orchestration-and-fleet-experiments/docs/milestone-sync-overhead.md).
This is a baseline observation, not an experiment arm.

From `worker/deno`:

```bash
deno task stabilisation-report \
  --evidence ../../docs/evidence/stabilisation-2026-10-18.input.json \
  ../../docs/evidence/stabilisation-2026-10-18.ledger.jsonl
```

The checked-in `.report.json` is that command's output. The `.ledger.jsonl` is
intentionally empty because collection was unavailable. The input explicitly
marks incomplete history and missing host coverage. It contains no synthetic
fleet activity. Synthetic reconciliation fixtures live only in
`tests/stabilisation_report_test.ts` and prove software behaviour, not deployment
or an operational saving.

The report reuses `readLifecycleLedger`, `lifecycleEventsAtCutoff`,
`classifyLifecycleOutcome` and `reconcileLifecycleEvents`. It neither writes a
second telemetry store nor changes gates, routing, model selection, subscriptions
or allocation. #3645's separate experiment/reporting prerequisite was cancelled;
this report does not recreate its randomisation or allocation system.

## What the available evidence establishes

The #3690 corpus observed **zero identical sync re-push repeats** and recorded
**zero expected reduction** from that guard in its window. Its inspected
force-pushes moved a parent; not every force-push was inspected individually.
That is no observed benefit for this selected corpus, with unknown check/time
cost and unknown net benefit. It is not proof that the guard can never prevent a
correctness problem. Its broader lifetime/cost comparison was unfinished.

The #3980 audit's 18 versus 41 failed-attempt records (4–10 and 11–17 October)
and 187 versus 177 new issues are different counts and windows. They do not give
a total-attempt denominator or establish a failure rate or causal change.
The historical implementation-PR totals in #3690 are not substituted for unique,
accepted implementation issues reaching the default branch.

| Selected repair | Live prevention/check/call/time/recurrence evidence in this baseline | Reached deployed worker build? | Net benefit |
| --- | --- | --- | --- |
| Audit producer #3976 | Unknown | Unknown | Unknown |
| Already-landed reconciliation #3977 | Unknown; synthetic controls are separate | Unknown | Unknown |
| Existing formatter path #3978 | Unknown | Unknown | Unknown |
| Facts renderer #3979 | Unknown | Unknown | Unknown |
| Declared causes #3738 | Unknown | Unknown | Unknown |
| Durable version statements #3954 | Unknown | Unknown | Unknown |
| Empty roll-ups #3910 | Unknown | Unknown | Unknown |
| Pending verification follow-ups #3961 | Unknown | Unknown | Unknown |

The accepted control remains **Sonnet manager / Haiku worker and Standards,
with Opus PR review**. That is owner direction, not a claim that a particular
unobserved host ran it. Capture each assignment's actual role treatment and
worker commit; do not replace missing fields with this planned configuration.

## Reading a collected report

An issue is active if it has an observation in the inclusive window, or a
verified delivery snapshot connects its earlier work to an in-window default
roll-up. Include all supplied history for that issue through the cutoff, so
pre-window attempts, failed/retried work and follow-ons remain in its cost.
Original assignment IDs recover follow-ons whose producers omit the issue number.

Delivery snapshots supply accepted implementation scope, the PR's actual target,
the repository's default branch and merge timestamp. Before supplying one,
retain the GitHub snapshot/acceptance evidence and verify child membership and
ancestry through the existing dependency/merge proof path. A tracking issue's
roll-up can deliver a child; a milestone-only merge cannot. The report also
requires the matching observed merge and existing pre-merge quality/review
proofs. Duplicate PRs or assignments earn one issue delivery. Missing target or
gate evidence remains missing, never presumed complete.

The cost numerator includes the whole active cohort, including pending and failed
work; it is not only the price of successful final attempts. Event-key replay
is deduplicated before aggregation. Manager, executor and reviewer subtotals reuse
existing role attribution. Follow-on records remain distinct from invocation
calls; selected-safeguard checks/calls/time are descriptive observations and are
not added to ledger spend a second time. Unknown usage/pricing and incomplete
collection prevent a complete per-delivery cost. A positive partial subtotal is
a lower bound, not a subscription bill.

First-pass quality/review means the first observed terminal gate decision per
issue; pending/skipped polls are ignored. Blocking review heads are a lower bound
on rework, not complete review rounds: the schema-1 polling ledger lacks review
IDs, so full rounds remain unknown. Root-cause input retains each existing
structured category/event-key pair, including simultaneous causes; it introduces
no text classifier. Unavailable older classifications remain missing.

Each safeguard shows supplied observed failures prevented, added checks, model
calls, seconds and residual recurrence. Synthetic observations are labelled and
cannot become live benefit. **Net benefit remains unknown**: this baseline has
no comparable avoided-rework measurements or causal assessment. A later report
must preserve assessment provenance before presenting a demonstrated or negative
net benefit; prevented-count arithmetic alone cannot establish it. There is no
comparative winner or inferred failure rate.

## Comparable follow-up procedure

1. Collect the explicit host ledger paths and their full relevant assignment
   histories. Keep a manifest of included hosts, missing/rotated files, collection
   times, source snapshots and exclusions. Do not mark `historyComplete` true
   until this coverage is verified; missing calls are not free work.
2. Record the actual deployed worker SHA and effective role treatment for each
   host/assignment. Establish deployment time separately from merge time for
   every selected fix. Hold the Sonnet/Haiku/Opus control fixed; mixed builds or
   role configurations are separate strata with explicit coverage.
3. Freeze another eight-day UTC window with the same repository/issue eligibility,
   host exposure, acceptance/default-ancestry checks and cutoff treatment. Keep
   milestone-only, failed, retried, pending and missing-evidence rows. Follow
   pending cohorts to a stated mature cutoff instead of dropping them.
4. Re-run this task on all collected files. Review the accepted-scope and target
   snapshots, all declared causes, unknown costs, first-head decisions and
   tracking-issue roll-up links. Obtain actual review IDs/round evidence separately
   before reporting a full review-round total.
5. For each safeguard retain prevention/recurrence receipts and measured added
   checks/calls/time, plus comparable avoided-rework time/cost and an assessment
   method. Keep deterministic sync time separate from model spend. Extend this
   read-only assessment with that provenance before changing `netBenefit` from
   unknown. A safety fix does not need financial ROI to be justified.
6. Have independent Spec and Standards reviewers inspect the baseline, coverage
   and follow-up comparison. Describe observed differences and uncertainty;
   unmatched counts or synthetic tests cannot establish causality, a winning
   model or a measured throughput gain. Model experimentation and subscription
   allocation remain separate work.

## Review

Independent review is recorded in the issue's PR summary once complete. The
initial review identified real producer-shape gaps: follow-on assignment joins,
tracking-issue roll-ups, simultaneous causes, pending gate polls and replacement
PRs after an abandoned attempt. Their regressions now exercise the report. The
live-evidence limitations above remain explicit rather than filled with fixture
results.
