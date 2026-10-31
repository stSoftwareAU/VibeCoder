## Summary

The fix-run prompts told the agent that the worker rebuilds the pull request
description from the PR summary file and that it must not edit the description
itself. That is false for a PR raised outside the worker: its body has no
`<!-- vibe-worker-issue-N -->` marker, and `buildSyncedPrBodyCandidate` returns
`ineligible: "no worker marker"` for it unless the head is the run's own
`issue-<N>-…` branch. The agent followed the prompt, the stale description stayed,
and the next review sent the PR back (VibeCoder#4502). The three prompts now say
the rebuild covers a worker-built description only, and that a description
written outside the worker is updated with `gh pr edit <n> --body-file <file>`
and named in `.pr_response_message`. Closes #4515.

## Spec

### Intent and Rationale

- Rewording only, as the issue proposes: the code is right (#2022 and #3804
  deliberately leave foreign bodies alone) and the prompts were wrong.
- Rendering only the applicable sentence per PR would need new processor
  plumbing; one sentence that names both cases and how to tell them apart
  (`gh pr view <n> --json body,headRefName`) covers it.

### Essential Design Decisions

- "No such marker (raised before #3315)" in `pr_feedback` now says plainly it
  means a worker-built body that has the issue marker but no digest marker, so
  it cannot be read as "any body without a marker".
- A marker-less body on the run's own `issue-<N>-…` branch is adopted by the
  worker (#3804), so the "written outside the worker" case is scoped to a
  marker-less body on any other branch.

### Undiscoverable Facts

- None.

## Evidence

Prompt and docs wording only; no UI files touched, no production code changed.
Code relied on: `worker/deno/lib/pr_body_sync.ts` (`buildSyncedPrBodyCandidate`,
the `no worker marker` and `worker marker present` branches), and
`worker/deno/tests/pr_body_sync_test.ts::sync - no worker marker: skips without editing or diffing`
which already pins the marker-less skip on a hand-raised branch.

Changed: `prompts/pr_feedback/prompt.md` (Making Changes),
`prompts/ci_fix/prompt.md` (Fixing the Failure), `prompts/merge_conflict/prompt.md`
(What To Do), and one sentence each in `docs/workflows/pr-feedback.md`,
`docs/workflows/ci-fix.md` and `docs/workflows/merge-conflicts.md`.

## Test Plan

- Added `worker/deno/tests/marker_less_body_rebuild_4515_docs_test.ts`: one test
  per prompt asserts the section names the worker marker (built from
  `WORKER_PR_MARKER_PREFIX`, not typed in), says a marker-less body "was written
  outside the worker", gives `gh pr edit <n> --body-file <file>` and
  `.pr_response_message`, and no longer carries the unconditional "do not edit
  the PR description yourself".
- Red check: with the three prompts restored to the base branch, the new file
  fails (0 passed, 3 failed); with the change it passes (3 passed).
- `deno task test:unit` on the new file, `tests/pr_body_matches_final_diff_3015_test.ts`
  and `tests/pr_body_sync_test.ts`: 52 passed, 0 failed.
- No assertion removed or edited in an existing test.
- Related rules checked: the "Keep the PR summary true to the head" paragraph in
  each of the three prompts, and `docs/workflows/` text on the digest marker and
  "only a PR the worker authored is edited"; they agree with the new wording.

`markdownlint-cli2` on the summary and the three prompts: 0 issues.

<!-- vibe-quality-gate-skipped reason="the full ./quality.sh takes longer than the 600s foreground command cap (a run on an earlier branch timed out at 580s inside the deno test stage); only targeted checks ran, CI runs the full gate" -->
