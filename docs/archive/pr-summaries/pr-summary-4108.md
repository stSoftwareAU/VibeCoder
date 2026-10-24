# Standards: a missing key in a parsed response is malformed, not the empty state

## Summary

Closes #4108.

Adds one clause to the existing "Absence of a success marker is not success"
bullet, with identical wording in `CODING-STANDARDS.md` and
`prompts/coding_guidelines/prompt.md`. Documentation and prompt text only; no
code, gate or lint rule changes.

## Spec

### Intent and Rationale

A parser that reads an omitted required key as the field's empty or null state
lets a malformed reply pass as a valid empty one. It happened twice:
`parseChecklistVerdicts` read an absent `checklist` as `[]` (#3695), and
`validateGraphQLBranchCompareJson` returned `ok({kind:"absent"})` for a missing
ref (#4104). The clause states the rule once so authors and reviewers apply it
to every parser of an external response.

### Essential Design Decisions

- Extend the existing "Absence of a success marker" bullet rather than add a new
  one: the rule is a special case of it.
- Scope the rule to keys the format guarantees (GraphQL selects it, a brief or
  schema requires it) whose documented empty state is `null` or `[]`.
- Require a rejection that names the field, and a test of the omitted-key case
  as a rejection.
- No deterministic check is added, as the issue proposes none.

### Undiscoverable Facts

- `deno fmt --check` already fails on both markdown files at the base commit;
  that is not a regression and the formatting was left alone to stay in scope.
- `worker/deno/lib/validation.ts:1075` already documents "explicit null means
  'branch absent'; an omitted key is malformed", which agrees with the new rule.

## Evidence

- `git diff origin/main --stat`: `CODING-STANDARDS.md` +6/−1,
  `prompts/coding_guidelines/prompt.md` +6/−1 (plus the worker's handover note).
- The layout/drift test `worker/deno/tests/coding_guidelines_layers_2574_test.ts`
  passes.
- Twinned copies: `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`
  carry the same clause; only line wrapping differs.
- Overlapping rules checked: "Surface every failure", "Do not swallow errors",
  "Prefer loud, early failure", "No silent fallback that masks a fault", and "A
  failure reason names the cause, not just the failure". None contradicts the
  clause; it agrees with each.
- Applied the rule to this PR's own diff: it adds no parser, so nothing was
  flagged.
- **Docs sweep:** grep: `omitted key|absent|Absence of a success marker`;
  section: `Never Fail Silently`; siblings: `Surface every failure`,
  `Do not swallow errors`, `Prefer loud, early failure`; left alone:
  `docs/AGENT-ACCOUNTABILITY.md:258` and `docs/BEST-PRACTICES-SCAN.md:613` only
  cite the rule and stay true; `prompts/coding_guidelines_claude/prompt.md` has
  no copy of the bullet.

## Test Plan

- Quality gate: `./quality.sh < /dev/null` (result recorded in the PR).
- `deno test` of `coding_guidelines_layers_2574_test.ts` passes.
- No branches added; no new tests, as the change is prose only.

<!-- vibe-branch-outcomes -->
