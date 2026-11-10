## Summary

The shared reviewer brief now tells the reviewer that a `coverage` entry's
`name` is matched as literal text in the file's source, and how to cite a test
whose name is built at run time. The `checkCoverage` header comment now says
what the code does. No check changed. Closes #4892.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- `checkCoverage` uses `probe.text.includes(name)`, so a parameterised test's
  run-time name never matches. The reviewer was not told, so the fix is in the
  brief, as the issue proposes.

### Essential Design Decisions

- The literal-text wording is scoped to the reviewer's own `coverage` entries
  and the "Verify every cited test" bullet. No rule is added about how a PR's
  own summary cites tests (per the issue comment).
- Not accepting a mismatched `existing` entry beside verified coverage: SKILL.md
  rule 4 requires each entry to resolve.

### Undiscoverable Facts

- None.

## Evidence

Prompt and comment wording only; no behaviour changed.
`deno task test:unit tests/review_fleet_prs_test_policy_4655_test.ts tests/pr_review_brief_gone_verification_4812_test.ts tests/pr_review_brief_shared_3395_test.ts`
passed (79 passed, 0 failed). Read `checkCoverage`
(`.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`) to confirm the
new comment: each failing `replacement`/`existing` entry pushes its own problem,
and `goneTestProblems` are pushed only when `passed.length === 0`.

## Acceptance Criteria

The issue states no acceptance-criteria heading; all three proposed edits are
made (brief line ~77, brief lines ~119-124, `checkCoverage` header comment), so
no part is outstanding.

## Test Plan

- No test added: wording-only change; existing brief and test-policy tests above
  pass.
- `./quality.sh`: every stage through release-tag ruleset passed (markdownlint,
  semgrep, mermaid, completeness); the run then hit the 400s timeout in a later
  stage, so the full gate did not finish.
  <!-- vibe-quality-gate-skipped: gate exceeded its 400s timeout after passing the stages before it; the worker re-runs it before the PR -->
