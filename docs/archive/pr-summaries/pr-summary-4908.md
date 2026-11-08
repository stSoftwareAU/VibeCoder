## Summary

Extended the baseline gate's duration normaliser to cover compact and spaced minute/hour compounds, so unchanged Deno failures compare as pre-existing while changed counts and diagnostics remain new output. Closes #4908.

Version bump: no version change in this PR; the merged commit records the final version.

## Spec

### Intent and Rationale

- Deno summary lines include compact elapsed values such as `2m14s`; treating those as new output prevents the baseline gate from recognising an unchanged failure.

### Essential Design Decisions

- The baseline normaliser replaces elapsed durations only. Failure counts and diagnostic lines continue to participate in the comparison.
- Kept the auto-fix normaliser's distinct `<dur>` and lowercase contract; agreement tests compare volatility across overlapping formats.

### Undiscoverable Facts

- The full quality gate's only test failure was caused by inherited proxy environment variables in the credential-channel test; see Test Plan for the failing test and assertion.

## Evidence

- Backend-only change. Regression tests exercise `normaliseGateOutputLines` and `decidePreExistingGateFailure` with the reported `1m43s` and `2m14s` summaries.
- Deno's existing `normaliseLogExcerpt` already handles compact and spaced compounds; the new behavioural agreement test checks shared formats without changing that module.
- No Node tooling or dependency changes were introduced.

## Deno regression avoided

- Used the repository's existing Deno test, lint, formatter and type-check commands; added no Node tooling.

## Test Plan

- `worker/deno/tests/pre_existing_gate_failure_test.ts::normaliseGateOutputLines - compact Deno durations compare as pre-existing` — passed; asserts equal normalised lines and a `pre_existing` decision.
- `worker/deno/tests/pre_existing_gate_failure_test.ts::normaliseGateOutputLines - changed failure counts and diagnostics remain new output` — passed; changed count and diagnostic text produce `new_output`.
- `worker/deno/tests/pre_existing_gate_failure_test.ts::normaliseGateOutputLines - compound durations and existing formats normalise` — passed for hour compounds, compact and spaced minute compounds, decimals, existing sub-second units and standalone minutes.
- `worker/deno/tests/pre_existing_gate_failure_test.ts::normaliseGateOutputLines - duration matching handles hostile digits and whitespace` — passed on 50,000 digits and 20,000 repeated minute/space segments; no wall-clock threshold.
- `worker/deno/tests/pre_existing_gate_failure_test.ts::normalisers agree that overlapping duration formats are volatile` — passed for compact Deno, hour, spaced-minute and decimal-second formats.
- Regression mutation: restored the original `DURATION_RE`; the baseline-gate test file failed with 4 regression cases, including the compact summary and compound-hour cases. Restoring the new expression made the touched suites pass.
- `deno task test:unit tests/pre_existing_gate_failure_test.ts tests/auto_fix_attempt_tracker_test.ts` — passed, 33 tests.
- `deno fmt --check` on the two changed TypeScript files, `deno lint` on the changed TypeScript files, and `deno check` on both normalisers and their tests — passed.
- `markdownlint-cli2 docs/INTERNALS.md` — passed; 244 Markdown files checked.
- `./quality.sh < /dev/null` — failed: 33,155 passed, 1 failed, 5 ignored. `tests/merge_fast_checks_credentials_4705_test.ts::spawnFastCheck: declared credentials ride the stdin channel, never argv, behind the sudo wrapper` expected the captured environment without proxy variables, but the run inherited uppercase and lowercase `HTTP(S)_PROXY` and `NO_PROXY`. The first gate run also failed its Deno test stage. Config integration and Checkov were skipped by the gate. No unrelated test or environment behaviour was changed.
- No existing test assertions were removed.
- Not checked: CI results and the full quality gate on a host without the inherited proxy environment.
