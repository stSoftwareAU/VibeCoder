# Pin the #2598 fast-failure path with the worker's real message format

## Summary

Closes #2598.

#2598 was filed at 23:23 UTC on 2026-09-24 by host `vibe-coder-51449`. It
reported the same symptom as #2590, this time on stSoftwareAU/GRQ: runs
died in `handle_no_changes` after 14 s, three of them backed the repository
off as "fast failures", and the issue's **Last error** read `‹/details›`.
The underlying cause is `API Error: 402`: the host's Anthropic API credit
ran out. That is an account condition, not something wrong with GRQ.

PR #2597 (#2590) fixed both halves at 23:37 UTC, 14 minutes later:

- a 402 is recognised as out-of-credit and categorised `rate_limit`, which
  the fast-failure tracker never counts against a repository;
- the `<details>` / `<summary>` / fence scaffolding lines are skipped when
  picking the last error.

The host that filed #2598 was still running pre-#2597 code. This PR adds
the missing guard: #2597's tests use a hand-written copy of the failure
message, so a change to the real formatter could silently undo the fix.

## Changes

- `worker/deno/tests/repo_fast_failure_tracker_test.ts`: two composition
  tests. Each builds the message with the worker's own
  `formatDetailedFailureMessage` and `redactedTail(…, 500)`, as
  `handle_no_changes_phase.ts` does, then runs it through
  `detectFailureCategory`, `isFastFailure` and `diagnosticErrorLine`.

## Reproduction

- **Symptom:** a 402 out-of-credit run backs a healthy repository off as a fast failure, and the filed issue's last error reads `‹/details›`.
- **Status:** verified
- **Regression test:** `composition - a 402 in handle_no_changes' real message is not the repository's fast failure (Issue #2598)`, which failed against the code before #2597 (`885d7ac3^`) and passes on `main`. Its partner, `composition - a genuine setup fault in the same message shape still counts (Issue #2598)`, also failed before #2597 because the last error was scaffolding, and passes now.

## Test Plan

- `repo_fast_failure_tracker_test.ts`: 33 passed.
- The same two tests against `worker/deno/lib` at `885d7ac3^`: 2 failed, as expected.
- `deno fmt`, `deno lint` and `deno check` are clean.
