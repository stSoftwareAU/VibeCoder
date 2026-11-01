# A human-gated PR is labelled needs-human and every lane stops

## Summary

Closes #4614

Owner rule (2026-11-01): when a CI check declares a human gate (a
`vibe-human-gate:` line), label the PR `needs-human` and stop.

Before this change the CI-fix lane parked only the gated check, with one
comment and no label. Issue #2727 left the label off deliberately so that the
conflict scan would keep maintaining the PR. Every other lane kept working it:
base merges, conflict resolution, CI fixes on other checks, branch updates and
babysitter repairs. Each of those reran the full CI on a PR that could not
merge until a person acted. On a private repository, a PR whose
`bootstrap-applied` check waits for an AWS SSO deploy was announced as
human-gated at 23:15 and still got a merge-conflict run at 23:56.

Now:

- The human-gate park labels the PR `needs-human`, and re-asserts the label on
  every pass while the gate fails.
- `listActionablePrs` drops `needs-human` PRs, which stops the CI-fix,
  review-feedback and auto-merge scans. The conflict scan already skipped
  them. The bot-PR listing now carries labels through so that it is covered
  too.
- The auto-merge sweep requests no branch update for a `needs-human` PR.
- The fleet PR babysitter never treats a `needs-human` PR as a candidate.
- Stall repair never lifts a `needs-human` that has a fleet human-gate marker
  behind it.

The person takes the step, re-runs the check and removes the label; the lanes
then resume.

## Spec

### Intent and Rationale

- A PR waiting on a person cannot merge, so any fleet push to it only spends
  a paid CI run. Stopping every lane removes that spend.

### Essential Design Decisions

- One filter in `listActionablePrs` rather than one per lane, so a lane added
  later inherits the hold.
- The label is re-applied on every pass while the gate fails, so removing it
  without taking the step does not restart the lanes.
- Stall repair recognises the hold by the fleet-authored
  `vibe-ci-human-gate` marker, the same way it already keeps the
  credential-rotation hold.

### Undiscoverable Facts

- The owner reversed the Issue #2727 decision (no label, keep the conflict
  scan maintaining the PR) on 2026-11-01 after seeing the spend on human-gated
  PRs.

## Evidence

Manual read: `docs/workflows/ci-fix.md` (human gate) and
`docs/workflows/fleet-pr-babysitter.md`; both updated. Visual evidence is not
applicable; this is a background service with no UI.

Each new behaviour was written as a test first and seen failing:

- `pr_ci_processor_human_gate_test.ts`: the gate adds `needs-human` and no
  other label. The existing label assertions now pin the hold instead of no
  label.
- `pr_maintenance_bot_prs_test.ts`: a `needs-human` PR is admitted by no lane.
- `auto_merge_sweep_test.ts`: an armed, behind, `needs-human` PR gets no
  branch update.
- `fleet_pr_babysitter_test.ts`: a `needs-human` PR is never a candidate.
- `stall_repair_test.ts`: a human-gate hold is left alone, even after ten
  stall thresholds.

Results:

- All PR-lane test files (pr_maintenance, pr_ci_processor, stall_repair,
  auto_merge, fleet_pr_babysitter, pr_bot, pr_merge_conflict, pr_feedback,
  blocking_pr): 1005 passed, 0 failed.
- `deno task check:manifests`: passed.

## Test Plan

- Modified: the five test files above.
- Wide suite: CI.

## Merge verification

- CI: not yet verified (pending on this PR).
