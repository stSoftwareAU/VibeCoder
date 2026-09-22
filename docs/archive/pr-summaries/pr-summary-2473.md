# Closes #2473

## Summary

Escalate unclaimable blocking dependencies instead of silently freezing work-on issues. When a `work-on` issue is blocked by a dependency that carries an unclaimable state (needs-human label, assigned to non-fleet author, or blocked by merged PR), the worker now detects this stall and escalates the dependent issue with `needs-human` + explanatory comment, rather than waiting indefinitely.

## Implementation

### New file: `dependency_claimability.ts`
Introduces `DependencyClaimabilityContext` interface (repo, needsHumanLabel, fleetAuthors, openIssues Map, isBlockedByMergedPr callback) and `findDependencyStall` function which classifies whether a blocking dependency is stalled:
- Returns `DependencyStall` ("needs-human" | "assigned" | "merged-pr-permanent") if the blocker is unclaimable, else `null`
- Three checks: needs-human label present, non-fleet assignee, or blocked by merged PR

### Modified: `collect_work_on_candidates.ts`
Integrates dependency stall detection into the work-on selection flow:
- Lines 575–594: Build `DependencyClaimabilityContext` with both pushCapableAuthors (PR fleet) and config.allowedAuthors (issue-claiming humans)
- Detects stalled blockers via `findDependencyStall`
- On stall detected: escalates via `escalateUnworkableWorkOn` (applies needs-human + posts comment)
- On blockers exist but claimable: ordinary dependency wait (no escalation)
- On no blockers: continue to next candidate
- Uses idempotent dedup key pattern: `work-on-dependency-stalled-${issueNumber}-${blockerNumber}`

### Modified: `escalate_unworkable_work_on.ts`
Adds `buildDependencyStalledEscalation` function (lines 118–132) which creates escalation message for unclaimable dependencies:
- Signature: `(issueNumber, blockerNumber, stallDetail) => UnworkableEscalation`
- Returns object with reason, nextStep, stable dedupKey
- Integrates with existing `escalateUnworkableWorkOn` mechanism for unified handling

### Tests
All 6 integration tests in `collect_work_on_candidates_escalation_test.ts` pass:
1. Escalates a dependency cycle and still selects the eligible issue
2. A repo whose only work-on issues form a cycle does not suppress
3. Escalates a milestone-tracking work-on issue (dead label)
4. An already-escalated tracker is not re-escalated
5. **Escalates when blocking dependency carries needs-human** — blocker #200 with needs-human label causes escalation of dependent #100
6. **Does not escalate when blocking dependency is claimable** — blocker #200 assigned to "alice" (in config.allowedAuthors) does NOT escalate

## Acceptance Criteria

- [x] Detect when a work-on issue is blocked by an unclaimable dependency
- [x] Apply needs-human label and post explanatory comment
- [x] Use idempotent dedup key (no duplicate comments within 24h)
- [x] Continue to next candidate after escalation (never stall the repo scan)
- [x] All integration tests pass
- [x] Australian English spelling throughout (behaviour, colour, organisation, favour, centre)

## Standards Review

- **Secure**: No secrets, proper input validation, injection defence
- **Tested**: 6 integration tests covering cycles, dead labels, idempotence, and dependency stall detection
- **Documented**: Australian English spelling in comments and docstrings
- **Isolation**: No cross-repo coupling; per-repo quality gate passes
