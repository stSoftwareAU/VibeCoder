## Summary

Complete trusted owner-gate collection and exception reporting in the existing
PR completion report. Actual fleet review posts now write hash-chained action
provenance. The collector verifies current owner-only holds separately from
generic `needs-human` labels, and reports their reasons alongside regressions.

The explicit `--human-actor-id` allowlist identifies unmatched GitHub review,
dismissal and merge actors. Eligible verified fleet actions take precedence over
closer unchained review logs. Commit author metadata remains unknown; it cannot
establish who performed implementation or repair.

Part of #4658.

## Spec

### Intent and Rationale

- Generic `needs-human` labels must not improve completion figures by removing
  stalled PRs from eligibility or rollout discovery.
- A genuine owner exception needs current reviewer-contract evidence and
  verified action provenance; a label, login or unchained log is insufficient.
- Git author metadata survives automated cherry-picks and cannot authenticate
  human repair. The report still recognises recorded trusted human actions.

### Essential Design Decisions

- The reviewer post producer uses the existing CLI runner and canonical audit
  writer. Export `<reviewer-state>/audit` with the other `--audit-dir` sources;
  failed posts retain failed evidence, and append refusals are reported.
- Current owner gates require an open labelled PR, complete review history, the
  latest submitted review on its current head carrying the canonical COMMENTED
  owner hold, and a matching verified reviewer action. Generic, stale,
  superseded, legacy and log-only evidence stays unverified.
- The hold policy and body contract are shared with the review writer. New
  snapshot evidence and exception rows are additive; old verified-owner
  snapshots remain readable without fabricated detailed evidence.
- Matching ranks eligible verified fleet actions before timestamp proximity.
  Human-ID promotion cannot overwrite an already verified action, including an
  audit run whose ID happens to be `review-log`.

### Undiscoverable Facts

- Both attribution defects reproduced before the fix through the collector and
  CLI collection seam: each incorrectly reported one human-assisted merge. Their
  regression tests now report zero for the same cases.
- No live fleet cohort or post-rollout measurement was collected. There is no
  claimed baseline or achieved 90% operational target.

## Evidence

Read the **PR completion evidence report** section in `docs/INTERNALS.md` and
updated it for actor trust, reviewer audit exports, owner-gate verification and
exception reporting. Updated the reviewer skill's posting documentation in
`.claude/skills/review-fleet-prs/SKILL.md`. Registered both new helper modules
in the existing #4658 library sweep slice.

The real posting boundary is exercised by
`worker/deno/tests/pr_completion_snapshot_test.ts::collect - actual reviewer posting journals genuine owner holds and preserves failed posts`:
the canonical review body is posted through an injected CLI seam, the real audit
writer records the attempt, and the collector verifies the resulting chain. Only
the successful post verifies a gate. The test also checks formatted exception
output. This backend change needs no visual evidence.

The closer-log regression uses a GitHub review and log at 01:00:00 and a
verified fleet action at 01:00:05. The authenticated fleet match wins and is not
promoted to human. The automated-commit regression retains an allowlisted
maintainer as author on an unsigned commit; its repair remains unknown. Both
scenarios also run through `runPrCompletionCollect`, covering the collector
result consumed by command dispatch and its existing callers.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Verify genuine owner gates separately from generic needs-human
  labels. — evidence:
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - genuine owner gates need a current verified reviewer hold, never a generic label`;
  `::collect - actual reviewer posting journals genuine owner holds and preserves failed posts`;
  `::collect - owner gates preserve incomplete provenance and historical rollout eligibility`
  — reviewer: met
- **met** — Report genuine owner-only exceptions and regressions alongside it. —
  evidence:
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - reports genuine owner-only exceptions with provenance alongside regressions`;
  actual posting test checks formatted output — reviewer: met
- **missing** — Complete blocker accounting for recovery and refresh waits
  using the records from #4656 and #4613; these are not yet represented as
  blocker intervals.
- **missing** — Journal the reviewer's branch refresh through the canonical
  audit writer as a branch-update, so its resulting merge commit has trusted
  provenance.

The independent Spec reviewer reviewed the changed diff and issue body,
confirmed both criteria met, and independently ran the 136 focused tests.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Independent Standards review checked Deno placement, canonical
  audit and hold-policy reuse, additive legacy compatibility, conservative
  attribution, meaningful test replacement and operator documentation; no new
  dependency, duplicated policy, unnecessary abstraction or reinvented
  standard-library operation was found.

The former author-based human-repair assertion was intentionally replaced:
self-set authorship is not authenticated action provenance. The replacement
collector and CLI tests fail with the old promotion. Recorded human repair
followed by a fleet merge remains covered by
`worker/deno/tests/pr_completion_report_test.ts::PR completion report deduplicates repeated observations and separates trusted outcomes`.

Generic needs-human labels no longer exclude PRs from rollout eligibility;
verified owner holds at verification remain excluded. The updated coverage is
`worker/deno/tests/pr_completion_snapshot_test.ts::collect - the rollout check counts stranded, rediscovered and processed PRs by verified time`
and `::collect - the rollout check strands only PRs open at verification and at least a day old`.

## Test Plan

- A verified review matched to GitHub supersedes one matching legacy log row;
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a matched fleet review supersedes its review log without double counting`
  covers both unattended completion and review rounds. Unmatched logs remain
  covered by `::collect - an unchained review log cannot verify a PR's history`.
  Owner exception and historical rollout tests use distinct review and audit
  timestamps, including a pair straddling the verification instant.
- Review matching reserves a matched reviewer post's duplicate log before
  matching other GitHub events. The previous late removal could erase another
  review's attribution; unmatched reviews remain unknown or explicitly human.
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a second review remains attributed when a fleet log is duplicated`
  covers both outcomes, and
  `::collect - a non-reviewer audit action cannot supersede a review log` covers
  the component boundary. No parallel matching rule was found.

- Reviews, dismissals and merges pair with verified actions one-to-one by
  nearest gap (trusted first), not event order.
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a nearer review takes the fleet action; an earlier allowlisted review stays a human action`
  puts an allowlisted COMMENTED review five minutes before the fleet hold on
  the same head (open and merged variants): the gate verifies, the earlier
  review is a verified human action and `humanAssistedMerged` is 1. It failed
  (`merged=false`) against the previous event-order pairing and passes now.
- `deno task test:unit tests/pr_completion_snapshot_test.ts tests/pr_completion_report_command_test.ts tests/pr_completion_report_test.ts < /dev/null`
  — passed, 141 tests after the review fix. Covers genuine and generic gates, owner exceptions with
  regressions, real posting provenance, failed posts, stale and superseded
  holds, legacy snapshots, truncated evidence and historical rollout timing.
- Reviewer posting, test-policy and Dependabot suites — passed, 82 tests; after
  moving the producer into the worker library, posting and hold-policy suites
  passed again, 66 tests, including granular-permission posting.
- Owner verification and exception tests failed before implementation; the
  actual-posting test failed before the producer wrote audit evidence.
- Deleting dismissal `actorId` forwarding (the original line 743 mutant) made
  `::collect - configured numeric GitHub actors identify unmatched reviews, dismissals and merges`
  fail. Restored code passes.
- The original line 850 and 864 null guards were semantically redundant:
  validated allowlists contain only numeric strings and cannot contain null.
  Removed both guards instead of retaining dead conditions or claiming an
  exemption.
  `::collect - null GitHub actors stay unknown with and without a review-log match`
  verifies null identities on both matching paths, dismissals and merges.
- Removing verified-fleet priority made both closer-log tests fail. Removing the
  verified-action promotion guard made the `review-log` run-ID collision test
  fail. Restored code passes.
- Removing the reviewer-footer guard made the isolated missing-footer owner
  matrix case fail. Restored code passes.
- Changed TypeScript formatting, lint and type checks — passed. Library sweep
  coverage — passed, 39 tests after registering the new helper modules.
- `./quality.sh < /dev/null` — failed its unit-test time budget on unchanged
  `worker/deno/tests/launcher_harness_reclaim_stub_test.ts` (2 tests, 3.44s;
  limit 1s). Both parallel and serial repository-wide test passes succeeded.
  Completeness, security scans, Markdown checks, lint, type checking and
  formatting passed. Configuration integration and Checkov were skipped because
  their required local configuration/tooling was unavailable.
- `pr-summary-check` with the issue body and labels supplied — zero blocked
  gates and zero unchecked gates; independent review provenance passed.
- Rule copies checked: hold policy markers/parser and fixed hold-body headers
  now share `fleet_review_hold.ts` between writer and collector. Actor-ID
  validation shares `ACTOR_ID_PATTERN` between collector and CLI. No prompt
  policy or parallel gate implementation was changed.

## Merge verification

The worker re-runs its quality gate and pre-PR verifier before raising the PR.
The local full gate's outstanding result is the unchanged launcher timing budget
failure described above. Live deployment, the two-week operational measurement,
configuration integration and Checkov were not verified here; exported reviewer
audit evidence is required for live owner verification.
