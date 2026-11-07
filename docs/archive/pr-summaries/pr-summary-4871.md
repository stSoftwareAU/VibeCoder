## Summary

Removed the "Raising the PR is your job" instruction from the shared coding guidelines, the `gh` guard's `PR_LIFECYCLE_REFUSED` text and the CI-failure diagnosis block, so they agree with the issue prompt: the worker raises the PR in its completion phase after the quality gate. Closes #4871.

## Spec

### Intent and Rationale

- Agents followed the shared guidance and opened PRs before any worker gate ran, with their own title and body; three earlier issues repaired the results but never the instruction. This removes the instruction rather than adding a counter-rule.

### Essential Design Decisions

- `gh pr create` stays unaffected in the guard and the guidelines (refusing it is out of scope); the text just stops telling the agent to use it.
- The CI-failure block is built inside `execute_claude_phase.ts`, i.e. the normal issue run that ends in the completion phase, so it now says the worker raises the PR from the run's branch. Routes that really raise their own PR (e.g. `prompts/workflow_setup/prompt.md`) are untouched.
- Also updated two statements the change made false: the `PR_LIFECYCLE_VERBS` doc comment (`worker/deno/lib/gh_pr_lifecycle.ts`) and `SECURITY.md` ("raising and describing the PR is the agent's job").

### Undiscoverable Facts

- `evals/capability_security/comparison-20261026.json` embeds a historical copy of the old guidelines; it is a recorded eval output and was left as is.

## Evidence

Backend/prompt-text change only. Related existing rules checked: the issue prompt (`prompts/issue/prompt.md` — "the PR, which the worker raises anyway"), `prompts/workflow_setup/prompt.md` (own-PR route, unchanged), the guidelines' Issue Lifecycle section, and `SECURITY.md` §6a; none conflicts with the new wording. Applied the rule to this diff: `git grep` for "your job", "stop there", "raise the PR itself" outside `docs/archive` finds only the new test assertions.

## Test Plan

- `worker/deno/tests/claimed_pr_lifecycle_guard_test.ts` — refusal reason no longer says "Raise the PR", still lists `'gh pr create'` as unaffected; coding guidelines prompt no longer contains the old sentences and contains "Deciding whether a PR lands is not your job.".
- `worker/deno/tests/ci_failure_issue_test.ts` — rendered CI-failure section no longer says "raise the PR itself" and says the worker raises the PR.
- Red check: with the production edits reverted, all three new tests fail; with them applied they pass.
- Ran `deno task test:unit` over the coding_guidelines, prompt_hash, gh_guard, claimed_ and ci_failure test files: 283 passed, 0 failed.
