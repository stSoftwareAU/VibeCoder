## Summary

The worker commits `bump-deps.sh` output after the agent has written the
summary, and the PR body never mentioned it, so a summary line such as "no
dependency changed" was false at the head. An `applied` bump now adds a
one-line note to the PR body, a resync of the body keeps it, and the
coding-guidelines prompt says when the bump runs. Closes #4570.

## Spec

### Intent and Rationale

- The agent cannot see the bump commit, so the fix is a worker-written PR-body note beside the existing milestone skip note, not a new summary obligation or gate.
- The coding-guidelines sentence ended in a dangling "see."; it now states that the bump runs after the agent's turn, is committed to the PR, and is noted in the PR body.

### Essential Design Decisions

- `buildBumpSkipNote` is unchanged (it stays empty for `applied`); a sibling `buildBumpAppliedNote` builds the new note, so the milestone note keeps its contract.
- The note follows the final `bumpInfo.status`: a bump the audit reverted is `rejected_by_audit` and gets none.
- Resync (`extractBumpNotes` in `pr_body_sync.ts`) reads the applied note only where the worker writes it: a line opening with the note prefix, then a newline and the footer rule. A summary quoting the prefix elsewhere is not carried over.
- Paths in the note are stripped of control characters and backticks and capped at 8 (then "and N more"), so the note is always one line.
- Assumption: PR #4596 (#4522) edits the same guidelines sentence; whichever lands second resolves a small textual conflict there.

### Undiscoverable Facts

- None.

## Evidence

Backend/prompt change, no UI. Code: `worker/deno/lib/bump_deps.ts` (`buildBumpAppliedNote`, `APPLIED_BUMP_NOTE_PREFIX`), `worker/deno/lib/phases/completion_phase.ts` (appended beside `buildBumpSkipNote`), `worker/deno/lib/pr_body_sync.ts` (`extractBumpNotes`), `prompts/coding_guidelines/prompt.md`. Docs: `docs/INTERNALS.md` (Phase 3.5 paragraph), `docs/TROUBLESHOOTING.md` (new row after the milestone-skip row). Sibling grep for the existing skip note (`MILESTONE_CHILD_BUMP_NOTE`, `skipped_milestone_child`) found no other doc describing the PR-body bump note.

Fixture layout taken from the existing carry-over test and `buildWorkerFooter` in `worker/deno/lib/worker_identity.ts` (`\n---\n\n🤖 Processed by: …`).

Issue numbers cited: #4570 (this issue), #1775 (milestone skip note, existing), #4522 / PR #4596 (related, same guidelines sentence).

## Test Plan

- `worker/deno/tests/bump_deps_test.ts`: `buildBumpAppliedNote` tests (sha and files, no sha, truncation, newline/backtick path, empty for every other status including `rejected_by_audit` and `undefined`), plus `buildBumpSkipNote` stays empty for `applied`.
- `worker/deno/tests/completion_phase_bump_comment_test.ts`: PR body carries the note for an `applied` bump; carries none after `rejected_by_audit`.
- `worker/deno/tests/pr_body_sync_test.ts`: resync keeps the applied note; a summary quoting the prefix (mid-sentence, and at a line start without the footer rule) is not carried over.
- Result: `deno task test:unit` on those three files: 86 passed, 0 failed.
- Red checks (each break made alone, then restored): drop the footer-rule lookahead in `extractBumpNotes` → `pr_body_sync_test.ts` red (1 failed); drop the match loop so nothing is carried over → red (1 failed); remove the `buildBumpAppliedNote` call in `completion_phase.ts` → `completion_phase_bump_comment_test.ts` red (1 failed).
- Entry points checked: completion-phase PR creation (`completionBody`) and PR-body resync (`buildSyncedPrBodyCandidate`); both covered by a test above. No existing test edited; no assertion removed.
- Existing text re-read: the milestone skip note and `rejected_*` comments are unchanged and still true; no guideline-pinning test exists for the old sentence.
- `deno fmt --check` on `docs/INTERNALS.md`, `docs/TROUBLESHOOTING.md` and `prompts/coding_guidelines/prompt.md` already fails on the base copies; not reformatted.

<!-- vibe-quality-gate-skipped reason="./quality.sh did not finish within its 600s foreground limit in this run; CI runs the same checks on the PR" -->

Not checked: the full quality gate; the 14-day send-back count in the issue's Verification section (it needs the fleet `log.jsonl` after this lands).
