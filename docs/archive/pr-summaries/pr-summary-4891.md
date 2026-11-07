## Summary

Classify Deno test failures that quote Docker errors as fixable rather than
Docker infrastructure failures. Closes #4891.

## Spec

### Intent and Rationale

The previous unanchored Docker matcher treated a test name or captured log
containing `docker:` and `not found` as an infrastructure fault, preventing
the worker from repairing the test failure.

### Essential Design Decisions

- Match unindented Docker CLI error lines, including shell-prefixed reports,
  outside Deno captured output. The captured-output walker is shared with the
  missing-command classifier.
- Exclude Deno's bare test wait lines, status lines (including multiple
  step and timing groups), and source-location summaries. ANSI decorations
  are stripped before matching.
- An unbracketed output line indistinguishable from a Docker CLI error can
  still match; the classifier cannot determine its origin from text alone.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. The regression tests exercise the classifier and
the Docker quality-gate decision in `worker/deno/tests/quality_gate_phase_test.ts`.

## Test Plan

- The test file covers real Docker errors, shell prefixes, captured output,
  indented quotations, ANSI decorations, hostile long lines, test result and
  source-location lines, and fixable gate outcomes.
- `isDockerInfraFailure - Deno wait and step summary lines are not infrastructure`
  and `runQualityGateCheck - Deno output and failed step summaries remain fixable`
  cover a logged failure with a wait line and output block, and a failed-step
  result with two parenthesised groups. Both tests failed before the review fix.
- The existing Docker infrastructure and missing-command tests retain their
  coverage; no existing assertions were removed or weakened. The shared
  captured-output walker is the only copy used by these classifiers.
- The focused test file passes with 84 tests. Formatter, linter and whole-tree
  type-check results are recorded in the validation accompanying this change.
