## Summary

Closes #3796. Closes #3797. Closes #3798.

The completion recovery path could arm an existing PR even when its own
pre-PR verifier still reported blocking findings. Carry that verdict through
standalone and folded summary blocks, withhold auto-merge, apply the existing
`standing-violation` label and post the surviving findings on the PR.

The feedback scan can now act on that top-level comment, including one from
its own login, when a fleet author posted the leading worker marker. The
existing fleet eyes check prevents repeat processing. A quoted marker,
inline marker or marker from an unauthorised non-fleet login grants no trust.

The verifier notice and recovery prompt require a fix or an evidence-backed
dispute. Recording a partial criterion, known gap or test not red-checked
does not settle a finding. Other recovery items retain their existing scope.

This branch includes a normal merge from `main` to bring milestone 109 up
to date; the changes described above are the issue-specific edits.

## Spec

### Intent and Rationale

- Act on defects already found by the worker before paying for another
  fleet-review round.
- Preserve the hold label recognised by the auto-merge sweep and CI-fix pass.

### Essential Design Decisions

- The marker must occupy the first line, and the author must be in the
  existing push-capable fleet set. The rest of the comment remains untrusted
  input to the repair agent.
- Feedback repairs do not release the hold or arm auto-merge. Main now
  includes independent review-fix verification from #3784; this integration
  preserves it alongside the milestone's closure-entry verification.
- A failed findings-comment post logs an error and does not arm auto-merge.
  Already-armed PRs are disarmed by the existing sweep.

### Undiscoverable Facts

- The three issues were unassigned and had no implementation PR in the live
  open-PR inventory when this work was claimed.
- Local Deno downloads needed the HTTP proxy supplied as `ALL_PROXY`;
  no repository dependency or lockfile was changed for that environment fix.

## Evidence

- Main integration after #3891: 192 focused verifier, closure, completion
  and feedback tests passed. Both closure and earlier-finding verdicts are
  retained in the shared prompt, parser and enforcement path.
- Five focused suites: 186 passed, 0 failed.
- The new tests against the unfixed production files: 166 passed, 8 failed.
  Failures included both completion hold paths, failed-comment handling,
  own/sibling hold admission and both generated guidance surfaces.
- Nine deliberate single-change breaks went red: remove the verifier hold
  term; lose the folded verdict; omit the PR comment; downgrade its error
  log; admit inline markers; remove fleet-author validation; accept a marker
  anywhere in the body; restore the blanket own-comment skip; omit hold
  comments from actionable feedback.
- Completeness checks: 687 passed, 0 failed, 1 ignored.
- Full local quality check: blocked locally, not a pass. The parallel unit
  stage stalled both normally and with `DENO_JOBS=4`; the unchanged test
  `runClaudeWithTimeout - a clean kill still settles normally with no killIncompleteSeconds (Issue #4254)`
  also exceeded a 15-second timeout alone. This host reports a process
  namespace mismatch (`ps` cannot look up itself). Type checking, lint,
  formatting, Mermaid and completeness checks passed. Optional markdownlint,
  Semgrep, configuration integration and release-tag checks were skipped.
  Keep this PR draft until the full gate passes in CI or a supported host.

**Docs sweep** — grep: `standing-violation`, `verifier`; section: `docs/workflows/issue-processing.md#-the-in-run-recovery-from-a-summary-rule-block`, `docs/workflows/pr-feedback.md#-priority-1--pr-feedback`, `docs/MERGE.md`; siblings: `trustedReviewBots`, `authorisedCommenters`; updated: `README.md`, `docs/MERGE.md`, `docs/workflows/issue-processing.md`, `docs/workflows/pr-feedback.md`. Other existing label consumers still honour the same hold label; verifier setup and execution rights are unchanged.

## Test Plan

- `completion_phase_pre_pr_verifier_3395_test.ts`: both surviving-verifier
  paths hold; a different gate with a clean verifier still arms; a failed
  comment post reports an error. The harness records the target PR/issue,
  applied labels and actual auto-merge call, with all existing assertions kept.
- `pr_maintenance_test.ts`: own and sibling holds, forged markers, fleet and
  stranger eyes, ordinary own comments, inline markers and quoted markers.
- `pre_pr_verifier_3395_test.ts` and `summary_rule_gate_retry_test.ts`: the
  rendered instructions name both valid exits and all three non-exits.
- `completion_phase_summary_incomplete_test.ts`: existing standing-violation
  and non-hold controls pass unchanged.
- No existing assertion was removed or relaxed. No UI change or performance
  claim is made.

<!-- vibe-branch-outcomes -->
