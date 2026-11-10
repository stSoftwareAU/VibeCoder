## Summary

SECURITY.md section 2 ("TOCTOU Protection for Issue Content") now describes what
the content-integrity gate actually does when the snapshot hash mismatches but
GitHub records no edit since the snapshot: it logs
`[SECURITY] [SNAPSHOT_SELF_MISMATCH]`, re-baselines from the live content and
proceeds without touching labels or comments (Issue #3964). The old sentence
claimed the whole recorded history was judged. The conditions the behaviour
relies on are stated: the body window covers the snapshot (Issue #4804) and the
newest rename is always visible. Docs-only; no code change. Closes #4948.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- SECURITY.md described a stricter control than the one that runs; an auditor
  could wrongly conclude an untrusted editor anywhere in the history blocks. The
  sentence is rewritten to match `worker/deno/lib/work_on_content_integrity.ts`
  (`if (sinceSnapshot.length === 0)` branch).

### Essential Design Decisions

- Only the one sentence changed. The nuance that a truncated body window which
  post-dates the snapshot never reaches this branch (it is blocked unless a
  trusted re-approval is found) is stated, matching the existing "Truncated body
  history" bullet.

### Undiscoverable Facts

- None.

## Evidence

Docs-only. Claims checked against the code:
`worker/deno/lib/work_on_content_integrity.ts` lines 853-880
(`[SNAPSHOT_SELF_MISMATCH]` log, `captureBaselineOrBlock`, no label mutation,
comment block citing #3964) and the doc comment at lines 507-512. Issue numbers
cited, from the issue text and code comments: #3964 (snapshot self-mismatch
behaviour), #4804 (truncated body history, already cited in SECURITY.md).

Grep for `judged instead|whole recorded history|newest actor wins` over
`*.md`/`*.ts` outside `docs/archive` found no other copy of the old claim.

## Acceptance Criteria

The issue states no acceptance-criteria heading; nothing it asks is left undone.

## Test Plan

- No test added: documentation-only change.
- `deno test tests/doc_prose_claims_test.ts` (the test that reads SECURITY.md),
  run from `worker/deno`: 15 passed, 0 failed.
- `./quality.sh < /dev/null`: every stage it printed passed (including
  markdownlint, mermaid, semgrep, completeness checks), but the run did not
  finish inside two bounded attempts (300s and 1000s, both timed out in the
  final stage after the release-tag ruleset check) and printed no overall
  verdict, so the gate is not recorded as passed; the worker re-runs it before
  the PR is raised.

<!-- vibe-quality-gate-skipped reason="quality.sh did not return a verdict within 1000s on this host; all printed stages passed, final stage hung" -->
