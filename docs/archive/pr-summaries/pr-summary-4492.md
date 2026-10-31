## Summary

Route Apple accepted-gap notices to WARNING and reserve ERROR for failed egress
self-checks, which still exit 90 before issue work. Closes #4492.

The worker regression test captures the production logger's output for healthy
and broken Apple launches. The standalone command uses `console.warn` for
accepted gaps and `console.error` for failures.

The standalone command now also forwards the `appleObserved` and `appleControl`
seams its type already declared to `checkEgressPolicy`, so a healthy Apple run
in its test is genuinely healthy.

Version bump: no version file changed for this fix; the merged commit records
the final version.

## Spec

### Intent and Rationale

- Accepted host/LAN and DNS gaps degrade containment but do not stop a healthy
  launch; their existing warning field belongs at WARNING.
- Failed control checks retain their ERROR marker and exit status.

### Essential Design Decisions

- Persisted egress records, control decisions and cleanup behaviour remain
  unchanged.
- The worker test leaves both production severity adapters installed and
  captures their formatted output at the console sink.
- The change is the egress severity routing, the command's seam forwarding, the
  `logWarning` seam on `RunWorkerDeps`, a `docs/CONTAINMENT.md` note and their
  tests; no other gate or suite is touched.

### Undiscoverable Facts

- None.

## Evidence

Backend and CLI change; no visual surface changed. Read `docs/CONTAINMENT.md`,
section `Apple measured containment`, and updated its marker/severity guidance.

`run_worker_test.ts::runWorker records actual Apple controls before claiming and refuses a broken proxy`
asserts WARNING for `[EGRESS-NOT-ENFORCED]`, ERROR for
`[EGRESS-SELFCHECK-FAILED]`, no ERROR on the healthy launch, exit 90 on failure,
no issue work on failure, cleanup, and the persisted measured-control record.

`egress_selfcheck_test.ts::egress-selfcheck - emits warnings with warn and failures with error`
runs the command, asserts the healthy run succeeds and the broken run fails,
`[EGRESS-NOT-ENFORCED]` goes to `console.warn` (never `console.error`) and
`[EGRESS-SELFCHECK-FAILED]` goes to `console.error`. With the new seam
forwarding removed the test fails on the healthy-run `success` assertion; with
`console.warn` changed back to `console.error` it fails as well.

## Reproduction

- **symptom** — `[EGRESS-NOT-ENFORCED]` was sent to the error sink on a healthy
  Apple launch.
- **status** — `verified` — the regression test was observed failing against the
  unfixed warning-sink wiring and passing after the fix.
- **regression test** —
  `worker/deno/tests/run_worker_test.ts::runWorker records actual Apple controls before claiming and refuses a broken proxy`.
- The previous 35 worker tests passed with the production warning adapter
  changed from `logger.warn` to `logger.error`. The strengthened test fails
  against that exact mutation, observing ERROR where WARNING is required.
- Changing the production error adapter to `logger.warn`, or changing the
  self-check failure route to `logWarning`, also fails the test's emitted ERROR
  assertion. Changing the accepted-gap route to `logError` fails its WARNING
  assertion. All mutations were restored after checking.

## Test Plan

- `tests/egress_selfcheck_test.ts` (11 tests at head) and
  `tests/run_worker_test.ts` (35 tests at head) together: 46 passed, 0 failed.
- The Apple worker test keeps the production logging adapters and newly checks a
  WARNING `[EGRESS-NOT-ENFORCED]` line, an ERROR `[EGRESS-SELFCHECK-FAILED]`
  line only for a broken launch, no ERROR on a healthy launch, cleanup, and no
  github-user call on failure. The dialect test captures the marker from
  `logWarning` and checks that `logError` receives nothing.
- `deno fmt`, `deno lint` and `deno check --frozen --lock=deno.lock` passed for
  the TypeScript files this PR changes.
