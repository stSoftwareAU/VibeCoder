## Summary

The worker commits `bump-deps.sh` output after the agent has written the
summary, and the PR body never mentioned it, so a summary line such as "no
dependency changed" was false at the head. An `applied` bump now adds a one-line
note to the PR body, a resync of the body keeps it, and the coding-guidelines
prompt says when the bump runs. Closes #4570.

## Spec

### Intent and Rationale

- The turn that writes the initial summary cannot see the later bump commit, so
  the fix is a worker-written PR-body note beside the existing milestone skip
  note, not a new summary obligation or gate. Later turns can see the commit.
- The coding-guidelines paragraph (`prompts/coding_guidelines/prompt.md`, "The
  bump and the substantive change land in the same PR") now states that the bump
  runs after the initial summary-writing turn and before `./quality.sh`, and
  that its commit is part of the PR. The PR body notes it, so the summary must
  not claim no dependency, lockfile or version changed beyond the agent's own
  change.

### Essential Design Decisions

- `buildBumpSkipNote` is unchanged (it stays empty for `applied`); a sibling
  `buildBumpAppliedNote` builds the new note, so the milestone note keeps its
  contract.
- The note follows the final `bumpInfo.status`: a bump the audit reverted is
  `rejected_by_audit` and gets none.
- Resync (`extractBumpNotes` in `pr_body_sync.ts`) reads the applied note only
  where the worker writes it: a line opening with the note prefix, then a
  newline and the footer rule. A summary quoting the prefix elsewhere is not
  carried over.
- Paths in the note are stripped of control characters and backticks and capped
  at 8 (then "and N more"), so the note is always one line.
- PR #4596 (#4522) merged first. This PR resolved the guidelines conflict in
  `7b720f1` and `fa06857f`, retaining the #4522 bump-commit wording.

### Undiscoverable Facts

- None.

## Evidence

Backend/prompt change, no UI. Code: `worker/deno/lib/bump_deps.ts`
(`buildBumpAppliedNote`, `APPLIED_BUMP_NOTE_PREFIX`),
`worker/deno/lib/phases/completion_phase.ts` (appended beside
`buildBumpSkipNote`), `worker/deno/lib/pr_body_sync.ts` (`extractBumpNotes`),
`prompts/coding_guidelines/prompt.md`. Docs: `docs/INTERNALS.md` (Phase 3.5
paragraph), `docs/TROUBLESHOOTING.md` (new row after the milestone-skip row).
Sibling grep for the existing skip note (`MILESTONE_CHILD_BUMP_NOTE`,
`skipped_milestone_child`) found no other doc describing the PR-body bump note.

Fixture layout taken from the existing carry-over test and `buildWorkerFooter`
in `worker/deno/lib/worker_identity.ts` (`\n---\n\n🤖 Processed by: …`).

Issue numbers cited: #4570 (this issue), #1775 (milestone skip note, existing),
#4522 / PR #4596 (related, same guidelines sentence).

## Test Plan

- `worker/deno/tests/bump_deps_test.ts`: `buildBumpAppliedNote` tests (sha and
  files, no sha, truncation, newline/backtick path, empty for every other status
  including `rejected_by_audit` and `undefined`), plus `buildBumpSkipNote` stays
  empty for `applied`.
- `worker/deno/tests/completion_phase_bump_comment_test.ts`: PR body carries the
  note directly before the footer for an `applied` bump; carries none after
  `rejected_by_audit`.
- `worker/deno/tests/pr_body_sync_test.ts`: resync keeps the applied note; a
  summary quoting the prefix (mid-sentence, and at a line start without the
  footer rule) is not carried over.
- Result: `deno task test:unit` on those three files: 86 passed, 0 failed.
- Review fix: the completion and guidelines drift test files passed (10 tests).
  The full local gate's parallel Deno test pass panicked while restoring test
  permissions; the focused tests passed, and CI remains authoritative.
- Red checks (each break made alone, then restored): drop the footer-rule
  lookahead in `extractBumpNotes` → `pr_body_sync_test.ts` red (1 failed); drop
  the match loop so nothing is carried over → red (1 failed); remove the
  `buildBumpAppliedNote` call in `completion_phase.ts` →
  `completion_phase_bump_comment_test.ts` red (1 failed).
- Entry points checked: completion-phase PR creation (`completionBody`) and
  PR-body resync (`buildSyncedPrBodyCandidate`); both covered by a test above.
  The completion test now also checks the note's position; no assertion removed.
- Existing text re-read: the milestone skip note and `rejected_*` comments are
  unchanged and still true. `worker/deno/tests/pr_review_brief_own_bump_4522_test.ts`
  pins the reworded guidelines sentence and passes at the head (2 tests passed).
- `deno fmt --check` on `docs/INTERNALS.md`, `docs/TROUBLESHOOTING.md` and
  `prompts/coding_guidelines/prompt.md` already fails on the base copies; not
  reformatted.

<!-- vibe-quality-gate-skipped reason="./quality.sh did not finish within its 600s foreground limit in this run; CI runs the same checks on the PR" -->

Not checked: the full quality gate; the 14-day send-back count in the issue's
Verification section (it needs the fleet `log.jsonl` after this lands).
