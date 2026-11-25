## Summary

Recognise Bash ANSI-C `$'…'` quote boundaries in the shared shell command
tokeniser, including openers split by unquoted line continuations. Escaped
apostrophes neither expose argument text as commands nor hide commands after the
closing quote. Restore the babysitter concurrency test's held-repair observation
window while retaining cleanup that awaits the production pass. Closes #5525.

## Spec

### Intent and Rationale

- Fix the shared tokeniser used by the best-practices scan and AWS Emulator
  workflow validator, preserving both consumers' existing command checks.
- Retain the repair queue regression protection while preventing temporary
  directory cleanup from racing asynchronous discovery writes.

### Essential Design Decisions

- Track ANSI-C quoting separately from ordinary single and double quotes.
  Consume escaped characters together; retain their spelling without decoding.
- Recognise the opener across unquoted backslash-newline continuations, which
  are removed from the word. Process escaped dollars before opener recognition.
- Keep command separators and concatenated quoted/plain word fragments intact.
  This remains a static command reader, rather than a full Bash parser.
- Keep the first repair held for 50 timer turns so a competing repair can
  complete asynchronous discovery preparation, then assert serial execution.
  Release all repair gates and await the pass before removing temporary state,
  including on assertion failure. Production repair concurrency remains one.

### Undiscoverable Facts

- Harmless Bash execution confirmed that a command-looking line after a
  continued ANSI-C opener remains argument text, while the executable control
  runs after the closing quote.
- With production concurrency temporarily set to two, the previous test passed.
  The repaired test fails with two repairs started beside each other; the
  production constant was restored to one before final validation.

## Evidence

- Backend scanner change; no UI surface or AWS operation changed.
- At pre-fix head `5aba75787`, the continued-opener negative fixture returned
  `true` from `workflowRunsAwsEmulator`, and its executable control returned
  `false`. Both new `workflowRunsAwsEmulator` tests and the
  multiple-continuation token boundary test failed before the parser fix; all
  pass after it.
- The concurrency test now rejects a production limit of two with
  `the second repair started beside the first` (actual 2, expected 1). The
  failing run completed cleanup without a directory-removal error.
- Read the AWS Emulator CI check section of `docs/BEST-PRACTICES-SCAN.md` and
  updated it to describe ANSI-C quoting, continued openers and escaped dollars.

## Test Plan

- `worker/deno/tests/aws_emulator_in_ci_check_test.ts`: ordinary and continued
  ANSI-C negative fixtures with executable controls; fourteen `shellSegments`
  boundary cases and the `shellCommands` separator regression. Covers escaped
  apostrophes and backslashes, multiline content, raw backslash-newline inside
  quotes, single/multiple and CRLF opener continuations, concatenated fragments,
  ordinary quotes, escaped dollars (including across a continuation), empty
  words and an unclosed word.
- `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`: pinned-install
  negative fixtures and executable controls using the real workflow and its
  mutation helpers, including a continued opener. The continued-opener variant
  already passed before this follow-up; it remains covered.
- `worker/deno/tests/babysitter_host_disk_admission_5105_test.ts`: retained
  repair start/release signals and failure cleanup, and restored the observation
  window before releasing the first repair. Verified that the test rejects a
  limit of two and passes with the unchanged production limit of one.
- Ran `deno task test:unit` on those three files from `worker/deno`: **606
  passed, 0 failed**; the unit-test runtime budget passed.
- Targeted `deno fmt --check` and `deno lint` passed for all four changed
  TypeScript files. Frozen `deno check` passed for the shared tokeniser, both
  affected consumers and all three changed test files.
- `deno task pr-summary-check --base origin/main` reported **0 blocked, 3 not
  checked**: acceptance closure and independent review lacked an issue body
  file, and reproduction status lacked labels. These are not passes.
- Related reader checked: `scanLine` in
  `worker/deno/lib/aws_emulator_workflow_check.ts` already consumes escaped
  characters in its ANSI-C quote state. Both consumers retain the shared
  tokeniser; no separate command-tokeniser copy was found.

## Merge verification

- Full quality gate, pre-PR verification, CI and independent review are pending
  for this follow-up. The earlier full gate passed with skipped checks before
  these review fixes; the worker re-runs the gate and verifier before PR
  creation. Pushing and PR creation are assigned to that workflow.

## Not checked and remaining risks

- The earlier full gate skipped config integration because Deno or local
  configuration was unavailable, and Checkov because no local pinned binary or
  preloaded image was available. This follow-up ran focused checks only; those
  skips await the worker's gate run.
- Live AWS execution was not run for this parser-only change. ANSI-C escape
  decoding and a complete Bash grammar remain outside this change.
