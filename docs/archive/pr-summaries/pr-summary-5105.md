# PR Summary — Issue #5105

## Summary

Agent-owned cargo target directories can now be released after a pass using
`sudo -n -u agent -- rm -rf -- <path>` when the worker's removal is denied. The
fallback is confined to an agent-keyed directory directly under the real
(non-symlink) ephemeral cargo root.

On trim-refused runtimes, work-volume telemetry also reports the ephemeral cargo
root's size and largest targets. The host-disk monitor refreshes this figure in
the background below `ok` on those runtimes only (production wires
`ephemeralCargoRootApplies` to `workVolumeTrimRefusedForLaunch`), without
delaying the floor verdict. Forced checks share one scan and cannot bypass its
refresh interval. Normal build-time file deletion preserves `du`'s size;
unreadable subtrees and other measurement failures remain `unknown`.

Part of #5105. The shared babysitter admission, proxy lifecycle and wait-versus-
kill criteria remain outside this PR, so the issue stays open.

## Spec

### Intent and Rationale

- Release as the account that built the directory, using the existing image sudo
  rule. Group-writable directories would depend on every build's umask.
- The cargo root is outside the work volume. Its size is a separate diagnostic
  figure, not another volume bucket or a subtraction from the host estimate.
- The disk-floor decision takes priority over diagnostic walks. A slow walk must
  not delay a running build's low-disk response or spawn concurrent walks from
  multiple worker lanes.

### Essential Design Decisions

- The monitor permits one background walk, followed by a quiet sample interval
  (60 seconds by default), including after failure. `force` still refreshes the
  host reading but cannot bypass this separate throttle. Pending detail labels
  an earlier figure `last measured`; a later probing check reports the completed
  result or the failure cause.
- Strict `du` runs with `LC_ALL=C`. Exit 1 is tolerated only when every
  diagnostic identifies a vanished path within the measured directory. A printed
  size is still required. If the target itself vanished, `lstat` confirms its
  absence and the listing omits only that target.
- Permission errors, mixed or unrecognised diagnostics, missing output and
  timeouts remain failures. A missing `du` executable cannot masquerade as a
  missing root. The pruning path retains its existing lenient measurement.
- The production remover is built at call time because its import graph is
  cyclic. Removal still falls back only for `PermissionDenied` on an agent-keyed
  directory, and reports both causes when sudo fails.

### Undiscoverable Facts

- The review identified forced production probes as a path around the original
  refresh cadence. The new composition test calls `parkRunningBuild` through the
  probe registered by `createProductionRunCoreDeps`, with a real monitor and a
  deliberately unresolved measurement.
- This repair environment cannot fetch JSR manifests. Runtime regression tests
  used an external import map to an available local Deno standard-library source
  checkout and `--no-check`; repository dependency pins and quality
  configuration were not changed. Standard CI remains authoritative.

## Evidence

- Test-first reproduction on the unfixed PR head, with only dependency seams
  added: 13 tests passed and five new tests failed. Failures showed repeated
  forced scans, a floor verdict blocked by a pending scan, rejection of benign
  ENOENT diagnostics, and loss of the root figure after a target was released.
- After the fix, 178 related tests passed, zero failed, and two real-agent tests
  were ignored because their required account/root capability was absent.
  Coverage includes heavy-build gates, host-disk monitoring, ephemeral caches,
  verifier release, the running-agent floor response and production disk wiring.
- The 55 completeness-check files also passed with the local import map: 866
  tests passed, zero failed, and one host-capability test was ignored.
- The real unreadable-subtree test passed: permission denial still produces
  `unknown`. The real released-target test passed while preserving the size of a
  surviving sibling. The composition test proves that a pending scan neither
  delays the low verdict nor overlaps another scan after the interval elapses.
- `./quality.sh < /dev/null` was attempted. Formatting, lint, Markdown, Mermaid,
  benchmark audit and source/chokepoint checks passed. Completeness, full tests
  and type checking could not load JSR manifests. Config integration, Semgrep,
  Checkov and release-tag ruleset checks were skipped for unavailable local
  configuration, tools or CLI authentication. This is not a full local pass.
- An additional strict type-check attempt with local source dependencies
  reported only two `noImplicitReturns` errors in that external standard-library
  checkout. No repository type errors were reported; CI must verify the pinned
  packages.
- Read and updated `docs/CONTAINER.md`, “Standing totals at cycle start and end
  of run”, and the attached source comments. The original agent-release changes
  also update `docs/CONTAINMENT.md`. No UI is changed.

## Reproduction

- **symptom** — a forced host-disk probe awaited a full cargo-root scan, and
  normal file deletion made the strict telemetry report `unknown`.
- **status** — `verified` — the focused tests failed before the behaviour fix
  and passed afterwards, using controlled promises, clocks and `du` results.
- **regression test** —
  `worker/deno/tests/ephemeral_root_telemetry_5105_test.ts::Issue #5105 - the registered build probe returns low during one slow shared scan`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Release an agent-owned target directory using the same account as
  the build. Existing confined-removal and production-binding tests pass;
  real-account tests remain conditional on host capabilities.
- **met** — Measure and name the ephemeral cargo root in work-volume and
  host-disk telemetry. Forced checks do not block on it, and vanished files no
  longer invalidate a usable size.
- **met** — A pass can release its agent target without an EACCES warning. The
  composition test exercises successful fallback and preserves another
  checkout's target; rejection tests retain both error causes.
- **missing** — Shared host-budget admission for worker and babysitter
  containers/builds; this PR does not change the babysitter launcher.
- **missing** — Reuse one egress proxy per host or the worker's proxy; this PR
  does not change proxy lifecycle.
- **missing** — Treat babysitter-driven floor dips as a wait rather than a kill;
  the existing park/kill policy is unchanged.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English; existing subprocess timeout helper; no new
  dependency or privilege; original removal confinement retained; errors remain
  visible; deterministic regression tests exercise production behaviour.
- **clean** — Updated the existing synchronous-refresh assertion because the
  supported behaviour is now asynchronous. It still asserts the low verdict, the
  refreshed size and failure visibility, alongside new ordering and cadence
  tests. No existing test was removed or newly skipped.

## Test Plan

- `ephemeral_root_telemetry_5105_test.ts`: forced-check throttling, a slow
  shared scan through the registered production probe, asynchronous result/error
  detail, benign GNU/BSD ENOENT output, mixed and external-path failures,
  missing size, timeout, and a target released between listing and real `du`.
- PR #5116 review: the same file gains a monitor test where the root does not
  apply (measure never called, no `ephemeral cargo root` text or log line on
  three checks a sample interval apart, plus a positive control once it applies)
  and a `createProductionRunCoreDeps` test, with no `hostDisk` override and no
  launcher reading, asserting the registered probe's park reason and the
  `Host disk: low` log carry no root text. The latter fails with the wiring
  removed.
- Run the existing `heavy_build_gate*_test.ts`, `host_disk*_test.ts`,
  `ephemeral*_test.ts`, `*4743*_test.ts`, `claude_runner_host_disk_4390_test.ts`
  and `run_core_production_deps_disk_test.ts` regression suites.
- The changed cadence has one implementation in `HostDiskMonitor`; production
  forced probes and ordinary checks share it. Strict and lenient sizing share
  `runDuSk`; only strict sizing classifies the diagnostics. No duplicated rule
  implementation was found.

## Merge verification

CI and a fresh review of the repaired head are pending. The shared babysitter
and proxy criteria above remain explicitly unfinished, independently of CI.
