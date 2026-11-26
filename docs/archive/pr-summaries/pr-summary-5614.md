## Summary

Keep a trailing credential flag name visible to the CLI redactor so it masks the
next value too. Preserve complete assignment masks and shared-quote overlaps.

Closes #5614.

## Spec

### Intent and Rationale

- An unclosed quoted value swallowed a second credential flag's name, leaving
  its value visible. Shortening the replacement boundary lets the existing
  scanner find that flag rather than introducing another value parser.

### Essential Design Decisions

- `redactCliFlags` owns the replacement boundary and reuses `flagNameEndingAt`
  and `credentialFlagTakesValueAt`.
- `cliFlagEnd` keeps its complete-extent contract for assignment callers.
  Shared-quote overlaps are extended before the CLI boundary is shortened.
- The name probe reads at most 150 characters. Resuming at the trailing name
  revisits a bounded suffix; the input remains untruncated.

### Undiscoverable Facts

- The issue's displayed examples were already redacted. Raw unclosed-quote
  inputs were reconstructed and observed leaking before the fix.
- The original checkout failed the gate's unit-test timing budget. An identical
  checkout on the container's other filesystem passed the affected suite in
  isolation. A subsequent gate under `/tmp` exposed two cache tests that require
  a checkout outside shared temporary directories; validation moved outside
  `/tmp`, where both affected suites passed together.

## Evidence

- #5614: secret-cli-flag rule masks a second credential flag's name inside an
  unclosed-quote value and publishes that flag's value.
- On unfixed base `f98d0d9c5`, `--api-key "tail'--api-key hunter2abc` and its
  `abc`-prefixed variant published `hunter2abc`. The output was already
  idempotent and `containsSecret` returned false on it, so those properties
  alone did not detect the leak.
- The new regression file failed before the production change: 10 failed, 2
  controls passed. After the fix, all 12 tests passed. They use the existing
  `assertRedacts` helper for exact output, input/output detection, removal of
  credential text and idempotence, plus the real `redactGhBodyArgs` body path.
- Backend redaction only; no visual surface changed. `capsec-secret-logging`
  applies at the shared redactor and outbound body wrapper. The change adds no
  external operation or privileged entry point.
- Read the redaction sections in `SECURITY.md` and `docs/THREAT-MODEL.md`.
  Updated current CLI/assignment explanations and source comments; historical
  archived summaries retain their original records.

## Test Plan

- Added `worker/deno/tests/secret_redaction_cli_flag_overlap_5614_test.ts`: both
  quote kinds and prefixed inputs, different credential flags, spaces, tabs,
  line breaks, chained overlaps, placeholders, missing values, non-credential
  flags, closed quotes, shared quotes and outbound bodies. Long-name and
  20,000-value-chain cases assert output without wall-clock thresholds. No
  existing test assertion was removed or changed.
- From `worker/deno`,
  `deno task test:unit tests/secret_redaction*_test.ts
  tests/secret_transform_redaction_test.ts tests/gh_body_redaction*_test.ts
  tests/gh_title_redaction_test.ts tests/git_message_redaction_test.ts`:
  passed, 822 tests, zero failures. Existing slow-test warnings were reported.
- Existing assignment protection is covered by
  `worker/deno/tests/secret_redaction_flag_in_value_5608_test.ts`; shared-quote
  protection is covered by
  `worker/deno/tests/secret_redaction_cli_flag_escaped_quote_5435_test.ts` and
  `worker/deno/tests/secret_redaction_outer_mask_flag_quote_5456_test.ts` in
  that run. No caller was rewired. The shared CLI patterns and assignment helper
  keep their existing contracts; no duplicated rule was introduced.
- Targeted `deno fmt --check`, `deno lint` and frozen `deno check` on the
  production module and new test file: passed.
- First `./quality.sh < /dev/null`: failed only its unit-test timing budget in
  `worker/deno/tests/parallel_safety_cap_test.ts`:
  `every test in tests/parallel_safety_cap_test.ts (2, 2.97s) is over the
  1.00s unit-test budget`.
  Both parallel and serial assertion passes succeeded.
- Second gate, identical code under `/tmp`: failed two tests in
  `worker/deno/tests/cache_secret_redaction_1261_test.ts` with
  `expected a work-volume directory, got a shared-tmp path`.
- In the identical checkout outside `/tmp`,
  `deno task test:unit tests/parallel_safety_cap_test.ts
  tests/cache_secret_redaction_1261_test.ts`:
  passed, 9 tests, including the timing-budget check. No test or threshold was
  altered for these retries.
- Third and final `./quality.sh < /dev/null`, on identical commit `160bdc5f7`
  outside `/tmp`: failed its unit-test timing budget. Both parallel and serial
  assertion passes succeeded; every other executed gate stage passed. The
  remaining failures were in
  `worker/deno/tests/git_operations_subprocess_test.ts` and
  `worker/deno/tests/parallel_safety_cap_test.ts`:

  ```text
  FAIL: every test in tests/git_operations_subprocess_test.ts (2, 2.79s) is over the 1.00s unit-test budget
  FAIL: every test in tests/parallel_safety_cap_test.ts (2, 4.24s) is over the 1.00s unit-test budget
  Deno tests: FAILED (unit-test time budget)
  Result: FAILED
  ```

  No fourth gate attempt was made. No unrelated source, test or threshold was
  changed to bypass these failures.
- `deno task pr-summary-check --base origin/main --issue-body-file <body>
  --labels work-on`
  on this summary: passed, 0 gates blocked and 0 not checked.
  Acceptance-criteria, independent-review and bug-label reproduction gates are
  not applicable to this issue.

## Merge verification

The full quality gate remains failed on the timing-budget checks above. CI and
independent code review are pending. No pull request was created in this
executor phase.

## Limitations

Config integration was skipped because `.config.json` was unavailable. Checkov
was skipped because its pinned binary/container was unavailable. Pushing is left
to the assigned delivery phase. The implementation is complete; the full gate
remains failed on timing budgets.
