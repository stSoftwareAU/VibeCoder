# Quota-aware polling gate: park low-priority repos and defer the idle-task tier when GraphQL quota is low

## Summary

The fleet burns its shared 5,000-point hourly GitHub GraphQL quota within
~25 minutes of each reset, then idles in the pre-flight pause for the rest of
the hour. Even a cycle that claims no issues spends 2,000–3,400 points —
`priority:idle-work-hooks` alone made 494 GraphQL calls in one observed cycle,
418 of them `issue list` searches. The polling gate reserves the tail of the
window for priority work, judged once per scan from the **free** quota probe
(`{ rateLimit { … } }`, a query GitHub does not charge):

- **Park tier.** Below `quota_poll_park_floor` (default 1500) points remaining,
  repos with `nice >= quota_poll_park_nice` (default 99 — TagsTS, template-rust,
  NEAT-AI-Examples) are skipped whole for that cycle: no PR fetches, no
  timeline batch, no candidate collectors. `parkedRepos` rides the finder
  result; one WARNING line names the reading, the floor and the parked count.
- **Idle tier.** Below `quota_poll_idle_floor` (default 500) points remaining,
  idle-task collection is deferred fleet-wide — the scan's
  `collectIdleTaskCandidates` and the idle-task filer's repo walk (~800
  points/cycle, the Issue #1915 measurement) both stand down, because nothing
  raised below that floor could be claimed before the window resets.

Both boundaries are strict less-than, each cycle re-probes so recovery is
automatic, a floor of `0` disables its tier, and an unreadable quota defers
nothing — the gate fails open everywhere. The idle-detect audit models both
deferrals as the fleet's own deliberate refusals (parked repos join its held
set, `quota_idle_deferred` excludes idle-task-only work), so neither parks into
a `mis_classification` alert.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `quota_poll_park_floor` | `1500` | Points remaining below which park-tier repos are skipped whole; `0` disables the park tier. |
| `quota_poll_park_nice` | `99` | The `nice` tier at or above which a repo is parked under the park floor. |
| `quota_poll_idle_floor` | `500` | Points remaining below which the idle tier is deferred fleet-wide; must not exceed the park floor; `0` disables the idle tier. |

## Tests

- `polling_quota_gate_test.ts` — the pure verdict and formatters (boundaries,
  fail-open, floor-of-zero kill switch).
- `find_oldest_issue_quota_gate_test.ts` — the park skip removes all PR
  fetches, timeline reads and collector searches for the parked repo; the idle
  deferral claims no idle-only work while a null reading claims it exactly as
  before.
- `polling_quota_gate_config_test.ts` — defaults, overrides, loud refusal of
  an idle floor above the park floor and of non-integer/negative floors.
- `run_core_idle_hooks_quota_gate_test.ts` — the filer seam defers with one
  line naming the reading, clears the disagreement streak, and the free
  week-pace check short-circuits before the quota probe is paid.
- `polling_quota_gate_wiring_test.ts` — one probe per scan, one fail-open
  warning on a failed probe, the default filer seam defers below the floor and
  passes above it.
- `idle_detect_week_pace_1915_test.ts` additions — `quota_idle_deferred`
  excludes idle-task-only work, off by default, and ranks below
  `pace_suppressed` in the dominance ladder.

**Docs sweep** — grep: `pollingGateVerdict`, `quota_poll_park_floor`,
`quotaPollParkFloor`, `quota_idle_deferred`, `parkedRepos`,
`idleFilerQuotaDeferred`; section:
`docs/CONFIGURATION.md#quota-poll-gate--park-the-tail-defer-the-idle-tier-issue-3628`;
siblings: `pace_suppressed`; updated: `docs/CONFIGURATION.md`,
`docs/workflows/issue-processing.md`, `docs/IDLE-TASK-FRAMEWORK.md`,
`DESIGN-PRINCIPLES.md`
