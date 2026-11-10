## Summary

`normaliseGateOutputLines` in `worker/deno/lib/baseline_gate.ts` now masks clock-format elapsed times, so a pre-existing red pytest or Maven check that runs over a minute is still recognised as pre-existing. Closes #4918.

## Spec

### Intent and Rationale

- pytest prints `in 75.12s (0:01:15)` and Maven prints `Total time:  01:15 min`; the clock part changed between baseline and post-change runs, so `decidePreExistingGateFailure` returned `new_output`.
- Two small linear patterns run inside the existing `normaliseGateOutputLines` path rather than a second parser, as the issue's scope note asks.

### Essential Design Decisions

- `CLOCK_UNIT_RE` (`01:15 min`, `02:03 h`) uses a `(?<![\w.:])` lookbehind so `file.ts:12:05 min` source locations are not masked; it also stops a match inside a long digit run. Maven's hour form (`02:03 h`) is included as the same format, which the issue did not list.
- `TRAILING_CLOCK_RE` only masks a parenthesised clock directly after an already-masked `<duration>`, so ordinary timestamps (`at 12:30:45`) stay part of the comparison.
- `normaliseLogExcerpt` (auto-fix tracker) is not changed: it already masks `H:MM:SS` as `<time>` and the issue concerns the baseline gate only.

### Undiscoverable Facts

- #4908 (compact `2m14s` durations) is closed and its `DURATION_RE` is already on the base branch; this change builds on it.

## Evidence

Backend-only change; no UI files touched. Tests in `worker/deno/tests/pre_existing_gate_failure_test.ts`, run with `deno task test:unit tests/pre_existing_gate_failure_test.ts` from `worker/deno`: 22 passed, 0 failed.

## Test Plan

- Added `pytest clock suffix after a duration compares as pre-existing`, `Maven clock elapsed times compare as pre-existing`, `source locations, timestamps and counts stay in the comparison` and `clock-format matching handles hostile digits and whitespace` (one hostile case per new pattern, asserting output).
- Red checks: removing the `CLOCK_UNIT_RE` replace turned the Maven test red; removing the `TRAILING_CLOCK_RE` replace turned the pytest test red; removing the lookbehind turned the source-location test and the hostile-digit test red.
- Callers of `normaliseGateOutputLines` checked: `decidePreExistingGateFailure` (covered by the pytest and `new_output` tests). The existing `normaliseGateOutputLines` tests still pass.
- Docs: `docs/INTERNALS.md` (pre-existing gate failure section) now names the clock formats.

Not checked: the Maven `h` form and `H:MM:SS` hour clocks beyond the pairs in the tests; real pytest/Maven output was not run (formats taken from the issue).
