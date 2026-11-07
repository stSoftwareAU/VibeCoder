## Summary

The milestone merge and resolution gates now read a Deno task failure whose
ANSI escape bytes were already stripped (a bare `[0m[1m[31merror[0m: Failed
caching npm package …`) as the same unreachable-registry gap as the coloured
form, so the task is left to CI instead of refusing the merged tree. Closes
#4853.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Issue #4853 is the same wedge as #4848 (GRQ-AutoTrader `web/` `deno task
  check`, `Failed caching npm package 'playwright-core@1.60.0'`, DNS error),
  reported 6 minutes after #4848's fix merged. The fix on main
  (`detectRemoteModuleGap` with `stripAnsi`) matches the output with its ESC
  bytes, and I confirmed it returns the gap for that form. The output as the
  issue prints it has no ESC bytes, leaving `[0m[1m[31merror[0m:`, and the
  detector returned `undefined` for it.
- So this change makes the detector tolerant of that form too. Whether the
  refusing host was simply still running pre-#4848 code cannot be told from the
  repository.

### Essential Design Decisions

- SGR remnants (`[0-9;]*m` after a `[`) are removed anywhere in the line, not
  only as a prefix: the remnant sits between `error` and `:`, so a prefix strip
  does not make the header match (found by a failing test).
- The cost is that a literal `[…m` in a cause line is removed from the reported
  `cause`; the detector only reads it for the header and the connection words.

### Undiscoverable Facts

- Observed with the issue's output: ESC form → gap; ESC-less form → no gap
  before this change.

## Evidence

Backend-only change; `detectRemoteModuleGap` is read by `checkMergedTree`,
`verifyResolvedTree` and `runMergeFastChecks`, which all gain the behaviour.
Docs updated: `docs/INTERNALS.md` and `docs/workflows/milestones.md` (the
Issue #4848 paragraphs).

## Reproduction

- **symptom** — the gate refused a merged tree with `Failed caching npm package
  … dns error` output, repeatedly.
- **status** — `partial` — reason: the ESC-less output printed in the issue was
  run against the unfixed detector (returned `undefined`) and the new test went
  red against it, but the live host run was not available, so whether the
  refusal came from ESC-less output or from a pre-#4848 worker is unverified.
- **regression test** —
  `worker/deno/tests/milestone_merge_gate_test.ts::detectRemoteModuleGap - npm output whose escape bytes were stripped upstream is still a gap (Issue #4853)`

## Test Plan

- Added to `worker/deno/tests/milestone_merge_gate_test.ts`: the ESC-less
  verbatim npm output is a gap; a remnant-prefixed integrity failure is not a
  gap; a long run of `[0m` or `[0` pairs returns `undefined`.
- Red check: removing the `ORPHAN_SGR_RE` replacement turns the first test red;
  restored.
- `deno task test:unit tests/milestone_merge_gate_test.ts
  tests/milestone_resolution_gate_test.ts`: 91 passed, 0 failed.

Not done / risk: no live milestone sync was run; a pre-#4848 worker would still
refuse until it runs this code.
