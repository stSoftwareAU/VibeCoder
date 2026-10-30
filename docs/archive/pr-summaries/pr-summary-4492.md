## Summary

Route Apple accepted-gap notices to WARNING and reserve ERROR for failed egress
self-checks, which still exit 90 before issue work. Closes #4492.

The worker regression test captures the production logger's output for healthy
and broken Apple launches. The standalone command uses `console.warn` for
accepted gaps and `console.error` for failures.

Remove the unrelated manifest expansion and restore the independent assertion
that every existing in-gate Windows suite still exercises PowerShell. Restore
Semgrep's detector-error propagation, including through its existing quality-gate
caller; detector timeouts cannot become nonblocking skips. Regression tests now
require detector timeouts and unexpected detector errors to reject.

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
- Semgrep production code and the script-suite manifests match the base;
  this fix does not change security-gate timeout policy or suite placement.

### Undiscoverable Facts

- None.

## Evidence

Backend and CLI change; no visual surface changed. Read `docs/CONTAINMENT.md`,
section `Apple measured containment`, and updated its marker/severity guidance.

`run_worker_test.ts::runWorker records actual Apple controls before claiming and refuses a broken proxy`
asserts WARNING for `[EGRESS-NOT-ENFORCED]`, ERROR for
`[EGRESS-SELFCHECK-FAILED]`, no ERROR on the healthy launch, exit 90 on failure,
no issue work on failure, cleanup, and the persisted measured-control record.

The PowerShell and Semgrep findings were reproduced before restoring their
protections. Removing the Windows launcher import and launcher-array arm passed
the weakened manifest tests; the restored assertion fails for that same change.
The new detector-timeout rejection test failed against the nonblocking skip
implementation and passed with the base implementation restored. The existing
quality-gate caller again receives the original rejection rather than SKIPPED.

## Reproduction

- **symptom** — `[EGRESS-NOT-ENFORCED]` was sent to the error sink on a healthy
  Apple launch.
- **status** — `verified` — the regression test was observed failing against
  the unfixed warning-sink wiring and passing after the fix.
- **regression test** —
  `worker/deno/tests/run_worker_test.ts::runWorker records actual Apple controls before claiming and refuses a broken proxy`.
- The previous 35 worker tests passed with the production warning adapter
  changed from `logger.warn` to `logger.error`. The strengthened test fails
  against that exact mutation, observing ERROR where WARNING is required.
- Changing the production error adapter to `logger.warn`, or changing the
  self-check failure route to `logWarning`, also fails the test's emitted
  ERROR assertion. Changing the accepted-gap route to `logError` fails its
  WARNING assertion. All mutations were restored after checking.

## Test Plan

- Nine focused suites: 152 passed, 0 failed. These cover the five reported
  mutation-baseline suites, worker and CLI egress severity, Semgrep, and the
  PowerShell/integration manifest guards.
- `tests/parallel_unsafe_test_manifest_test.ts`: 31 passed after restoring the
  unrelated manifest optimisation to its base implementation.
- `deno task check:manifests`: 846 passed, 0 failed, 1 ignored. The ignored
  test is not counted as a pass.
- The reported baseline failure could not be reproduced for
  `agent_transcript_config_1141_test.ts`, `codex_subscription_auth_test.ts`,
  `run_entrypoint_test.ts`, `run_mode_test.ts`, and `run_worker_test.ts`. These
  suites passed (95 tests) with `deno task test` and again with the mutation
  runner's exact `deno test --no-check -A` arguments. They also passed through
  `defaultMutationRunnerSeams().runProcess`, using its isolated, allowlisted
  environment. No mutation-check opt-out or untestable exemption was added.
- The actual diff-scoped `runMutationCheck` completed on the corrected head:
  3 mutants killed, 3 total, no survivors, no baseline error. Its production
  isolated process implementation and environment were used.
- The worker test's prior warning/error sink assertions are replaced by
  stronger assertions on the actual formatted severity for the same markers;
  its exit, work-order, cleanup and persisted-record checks remain.
- `deno fmt --check`, `deno lint`, and
  `deno check --frozen --lock=deno.lock` passed for all five TypeScript files
  remaining in the branch diff.
- `deno task pr-summary-check --base main --issue-body-file /tmp/issue-4492-body.md --labels bug,work-on ../../docs/archive/pr-summaries/pr-summary-4492.md`:
  0 blocked, 0 not checked. Acceptance closure and independent two-axis review
  were reported not applicable.
- The earlier full `./quality.sh < /dev/null` attempt timed out after 900
  seconds; no full-gate pass is claimed. The worker reruns the quality gate
  after this correction.
