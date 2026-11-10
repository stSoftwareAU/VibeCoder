## Summary

The `ci_fix` prompt now states the rule for a PR description the worker never
rebuilds in its own paragraph, **A description the worker does not rebuild stays
true too.**, instead of inside the summary-file paragraph. The new paragraph
covers a bot PR's title as well as its description
(`gh pr view <n> --json title,body,headRefName`,
`gh pr edit <n> --title <title> --body-file <file>`). Closes #4893.

## Spec

### Intent and Rationale

- Two Dependabot PRs kept titles and bodies claiming a bump that CI-fix had
  reverted. The rule sat under a paragraph conditional on a committed summary
  file, which a bot PR never has, and never named the title.

### Essential Design Decisions

- No new duty or check: the existing duty is moved and the title added. Only
  `ci_fix` changes. The `pr_feedback` and `merge_conflict` templates keep their
  wording because the issue scopes the fix to `ci_fix`.
- The "Dependency audit failures" paragraph still uses the body-only
  `gh pr edit <n> --body-file <file>`, as it only appends `Fixes #N`.

### Undiscoverable Facts

- None.

## Evidence

Docs-only change plus its drift test; no UI. Related rules checked: the
`pr_feedback` and `merge_conflict` marker-less rules (unchanged, still agree),
the `ci_fix` "What you may change" close rule (untouched, as the issue says) and
`docs/workflows/ci-fix.md` (updated). Applied the rule to this diff: the new
paragraph's own `gh pr edit` example matches the allowed guard
(`gh_guard_decision.ts`).

## Acceptance Criteria

The issue states no acceptance-criteria heading and nothing it asks is left
undone.

## Test Plan

- Modified `worker/deno/tests/marker_less_body_rebuild_4515_docs_test.ts`: the
  `ci_fix` pins now expect `gh pr edit <n> --title <title> --body-file <file>`,
  `gh pr view <n> --json title,body,headRefName` and `every bot pull request`;
  the other types keep the old command. Added
  `ci_fix summary paragraph carries no marker-less wording` (the new heading is
  present, and the summary-file paragraph no longer carries the marker-less
  sentences).
- Removed from `worker/deno/tests/marker_less_body_rebuild_4515_docs_test.ts`:
  the `ci_fix` pin `gh pr edit <n> --body-file <file>` in "Fixing the Failure".
  - Required by: "name the title in it"
  - Replaced by: `gh pr edit <n> --title <title> --body-file <file>`
- `deno task test:unit tests/marker_less_body_rebuild_4515_docs_test.ts`: 5
  passed.
- Not run: red-check against the base prompt (the new pins name text absent on
  base by construction).
