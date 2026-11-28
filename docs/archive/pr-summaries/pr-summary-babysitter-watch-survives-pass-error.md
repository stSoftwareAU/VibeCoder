# Babysitter: a pass that throws no longer ends the watch loop

## Summary

The GRQ-health board has shown `Fleet PR Babysitter:GRQ-23` as failed since
23 November 2026 at 20:24 UTC. On that host the babysitter ran by hand as
`./fleet-pr-babysitter/run.sh --watch`, with no launch agent. The host disk
fell to 0.2 GB free that evening, the worker image was missing, and each pass
failed its Chromium check. The process was gone by the next five-minute pass,
and its last log is that 20:24 failure. The host was not rebooted (up since 14
November), so the watch process ended by itself and nothing restarted it.

In the supervisor's `--watch` loop, only some of `pass()` was guarded.
Creating the pass log (`Deno.open` with `createNew`) sits outside every
`try`, and the `catch` around the child process writes to that log again. On a
full disk either one throws ENOSPC out of `pass()`, and the loop exits.

The loop now lives in an exported `runPasses`. A pass that throws is logged as
`Babysitter pass error; the next pass retries: ...`, counts as a failed pass
(exit code 1), and the watch loop sleeps and runs the next pass. A single pass
without `--watch` still exits 1 instead of crashing.

## Spec

### Intent and Rationale

- A wedge that only clears after a human restarts a process is itself a defect.
  A watch loop must keep running when one pass fails, so it recovers by itself
  once the disk has room again.

### Essential Design Decisions

- The health hook is not called for a pass that threw: the hook needs the disk
  and network that probably caused the throw. The next pass that completes
  reports health as usual.
- No launch agent is installed by this change. Setup still asks before
  installing one.

### Undiscoverable Facts

- `~/.vibe-coder/fleet-pr-babysitter/logs` on GRQ-23 holds 30 archives, all
  from pid 73980. The last is 2026-11-23T20:24:02Z, with 0.2 GB free and
  `the worker image is not built`.

## Evidence

- Read and updated `docs/workflows/fleet-pr-babysitter.md` (the launch-agent
  paragraph).
- Both new tests failed before the change (`runPasses` did not exist) and pass
  after it. All 5 tests in `fleet_pr_babysitter_supervisor_test.ts` pass.

## Test Plan

- `worker/deno/tests/fleet_pr_babysitter_supervisor_test.ts`:
  - `watch mode keeps running after a pass throws`
  - `a single pass that throws exits non-zero instead of crashing`
