## Summary

`earlierFindingGaps` now renders a readable, one-level-deep gap instead of
`JSON.stringify` of the old finding. Closes #4446.

Version bump: not applicable (no `VERSION` change).

## Spec

### Intent and Rationale

- Gaps nested one JSON layer per send-back and hid the reviewer's note; the gap
  text is reworded only, so a missing, duplicate or non-`fixed` verdict still
  blocks.

### Essential Design Decisions

- The gap carries the finding it wraps as structured data (`earlier`), so
  unwrapping needs no parsing for the fleet log path (`post.ts` now passes
  `previousFindings` objects directly).
- The worker's PR-feedback path only has posted text, so a text gap is unwrapped
  by its own `Original finding:` marker (last occurrence). The posted gap ends
  with the generic `**Fix:**` line, so the unwrap cuts that trailing line before
  the original is quoted again; otherwise it would gain one copy per round.
- Legacy gaps already logged without `earlier` are quoted as they are; they stop
  growing but are not repaired.

### Undiscoverable Facts

- None.

## Evidence

Changed: `worker/deno/lib/earlier_findings.ts`,
`.claude/skills/review-fleet-prs/scripts/post.ts`,
`.claude/skills/review-fleet-prs/scripts/review_log.ts` (type only:
`Finding.earlier`). Purely backend; no UI.

## Test Plan

- Added to `worker/deno/tests/earlier_findings_3784_test.ts`: text with
  `file:line`, verdict and note and the original Fix; no-verdict and duplicate
  wording; four rounds of wrapping stay one level deep; a posted text gap
  unwraps; four rounds of the posted-text path (the worker's PR-feedback
  verifier) quote an identical original with one original Fix and no repeated
  generic Fix; a gap pins `file` and `line`; a non-gap finding carrying
  `earlier` is not unwrapped; a legacy gap without `earlier` is quoted as it is.
- Ran `deno test -A` on the earlier-findings, checklists_3594,
  pr_feedback_verifier_3784, pre_pr_verifier_3395, review_log_2678,
  post_claim_4398 and dependabot tests: 144 passed, 0 failed.
- Red check: replacing the unwrap (`originalOf(wrapped)` → `wrapped`) fails the
  nesting and text-unwrap tests. Surviving mutants now killed (each run fails
  the tests): `earlier_findings.ts` line 68 operands `finding.file === GAP_FILE`
  and `finding.earlier`, and the deleted `file` and `line` properties of the
  text gap. Dropping the trailing-Fix cut fails the multi-round test.
- Full `./quality.sh` not run: skipped for budget; CI runs it.

<!-- vibe-quality-gate-skipped reason="run budget; targeted tests, fmt and lint passed" -->
