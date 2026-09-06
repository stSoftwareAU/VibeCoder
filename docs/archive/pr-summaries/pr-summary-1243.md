# Verify the author of finding-id dedup matches

## Summary

`worker/deno/lib/idle_task_snapshot.ts` read the `<!-- finding-id: … -->` marker
out of open issue **bodies** with `--json number,body` and treated any match as
"this finding is already filed". An issue body is text anyone with a GitHub
account can write and finding ids are deterministic per scanner, so one planted
issue suppressed a real finding on every subsequent scan — silently, and for as
long as it stayed open — across the ~12 scanners that share these helpers.

Both look-ups now go through the control that already closes this class
elsewhere (`host_escalation.ts`, `idle_task_backfill.ts`, …):

- `listOpenIssueBodies` requests `ALERT_DEDUP_JSON_FIELDS`
  (`number,body,author`) and filters every marker match through
  `selectFleetAuthoredMatches` before either consumer sees it.
- `findOpenIssueByFindingId` → `fileFindingOnce` therefore skips
  `gh issue create` only for a **fleet-authored** open issue.
- `listKnownOpenFindingIds` feeds `{{KNOWN_OPEN_FINDING_IDS}}` only ids a fleet
  account wrote.

Fail direction is towards filing: a match outside the fleet — and every match
when the fleet author set cannot be resolved — is discarded and logged, so the
finding is filed. A duplicate finding is noise a human closes; a suppressed one
is a finding nobody hears about.

A `FindingIdDedupOptions` bag (`fleetAuthors` / `env` / `loadConfigFn` / `log`)
is threaded through the 15 scan templates, `workflow_annotation_filer.ts` and
`alert_feed_enable_issue.ts` as their existing `dedupAuthors` dependency.
Production callers omit it and get the configured fleet identity
(`service_accounts` ∪ `fleet_pr_authors` ∪ `GITHUB_USER`), exactly as the
wrapper-title dedup already does. `lib/idle_task_snapshot.ts` is removed from
`MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS` — that list has no automatic
staleness gate, so a fixed entry must be deleted by whoever fixes it.

Closes #1243.

## Evidence

Backend-only change — no web interface to screenshot. The evidence is the test
suite and the quality gate.

**Regression test, red then green.** `worker/deno/tests/idle_task_snapshot_test.ts::fileFindingOnce - files the finding when an outsider planted the finding-id marker`
feeds an outsider-authored body carrying a known finding id through
`fileFindingOnce()` and asserts the finding is still filed — exactly the failure
detection the issue asked for. Observed failing against the unfixed
`lib/idle_task_snapshot.ts` (stashed, `--no-check`) and passing after the fix:

```text
# unfixed lib, new tests only
FAILURES
fileFindingOnce - files the finding when an outsider planted the finding-id marker
findOpenIssueByFindingId - ignores an outsider-authored marker and logs the discard
listKnownOpenFindingIds - drops outsider-authored ids from the skip-list
FAILED | 0 passed | 3 failed | 60 filtered out

# after the fix
ok | 63 passed | 0 failed
```

**Original trigger closed, no trivial bypass.** The attack input was an issue
whose body contains `<!-- finding-id: BP-LINTER-typescript -->`, opened by any
GitHub account. `listOpenIssueBodies` is the single read both consumers share,
and every row it returns has passed `selectFleetAuthoredMatches`, so neither
`findOpenIssueByFindingId` (pre-file skip) nor `listKnownOpenFindingIds`
(prompt skip-list) can see an outsider's row at all. There is no second path to
the marker: the regex, the prefix filter and the truncation warning all operate
on the already-filtered list, the `logLabel` and `idPrefix` arguments narrow the
set further rather than widening it, and an unresolvable fleet author set
discards **every** row rather than falling back to trusting the body. Spoofing
the author is not open to an outsider — `author.login` comes from GitHub's own
API response for the issue, not from any attacker-writable field — so the only
way back into the skip-list is to be a fleet account.

**Quality gate.** `./quality.sh` — `Result: PASSED (with skipped checks)`; the
three skips (`config integration`, `pages-liquid`, `mermaid built output`) are
environment-gated and pre-existing.

## Test Plan

Added to `worker/deno/tests/idle_task_snapshot_test.ts`:

- `fileFindingOnce - files the finding when an outsider planted the finding-id marker`
  — the regression test above (files rather than skips).
- `findOpenIssueByFindingId - ignores an outsider-authored marker and logs the discard`
  — returns `null` and logs `authored outside the fleet`.
- `findOpenIssueByFindingId - still matches a fleet-authored marker` — the
  legitimate dedup still works.
- `listKnownOpenFindingIds - drops outsider-authored ids from the skip-list`
  — a planted id never reaches `{{KNOWN_OPEN_FINDING_IDS}}`.
- `listKnownOpenFindingIds - an unresolvable fleet author set drops every id`
  — the fail-towards-filing direction, with the loud log.
- `listKnownOpenFindingIds - requests the author field from gh` — the query
  asks for `number,body,author`.

**Existing tests modified, not removed** (business-logic change, documented per
the TDD standard): every fixture that asserts dedup now attributes its
`<!-- finding-id: … -->` issue to a fleet login and states the fleet inline via
`dedupAuthors`, because an unattributed marker no longer deduplicates. That
covers the `listKnownOpenFindingIds` / `findOpenIssueByFindingId` /
`fileFindingOnce` cases in `idle_task_snapshot_test.ts`, the `--json` field-list
assertions (`number,body` → `number,body,author`), the gh stubs in the 14
affected template test files, and `alert_feed_enable_issue_test.ts`. No test was
deleted or commented out.

Full suite: `deno tests PASSED` in the gate.
