## Summary

Repeated reviews of an unchanged problem/Fix pair no longer reset the
babysitter's repair budget. The identity uses the original findings and
reviewers, while a changed ask still starts a new incident. A missing ready
marker now retains the agent's bounded, redacted explanation instead of
discarding the cause. Closes #4922.

## Spec

### Intent and Rationale

- One investigated fleet PR accumulated 38 no-change repair attempts. Eleven
  review submissions repeated the same underlying findings under new IDs.
- Reusing the earlier-finding parser removes changing verifier commentary
  from the identity while retaining the original problem and requested fix.

### Essential Design Decisions

- Reuse the existing FNV hash and durable retry machinery. Findings and
  reviewers are sorted; unfamiliar review formats remain intact. An absent
  review body retains a per-review fallback for unseen inline feedback.
- The `findings-v1` identity starts one new incident after upgrade. Existing
  version-2 records remain readable; no record fields or public contracts
  change. Branch movement and successful-push handling retain their policy.
- No-ready replies remain substantive failures. Agent text is untrusted
  evidence and cannot label its own cause, authorise a push or dismiss a
  review. Redaction precedes the 2,000-character limit.

### Undiscoverable Facts

- The inspected review-history replay produced one identical identity for
  eleven repeated review submissions. Private repository contents are not
  included in the fixtures or this summary.
- JSR is unreachable from this repair environment. Focused tests used a
  local checkout of Deno's standard library; CI must validate the locked
  dependency graph. The repository lockfile is unchanged.

## Evidence

The new orchestration regressions fail on the previous implementation:
reposting a review starts a fourth session after the cap of three, and the
missing-ready exception omits the agent's actual cause. Both pass with the fix.

Read and updated `docs/workflows/fleet-pr-babysitter.md`, the durable retry
section and the stale output-exchange recovery paragraph. Searches covered
`repairFailureIdentity`, new-review identity and no-progress wording. The
legacy `attemptKey` remains per-review intentionally, for old-file lookup.

## Reproduction

- **symptom** — a new review ID restarts an exhausted repair incident, even
  when it repeats the same finding; no-ready diagnostics lose the cause.
- **status** — verified with failing tests against the previous implementation.
- **regression test** —
  `worker/deno/tests/babysitter_fix_orchestration_test.ts::reposted review findings retain the exhausted budget; a changed Fix gets a new incident`.

## Test Plan

- 72 tests passed across `babysitter_fix_orchestration_test.ts`,
  `earlier_findings_3784_test.ts` and `babysitter_retry_state_test.ts`.
- The orchestration suite covers retry exhaustion, reposted review IDs,
  changed Fix requests, reordered reviewers, unavailable bodies, redacted
  no-ready causes, no push/dismissal, existing restart/shared-marker behaviour
  and preserved independent review verification.
- Parser coverage includes original versus wrapped findings, reordered
  findings, changed asks, unfamiliar formats and changed review summaries.
- The old test expecting every new review ID to restart a session described
  the defect. It is replaced by the repost-versus-changed-Fix regression;
  legacy attempt-file naming still has its original assertions.
- Formatting, lint and TypeScript checks passed for the changed code.
  `git diff --check` passed. No twinned implementation of
  `repairFailureIdentity` was found; both discovery and repair call it.

## Merge verification

CI and independent code review are pending. Auto-merge must still honour
the repository's required checks; this change grants no bypass.

## Not done

The complete quality gate and the locked manifest-check suite could not run
locally because their dependency resolution requires unreachable JSR.
This change does not supply missing native build capability or extend agent
command timeouts; those remain with #4770 and #4913 respectively.
