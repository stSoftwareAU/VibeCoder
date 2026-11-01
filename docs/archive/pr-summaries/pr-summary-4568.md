# Issue #4568: control-plane probe lifetime

## Summary

Part of #4568. Stop a probe when its supervisor dies or changes parent, or
when its watched worker container disappears. Reap registered orphaned probes
at the next supervisor start. Orphans from versions before registration was
introduced still require a manual kill.

## Spec

### Intent and Rationale

- Prevent an orphaned probe from continuing to watch and recover later workers.
- A failed container listing is not evidence that the watched worker is gone.

### Essential Design Decisions

- Record the supervisor's parent and check it on each probe tick. Watch the
  first worker container, excluding the egress and init side containers.
- Only reap a registered PID when the checkout, parent and command match.
  An unregistered orphan cannot be distinguished safely from a legitimate
  `loop.sh` launched under PID 1 using those process properties alone.

### Undiscoverable Facts

- `loop.ps1` has no matching Apple container control-plane probe. Its absence
  is an intended asymmetry in `worker/deno/lib/loop_contract.ts`.

## Evidence

The process and container behaviours are exercised by
`worker/deno/tests/loop_supervisor_test.ts`. The added
`pid_guard_identity_501_test.ts` case carries over the prior coverage notice:
when a descendant cannot be fingerprinted it is skipped while other
identifiable descendants are signalled. Read the “Wedged container watchdog”
section of `docs/workflows/resilience-and-concurrency.md` and updated it with
the registration and legacy-orphan limitation. No visual evidence is relevant.

## Test Plan

- `loop.sh #4568 - SIGKILL to the supervisor alone takes its control-plane probe down too`.
- `loop.sh #4568 - the probe stops once the container it watched is gone, and loop.sh keeps supervising`.
- `loop.sh #4568 - the probe keeps waiting while no container has been seen yet`.
- `loop.sh #4568 - a fresh supervisor reaps a probe orphaned from its checkout`.
- `loop.sh #4568 - the reaper leaves a probe registered to another checkout alone`.
- `loop.sh #4568 - the reaper leaves a probe that is not an orphan alone`.
- `loop.sh #4568 - a failed listing and side containers do not end the worker watch`.
- `loop.sh #4568 - a registered orphan with a different command survives`.
- `loop.sh #4568 - the probe stops when its living supervisor changes parent`.
- `pid_guard - terminateDescendants skips a descendant that cannot be fingerprinted and signals the rest (PR #4609 review)`.

The focused listing and side-container test and the fingerprint carry-over
test passed locally. The other process-based tests could not be validated in
this sandbox: spawning `ps` was denied. The full quality gate was not run.

## Merge verification

CI and review of the updated changes are pending. Legacy unregistered orphans
remain an open limitation of the issue.
