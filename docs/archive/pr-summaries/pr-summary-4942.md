# Shared completion-first admission

## Summary

When a configured repository reaches its shared work limit, free issue slots
now dispatch existing PR repairs and stop starting unrelated implementation.
Live claims and PRs share capacity across hosts, with high/low hysteresis and
bounded recovery. The existing completion report can count delivered issues
separately from partial PRs. Closes #4942.

Version bump: no version change.

## Spec

### Intent and Rationale

- Improve issue-to-merge throughput by limiting concurrent changes and spending
  available capacity on finishing PRs. Opt-in policy preserves existing defaults.

### Essential Design Decisions

- Per-repository `completion_admission: {"high": 4, "low": 2}` opts in. A
  versioned, authenticated comment on the oldest issue holds shared policy,
  hysteresis and reservations, serialised by the existing distributed lock.
- Existing claim heartbeats retain reservations and recover crashed owners.
  Drafts, human PR pressure and final milestone integration count; claim-to-PR
  conversion is deduplicated by fleet branch identity or explicit closing refs.
  Milestone child streams retain a separate one-change limit.
- One explicitly referenced blocking dependency can exceed an inherited
  backlog, including base-CI repair. It retains its recovery slot through PR
  closure. Labels alone grant no exception. Existing PR ownership, same-host
  clone leases, review, CI and #4613 final refresh authority remain in force.
- Completion mode calls existing feedback, CI and conflict handlers through
  the existing watchdog dispatcher. Shared snapshots are reused for 30 seconds;
  implementation claims always recheck live under the distributed lock.

### Undiscoverable Facts

- Fleet deployment and seven-day pilot results are not observed in this coding
  session. Enable the policy after all hosts have the same revision and settings.
- JSR is unreachable from this environment. Tests used an external temporary
  import map pointing to the available local standard-library checkout; no
  dependency, lockfile or repository import-map changes were made.

## Evidence

The concurrent admission test admits four of eight competing reservations.
Removing the capacity guard makes that test fail; restoring it passes. Tests
also exercise high/low transitions, draft conversion and resumption, bootstrap
claims versus tentative admissions, expired owners, all-author pressure,
milestone streams, one recovery slot, corrupt state recovery, forged comments,
claim cleanup and actual serial/pool repair dispatch.

Read the issue-processing suppression rules and the completion-report section
of the operator manual. Updated `docs/workflows/issue-processing.md`,
`docs/CONFIGURATION.md`, `docs/INTERNALS.md`, `docs/HUMAN-PR-POLICY.md`,
`docs/OVERVIEW.md` and `DESIGN-PRINCIPLES.md`. The issue prompt now directs
resumption from remaining acceptance scope. New modules are registered in
`docs/audits/lib-sweep-coverage/top-up-4942.json`.

Backend scheduling and reporting only; browser evidence does not apply.

## Reproduction

- **symptom** — PR-only admission permits multiple hosts to start before their
  PRs exist, and refusing new issues alone leaves repair capacity unused.
- **status** — verified with deterministic competing-host and dispatcher tests.
- **regression test** — `worker/deno/tests/completion_admission_test.ts`:
  `completion admission: competing Macs share four reservations` fails when
  the capacity guard is removed and passes with it restored.

## Test Plan

- `worker/deno/tests/completion_admission_test.ts` — concurrency, hysteresis,
  conversion, resumption, human/integration pressure, milestone bounds,
  oversized-backlog recovery and policy disagreement.
- `worker/deno/tests/completion_admission_github_test.ts` — independent store
  instances, pagination, bootstrap, expiry, corrupt/forged state, custom branch
  linkage, unreadable snapshots and cleanup of a refused implementation claim.
- `worker/deno/tests/completion_scheduler_test.ts` — repair dispatch, pacing,
  failure recovery and unrelated repository eligibility.
- `worker/deno/tests/run_core_slot_pool_test.ts`,
  `worker/deno/tests/setup_claim_refusal_1193_test.ts`,
  `worker/deno/tests/find_oldest_issue_test.ts` and
  `worker/deno/tests/config_test.ts` — production boundaries and configuration.
- `worker/deno/tests/issue_completion_metrics_test.ts`,
  `worker/deno/tests/pr_completion_report_test.ts` and
  `worker/deno/tests/pr_completion_report_command_test.ts` — unique issue
  accounting, unknown evidence, cancellation ratios and CLI collection.
- Targeted and related regression suites: 597 tests passed using the temporary
  offline standard-library map. Production entry-point type check passed with
  the same map. The completeness family passed after registering the four new
  modules; one pre-existing test is intentionally ignored.
- `./quality.sh < /dev/null` ran in the foreground. Formatting, lint,
  Mermaid and the available structural/security boundary checks passed. Its
  type-check, unit-test and completeness subprocesses could not fetch
  `@std/assert` from JSR. Markdownlint, Semgrep, Checkov and credential-dependent
  checks were unavailable/skipped. This is not a full quality-gate pass.

## Merge verification

Required repository CI and independent code review are pending. No required
check or approval is bypassed. The seven-day pilot is measurement after rollout,
not an additional merge gate.
