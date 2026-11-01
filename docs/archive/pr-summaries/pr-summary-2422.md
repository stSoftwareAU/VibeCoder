## Summary

No production change. Closes stSoftwareAU/NEAT-AI-Discovery#2422.

The fast-failure exclusion landed in #4389 (commit `9e4a7d912`); #4540
subsequently added claim-time deferral for cloned cargo repositories.

An earlier iteration of this branch added a `parkInFlightBuild(workspaceDir)`
check at the top of `runOrchestratedIssueRun`. Review showed it changes no
production outcome, so it is removed and the branch carries only this record.

Version bump: none; no production code changes.

## Spec

### Intent and Rationale

- The reported failure
  (`manager call failed after 2 attempt(s): ephemeral cargo root over budget (58.2 GB free, floor 46.0 GB + headroom 25.0 GB)`)
  is the park `runClaudeWithTimeout` already applies to every agent call in a
  checkout: `worker/deno/lib/claude_runner.ts`
  (`if (cwd) { const park = await
  parkInFlightBuild(cwd); ... }`, before
  `selectAgentProvider`). The orchestrator's manager call uses the real
  `runClaudeWithRetry` with `cwd` = `repoDir` = `workspaceDir`, so it is parked
  before any provider is chosen or spawned. A second check in
  `runOrchestratedIssueRun` repeats that park and would end the run with the
  same reason minus the `manager call failed after 2 attempt(s):` prefix.
- The tally issue is a fast-failure back-off. `isFastFailure` in
  `worker/deno/lib/repo_fast_failure_tracker.ts` excludes host-disk text before
  setup-fault and timing checks for `internal_error` and `zero_output`, provided
  the message has no worker-gate marker prefix. `isHostDiskFaultText` recognises
  the cargo-budget park even with the execution and manager-call wrappers.
  #4389 landed that exclusion; #4540 also defers claims on a cloned cargo
  repository short of the headroom.
- The earlier iteration's claims that a paid manager plan call was saved were
  against its own abandoned manager-only exemption, not against `main`; on
  `main` no plan call is paid at these readings.

### Essential Design Decisions

- No production change is needed for #2422: no failing path was found on `main` that
  a change in `runOrchestratedIssueRun` would alter. A check that only trims the
  error prefix, the `--version` preflight probes, the checkpoint write and one
  orchestrator retry is not a fix for the reported symptom (a run fails at that
  reading and is claimed again), and its fake-runner test would guard no
  externally meaningful regression.

### Undiscoverable Facts

- Not verified: a live fleet run at the reported readings. The conclusion rests
  on reading the code and testing the classifier, not on replaying a fleet run.

## Reproduction

- **symptom** — the fleet tallied a host-disk park and backed off the repository.
  The logged line began: `execute after 79s: Claude execution failed: manager
  call failed after 2 attempt(s): ephemeral cargo root over budget (58.2 GB
  free, floor 46.0 GB + headroom 25.0 GB) — pruned 0.0 GB of idle target dirs
  and 12.9 GB is still short, so cargo builds wait for CI (Issue #3178 budget;
  Issue #4326 skip); ca` (the recorded comment truncates there).
- **status** — `partial` — reason: the classifier is exercised with the logged
  cargo-budget text and park note, but the original fleet run was not replayed
  and the test was not run against the code before #4389.
- **regression test** — `worker/deno/tests/repo_fast_failure_tracker_test.ts::isFastFailure - the cargo-budget parks in Discovery #2422 do not back off the repository`.

## Evidence

The classifier test covers both reported timings and budget readings with the
execution and manager wrappers and a setup-fault flag. The redundant
orchestration check and its test are back to `main`.

## Test Plan

- `deno test --allow-all tests/repo_fast_failure_tracker_test.ts` from
  `worker/deno`.
- Branch outcomes: the existing host-disk exclusion returns false for both
  cargo-budget parks, even with `setupFault: true`.
