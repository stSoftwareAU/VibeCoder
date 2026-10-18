# Subscription allocation

Issue #3646 adds an opt-in allocation controller for the main issue-processing
loop. It compares successfully reviewed, required-CI-green, merged issues per
**estimated API-equivalent USD**, including observed retries, failed invocations
and follow-on work. This is the existing published-model-price estimate. It
does not calculate subscription fees, amortise seats, purchase subscriptions,
change entitlements or enable metered billing.

The incumbent remains native Claude: Sonnet manager at high effort, Haiku
executors and the existing review gates, including post-PR review. Candidate
arms use [independent role dispatch](ROLE-CONFIGURATION.md). Every role provider
must have a registered adapter, provisioned fixed-price subscription and
available observed quota. Fable is excluded, including as reviewer. Astra/Sol
are feasibility candidates; naming them does not prove CLI availability,
pricing, subscription entitlement or sandbox support.

## Configure and preview

Add `subscription_allocation` to the host configuration. This example keeps
routing off and illustrates a same-provider candidate; it makes no claim that
the candidate outperforms the incumbent. Replace paths, host names, budgets and
capacities with the provisioned fleet's values. All participating hosts must
use the same policy and complete ledger set.

```json
{
  "subscription_allocation": {
    "seed": "trial-2026-10",
    "auto_routing": false,
    "ledger_paths": ["/fleet/lifecycle_ledger_worker-a.jsonl"],
    "capacity_path": "/fleet/allocation-capacity.json",
    "providers": {
      "claude": {"estimated_budget_usd": 1000, "max_parallelism": 2}
    },
    "hosts": {
      "worker-a": {"providers": ["claude"], "capacity": 2, "weight": 1}
    },
    "arms": [
      {
        "id": "sonnet-haiku", "label": "Incumbent", "control": true,
        "status": "active", "weight": 1,
        "manager": {"provider": "claude", "model": "sonnet"},
        "executor": {"provider": "claude", "model": "haiku"}
      },
      {
        "id": "sonnet-sonnet-v1", "label": "Candidate", "control": false,
        "status": "active", "weight": 1,
        "manager": {"provider": "claude", "model": "sonnet"},
        "executor": {"provider": "claude", "model": "sonnet"},
        "reviewer": {"provider": "claude", "model": "opus"}
      }
    ]
  }
}
```

`reviewer` defaults to Claude/Opus. Manager/executor pairings can use any
registered, admitted provider combination. `awaiting-feasibility` arms receive
no assignments. Use a new cohort ID when changing a treatment: recorded roles
that disagree with the configured manager/executor block comparisons.

From `worker/deno`, run with the normal worker configuration:

```bash
deno run --allow-all mod.ts subscription-allocation
```

Preview prints weights, reasons, intervals, mature merge counts and effective
host-day sample counts. It records a durable dry-run receipt without applying
the recommendation. An empty existing ledger supports preview; a missing or
unreadable named ledger fails. Once the preview is reviewed, explicitly set
`auto_routing: true` and run `subscription-allocation --apply`, or let the main
loop apply it before its next issue. No route changes happen without both the
opt-in and the receipt. The standalone `execute-claude-phase` command uses role
configuration directly and does not participate in allocation.

## Budgets, capacity and routing

`estimated_budget_usd` is a rolling-window experiment admission limit per
provider, measured in estimated API-equivalent USD. `hosts.*.weight` divides
that allowance between hosts; it does not buy capacity. Host capacity must
cover `max_concurrent_issues`. The sum of configured host capacities using a
provider cannot exceed its `max_parallelism`, conservatively reserving slots
even when other hosts are idle. Only declared host providers participate and
all must be enabled in `agent_providers`.

Before a new issue, admission checks live slot holds, fixed subscription proof,
observed quota, published model pricing, known historical costs, and room for
`max_issue_cost_usd` per active/reserved issue. Follow-on costs without provider
identity conservatively consume each provider's admission budget, while the
efficiency report counts them once. These estimated budgets cover the declared
trial arms; provider quota checks also reflect other subscription use.

Routing draws deterministically from the current eligible weights using the
seed, decision epoch, repository and issue. Unavailable arms receive no work;
their configured weights remain. Stable issue assignment markers preserve the
original cohort across retries and fallbacks. Host restrictions and missing
quota can temporarily prevent a control assignment; the controller retains its
control floor. Provision enough control capacity across the fleet.

The native control requires `issue_executor_split: true`. A repository override
`external_orchestration: false` restores native routing for that repository.
Setting `auto_routing: false` stops allocation across the host. Existing issue
discovery, CI, review and merge gates continue to apply.

## Evidence and gradual decisions

The controller refreshes after terminal issue callbacks, after observing closed
or merged PRs, at completed scan cycles, and before issue admission. Scan
frequency follows the existing worker loop; no fixed 30-day wait or additional
background timer is introduced. Changes are limited to one decision per
`min_decision_seconds` (default 900), and unchanged outcome evidence cannot
compound shifts. Quality and reliability rollback bypass this cadence.

Only original cohorts inside the rolling `window_days` (default 30) are
compared. `horizon_days` (default 1, configurable to a positive fraction) is
assignment maturity, not a minimum experiment duration. Immature merges do
not count towards efficiency. Pending/censored issues, failed attempts and
unknown costs remain visible. Missing cost, excluded models and detected
repository/issue-mix bias prevent shifts.

Defaults require 30 mature verified merges and 10 independent host-day clusters
per arm. These are admission minima, not guarantees of sufficient evidence.
Reward and cost intervals use bounded host-day cluster means, empirical
Bernstein bounds and summable error spending across decision looks, sample
counts and report timestamps. Independent clusters and the declared bounds
are assumptions; within-cluster correlation is allowed. `error_budget`
defaults to 0.01; `max_cluster_issues` defaults to 24 and
`max_issue_cost_usd` to 10. Observations exceeding either bound block changes.
The conservative intervals may need substantially more observations than the
minimums. Their output is not a live performance claim.

A candidate's lower efficiency bound must exceed every other arm's upper
bound by `min_relative_gain` (default 0.10). It must also preserve measured
throughput, avoid extra idle time, keep quota saturation below
`max_failure_rate`, keep merge rate within five percentage points of control,
and keep mean merge latency below `max_latency_hours` (72) and 1.25 times
control. Each shift transfers at most `max_shift` (0.05; maximum 0.10), retaining
`control_floor` (0.20) and each active candidate's `exploration_floor` (0.10).
Overlapping uncertainty retains weights. This starts as a randomised control
trial and becomes bounded adaptive routing only with adequate evidence.

Capacity measurements must cover the same mature cohort exposure as the report.
Publish a fresh JSON snapshot through `capacity_path`, using measured host-days
and slot seconds, for example:

```json
{
  "observedAt": "2026-10-18T12:00:00Z",
  "correlatedOutage": false,
  "arms": {
    "sonnet-haiku": {
      "hostDays": 10, "availableSlotSeconds": 864000,
      "idleSlotSeconds": 1000, "quotaBlockedSlotSeconds": 100
    },
    "sonnet-sonnet-v1": {
      "hostDays": 10, "availableSlotSeconds": 864000,
      "idleSlotSeconds": 1000, "quotaBlockedSlotSeconds": 100
    }
  }
}
```

Snapshots older than one hour, missing/invalid measurements or a reported
correlated outage hold weights. The controller does not invent idle-time
measurements from missing ledger events. `max_pending_fraction` (0.50) blocks
comparisons with excessive pending/censored exposure. Recent review rejection
rate above `max_review_rate` (0.20), gate failures above `max_failure_rate`
(0.25), or invocation failure/quota rate above that limit immediately restore
initial weights and persist a pause. Paused admission uses the control only,
subject to its subscription, budget and quota checks.

## Restart and recovery

State lives under the existing durable agent-state directory in
`subscription-allocation/state-v1.json`, protected by the existing file lock
and atomic writer. Schema or policy mismatch fails closed without overwriting
the old state. Toggling `auto_routing` alone preserves the policy identity.
After reviewing a pause or changing policy, run the preview command with
`--reset-state`, review the new initial allocation, then apply. This explicitly
resets weights and decision history; it does not rewrite assignment markers or
ledger history. Automatic refresh failures are logged without changing the
completed issue/scan result; subsequent issue admission still fails closed on
invalid evidence or state.

## Read-only experiment reports

`fleet-experiment-report` reads lifecycle ledgers without changing allocation.
It supports `--ledger a.jsonl,b.jsonl`, `--window 30`, `--horizon 1`,
`--format json` or `csv`, and `--covariates covariates.json`. Covariates map
`repo#issue` to string-valued attributes. Its default follow-up horizon is 14
days. Text breakdowns distinguish all merges from mature merges and use mature
costs, avoiding an immature numerator against a mature denominator.

`--synthetic 42` produces repeatable artificial history and is explicitly
labelled as synthetic. The report's fixed-cutoff bootstrap verdict is
descriptive; automatic allocation uses the separate sequential safeguards
above. The report foundation was recovered from the unmerged #3645 branch as
a prerequisite of #3646; the cancelled ticket was not reopened.
