## Summary

Added versioned retry state, bounded backoff and legacy migration to the PR
babysitter. Substantive attempts are tallied through fleet-authored PR markers,
read-token sessions stop before expiry, and pushed PRs remain tracked until a
merge is observed. The end-to-end recovery and escalation requirements remain
incomplete. Part of #4656.

Version bump: none in this change; no release version was changed.

## Spec

### Intent and Rationale

- Temporary provider, capability and lock failures should retry without manual
  deletion of an attempt file.
- Keep recovery in the existing babysitter scan and branch-lock flow.

### Essential Design Decisions

- Host-local JSON stores cooldown and reconciliation state; configured fleet
  authors' existing PR attempt markers share the substantive retry tally.
- The agent receives a repository-scoped read token and the runner restarts its
  session before token expiry. Runner write authority stays outside that
  session.
- State is cleared only after GitHub reports the PR merged.

### Undiscoverable Facts

- The task's listed related issues were checked with `gh issue view`; their
  separate outcomes were not duplicated here.
- `gh api repos/stSoftwareAU/VibeCoder/issues/4656/comments --paginate --slurp`
  returned an array of page arrays with `id`, `user.login`, `created_at` and
  `body`, which the shared-marker reader validates.

### Deno regression avoided

- Used Deno tasks and Deno checks; no Node tooling or lockfile dependency was
  added.

## Evidence

Backend/CLI change. The retry record is atomically written and validates its
version and fields. An old attempt marker creates a five-minute cooldown. The
shared attempt tally accepts markers only from configured fleet authors.

The related deliverables are kept separate: the babysitter continues to use
the existing branch updater and branch lock, and does not run a merge itself.

## Acceptance Criteria

- **missing** — Tests drive transient failure -> unchanged-head cooldown ->
  retry -> checked repair -> CI -> independent review -> merge observed. —
  reason: Unit tests cover retry state, credential expiry and the repair
  marker, but no production-orchestration test drives the complete sequence.
- **missing** — Include process restart and migration of an old attempt file,
  two hosts contending, head movement, missing tools/disk recovery, credential
  expiry and repeated no-progress. — reason: Legacy migration, state reload,
  retry classification and token expiry have targeted tests; contention,
  head movement, tool/disk recovery and repeated no-progress are not verified
  through the production orchestration.
- **missing** — Show that waits hold no repair lock, one incident produces one
  deduplicated escalation and real human gates remain paused. — reason: The
  existing lock is released in the repair `finally` path and shared attempt
  markers deduplicate the substantive tally, but no escalation path or
  end-to-end owner-hold test was added.
- **missing** — On repeated substantive no-progress, persist the evidence and
  use the existing automated escalation/repair mechanism from #569/#4158. —
  reason: Attempt counts and the last outcome persist and the prompt asks for a
  changed diagnosis at the configured limit; diagnostic evidence and the
  escalation/repair handoff are not implemented.

## Test Plan

- `worker/deno/tests/babysitter_retry_state_test.ts` — passed with the targeted
  Deno unit run. It covers migration, reload, bounded retry classification,
  merge-state clearing and the fleet-author attempt tally.
- `worker/deno/tests/fleet_pr_babysitter_test.ts` — passed: 59 tests. Removing
  `queued.delete(version)` made the unchanged-version retry test fail; the line
  was restored.
- `worker/deno/tests/fleet_babysitter_app_test.ts` — passed in the targeted
  run. Removing the two-minute token safety margin made the expiry-bound test
  fail; the margin was restored. Disabling shared-marker publication made the
  production repair fixture fail because no attempt marker was recorded.
- Changing the legacy cooldown to zero made the migration test fail; the
  five-minute cooldown was restored.
- `deno task check:manifests` — passed: 847 passed, 0 failed, 1 ignored.
- Targeted `deno fmt --check`, `deno lint` and `deno check` — passed.
- `./quality.sh < /dev/null` — failed twice on the full Deno suite. The latest
  run reported 31,979 passed, 7 failed and 5 ignored. The failures were in
  unchanged tests: `merge_fallback_issue_test.ts`,
  `milestone_resolution_gate_test.ts` and `pr_maintenance_command_test.ts`.
  The merge-fallback test also failed when run alone; the PR-maintenance file
  passed when run alone. These failures were not reproduced against the base
  branch. Config integration and Checkov were skipped by the gate.
- `deno.lock` was unchanged.
- The test, manifest and full-quality commands were run with stdin redirected
  from `/dev/null`.
