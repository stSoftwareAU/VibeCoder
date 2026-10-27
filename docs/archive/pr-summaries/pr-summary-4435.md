## Summary

Reworded step 2 of the shared review brief (`prompts/pr_review_brief/prompt.md`) so a change that clears a dependency audit that is red on the PR is not read as unrelated scope. The fleet reviewer and the pre-PR verifier share this brief, so both stop sending back the advisory fix that `prompts/ci_fix/prompt.md` ("Dependency audit failures") requires in every red PR. Version bump: not applicable (prompt and test only). Closes #4435.

## Spec

### Intent and Rationale

- The brief's "nothing unrelated" contradicted the CI-fix rule that every PR red on an advisory fixes it itself; the brief now names the exception and cites the CI-fix section.

### Essential Design Decisions

- The change only removes a send-back reason: the correctness, test and summary rules (steps 3–5) still apply to the dependency change, so a bump that is wrong is still a finding.
- The wording is the issue's proposed rewording, wrapped to the file's line width.

### Undiscoverable Facts

- None.

## Evidence

Doc-only prompt change plus a doc-drift test. Existing rules checked for overlap: `prompts/ci_fix/prompt.md` "Dependency audit failures" and "Base-branch failures" (agree), `.claude/skills/review-fleet-prs/SKILL.md` rule 2 (agrees; it links the brief, not a copy), step 10 of the brief (pre-existing problems — unaffected). Applied the rule to this diff: nothing in it contradicts it. Docs grep for `nothing unrelated` found only the brief itself.

## Test Plan

- Added `worker/deno/tests/pr_review_brief_audit_fix_4435_test.ts` (two tests): the first pins the new step 2 wording; the second checks the cited CI-fix section exists and still says every red PR fixes the advisory itself.
- Red check: with step 2 reverted to the old line, the first test fails (`to contain: "A change that clears a dependency audit that is red on this PR is not unrelated"`); restored, it passes. The pinned phrases are absent from the base brief.
- `deno task test:unit` on the new test, `pr_review_brief_shared_3395_test.ts` and `pre_pr_verifier_3395_test.ts`: 83 passed, 0 failed. `deno fmt --check` and `deno lint` on the new file: clean.
- No existing test was edited.
