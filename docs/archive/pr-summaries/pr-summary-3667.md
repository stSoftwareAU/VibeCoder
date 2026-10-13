# Poll low-priority repos less often: nice-derived per-repo cadence for the Priority 1.x passes

## Summary

Closes #3667.

The fleet's shared GitHub account (VibeCoderST) kept tripping GitHub's
**secondary** (burst) limit while most of its hourly GraphQL quota was unspent:
the three laptop launches on 2026-10-13 between 03:50Z and 08:05Z logged 929,
737 and 111 `GitHub secondary rate limit cool-down` lines, and GitHub refused
calls with 2,300–4,800 of 5,000 points left. The Issue #3628 quota gate never
saw this. It engages only below 1,500 points remaining, and only in the issue
scan. Every Priority 1.x pass walked all 22 monitored repos on every 2–3 minute
cycle. In those logs milestone-branch-sync made 426 gh calls,
stale-assignment-recovery 365 and milestone-completions 322.

The per-repo Priority 1.x passes now poll each repo on a cadence set by its
`nice`, always:

- `nice <= 0` — every cycle (unchanged).
- `0 < nice < quota_poll_park_nice` — every `poll_cadence_low_cycles` cycles
  (default 3).
- `nice >= quota_poll_park_nice` (99) — every `poll_cadence_park_cycles`
  cycles (default 10).

`repo_poll_cadence.ts` holds the pure cadence. Production deps pick the
cycle's repos once per cycle through the new optional
`RunCoreDeps.selectCyclePollRepos`, called right after
`resetIterationCaches`. The pick feeds PR feedback, spelling, CI fix, branch
updates, CI nudge, stall repair, close-issues-for-merged-PRs, milestone sync,
completions and closed-milestone housekeeping, failure-detection resume,
stale-workflow detection and stale-assignment recovery. A new
`secondaryLatchCount()` in `primary_quota_latch.ts` tells the pick that a
burst limit was taken since the last cycle. When one was, due low-priority
repos are held one more cycle, never beyond twice their cadence.

## Spec

### Intent and Rationale

- Cut the per-cycle burst against the shared account by polling deprioritised
  repos less often, independent of the hourly quota reading.
- Keep the Issue #2776 invariant: in-flight work in a high-`nice` repo is
  serviced later, never not at all.

### Essential Design Decisions

- Each repo remembers the cycle it was last polled, rather than using
  `cycle % N`, so a burst hold cannot push a repo out by a whole cadence and
  starvation is bounded at twice the cadence.
- First polls are staggered by list position, so the low-priority tier never
  lands on one cycle (a burst is what trips the secondary limit).
- Fail open: until the first pick every pass sees every repo, and a cadence
  that is not a whole number above 1 reads as every cycle. Allowlist checks
  (`isRepoAllowed`), the Priority 2 scan, auto-merge, conflict repair and the
  idle hooks keep the full list. Auto-merge and conflict repair finish work
  that is already done; the idle audit must model the same repos the scan saw
  (Issue #898).
- The park tier reuses `quota_poll_park_nice` rather than adding a third
  `nice` threshold.

### Undiscoverable Facts

- The laptop's own GraphQL use was 4–74 calls a cycle while the account's
  `spent-since-last-cycle` reached 4,479 points in four minutes. Other hosts
  on the shared account spend most of it, so this change has to land
  fleet-wide to matter.

## Evidence

Bug-fix evidence is tests (below), and the log line operators will see:

```text
poll-cadence: polling 19 of 22 repo(s) this cycle — deferred 3 low-priority repo(s) (nice > 0) to a later cycle: stSoftwareAU/GRQ-extract-score, stSoftwareAU/TagsTS, stSoftwareAU/template-rust
```

**Docs sweep** — grep: `quota_poll_park_nice`, `nice-gated`, `New-work
selection only`, `Priority 1.x`; section:
`docs/CONFIGURATION.md#poll-cadence--poll-low-priority-repos-less-often-issue-3667`;
siblings: `quota_poll_park_floor`, `quota_poll_idle_floor`; updated:
`docs/CONFIGURATION.md`, `DESIGN-PRINCIPLES.md`, the Issue #2776 scope note in
`worker/deno/lib/run_core.ts`.

## Test Plan

- `worker/deno/tests/repo_poll_cadence_test.ts`: tier cadences, a missing or malformed cadence
  failing open to every cycle, priority repos never deferred (even under a
  burst), staggered first polls, burst hold, no starvation
  under a burst every cycle, cadence 1 turns it off, a repo added mid-launch.
- `worker/deno/tests/repo_poll_cadence_wiring_test.ts`: real production deps. Before the first
  pick PR feedback sees every repo. Over 30 cycles it polls the nice -10 and
  unset repos 30 times, nice 10 ten times and nice 99 three times. A
  secondary latch holds the low tier for one cycle. Reverting the PR-feedback
  wiring turns this red.
- `worker/deno/tests/run_core_stale_recovery_test.ts`: `runCoreLoop` picks exactly once per
  cycle, before stale recovery reads the list.
- `worker/deno/tests/primary_quota_latch_test.ts`: `secondaryLatchCount` counts only secondary
  latches and survives the latch expiring.
- `worker/deno/tests/repo_poll_cadence_config_test.ts`: defaults, overrides, recognised keys,
  and loud refusal of zero, negative and fractional cadences.

Branch outcomes: (each flipped by a mutation run; every flip went red)

- `worker/deno/lib/repo_poll_cadence.ts:62` — `nice <= 0` polled every cycle;
  `worker/deno/tests/repo_poll_cadence_test.ts` "priority repos (nice <= 0) are polled every
  cycle" — red.
- `worker/deno/lib/repo_poll_cadence.ts:63` — park tier vs low tier; "low-priority
  repos are polled on their cadence" — red.
- `worker/deno/lib/repo_poll_cadence.ts:64` — operand `Number.isInteger`, and
  operand `cycles > 1`; "a missing or malformed cadence fails open" — red for
  each.
- `worker/deno/lib/repo_poll_cadence.ts:87` — cadence 1 is always due; "priority
  repos … even under a burst limit" — red.
- `worker/deno/lib/repo_poll_cadence.ts:92` — staggered first poll; "park-tier
  repos are staggered" — red.
- `worker/deno/lib/repo_poll_cadence.ts:94` — operand `burstSinceLastCycle`
  ("a burst limit holds a due low-priority repo") and operand
  `elapsed < 2 * cadence` ("never starves") — red for each.
- `worker/deno/lib/repo_poll_cadence.ts:95` — operand `elapsed >= cadence`
  ("polled on their cadence") and operand `!hold` ("a burst limit holds") —
  red for each.
- `worker/deno/lib/repo_poll_cadence.ts:99` — `burstHeld` set;
  `worker/deno/tests/repo_poll_cadence_wiring_test.ts` "a burst latch since the last pick holds
  due low-priority repos" — red.
- `worker/deno/lib/repo_poll_cadence.ts:114` — no line when nothing deferred;
  "formatRepoPollCadenceLine - names the deferred repos, or says nothing" —
  red.
- `worker/deno/lib/repo_poll_cadence.ts:119` — burst clause in the line; same
  test — red.
- `worker/deno/lib/config.ts:788` — operand `!Number.isInteger(value)` and
  operand `value < 1`; `worker/deno/tests/repo_poll_cadence_config_test.ts` "zero, negative or
  fractional cadences are refused" — red for each.
- `worker/deno/lib/primary_quota_latch.ts:162` — secondary latch counted;
  `worker/deno/tests/primary_quota_latch_test.ts` "secondaryLatchCount - counts secondary
  (burst) latches only" — red.
- `worker/deno/lib/run_core_production_deps.ts:5448` — burst detected from the
  latch count; wiring test "a burst latch since the last pick" — red.
- `worker/deno/lib/run_core_production_deps.ts:5458` — the cadence line is
  logged; wiring test "polls only the cycle's pick, by nice" — red.
- `worker/deno/lib/run_core.ts:6119` — the loop picks once per cycle;
  `worker/deno/tests/run_core_stale_recovery_test.ts` "picks the cycle's poll repos once per
  cycle, before stale recovery reads them" — red.
