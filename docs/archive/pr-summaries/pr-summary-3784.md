## Summary

Closes #3784.

Review-fix rounds now independently verify the complete earlier problem/Fix
pairs before the worker pushes. Each numbered finding needs exactly one
`fixed` verdict with evidence. Missing, duplicate, partial and unresolved
verdicts become blockers even when the model returns an empty findings list.

## Spec

### Intent and Rationale

Avoid another full review round discovering that a fix answered only part of
an earlier finding. Reuse the disposable pre-PR verifier and shared fleet
review brief; make the worker enforce the verdict inventory.

### Essential Design Decisions

- Apply the gate to authorised change-requesting reviews (`pr_review`).
  Ordinary inline and issue comments retain their existing flow.
- Verify after the final commit, formatter and pre-flight gate, so the
  disposable checkout contains the edits being pushed. A push-recovery merge
  requires another verdict before its retry push.
- Preserve full review bodies rather than the feedback prompt's truncated
  version. Keep problem/Fix pairs together; unfamiliar review formats stay
  whole. A rebuttal is evidence to check independently, not an automatic pass.
- Allow one verifier correction turn. A remaining block or unavailable
  verifier leaves the review outstanding, charges a failed attempt, and
  attempts both the standing-violation label and auto-merge disable operation.
- Apply no-push instructions and tool denials to all agent calls in the
  review round, including drift and correction calls. These are runner
  restrictions, not a network sandbox.
- The fleet post command requires the gate's earlier-findings inventory and
  applies the same verdict check. Older replies without this optional array
  still parse; they cannot clear an inventory containing earlier findings.

### Undiscoverable Facts

The issue was unassigned and had no implementation PR when claimed. Its
`review-fix-partial` pattern is the intended throughput measure; this PR does
not claim a measured reduction in fleet rejections yet.

## Evidence

- Focused verifier, settlement, real-Git push/recovery and fleet-post suites:
  126 passed, zero failed.
- Twenty-three deliberate changes to the new enforcement logic each made the
  named test fail. The adjacent facts file records the changes and tests.
- Broader caller run initially passed 540 tests and found one stale end-to-end
  fixture without the now-required earlier-findings inventory. Added the empty
  inventory to that fixture; its original assertions are unchanged. Final
  broader run: 544 passed, zero failed.
- Repository completeness checks: 687 passed, zero failed, one ignored.
- Full local `./quality.sh </dev/null` did not complete and is not a pass.
  Formatting, lint, Mermaid and source-target checks passed before the run
  stalled. Full CI is required before this PR is marked ready.

**Docs sweep** — grep: `pr_review`, `PREVIOUS_FINDINGS`, `pre-PR verifier`, `commitAndPushPending`; section: `docs/INTERNALS.md` (PR feedback processing); siblings: `checklist`, `testChanges`; updated: `docs/INTERNALS.md`, the shared review brief, and the fleet review skill's earlier-findings instructions.

## Test Plan

- `earlier_findings_3784_test.ts`: preserve full asks, reject malformed
  verdicts, match indices, and require exactly one fixed verdict per finding.
- `pr_feedback_verifier_3784_test.ts`: pass complete review and rebuttal
  evidence without consuming the reply; fail closed on unavailable or
  blocking verification and malformed PR metadata.
- `pre_pr_verifier_3395_test.ts`: run the real disposable verifier with
  earlier findings, including omitted and partial verdicts.
- `pr_feedback_review_dismissal_3383_test.ts`: recovery clears before push;
  persistent failures do not push or dismiss; ordinary comments are unchanged.
  A pre-flight failure before verification cannot accept a rebuttal as resolved.
  The four targeted review-fix tests pass after this final guard was added.
- `git_push_preflight_test.ts`: real repositories prove the verifier sees
  committed edits and blocks both a direct push and an unchecked recovery merge.
- `review_fleet_prs_checklists_3594_test.ts`: fleet posting cannot approve
  missing or unresolved verdicts, or a missing earlier-findings inventory.
- Shared Git callers inspected: CI, spelling, feedback, merge-conflict,
  completion, declared hand-off, WIP preservation/checkpoints, screenshot and
  summary-rule retries, and push-recovery retries. The new callback is optional;
  callers outside review feedback omit it. Existing Git recovery and feedback
  suites exercise that compatibility.
- New module security review: earlier review and rebuttal text remain data
  inside the existing prompt boundaries; the verifier keeps its disposable,
  remote-less checkout. No new shell command interpolation or network-write
  capability was introduced. Both modules are registered in the sweep ledger.

<!-- vibe-branch-outcomes -->
