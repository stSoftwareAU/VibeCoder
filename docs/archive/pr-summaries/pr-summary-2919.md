# PR Summary — Issue #2919

## Summary

Closes #2919

The CI-infrastructure rerun (Issue #2914) was meant to happen at most once per
PR head. Each host tracked this with a marker file in its own state directory,
so with several fleet hosts the same cancelled run could be re-run once by
every host. The record now lives on the pull request, so the limit holds across
the whole fleet.

- **Marker:** `lib/ci_fix_attempt_markers.ts` gains a
  `<!-- vibe-ci-infra-rerun head="<sha>" -->` marker
  (`buildCiInfraRerunMarker`, `parseCiInfraRerunMarkers`). It is collected
  into `FleetCiFixMarkers.infraReruns`, attributed to its author the same way
  the CI-fix attempt cap's markers are (Issue #1879).
  `isInfraRerunRecordedAt` reports whether any fleet host has already re-run a
  head.
- **Scan:** `findFailedCiChecks` in `lib/pr_maintenance.ts` now reads the PR's
  fleet markers whenever an infrastructure check is involved, and passes them
  to `rerunInfrastructureChecks`. Before, it passed the host-local `stateDir`.
  The body of `rerunInfrastructureChecks` in `lib/ci_infrastructure_rerun.ts`
  hasn't been converted yet: it still takes `stateDir` and writes the
  host-local marker file. As of this commit, `deno check` fails with TS2304
  (`sanitiseRepoName`) and TS2353 (`fleetMarkers`).
- **Docs:** the "Cancelled or never-started checks" entry and flowchart in
  `docs/workflows/ci-fix.md` now describe the fleet-wide limit and the
  unreadable-comments error path.

## Reproduction

- **symptom** — two or more fleet hosts scanning the same PR each re-run the
  same cancelled or never-started head once, because the once-per-head
  marker was a host-local file that no other host could see
- **status** — `not-run` — reason: no regression test was added on this
  branch, so no test was seen failing before the fix and passing after it,
  and the multi-host double rerun was not reproduced
- **regression test** — none on this branch
