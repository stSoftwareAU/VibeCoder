# PR Summary — Issue #5375

## Summary

`gateAlreadyResolvedClose` logged a warn-level `[SECURITY]` line promising
"Handing off for human review", but since Issue #4227 a withheld
already-resolved close is retried as not finished: no `needs-human`, no person
paged. The audit line now says the close is withheld and the issue is retried
as not finished (Issue #4227), matching `gatePlanningHandoff`. The same stale
claim is corrected in the module header, three `declared_handoff.ts` comments,
and the SECURITY.md planning hand-off section. No behaviour change.
Closes #5375.

## Spec

### Intent and Rationale

- A log line must name the action the worker takes ("Log Levels Are a Promise
  About What the Reader Must Do"). An operator reading this one would wait for
  a `needs-human` label that never comes.
- This PR only rewords text. The retry behaviour from Issue #4227 is correct
  and stays as it is.

### Essential Design Decisions

- The new audit tail copies `gatePlanningHandoff`'s wording ("the issue stays
  open and is retried as not finished (Issue #4227)"), so both gates in the
  file describe the same fall-through the same way.
- SECURITY.md: the issue named one sentence (the `work-on`-only bullet). Two
  nearby statements gave the same stale answer, so they were fixed too. One is
  the "Once per issue" bullet, where a repeat request "falls back to
  `needs-human`". The other is the flowchart node `H["needs-human"]` that every
  refusal edge points at. The `work-on` bullet also now names
  `declared_handoff.ts`, where the anchor check actually lives (line ~570).
- The header paragraph saying "the other conclusions … land in front of a
  human: the analysis-only hand-off …" was also stale. It now lists the
  blocked and time deferrals and the not-finished retry.

### Undiscoverable Facts

- Quality-gate timing: the "11s" measured earlier in the run was a
  cached pass. Editing a test file invalidates the digest, so the full gate
  re-ran the whole Deno test suite (several minutes).

## Evidence

Backend and docs only; no UI file touched.

- Code read for each claim: `handle_no_changes_phase.ts` (the withheld close
  sets `closeWithheld` → `finishOrRetry` → `retryUnfinishedIssue`, or a
  usage-limit or interrupted retryable failure first; `finishOrRetry` skips
  the analysis-only close when `closeWithheld`);
  `unfinished_issue_retry.ts` (posts the "Not finished — retrying" comment
  carrying the agent's output); `declared_handoff.ts` (`fallThrough`, the
  deferral-exhausted path calling `retryUnfinishedIssue`, the
  `PLANNING_HANDOFF_ANCHOR` check).
- `docs/THREAT-MODEL.md` (R10, C31, C34) already says the run is retried, so
  it needed no change and agrees with the new SECURITY.md text.
- Grep on the head: `Handing off for human review` has no hits outside
  `docs/archive/`. `analysis-only` in `declared_handoff.ts` appears only in
  the new header wording, which says an analysis-only issue is closed with
  its analysis (Issue #4298).
- Issue numbers cited: #4227: An approved issue is never handed back: a run
  that delivers nothing is retried, not labelled needs-human as
  'analysis-only'; #4298: Issue lane hands approved issues back to a human;
  #1385: Suspicious-image prompt-injection detection has no independent
  code-level backstop.

## Test Plan

- `worker/deno/tests/image_conclusion_gate_test.ts` — the existing test "image
  conclusion gate - an untrusted image withholds the already-resolved close"
  keeps all its assertions. It gains two more: the audit message contains
  "retried as not finished" and does not contain "human review". Against the
  unfixed message the test failed ("Expected actual … Handing off for human
  review instead — the issue stays open. to contain: retried as not
  finished"). After the fix all 10 tests in the file pass.
- No existing assertion removed.
- `./quality.sh < /dev/null` on the head: PASSED (config integration and
  checkov skipped as usual; deno tests, lint, type check, fmt, mermaid and
  markdownlint passed).

## Not done / not checked

- No standalone mermaid render of the edited SECURITY.md flowchart. The
  gate's mermaid and markdownlint stages ran over it and passed.
- Rules checked for overlap: CODING-STANDARDS.md "Log Levels Are a Promise
  About What the Reader Must Do". No prompt or standard rule was added or
  changed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
