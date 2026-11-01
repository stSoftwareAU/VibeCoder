## Summary

The split-run advisor block now tells the advisor to dispatch every executor and
reviewer with `run_in_background: false`. A hook enforces foreground dispatch,
and the runner refuses completion when an executor result is unfinished. Before,
a background dispatch let the advisor end its turn with an executor still
running, and the run reached the PR with no summary and a bare `Closes #N`.
Closes #4599.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The split design assumes an executor call returns before the advisor moves on.
  The block said "dispatch ... in a single message" and nothing about returning
  within the turn, so a background dispatch was allowed. Pinning the foreground
  in the prompt and enforcing it in the worker protects that assumption.

### Essential Design Decisions

- The Claude CLI's agent schema has an optional `background` field, but
  `background: false` only means "do not force a background run"; it does not
  stop the model passing `run_in_background: true` on the call. The `--agents`
  definitions are unchanged; the split-run hook denies advisor `Agent` and
  `Task` calls without explicit foreground mode.
- The runner checks the stream for a completed result for every advisor executor
  dispatch. Outstanding calls, asynchronous launch acknowledgements, errors and
  malformed stream lines fail the invocation instead of allowing PR creation;
  the existing failure path retains work for retry.
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
`worker/deno/tests/issue_executor_enforcement_test.ts` also exercises the hook
and the runner with fake CLI streams, including an executor still active when
the advisor turn ends and a completed executor result.

## Test Plan

- After the lifecycle enforcement change,
  `deno task test:unit
  tests/issue_executor_enforcement_test.ts
  tests/issue_prompt_executor_split_2343_test.ts`:
  29 passed, 0 failed. The runner fixture covers pending, completed, background,
  asynchronous, error, nested and unrelated results; only the completed case
  succeeds.
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
- `./quality.sh`: every stage passed except `deno tests`: parallel pass 31551
  passed, 2 failed, both in `completion_phase_repo_formatters_test.ts` (lines
  480 and 567, the cargo fmt commit tests; this host has no rustup/cargo and the
  diff does not touch that code). The serial pass did not run because the
  parallel pass failed; `config integration` and `checkov` were skipped for
  local prerequisites. `deno task pr-summary-check`: 0 blocked, 0 not checked.
