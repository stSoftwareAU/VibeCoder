## Summary

The 46 GB host-disk floor stopped new claims and left a build that was already
running free to fill the disk. On GRQ-23 (2026-10-25) a security-fix
discrimination `cargo` took the host from about 60 GB free to 0 in forty
minutes. The worker then adopted a reading that was already minutes old, the
guest went read-only, and the fallout — a security-fix gate block, a failed
callback, a label-cache miss — was charged to the issue.

In-flight builds now use the same floor and the same ephemeral headroom as the
maintenance gate:

- Before an agent invocation in a checkout, a quality-gate run, a mutation
  check or a discrimination `cargo`/`deno`, the worker force-reads the
  launcher's `host-disk.json` and parks the step when the host is below the
  floor, or short of the floor plus 25 GB where the trim is refused. The park
  is infrastructure (`Parked as infrastructure (Issue #4360)`). It is not a
  security-fix or mutation gate verdict and it does not earn `failed-once`.
- While that `cargo` or `deno` (and the agent) is still running, the same
  check repeats and the child is stopped.
- `Read-only file system` / `os error 30` / `ENOSPC` classify as `disk-full`.
  A marked security-fix gate that merely quotes those words stays an issue
  failure. The existing run-failure filer dedupes `disk-full` onto one open
  issue, which is the one host-fault alert.
- Where the volume trim was refused and the host is below the floor, the
  launch ends with status 74. Deleting files in that volume does not return
  host blocks. Leaving the container discards the ephemeral layer, and the
  next launch recreates the volume if the host is still short. Mutation and
  discrimination `cargo`/`deno` write to that layer when the trim is refused,
  the same placement the agent and the quality gate already use.

Closes #4360.

## Spec

### Intent and Rationale

- The claim gate and the in-flight gate read one `HostDiskMonitor`. The build
  probe calls `check({ force: true })`, so it does not sit on the worker's
  60-second cache. The launcher file can still be as old as
  `HOST_DISK_REFRESH_SECONDS` (default five minutes). That interval is not a
  new scheduler.
- A park is `internal_error` with no worker-gate marker. `detectHostFault`
  ignores any other declared category, and a gate marker is excluded before
  the disk pattern, so quoting `os error 30` inside a real security-fix
  refusal must not become a host fault (Issue #3454).
- Ending the launch reuses status 74, the status the supervisor already
  relaunches promptly. The log is `[HOST_DISK_LOW]` and names the floor and
  the trim refusal. It does not claim the root is `emergency_ro`.

### Essential Design Decisions

- The in-flight gate is armed from the `run-core` command, not from
  `createProductionRunCoreDeps`. Unit tests build those deps in the same
  process as every other test, and a process-global probe must not park them.
- An `unknown` reading never parks, the same rule as the claim gate.
- Above the floor, or where the trim is honoured, the build is parked and the
  launch continues. A recreate would not run, and `fstrim` can return the
  blocks when the runtime allows it.
- A security-fix verdict that cannot be persisted because the filesystem is
  read-only or full is not replaced with an in-memory block. That fallback
  was what charged the issue a blocked run.

### Undiscoverable Facts

- Pruning ephemeral target directories does not return host blocks when the
  trim is refused. The guest reuses them; the host gets them back when the
  container exits.
- Rust's `os error 30` is `EROFS`, not `ENOSPC` (`os error 28`). After the
  guest remounted read-only, the later failures quoted the read-only error.

## Evidence

Backend-only change; no UI files touched.

**Docs sweep** — grep: `HOST_DISK_LOW defers maintenance builds`, `plus 25 GB`,
`maintenance continues`, `workVolumeTrimRefused`; section:
`docs/CONTAINER.md` (maintenance-build section and the ephemeral-budget
bullet), `docs/INTERNALS.md` (shared-clone ref sweep); updated:
`docs/CONTAINER.md` (new "In-flight builds stop at the same floor"),
`docs/INTERNALS.md` (one sentence on the launch ending when the trim is
refused and the host is below the floor).

## Test Plan

- [x] `worker/deno/tests/host_disk_inflight_4360_test.ts` — injected readings,
  no live disk fill.
- [x] `os error 30` / `Read-only file system` classify as `disk-full`, the
  ladder does not apply, and a marked security-fix gate quoting the same text
  stays `agent-outcome` / `ladder`.
- [x] Trim refused and below the floor ends the launch and the log line is
  `[HOST_DISK_LOW]`, not a root-filesystem fault. Above the floor, trim
  honoured, and an unknown reading do not end the launch.
- [x] Discrimination and the mutation check do not start cargo when the park
  reason is injected. The reason is `internal_error` / `disk-full` and
  `applyLadder` is false.
- [x] `cargo` and `deno` receive `CARGO_TARGET_DIR` under the ephemeral root
  when the trim is refused. `git` does not. A trimming runtime does not.
- [x] A `sleep` child is stopped when an injected park fires during the wait,
  and the error is `disk-full`.
- [x] `deno test` on the new file plus `heavy_build_gate_3178_test.ts`,
  `host_fault_test.ts`, `root_filesystem_fault_test.ts`,
  `mutation_runner_test.ts`, `security_fix_discrimination_test.ts`,
  `security_fix_gate_retry_test.ts`: 196 passed, 0 failed.
- [x] `run_outcome_classifier_test.ts`, `coding_failure_ladder_test.ts`,
  `pre_push_gate_failure_category_test.ts`: 84 passed, 0 failed.
- [x] `deno fmt`, `deno lint` and `deno check` on the touched files: clean.
- [ ] `./quality.sh` was not run. The live 60 GB fill was not reproduced.

## Reproduction

The classification decision was shown red before the fix. With the patterns
still matching only `ENOSPC` and "No space left on device":

```text
[FAIL] Issue #4360 - os error 30 is a disk-full host fault, not an issue failure
error: AssertionError: Values are not equal.
[Diff] Actual / Expected
-   null
+   "disk-full"
FAILED | 1 passed | 2 failed
```

`detectHostFault` of `discrimination runner failed: Read-only file system
(os error 30): tmpdir` returned null, so the issue would have been charged.
The same test passes after the fix.

The live fill (about 60 GB to 0 in forty minutes) was not reproduced. The
park, the headroom refusal and the launch-stop were tested with an injected
disk reading. Those helpers did not exist on `origin/main`, so they were not
shown red against the old module.
