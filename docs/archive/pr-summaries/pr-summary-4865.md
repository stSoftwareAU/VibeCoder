## Summary

The unmet-criteria gate note now says a `partial` or `missing` entry makes the
pull request body `Part of #N`, matching `withholdsIssueClose` and
`findMissingCriteria`, which treat both statuses alike since #4644. The
`missingCriteria` doc comment on `MergedPR` in `issue_query.ts` is aligned to
the same wording. Closes #4865.

Version bump: no `VERSION` change; this is a message and doc-comment correction.

## Spec

### Intent and Rationale

- The note is shown to the agent once and posted on the PR; naming only
  `missing` led a partial-only run to keep `Closes #N`, which disagreed with the
  worker's `Part of #N` body.
- Only the sentence changes: the gate logic already treats both statuses the
  same.

### Essential Design Decisions

- None.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. `buildUnmetCriteriaGateComment` is
exercised by `worker/deno/tests/unmet_criteria_gate_test.ts`.

## Test Plan

- Extended
  `worker/deno/tests/unmet_criteria_gate_test.ts::buildUnmetCriteriaGateComment - names each criterion and does not claim the PR is withheld`
  to assert the `partial` or `missing` wording and that the `missing`-only
  phrasing is absent. Red check: restoring the old sentence made that test fail;
  restored, `deno task test:unit tests/unmet_criteria_gate_test.ts` passed (6
  passed).
- Removed from existing tests: nothing.
- Docs sweep: grepped `README.md`, `docs/` (excluding archive) and `prompts/`
  for the old "`missing` entry makes" wording and found no other hit.
- Quality gate: `./quality.sh` did not finish within 300s or 600s (two runs).
  Every stage that reported passed, including semgrep and markdownlint. The
  unit-test stage after "release-tag ruleset" never reported.

<!-- vibe-quality-gate-skipped reason="gate did not complete within the foreground time bound; targeted fmt, lint and unit tests passed" -->
