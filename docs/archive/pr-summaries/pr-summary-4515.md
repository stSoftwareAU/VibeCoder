## Summary

The fix-run prompts told the agent that the worker rebuilds the pull request
description from the PR summary file and that it must not edit the description
itself. That is false for a PR raised outside the worker: its body has no
`<!-- vibe-worker-issue-N -->` marker, and `buildSyncedPrBodyCandidate` returns
`ineligible: "no worker marker"` for it unless the head is the run's own
`issue-<N>-…` branch. The agent followed the prompt, the stale description
stayed, and the next review sent the PR back (VibeCoder#4502). The three prompts
now say the rebuild covers a worker-built description only, and that a
description written outside the worker is updated with
`gh pr edit <n> --body-file <file>` and named in `.pr_response_message`.
Closes #4515.

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
`prompts/ci_fix/prompt.md` (Fixing the Failure and Dependency audit failures),
`prompts/merge_conflict/prompt.md` (What To Do), and one sentence each in
`docs/workflows/pr-feedback.md`, `docs/workflows/ci-fix.md` and
`docs/workflows/merge-conflicts.md`.

## Test Plan

- `worker/deno/tests/marker_less_body_rebuild_4515_docs_test.ts` (4 tests):
  each prompt section names the worker marker from `WORKER_PR_MARKER_PREFIX`,
  describes the outside-worker body and edit command, and requires the reporting
  clause built from `PR_RESPONSE_MESSAGE_FILE`. It rejects the old ban. The
  dependency-audit section also requires the marker-scoped rebuild and live
  body update for its tracking issue; it is excluded from the main ci_fix
  section check so it cannot satisfy that check's pins. The pr_feedback test
  also distinguishes the worker-built body without a digest marker.
- The head test file passes (4 passed, 0 failed); with the three prompts
  restored from `main`, it fails (0 passed, 4 failed).
- `deno task drift-pins-on-base` confirmed every required phrase is absent from
  each corresponding section on `main`.
- Changing `PR_RESPONSE_MESSAGE_FILE` at its source made all four tests fail
  on the missing reporting clause; the source was restored afterwards.
- Changing `WORKER_PR_MARKER_PREFIX` at its source made all four tests fail
  on the missing marker; the source was restored afterwards.
- Removing the `gh pr edit` clause from the main ci_fix guidance made its test
  fail (3 passed, 1 failed); the prompt was restored afterwards.
- Restoring the base wording for the pre-#3315 digest case made the pr_feedback
  test fail (3 passed, 1 failed); the prompt was restored afterwards.
- No assertion removed or edited in an existing test.
- Related rules checked: the "Keep the PR summary true to the head" paragraph in
  each of the three prompts, and `docs/workflows/` text on the digest marker and
  "only a PR the worker authored is edited"; they agree with the new wording.

`markdownlint-cli2` on the summary: 0 issues.

<!-- vibe-quality-gate-skipped reason="the full ./quality.sh failed in the Deno test stage; a separate unit run reproduced a Deno 2.9.0 parallel test permissions panic. Semgrep and Checkov were unavailable locally; CI runs the full gate" -->
