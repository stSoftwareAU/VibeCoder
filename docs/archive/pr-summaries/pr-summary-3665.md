## Summary

`preserveRunWip` no longer ends its release-comment `wipNote` with a fixed VibeCoder citation (`(Issue #47)` or `(Issue #4170)`). The note is posted on the issue being worked, which can be in any target repo, and there a bare `#47` links to an unrelated issue. All four variants now read the same as before minus the suffix: pushed, checkpoint-only, already checkpointed and preservation failed. Provenance moves to doc comments. Closes #3665.

## Spec

### Intent and Rationale

- Same defect class as the commit-subject fixes (#3345, #3338, #3499), this time in the release-comment detail and the superseded pointer that quotes it.
- Dropping the suffix is enough: `describesPreservedWip` matches only on the `WIP preserved:` marker, so nothing reads the citation.

### Essential Design Decisions

- The `WIP preserved:` marker and the rest of each sentence are unchanged, so classifiers and existing release-comment tests keep matching.
- The provenance note on the `PreservedRunWip.wipNote` field doc tells a later editor why the note carries no issue number.

### Undiscoverable Facts

- `gh issue view 4170` does not resolve in stSoftwareAU/VibeCoder, so the new doc comment cites `wip_checkpoint.ts` and #3665, not #4170.

## Evidence

Backend-only change. The new test `worker/deno/tests/run_wip_preservation_note_test.ts` runs each `wipNote` variant through the real `preserveRunWip`, with git mocked through `createMockDeps`.

**Docs sweep** — grep: "resumes from that branch", "WIP already checkpointed", "remains only in the local clone", `(Issue #47)`, `(Issue #4170)` over `README.md`, `docs/` (excluding `docs/archive/`) and `*/README.md`; section: none — no manual documents the wipNote wording; siblings: none — no existing set gained a member; updated: the doc comments on `PreservedRunWip.wipNote` and `describeCheckpointCommits` in `worker/deno/lib/phases/run_wip_preservation.ts`; no doc hits. Test fixtures that quote the old suffixed wording, such as `worker/deno/tests/wip_resume_handoff_test.ts:28` and `worker/deno/tests/run_outcome_classifier_test.ts:389`, are left in place. They are still valid because they feed the classifiers literal historical reasons, and those match on the marker, not the suffix.

Issue numbers added as provenance: #3665: Preserved-WIP notes in the claim-release comment cite fixed VibeCoder issue numbers (#47, #4170) on target-repo issues.

## Test Plan

- Added `worker/deno/tests/run_wip_preservation_note_test.ts`, with four tests, one per variant: dirty tree pushed, clean tree with 2 checkpoint commits, dirty tree already checkpointed, and failed push. Each asserts the variant's wording and that the note does not match `/#\d/`. As a positive control, the first three also assert the branch name and the failed variant asserts the failure reason.
- Red run against the unfixed production code, before the edit: 0 passed, 4 failed. Each failure quoted the note ending `(Issue #47)` or `(Issue #4170)`. Green after the fix: 4 passed.
- `deno task test:unit` over the new test plus `execute_phase_superseded_wip_test.ts`, `completion_phase_superseded_wip_test.ts`, `preserved_branch_release_comment_test.ts`, `wip_resume_handoff_test.ts`, `run_outcome_classifier_test.ts`, `heartbeat_outcome_render_test.ts`, `completion_wip_only_gate_test.ts` and `wip_checkpoint_test.ts`, all under `worker/deno/tests/`: 89 passed, 0 failed. `deno fmt --check`, `deno lint` and `deno check` on both changed files are clean.
- `./quality.sh`: QUALITY_RESULT_LINE
- No existing test was edited, and no assertion was removed.

<!-- vibe-branch-outcomes -->

Not done or not checked: none. The four strings, their doc comments and the new test are the whole change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
