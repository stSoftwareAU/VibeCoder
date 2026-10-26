## Summary

Closes #4048

Every container start now proves the egress policy before the first claim.
When the launch plan says egress is enforced, any verdict other than
`enforced` exits 90 and writes `[EGRESS-SELFCHECK-FAILED]`. Apple container,
where the plan does not enforce egress, logs one `[EGRESS-NOT-ENFORCED]`
warning naming the dialect and continues. Each start appends one
`egress policy:` line to `run_core.log`.

No version file is changed.

## Spec

### Intent and Rationale

- A launch that claims to be contained must show the containment before it
  claims work. The check runs in `runWorker`, after the toolchain self-check
  and before GitHub user resolution and the claim loop.
- `not_checked` and `proxy_unavailable` are not passes. Only `enforced` is.
- A runtime that does not enforce egress must not be reported as passed, and
  must not be blocked by a check its network cannot satisfy.

### Essential Design Decisions

- Exit status 90 (`EGRESS_SELFCHECK_EXIT_STATUS`). 74, 75, 76, 87, 88 and 89
  were already taken. `container_restart_backoff.ts` classifies 90 beside the
  toolchain and host-egress statuses, and a 90 does not remove the image.
- The four probes are injectable. Direct TCP to `1.1.1.1:443` and to
  `api.github.com:443` must fail. CONNECT to `example.com:443` must be
  `403` with `[EGRESS_DENIED]`. CONNECT to `api.github.com:443` must succeed.
- When `VIBE_EGRESS_ENFORCED` is `false` or absent, no probe runs. `false`
  warns and records `not_enforced`. Absent records `not_enforced` and does
  not warn, so a native test run is not treated as an Apple launch.
- The record is `egress policy: <verdict> runtime=<kind> version=<version>
  date=<YYYY-MM-DD>`, written with the run-mode line.

### Undiscoverable Facts

- The issue points at `worker/deno/mod.ts`. The claim loop is
  `runWorker` in `worker/deno/lib/run_worker.ts`. The check is called there.
- `commands.length` in `worker/deno/tests/mod_test.ts` was 158. Registering
  `egress-selfcheck` makes it 159. `mod.ts` registers that command and lists
  it with the other config-optional commands.
- The flag reaches the worker as `VIBE_EGRESS_ENFORCED`, with
  `VIBE_RUNTIME_KIND` and `VIBE_RUNTIME_VERSION`, set by the launch plan.
- Unit tests never open a socket. `checkEgressPolicy` probes only when the
  flag is `true` and neither a probe set nor a probe function was injected.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

The durable record is the `egress policy:` line in `run_core.log`, the same
file as the run-mode record (`docs/CONTAINMENT.md`, green-gate section). No
UI change, so there is no screenshot.

`./quality.sh` was not run. The focused Deno tests, `deno fmt` and `deno
lint` were.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — injected probe results classify each verdict; `not_checked` and
  `proxy_unavailable` are never enforced; an enforcing dialect exits 90 with
  the marker on every other verdict; a non-enforcing dialect warns and
  continues — evidence: `worker/deno/tests/egress_selfcheck_test.ts` (10
  passed) — reviewer: met
- **met** — `container_restart_backoff.ts` classifies 90, and both launchers
  restate the status and the marker — evidence:
  `worker/deno/tests/container_restart_backoff_test.ts` and
  `worker/deno/tests/launcher_egress_selfcheck_test.ts` (passed in the
  focused batch) — reviewer: met
- **met** — every verdict writes a record carrying runtime kind, runtime
  version and date — evidence:
  `worker/deno/tests/egress_selfcheck_test.ts::formatEgressPolicyRecord - refuses a field that is not one token`
  and the verdict cases in the same file — reviewer: met
- **met** — the self-check runs before the first claim — evidence:
  `worker/deno/tests/run_worker_test.ts::runWorker - an unproved egress policy exits before any claim (Issue #4048)`
  and `runWorker - a non-enforcing dialect warns and still claims (Issue #4048)`
  (both in the 107-test pass of that file with `container_launch_test.ts`) —
  reviewer: met
- **met** — focused tests, `deno fmt` and `deno lint` — evidence: Test Plan.
  `./quality.sh` was not run — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — the new exit status is a named constant, the failure marker is
  written by the worker, and both launchers are kept in step by a test
- **clean** — probes are bounded (`EGRESS_PROBE_TIMEOUT_MS` is 2000) and the
  unit tests do not open the network; no host-pattern list was added, so
  `parallel_unsafe_test_manifest.ts` is unchanged

## Merge verification

- Required CI and the routine code review are pending until observed.

## Test Plan

- `worker/deno/tests/egress_selfcheck_test.ts`: 10 passed.
- `worker/deno/tests/run_worker_test.ts` with
  `worker/deno/tests/container_launch_test.ts`: 107 passed.
- `worker/deno/tests/container_restart_backoff_test.ts`,
  `worker/deno/tests/launcher_failure_evidence_test.ts`,
  `worker/deno/tests/launcher_egress_selfcheck_test.ts` and
  `worker/deno/tests/mod_test.ts` passed in the 144-test focused batch.
- Not run: `./quality.sh`.
