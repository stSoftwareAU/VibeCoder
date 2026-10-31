## Summary

The shared review brief and the coding guidelines now say the routine
`bump-deps.sh` refresh the worker commits on every PR is part of the PR, so a
run no longer reverts it as unrelated. Closes #4522.

- `prompts/pr_review_brief/prompt.md` step 2: the worker's bump commit is "not
  unrelated: it is part of the PR, so do not ask for it to be reverted", reviewed
  for correctness like any change. The existing audit-fix sentence is unchanged.
- `prompts/coding_guidelines/prompt.md` ("Dependency Bumps and Supply Chain"):
  the dangling "see." now says the bump commit is part of the PR.

## Spec

### Intent and Rationale

- The pre-PR verifier saw the worker's own post-implementation bump commit as an
  unrequested change and the run reverted it; only the brief and guidelines needed
  to say otherwise. No check was added and no review was relaxed.

### Essential Design Decisions

- The new sentence is added beside the #4435 audit exemption rather than merging
  the two, so the #4435 wording and its test stay untouched.

### Undiscoverable Facts

- The CI autofix behaviour of the affected private fleet repo is described in the
  issue only; it is not reproducible here.

## Evidence

Prompt-only change. The commit subject comes from `buildBumpCommitMessage` in
`worker/deno/lib/bump_deps.ts`, which the new test imports.

## Test Plan

- Added `worker/deno/tests/pr_review_brief_own_bump_4522_test.ts` (two drift
  tests): step 2 names the bump subject, the guidelines section title and the
  "not unrelated" rule; the guidelines sentence is finished and no longer ends in
  "see.". Passed, together with `pr_review_brief_audit_fix_4435_test.ts`,
  `pr_review_brief_shared_3395_test.ts` and `pre_pr_verifier_3395_test.ts`
  (85 passed, 0 failed).
- Red check: with both prompt edits reverted, both new tests fail.
- No existing test edited. Related rules checked: the #4435 audit exemption in the
  same step, `prompts/ci_fix/prompt.md` "Dependency audit failures"; they agree.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh exceeded the 500s bound; CI runs it" -->
