## Summary

The "Not closing" decisions for a merged PR (did not land, Issue #4396; marks
acceptance criteria missing, Issue #3177) were logged at WARNING on every cycle
for the same issue/PR pair. They now warn when the decision first applies or its
inputs change, and log an unchanged repeat at DEBUG. Closes #4495.

## Spec

### Intent and Rationale

- A repeated identical decision is not actionable; ~380 of ~985 WARNING/ERROR
  lines a day buried the warnings that need action. The decision itself (issue
  stays open) is unchanged.
- A worker process lasts about an hour (`runDurationSeconds`, default 3600) and
  every start re-runs the merged-PR issue sweep, which re-checks each held-open
  pair once. An in-memory map alone would therefore warn once per process, i.e.
  roughly once per pair per hour — the repeat rate the issue reports (PR #4535
  review). The last signature per key is kept in a small JSON file on the work
  volume, so the first sighting in a new process is a DEBUG repeat.

### Essential Design Decisions

- `shouldWarnDecision(key, signature)` in `lib/decision_warn_dedup.ts` warns
  when the signature for a key is new or differs. Keys include the PR number, so
  a different PR warns again. The did-not-land signature is `landing.reason`
  (the verdict, not the free-text `detail`); the missing-criteria signature is
  the sorted `missing` set.
- `ensureIssueClosedIfPrMerged` and `closeIssuesForMergedPrs` share the
  did-not-land key, so one pair warns once whichever path sees it first.
- State survives a restart: `configureDecisionWarnStore(workDir)` (called
  through the injectable `HousekeepingDeps.configureDecisionStore` seam, whose
  production default wraps it, from `runStartupHousekeeping` in
  `lib/run_housekeeping.ts`, before the sweep) loads
  `<workDir>/decision_warn_signatures.json`; a signature change rewrites it
  tempfile-then-rename. The directory is passed in, never read from `WORK_DIR`,
  so a suite that does not configure it cannot touch the live file (Issue
  #1177); with no store configured the map is memory-only. An A→B→A change warns
  on each change.
- Bounded: an entry not seen for 7 days is dropped (on load and on every write);
  an unchanged sighting re-stamps its entry once a day, so a pair still being
  re-checked is kept and a closed issue's pair ages out.
- A missing file reads as empty. A corrupt or unreadable file is logged at
  WARNING and read as empty; a subsequent write can replace it. A failed write
  is logged at WARNING and leaves the signature in memory until a later write
  succeeds. These faults do not throw. Each is covered by a test (see the Test
  Plan).

### Undiscoverable Facts

- Figures (338 and 41 lines, 15 and 2 pairs on GRQ-23) are from the issue and
  were not re-measured.

## Evidence

Backend logging change; no UI files touched.

```mermaid
flowchart TD
    A[Not closing decision] --> B{signature for key unchanged?}
    B -- yes --> C[logger.debug]
    B -- no --> D[record signature, logger.warn]
```

Docs: grepped `README.md` and `docs/` (excluding `docs/archive/`) for
`Not closing`, `did not land`, `Issue #4396`, `Issue #3177`. No sentence says
these warn each cycle; the one doc edit is in `docs/INTERNALS.md`, which
describes the WARNING/DEBUG behaviour of `ensureIssueClosedIfPrMerged` and the
`decision_warn_signatures.json` file. Related sentence read and still true:
`docs/workflows/issue-processing.md:1077` ("log the missing criteria").

Callers of the changed functions: both warn sites in
`ensureIssueClosedIfPrMerged` (callers pass through unchanged return values) and
the did-not-land site in `closeIssuesForMergedPrs` are covered by tests that
call the real function.

## Reproduction

- **symptom** — `Not closing issue #N: PR #N merged but did not land …` and
  `Not closing the issue: the merged PR marks acceptance criteria missing …`
  logged at WARNING again on every cycle with unchanged inputs.
- **status** — `verified` — with `lib/issue_lifecycle.ts` and
  `lib/pr_maintenance.ts` restored to the base commit and the new tests kept, 9
  of the new site tests fail (149 run: 140 passed, 9 failed); they pass on the
  fix.
- **regression test** —
  `worker/deno/tests/issue_lifecycle_test.ts::ensureIssueClosedIfPrMerged - an unchanged did-not-land verdict warns once across two cycles (Issue #4495)`

## Test Plan

Added:

- `worker/deno/tests/decision_warn_dedup_test.ts`: 12 tests (first sighting,
  changed signature, independent keys, reset; restart with an unchanged then a
  changed signature; no store means a restart warns again; 7-day age-out and
  daily refresh; corrupt store, which also asserts its one WARNING; a store with
  no `decisions` object, one WARNING; an unreadable store (a directory at the
  store path), one "unreadable" WARNING then one "could not be written" WARNING,
  no throw, memory-only dedup and no `*.tmp` left; a failed write (volume
  directory removed), one WARNING, no throw, memory-only dedup). The fault tests
  inject a recording sink through the optional `logger` argument of
  `configureDecisionWarnStore` (defaults to `defaultLogger`).
- `worker/deno/tests/run_housekeeping_test.ts`: production wiring (the real
  `createDefaultHousekeepingDeps().configureDecisionStore`), two startup sweeps
  with fresh in-memory state produce one warning. The recording-deps tests
  inject a no-op `configureDecisionStore`, so the shared `/tmp/work` fixture is
  never read (PR #4535 review). Red check: making the production default a no-op
  turns the wiring test red (`NotFound … decision_warn_signatures.json`).
- `worker/deno/tests/issue_lifecycle_test.ts`: unchanged did-not-land verdict
  warns once across two cycles; the same verdict warns once across a simulated
  worker restart (memory reset, store reloaded) and a changed reason after the
  restart warns again; a changed reason or PR number warns again; the WARNING
  and its DEBUG repeat carry `repo`, `issueNumber`, `prNumber` and `reason` in
  their context.
- `worker/deno/tests/missing_criterion_close_guard_3177_test.ts`: unchanged
  missing-criteria verdict warns once; a changed missing set or PR number warns
  again.
- `worker/deno/tests/pr_maintenance_test.ts`: `closeIssuesForMergedPrs` warns
  once across two cycles for an unlanded merge; a changed reason warns again;
  the WARNING context and the DEBUG repeat (message and context) carry `repo`,
  `issueNumber`, `prNumber` and `reason`.

Edited: the existing #4396 did-not-land test in `issue_lifecycle_test.ts` now
calls `resetDecisionWarnings()` first (module state is shared within a file); no
assertion was removed or changed.

Mutation follow-up: the surviving mutants (the four context properties at
`issue_lifecycle.ts:348-351` and `pr_maintenance.ts:2638-2641`, and the deleted
`logger.debug` call at `pr_maintenance.ts:2651`) are killed by the two new
context tests; each was re-applied by hand and the matching test went red.

Persistence red checks (PR #4535 review, re-run on the head, each reverted
after, counts per test file): skipping `loadStore` →
`decision_warn_dedup_test.ts` 6 red, `issue_lifecycle_test.ts` 1,
`run_housekeeping_test.ts` 1; skipping the write on a changed signature →
`decision_warn_dedup_test.ts` 4 red, `issue_lifecycle_test.ts` 1,
`run_housekeeping_test.ts` 1; disabling `pruneStale` →
`decision_warn_dedup_test.ts` age-out test red (1); disabling the daily re-stamp
→ `decision_warn_dedup_test.ts` age-out test red (1). The other changed test
files stayed green in each case. The error-branch checks below are all in
`decision_warn_dedup_test.ts`. Error-branch red checks (PR #4535 review), each
reverted after: rethrowing a non-NotFound read error → the unreadable-store test
red; rethrowing in `saveStore`'s catch → the unreadable-store and failed-write
tests red; turning the "unreadable" `warn` into a no-op → the unreadable-store
test red; turning the "could not be written" `warn` into a no-op → both
write-fault tests red; dropping the `removeSync(temp)` cleanup → the
unreadable-store test red (temp file left). Production wiring is covered by
`run_housekeeping_test.ts`: two startup sweeps with fresh in-memory state
produce one warning. Before the call moved into housekeeping, the new test
failed because the store file was absent.

Red checks: `shouldWarnDecision` forced to return true (`return true;` as its
first statement), re-run on the head, one `deno task test:unit` per file:
`decision_warn_dedup_test.ts` (12 tests at head) 10 red, 2 passed;
`issue_lifecycle_test.ts` (37 tests at head) 4 red, 33 passed;
`missing_criterion_close_guard_3177_test.ts` (25 tests at head) 2 red, 23
passed; `pr_maintenance_test.ts` (87 tests at head) 3 red, 84 passed. The
`issue_lifecycle`, `missing_criterion_close_guard_3177` and `pr_maintenance`
failures show two identical warn lines instead of one. The edit was reverted
after. Base-branch production files with the new tests → 9 site tests red
(above).

Results on the head, `deno task test:unit` per file, 0 failed in each (test
counts at head): `decision_warn_dedup_test.ts` (12 tests),
`issue_lifecycle_test.ts` (37), `missing_criterion_close_guard_3177_test.ts`
(25), `pr_maintenance_test.ts` (87), `run_housekeeping_test.ts` (25),
`run_worker_test.ts` (37), `issue_lifecycle_cache_test.ts` (7),
`pr_maintenance_issue_state_cache_test.ts` (7), `merged_pr_issue_sweep_test.ts`
(41), `merged_pr_precheck_phase_test.ts` (9),
`completion_phase_merged_pr_closure_test.ts` (7); 12+37+25+87+25+37+7+7+41+9+7 =
294 in total. Of these, `run_worker_test.ts`, `issue_lifecycle_cache_test.ts`,
`pr_maintenance_issue_state_cache_test.ts`, `merged_pr_issue_sweep_test.ts`,
`merged_pr_precheck_phase_test.ts` and
`completion_phase_merged_pr_closure_test.ts` are unchanged by this PR and were
run only as regression coverage of callers. `deno fmt --check`, `deno lint` and
`deno check` are clean on the nine changed `.ts` files.

Twinned copies: the did-not-land message is logged at two sites
(`issue_lifecycle.ts`, `pr_maintenance.ts`); both changed and share a key.

`./quality.sh`: the earlier head's run (before the PR #4535 review fix) passed
every stage except two unrelated tests in
`worker/deno/tests/completion_phase_repo_formatters_test.ts`; it was not re-run
on this head. The lib sweep ledger entry is
`docs/audits/lib-sweep-coverage/top-up-4495.json`.
