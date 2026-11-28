# Babysitter: a PR that needs a human no longer fails the pass

## Summary

The GRQ-health board showed `Fleet PR Babysitter:Mac-Ultra-M2` as failed
whenever one PR could not be repaired, then cleared on the next clean pass. On
27 November 2026, GRQ-AutoTrader#7102 failed two passes. It is a rustdoc-only
edit to a contract path, and its `contract-change` check needs a label and the
owner's approval, which the bot cannot give. The agent correctly declined to
report the fix ready, the repair threw a `code` failure, the failure joined the
pass's `AggregateError`, and the pass exited 1. The health hook reports that
exit code as a failed babysitter.

A repair whose agent ran and judged the PR not ready now throws
`BabysitterNeedsHuman`, a `BabysitterFailure` subclass that keeps the `code`
blocker class. `runRepairs` logs it as one `Babysitter repair needs a human:`
line and leaves it out of the `AggregateError`, as it already does for
`BabysitterParked` (Issue #5072). The pass then exits 0 and the board stays
green. The failure record is now kept for faults in the babysitter itself.

## Spec

### Intent and Rationale

- Owner direction (28 November 2026): checking contract-change PRs by hand is
  expected, and those PRs should not be recorded as a babysitter failure.
- The health record is meant to say whether the babysitter works, not whether
  every PR it looked at could be fixed.

### Essential Design Decisions

- Only the "agent did not report that its fix was ready" outcome changes. Other
  code failures, such as an exhausted session budget, still fail the pass, as
  do scan errors and infrastructure, capability and race failures.
- The subclass keeps `blockerClass: "code"`, so retry records, the
  substantive-attempt budget, attempt markers and the no-progress escalation
  issue are unchanged. The PR's outcome is still visible per PR.
- A pre-push gate block on the PR's own checks also arrives as a not-ready
  response, so it is covered too. It is a verdict on the PR, not the babysitter.

### Undiscoverable Facts

- Most passes on Mac-Ultra-M2 succeed. In the 30 passes before this change, 3
  exited 1, and all 3 were not-ready repairs (GRQ-AutoTrader#7102 twice and
  #7036 once).

## Evidence

- Read and updated `docs/workflows/fleet-pr-babysitter.md` (the health-hook
  paragraph).
- The new test file failed before the change (the class did not exist) and
  passes after it. `fleet_pr_babysitter_test.ts`,
  `babysitter_fix_orchestration_test.ts` and `babysitter_quota_park_5072_test.ts`
  pass (208 tests in all).
- In the wider babysitter test run, three `babysitterSpawn` and
  `babysitterImageExists` tests in `fleet_babysitter_container_4738_test.ts`
  fail on this host with and without this change. CI passed them on #5644.

## Test Plan

- Added `worker/deno/tests/babysitter_needs_human_not_failure_test.ts`:
  - `a needs-human repair keeps the code blocker class`
  - `a needs-human repair is logged once and does not fail the pass`
  - `another code failure still fails the pass`
