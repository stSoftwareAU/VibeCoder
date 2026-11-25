## Summary

Recognise Bash ANSI-C `$'…'` quote boundaries in the shared shell command
tokeniser, so escaped apostrophes neither expose argument text as commands nor
hide commands after the closing quote. Closes #5525.

## Spec

### Intent and Rationale

- Fix the shared tokeniser used by the best-practices scan and AWS Emulator
  workflow validator, preserving both consumers' existing command checks.

### Essential Design Decisions

- Track ANSI-C quoting separately from ordinary single and double quotes.
  Consume escaped characters together; retain raw spelling without decoding.
- Keep command separators and concatenated quoted/plain word fragments intact.
  This remains a static command reader, rather than a full Bash parser.

### Undiscoverable Facts

- Harmless Bash commands confirmed that the embedded multiline command remains
  argument text, while a command after the closing quote executes. Escaped
  backslashes, adjacent fragments and literal openers in ordinary quotes were
  also checked with Bash.

## Evidence

- Backend scanner change; no UI surface or AWS operation changed.
- On unfixed base `0d52315dacadaa56376feedf7ff834b277b7dec9`, the two consumer
  regressions failed: `workflowRunsAwsEmulator` returned `true` for the hidden
  command, and the workflow validator omitted the expected `[pinned-install]`
  finding. The executable ANSI-C controls also failed on base. Ordinary
  double-quoted controls passed. After the fix, both consumers pass their
  negative cases and executable controls.
- Issue provenance: #5525: shell_command_words: `shellCommands` does not model
  `$'...'` ANSI-C quoting, so an escaped quote inside one inverts the quote state
  for the rest of the body.

## Test Plan

- `worker/deno/tests/aws_emulator_in_ci_check_test.ts`: added the
  `workflowRunsAwsEmulator - ANSI-C escaped quotes keep multiline arguments out
  of command position` regression, eleven `shellSegments` boundary cases and
  the `shellCommands` separator regression. Covers escaped apostrophes and
  backslashes, multiline content, raw backslash-newline, concatenated fragments,
  ordinary quotes, escaped dollars, empty words and an unclosed word.
- `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`: added
  `pinned install inside a multiline argument after an ANSI-C escaped quote is
  refused`, using the real workflow and existing mutation helpers. Requires
  exactly the pinned-install finding and an executable control with no findings.
- Ran `deno task test:unit` on those two files from `worker/deno`: **585 passed,
  0 failed**. With the full new boundary table on base: **578 passed, 7 failed**.
  No existing assertions were removed or changed.
- Targeted `deno fmt --check`, `deno lint` and frozen `deno check` passed.
  Type checking included the shared tokeniser, both consumer modules and both
  affected test files.
- Corpus: compared base and head readers over all **15** real workflow YAML
  files, the three applicable workflow validators, and the aggregate repository
  scan. **0 changed verdicts; 0 observed false positives or false negatives** in
  that inspected scope. Direct-workflow checks returned false; aggregate
  analysis correctly credited `aws-emulator.yml` through its reusable-workflow
  caller. The three validators returned no findings, and no workflow was
  unreadable. The affected test corpus is covered by the unit run above;
  archived Markdown summaries are not workflow inputs.
- Related reader checked: `scanLine` in
  `worker/deno/lib/aws_emulator_workflow_check.ts` already consumes escaped
  characters in its ANSI-C quote state. Both consumers retain the shared
  tokeniser; no separate command-tokeniser copy was found.
- First full `./quality.sh < /dev/null`: **failed** in the unchanged
  `worker/deno/tests/babysitter_host_disk_admission_5105_test.ts` test
  `the production pass runs one repair container at a time`, during temporary
  directory cleanup: `Directory not empty (os error 39)`. The parallel pass
  reported 36,724 passed, 1 failed and 5 ignored; the serial pass did not run.
  Running that file directly through `deno task test:unit` then passed all
  **16** tests. Other completed gate checks passed, except the skips below.

## Merge verification

- CI and independent code review remain pending with the implementation
  workflow. Pushing and PR creation are assigned to that workflow.

## Not checked and remaining risks

- Config integration and Checkov were marked skipped by the local gate.
  Live AWS execution was not run for this parser-only change. ANSI-C escape
  decoding and a complete Bash grammar remain outside this change.
