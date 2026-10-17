## Summary

Closes #3865. Builds on the hold/repair path in milestone integration PR #3890.

A manual or prompt sentence already confirmed wrong now gets one narrow
correction turn when the claim check is the only earlier summary gate still
blocking. The model returns indexed replacement strings; the worker replaces
only the uniquely located flagged spans. A surviving manual finding holds the
PR and posts the findings for repair, including when another gate also blocks.

## Spec

### Intent and Rationale

Use the exact sentence and code evidence the worker already has to avoid a
full review round rediscovering the same wrong manual claim.

### Essential Design Decisions

- Preserve the existing summary-only reply protocol. When manual findings
  are present, use indexed replacements for all flagged sentences in that
  block, including summary findings. The model cannot choose output paths.
- Locate spans with `sentenceFoundIn` and the same whitespace-normalised
  matching rule. Reject missing, ambiguous or overlapping spans, incomplete
  or duplicate index inventories, unsafe paths and symlink aliases. Preserve
  bytes outside the flagged spans.
- Keep file-writing tools and Bash denied. Read source content again before
  writing so a concurrent change is not overwritten from an old snapshot.
- Commit corrected files and run quality checks before re-running completion.
  The correction remains bounded to one turn. Unchanged confirmed manual
  findings survive a flaky recheck; an unreadable file does not clear them.
- Include surviving manual findings in the existing auto-merge hold and
  standing-violation label path. Post the findings with the existing repair
  marker so the worker's own PR-feedback scan can act on them.

### Undiscoverable Facts

The prerequisite integration PR had routing-file conflicts with main. Those
were resolved separately on #3890 by retaining main's newer routing-decision
error context, routing allowlist and regression tests. This PR contains the
manual-claim change, not a second implementation of those routing fixes.

## Evidence

- Focused correction and completion caller suites: 134 passed, zero failed.

- The new completion test failed before implementation: a late manual finding
  received no correction turn and the run failed instead of correcting it.
- Twenty-two deliberate changes to the new enforcement logic made their
  named tests fail; details are in the adjacent branch-outcome facts file.
- Full local `./quality.sh </dev/null` did not complete and is not a pass.
  Completeness, formatting, lint, Mermaid, source-target and the early
  chokepoint checks passed before the run stalled. Configuration integration,
  markdownlint, Semgrep and release-tag checks were skipped locally. Full CI
  remains required before this PR is ready to merge.

**Docs sweep** — grep: `summary-only correction`, `docFindings`, `summary_incomplete`, `holdAutoMerge`; section: `docs/workflows/issue-processing.md` (summary claim checks and recovery), `docs/INTERNALS.md` (module map); siblings: `findings`, `verifierHoldComment`, `standingViolations`; updated: those two manuals and the correction/completion module comments, including the flow diagrams and later-block restatements.

## Test Plan

- Pure correction tests pin whitespace-aware exact replacements, unchanged
  surrounding bytes, inventory errors, duplicate and unknown indices,
  ambiguity, overlap, reply caps, unsafe paths and symlink rejection.
- Carry-forward tests cover unchanged, changed, unreadable and duplicate
  findings, including identical text in different files.
- Completion tests cover a late manual-only block corrected successfully,
  surviving manual findings, mixed gate blocks, a flaky recheck, and a timed-out
  correction reply. They assert actual manual text, commits, the hold label,
  repair comments and the absence of auto-merge arming.
- Existing summary-only correction, summary claim-check, summary-incomplete
  and pre-PR verifier tests remain in the caller run. The two previous tests
  asserting that manual findings never get the correction turn now assert
  the new behaviour; their other assertions remain in place.
- Existing helpers remain the owners of sentence matching, regex escaping,
  prompt boundaries, read-only tool restrictions, recovery commits and PR
  holds. No new module, dependency or model pass outside the bounded
  correction path is introduced.

<!-- vibe-branch-outcomes -->
