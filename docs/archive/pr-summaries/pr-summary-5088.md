# PR Summary — Issue #5088

## Summary

`worker/deno/tests/recovery_authority_4417_test.ts` failed on macOS hosts. Its
`launch(d)` helper injected the runtime probe but not the host platform, so
`detectContainerRuntime` resolved Apple `container` from `Deno.build.os`. That
plan correctly reports `egressEnforced: false`, and the #4417 assertion
`assertEquals(ceiling.egressEnforced, true)` failed. `buildLaunchPlanForCommand`
now takes an optional `platform`, forwarded to `detectContainerRuntime` like
`probe` already is. The test pins Linux (a Docker/Podman plan with egress
enforced) on every host, and a new case asserts the Apple runtime's
`egressEnforced: false` explicitly. Closes #5088.

## Spec

### Intent and Rationale

- The test was checking the host it ran on, not the #4417 invariant. Injecting
  the platform is the smallest seam: the runtime detector already accepts
  `platform`; only the command did not pass it through.

### Essential Design Decisions

- `platform` is optional and omitted by both production callers
  (`commands/container_launch_plan.ts` main, `lib/fleet_babysitter_container.ts`),
  so they still resolve from `Deno.build.os`. Lib behaviour is unchanged.
- `launch(d, platform = "linux")` defaults to Linux so every existing #4417 case
  is unchanged in intent; only the new case passes `"darwin"`.
- No platform-conditional skip.

### Undiscoverable Facts

- `plan.runtime` is the probed path (`descriptor.executable`, set from the
  probe's `path`), so the injected probe makes it `/usr/bin/container` or
  `/usr/bin/docker`.

## Evidence

Backend/test-only change, no UI files.

- `worker/deno/commands/container_launch_plan.ts`: `platform` option forwarded
  to `detectContainerRuntime`.
- `worker/deno/tests/recovery_authority_4417_test.ts`: `launch(d, platform)`
  and the new Apple case.
- Issue numbers this diff cites: #5088 (recovery_authority_4417_test fails on
  macOS hosts: the launch plan reads the host's container runtime instead of an
  injected one).

## Test Plan

- New case in `worker/deno/tests/recovery_authority_4417_test.ts`: "recovery
  authority - the Apple container runtime reports egress as not enforced (Issue
  #5088)". `launch(d, "darwin")` gives runtime `/usr/bin/container` and
  `egressEnforced: false`. The positive control `launch(d)` on the same
  deployment gives `/usr/bin/docker` and `egressEnforced: true`.
- The `"darwin"` case reproduces the plan the macOS host produced, which is
  what failed line 750. This run is on Linux, so the original macOS failure was
  not observed here, and the fixed test was not run on a macOS host.
- No existing assertion was edited or removed.
- `deno task test:unit tests/recovery_authority_4417_test.ts
  tests/container_launch_plan_command_test.ts < /dev/null` (from
  `worker/deno`): 23 passed, 0 failed.
- `./quality.sh < /dev/null` on the head: PASSED. This host skipped config
  integration and checkov.

Not done or not checked: the test was not run on macOS (no macOS host in this
container). No reviewers were dispatched, because the issue's `## Acceptance`
heading is not an acceptance-criteria heading.
