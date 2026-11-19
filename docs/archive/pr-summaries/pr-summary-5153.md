# PR Summary — Issue #5153

## Summary

The test "Issue #5105 - the registered build probe returns low during one slow
shared scan" in `worker/deno/tests/ephemeral_root_telemetry_5105_test.ts` no
longer races `parkRunningBuild()` against a timer. It awaits `first` directly
while the scan stays unresolved, then asserts that the verdict names the host
disk floor. The test's ordering no longer depends on the wall clock, so a loaded
parallel pass can't flip it. Closes #5153.

## Spec

### Intent and Rationale

- The issue reported a `setTimeout(…, 0)` race. The base branch had already
  widened it to a 10-second guard, but that is still a timer race. The issue
  asks for "no timer race", so the guard is removed and nothing replaces it.
- The issue's first suggested fix was used: "await `first` while the scan stays
  unresolved and assert that it settles". The test already asserts
  `calls === 1` through the injected monitor, so no extra call-counting was
  needed.

### Essential Design Decisions

- The scan's promise is only resolved later in the test. If the probe blocked on
  it, `first` could never settle, and Deno fails a test whose event loop drains
  with a promise still pending. That is the failure signal now, not a timeout.
  It relies on the fixture leaving no live timers or ops, which is true today
  (observed below).
- Production code is unchanged. The fault was in the test's ordering, not in
  `HostDiskMonitor` or `parkRunningBuild`.

### Undiscoverable Facts

- On the base branch the race had already been widened from zero delay to a
  10-second `setTimeout` guard by the Issue #5161 PR (commit `c99365855`). The
  comment it carried cited that PR's pre-push gate.

## Evidence

Backend test-only change; no UI files touched.

- Red-capability check (run in this branch's earlier attempt, then reverted).
  The `cls.level !== "ok"` branch in `worker/deno/lib/host_disk.ts` `check()`
  was temporarily changed to also `await this.ephemeralCargoRootRefresh`, so the
  probe blocks on the scan. Then:
  `timeout 120 deno test -A tests/ephemeral_root_telemetry_5105_test.ts --filter "slow shared scan" < /dev/null`
  gave `FAILED (23ms)` with
  `error: Promise resolution is still pending but the event loop has already resolved.`
  It failed straight away with no hang. `lib/host_disk.ts` was then restored
  with `git checkout`.
- On the head:
  `deno task test:unit tests/ephemeral_root_telemetry_5105_test.ts < /dev/null`
  gave `ok | 20 passed | 0 failed`, and its parallel pass PASSED.
- Issue numbers in the diff: #5153 (ephemeral_root_telemetry_5105 'slow shared
  scan' test races a setTimeout(0) and fails under parallel load). The diff
  drops the comment that cited #5161.

## Reproduction

- **symptom** — `AssertionError: Expected actual: "blocked on scan" to contain: "host disk below its floor".` at `ephemeral_root_telemetry_5105_test.ts:407`, seen once under the `./quality.sh` parallel pass on a loaded host
- **status** — `partial` — reason: the loaded-host timer race could not be recreated on demand. What was observed: the new timer-free test fails at once (the event loop drained with `first` still pending) when the probe is made to block on the scan, and passes on the head.
- **regression test** — `worker/deno/tests/ephemeral_root_telemetry_5105_test.ts::Issue #5105 - the registered build probe returns low during one slow shared scan`

## Test Plan

- Modified `worker/deno/tests/ephemeral_root_telemetry_5105_test.ts::Issue #5105 - the registered build probe returns low during one slow shared scan`:
  - The `Promise.race` against the `setTimeout` guard is now `await first`.
  - Every assertion is kept: the first verdict contains "host disk below its
    floor", a second park after `now = 120_000` still returns low, `calls === 1`,
    and after the scan resolves the verdict contains "ephemeral cargo root
    38.5 GB".
  - No assertion was removed. The deleted lines were only the timer guard and
    its `clearTimeout`.
- `deno fmt --check` and `deno lint` on the file: passed.
- `deno task test:unit tests/ephemeral_root_telemetry_5105_test.ts`: 20 passed, 0 failed.
- `./quality.sh < /dev/null` on the head: lint, type check, fmt and every other
  stage passed. `deno tests` FAILED, 35242 passed and 1 failed. The one failure
  is `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`
  ("PR summary CI task runs git with restricted environment permissions"). It
  failed with
  `error: Failed caching npm package 'commonmark@0.31.2'` … `dns error: failed to lookup address information: Temporary failure in name resolution`.
  This container cannot resolve `registry.npmjs.org`, and the test does not
  touch the file this PR changes. `ephemeral_root_telemetry_5105_test.ts`
  passed in that run.
