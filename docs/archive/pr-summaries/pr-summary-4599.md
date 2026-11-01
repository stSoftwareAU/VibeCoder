## Summary

The split-run advisor block now tells the advisor to dispatch every executor and
reviewer with `run_in_background: false`, so each result comes back in the same
turn. Before, a background dispatch let the advisor end its turn with an
executor still running, and the run reached the PR with no summary and a bare
`Closes #N`. Closes #4599.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The split design assumes an executor call returns before the advisor moves on.
  The block said "dispatch ... in a single message" and nothing about returning
  within the turn, so a background dispatch was allowed. Pinning the foreground
  in the prompt restores the assumption.

### Essential Design Decisions

- Prompt wording only. The Claude CLI's agent schema has an optional
  `background` field, but `background: false` only means "do not force a
  background run"; it does not stop the model passing `run_in_background: true`
  on the call. So the `--agents` definitions are unchanged.
- The reviewer bullet in the split block gets the same wording, because the
  advisor also needs the reviewers' verdicts before it writes the summary. The
  shared "Independent Review" section is untouched (an existing test requires it
  to be identical with the split on and off).

### Undiscoverable Facts

- The CLI behaviour (sub-agents may run in the background and notify the caller)
  comes from the issue's run transcripts. It was not reproduced here, so the fix
  is unverified against a live split run.

## Evidence

Backend/prompt only, no UI.
`worker/deno/tests/issue_prompt_executor_split_2343_test.ts` renders the real
key-on issue prompt and asserts the executor bullet and the reviewer bullet each
carry `` `run_in_background: false` `` (the executor bullet also "in a single
message") and that the block never contains `run_in_background: true`. Issue
numbers cited as provenance: #4599 (this issue), #2343 (the split block).

## Test Plan

- Added
  `issue prompt - the block dispatches executors and reviewers in the
  foreground (Issue #4599)`
  in `worker/deno/tests/issue_prompt_executor_split_2343_test.ts`.
- Red check: changing both `run_in_background: false` in the lib file to `true`
  made that test fail; restoring them made it pass. Flipping only the first
  (executor bullet) or only the last (reviewer bullet) occurrence to `true` also
  fails it (9 passed, 1 failed each time).
- `deno task test:unit` on that file: 10 passed, 0 failed.
  `tests/prompt_builder_test.ts`: 69 passed, 0 failed.
- Docs: `docs/MANAGER-WORKER-CONTRACT.md` ("Prompt templates") gains a bullet on
  the foreground pin and the corrected `issue_executor_split_prompt.ts:31`
  citation; it was the only citation of that file there. `deno fmt --check` on
  that doc already reported two unrelated paragraphs before this change.
- Callers checked: `ISSUE_EXECUTOR_SPLIT_INSTRUCTIONS` is spliced only by
  `prompt_builder.ts` into the issue prompt; the existing "key-on prompt is the
  key-off prompt plus the block" test still passes.
