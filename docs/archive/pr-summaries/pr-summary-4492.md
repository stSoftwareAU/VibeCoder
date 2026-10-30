## Summary

Route Apple accepted-gap notices to WARNING and reserve ERROR for failed egress
self-checks, which still exit 90 before issue work. Closes #4492.

Version bump: no version file changed for this fix; the merged commit records
the final version.

## Spec

### Intent and Rationale

- Accepted host/LAN and DNS gaps degrade containment but do not stop a healthy
  launch.
- The worker now logs the existing warning field at WARNING; failed control
  checks retain their ERROR marker and exit status.

### Essential Design Decisions

- Persisted egress records, control decisions and cleanup behaviour remain
  unchanged.
- The standalone command uses `console.warn` for warning output and keeps
  failure markers on `console.error`; both remain on stderr.

### Undiscoverable Facts

- None.

## Evidence

Backend and CLI change; no visual surface changed. The targeted tests exercise
both healthy and broken Apple launches and the standalone command's warning and
failure output.

## Reproduction

- **symptom** — `[EGRESS-NOT-ENFORCED]` was sent to the error sink on a healthy
  Apple launch.
- **status** — `verified` — the regression test failed with the original
  error-sink wiring and passed after the fix.
- **regression test** —
  `worker/deno/tests/run_worker_test.ts::runWorker records actual Apple controls before claiming and refuses a broken proxy`

## Test Plan

- `worker/deno/tests/run_worker_test.ts` and
  `worker/deno/tests/egress_selfcheck_test.ts`: 46 passed, 0 failed on the final
  code head.
- `worker/deno/tests/egress_selfcheck_test.ts::egress-selfcheck - emits warnings with warn and failures with error`:
  the command emits accepted-gap output through `console.warn` and failed
  self-check markers through `console.error`.
- Base-route reproduction: before changing the warning sink, the new launch
  tests failed because `[EGRESS-NOT-ENFORCED]` was captured by `logError`
  instead of `logWarning`.
- Warning-wiring mutation: changing the warning call back to `logError` made
  both worker severity tests fail.
- Failure-severity mutation: changing the self-check failure call to
  `logWarning` made the Apple failure severity assertion fail.
- Standalone command mutation guard: its test observes the accepted-gap marker
  through `console.warn` and the failure marker through `console.error`.
- `deno fmt --check` on the four changed TypeScript files: passed.
- `deno lint` on the four changed TypeScript files: passed.
- `deno check --frozen --lock=deno.lock` on the four changed TypeScript files:
  passed from `worker/deno`.
- `timeout 900 ./quality.sh < /dev/null`: timed out after 900 seconds with exit
  124 while the full Deno test/validation work was still running; no full-gate
  pass is claimed.
- `deno task pr-summary-check --base main --issue-body-file /tmp/issue-4492-body.md --labels bug,work-on ../../docs/archive/pr-summaries/pr-summary-4492.md`:
  passed, 0 blocked and 0 not checked.
- No existing test assertions were removed; the existing non-enforcing assertion
  now checks the warning sink and also asserts that the error sink stays empty.
