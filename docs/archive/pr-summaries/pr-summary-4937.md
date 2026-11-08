## Summary

The two sentences that told an agent to "create" its per-issue PR summary now say
to write it, and to replace a copy an earlier PR for the same issue left on the
base branch. Closes #4937.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A follow-up PR for the same issue finds the merged sibling's summary at the same path. "Create" plus "permanent documentation" made that file look like a record to keep, so agents extended it and re-claimed the sibling's work. Rewording the two sentences removes that reading.

### Essential Design Decisions

- Wording only, as the issue proposes: no new rule, check or gate. The diff-must-match rule in `prompts/issue/prompt.md` stays as written.
- The issue's proposed text is used as given. In `CODING-STANDARDS.md` the line wrap now falls between "every" and "PR summary" in "the canonical home for every PR summary".

### Undiscoverable Facts

- None.

## Evidence

Documentation and prompt wording only; no code changed. Related rules checked: the "Describe the final state of the branch" rewrite list in `prompts/issue/prompt.md` (a review fix, a retry, a base merge, a resumed attempt) still holds and the new sentence agrees with it. A grep of `prompts/`, `CODING-STANDARDS.md` and `docs/` (outside `docs/archive/`) for "create/write … pr-summary-" found no other restatement. `worker/deno/lib/pr_summary_loader.ts` is unchanged: it reads whatever sits at the path at the head, which is now the replaced summary.

## Test Plan

- No test was added: the issue states no test pins the "create a file called" wording, and a test over prompt prose would only pin incidental text.
- `deno task test:unit tests/breakpoint_sides_3656_docs_test.ts` from `worker/deno` (a prompt-wording drift test over the same file): passed.
- `./quality.sh` on the head, with the host proxy variables unset: PASSED, with config integration and Checkov skipped and the release-tag ruleset check skipped (GitHub API unreachable). With the proxy variables set it fails `deno tests`, in a file this change does not touch.
