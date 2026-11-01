## Summary

No production change. Part of stSoftwareAU/NEAT-AI-Discovery#2422.

An earlier iteration of this branch added a `parkInFlightBuild(workspaceDir)`
check at the top of `runOrchestratedIssueRun`. Review showed it changes no
production outcome, so it is removed and the branch carries only this record.

Version bump: none; no code changes.

## Spec

### Intent and Rationale

- The reported failure
  (`manager call failed after 2 attempt(s): ephemeral cargo root over budget (58.2 GB free, floor 46.0 GB + headroom 25.0 GB)`)
  is the park `runClaudeWithTimeout` already applies to every agent call in a
  checkout: `worker/deno/lib/claude_runner.ts` (`if (cwd) { const park = await
  parkInFlightBuild(cwd); ... }`, before `selectAgentProvider`). The
  orchestrator's manager call uses the real `runClaudeWithRetry` with
  `cwd` = `repoDir` = `workspaceDir`, so it is parked before any provider is
  chosen or spawned. A second check in `runOrchestratedIssueRun` repeats that
  park and would end the run with the same reason minus the
  `manager call failed after 2 attempt(s):` prefix.
- The tally issue is a fast-failure back-off, not a disk-budget defect. Its
  failures (02:36 and 02:51 UTC, 26 Oct) came minutes after the change that
  stops a host-disk park counting as a repository fast failure merged. Every
  matcher that decides that reads the park wording as a substring, so the
  orchestrator's `manager call failed ...` prefix does not hide it:
  `worker/deno/lib/host_disk_protective_stop.ts`
  (`isHostDiskProtectiveStopText`), used by `host_fault.ts` and
  `run_outcome_classifier.ts` (`DISK_FULL_PHRASE_RE`). Claims on a cloned
  cargo repository short of the headroom are also deferred at claim time.
- The earlier iteration's claims that a paid manager plan call was saved were
  against its own abandoned manager-only exemption, not against `main`; on
  `main` no plan call is paid at these readings.

### Essential Design Decisions

- Nothing is landed as a fix for #2422: no failing path was found on `main`
  that a change in `runOrchestratedIssueRun` would alter. A check that only
  trims the error prefix, the `--version` preflight probes, the checkpoint
  write and one orchestrator retry is not a fix for the reported symptom (a run
  fails at that reading and is claimed again), and its fake-runner test would
  guard no externally meaningful regression.

### Undiscoverable Facts

- Not verified: a live fleet run at the reported readings. The conclusion rests
  on reading the code above, not on replaying a run.

## Evidence

Docs-only branch: `git diff origin/main...HEAD` contains this file only.
`docs/CONTAINER.md`, `worker/deno/lib/orchestration/issue_run_gate.ts` and the
earlier `orchestration_gate_host_disk_2422_test.ts` are back to `main`.

## Test Plan

- No code or test changes; nothing to run. `./quality.sh` — not run (no code
  changed); CI runs the same checks.
- Branch outcomes: none; the branch adds no branch.
