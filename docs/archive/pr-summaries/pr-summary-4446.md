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
  only when the text opens with the gap's own worker-written head
  (`Earlier finding <n> is not independently verified as fixed (`, bare or
  under the posted ``**`(earlier review)`**:`` header; `GAP_TEXT_HEAD` in
  `earlier_findings.ts`). The quoted original starts at the first
  `). Original finding: ` after that head, so an original that itself quotes
  the marker is kept whole. Any other text, including a plain finding or a
  trailing review summary that quotes the marker, is an original and is
  quoted whole (PR #4467 review). The unwrap cuts the gap's generic
  `**Fix:**` line and anything after it (the review summary, when the gap was
  the last finding) before the original is quoted again; otherwise it would
  gain one copy per round. A verdict note that itself contains
  `). Original finding: ` would still cut the quote early; the note is the
  reviewer's own short text, so this is left as it is.
- Legacy gaps already logged without `earlier` are quoted as they are; they stop
  growing but are not repaired.

### Undiscoverable Facts

- None.

## Evidence

Changed: `worker/deno/lib/earlier_findings.ts`,
`.claude/skills/review-fleet-prs/scripts/post.ts` (passes `previousFindings`
objects, typed `EarlierFinding[]`),
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
- Added to `worker/deno/tests/earlier_findings_3784_test.ts` (PR #4467 review,
  look-alikes for the anchored unwrap): a plain finding that quotes a gap's
  `). Original finding: ` is quoted whole; a trailing review summary that
  quotes it leaves the last finding whole; a posted gap whose original quotes
  it unwraps to the whole original; a posted text gap that was the last
  finding drops the review summary; a bare gap problem with no posted header
  still unwraps. `worker/deno/tests/earlier_findings_3784_test.ts` has 13
  tests at head.
- Added to `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`:
  "fleet post - an earlier finding comes back as a readable gap that stays one
  level deep" (PR #4467 review). It calls `reviewForPost` with a structured
  previous finding and a `partly` verdict, asserts the gap quotes
  `a.ts:2 — two paths broken` and the note, has no `{` or backslash, keeps the
  original Fix and carries `earlier`; then JSON round-trips the findings as the
  review log does and feeds them back with a `not fixed` verdict, asserting
  `earlier` is still the original and the problem has one "Earlier finding".
- Ran `deno test -A` on `worker/deno/tests/earlier_findings_3784_test.ts`,
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`,
  `worker/deno/tests/pr_feedback_verifier_3784_test.ts`,
  `worker/deno/tests/pre_pr_verifier_3395_test.ts`,
  `worker/deno/tests/review_fleet_prs_dependabot_test.ts` and
  `worker/deno/tests/review_fleet_prs_post_claim_4398_test.ts` on the final
  head: 140 passed, 0 failed.
- Red checks for the PR #4467 review fixes, each run against
  `worker/deno/tests/earlier_findings_3784_test.ts` or the `fleet post` tests:
  - `post.ts` line restored to `.map((f) => JSON.stringify(f))`: the new
    `reviewForPost` test fails (the gap quotes
    `{"file":"a.ts","line":2,...}`).
  - `earlier_findings.ts` restored to the previous head: the four look-alike
    tests fail (9 passed, 4 failed at that point).
  - Head anchor removed (`GAP_TEXT_HEAD` check skipped): the plain-finding and
    trailing-summary tests fail.
  - First quote opening replaced by the last (`lastIndexOf`): the
    marker-quoting original test fails.
  - Optional header made mandatory: the bare-gap test fails.
  - Fix-line cut restored to `endsWith`: the last-finding summary test fails.
- Red check: replacing the unwrap (`originalOf(wrapped)` → `wrapped`) fails the
  nesting and text-unwrap tests. Surviving mutants now killed (each run fails
  the tests): `earlier_findings.ts` line 68 operands `finding.file === GAP_FILE`
  and `finding.earlier`, and the deleted `file` and `line` properties of the
  text gap. Dropping the trailing-Fix cut fails the multi-round test.
- On the final head, `deno fmt --check`, `deno lint`, `deno check` of the
  changed files and `deno task check:manifests` passed from `worker/deno`.
- Full `./quality.sh` not run: the review-fix host cannot reach jsr.io; CI
  runs it.

<!-- vibe-quality-gate-skipped reason="jsr.io unreachable on the review-fix host; targeted tests, fmt, lint, check and manifests passed" -->
