## Summary

`ownDiffUnchanged` (review-fleet-prs gate) now keeps a sent-back Dependabot PR
`awaiting-fix` when Dependabot re-cuts it (a `diverged` compare with an
identical own diff), instead of starting a full re-review that ends in the same
send-back. Any other force-push still gets a fresh review. Closes #4723.

## Spec

### Intent and Rationale

- Dependabot never merges the base into its PRs; it force-pushes a fresh commit
  with the same change, so `compare/{since}...{head}` is `diverged` and the
  ancestry check refused it every time.
- The ancestry check stays for fleet PRs: a force-push can itself be the fix
  (VibeCoder#3772, a squash with an identical tree that fixed a commit-message
  finding).

### Essential Design Decisions

- The exception needs all of: `kind === "dependabot"`, compare status
  `diverged`, a complete `base...head` commit list where every author login is
  `dependabot[bot]` (a null author fails), known non-empty findings that each
  (unwrapping structured earlier-review gaps) name a file in the sent-back own
  diff, and the strict path for every file (`normalisePatch` equality including
  context, no version exception, no file dropped or added; head-only files, the
  300-file cap and duplicate names are refused as before).
- Findings that name a non-file (commit message, history, metadata) or are
  missing/empty force a fresh review. The check is structural (the finding's
  `file` must be in the own diff), not a wording guess, and fails towards a
  review.
- `kind` is a new optional last parameter of `ownDiffUnchanged`, passed from the
  gate loop (its only production caller). The held/`awaiting-owner` path passes
  no findings, so the exception never applies to it.
- It cannot approve anything: `awaiting-fix` only applies while the latest
  review requests changes.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI only. At head `7cbefaf`, the gate suite contains seven new Issue
#4723 tests and passes all 61 tests. The pass-level suite adds one Issue #4723
test. The gate, pass-level and earlier-findings suites passed 80 tests together,
with no failures.

Docs updated: `.claude/skills/review-fleet-prs/SKILL.md` (rule 8) and
`.claude/skills/review-fleet-prs/references/edge-cases.md` ("Version-only
re-bumps"). Grepped both for `force-push`, `ancestor`, `ahead`, `diverged`; no
other sentence became false.

The merge conflict in the gate test imports retains both the Dependabot finding
type and the base branch's hold-policy marker for their tests. The
`ownDiffUnchanged` comment also states the non-empty findings requirement and
how structured earlier-review gaps are evaluated.

## Test Plan

- After resolving the import conflict, `deno fmt --check`, `deno lint` and
  `deno check '**/*.ts'` passed from `worker/deno`.

- The gate suite passes 61 tests with
  `deno task test:unit
  tests/review_fleet_prs_gate_2675_test.ts`. Running that
  suite with `review_fleet_prs_upkeep_failure_2891_test.ts` and
  `earlier_findings_3784_test.ts` passes 80 tests.
- The pass-level regression checks that a Dependabot re-cut is skipped as
  `awaiting-fix`, while the same fleet-authored fixture is ready for review.
  Removing `kind` from the production call made that regression fail.

Covered: Dependabot diverged + identical patch → `awaiting-fix`; one
non-Dependabot or null-author commit → review; fleet/omitted kind with diverged
head → review (VibeCoder#3772 case); differing patch, version-only difference,
or dropped file → review; undefined/empty findings, a finding on a non-file, or
a non-file `earlier` → review (with a positive control naming `a.ts`);
context-only change in an unnamed file → review (strict path). A structured
content gap alone or alongside a plain finding → `awaiting-fix`; a COMMIT_MSG
gap or text-only gap → review. The earlier-gap test failed before its fix. No
existing assertion was removed.

Red checks (each break reverted afterwards):

- drop `kind === "dependabot"` → the fleet-diverged test red
- drop the author check → the commit-author test red
- drop the findings content check → the content-findings test red
- make the file loop non-strict → the strict-path and whole-patch tests red
