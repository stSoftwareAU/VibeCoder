## Summary

Two fleet PRs recorded failure reasons that quoted git's generic last line
(or nothing), and their tests checked only the operation-and-exit-code prefix.
This adds the two rules the issue proposes to `CODING-STANDARDS.md` and,
word for word, to its runtime twin `prompts/coding_guidelines/prompt.md`:

- **A failure reason names the cause, not just the failure** (in
  **Never Fail Silently — Fail Loud**). Quote the line that names the cause,
  never the last line blindly; carry the failed attempt's cause through a retry
  wrapper; redact credentials; observe each failure class.
- **A failure-reason test asserts the cause** (in the test-coverage rules,
  after **Observe the real tool before you rely on it**). The test must assert
  the cause text and go red when the cause is dropped.

`CODING-STANDARDS.md` **Choosing assertions** points at the new test rule, and
the issue prompt's PR Raising Requirements (Bugs/Enhancements) carries the
issue's one-line check. Closes #3429.

## Spec

### Intent and Rationale

- The repository already said to "throw with context" but not what the context must contain when it quotes a tool, so reasons that looked compliant told the operator nothing
- Guidance on both surfaces (human standards and the injected guidelines) reaches every fleet run, which is where the two PRs went wrong

### Essential Design Decisions

- The rule names "the line that names the cause", not "the first `fatal:` line" as the issue drafted: real git puts the DNS cause on an `ssh:` line, and its first `fatal:` line is itself boilerplate
- The bullet sits in the core guidelines layer (Never Fail Silently) and the test rule in the code layer, matching where each sibling rule already lives
- A drift test keeps both surfaces identical

### Undiscoverable Facts

- Observed with git on this host (see Evidence): the access-rights advice sentence appears for SSH and local-path failures but not for HTTPS, so the rule scopes that claim to SSH or a local path

## Evidence

Purely documentation and prompt text plus a drift test; no runtime code changed.

Real tool observed before writing the examples:

```text
$ git ls-remote /tmp/no-such-repo-3429
fatal: '/tmp/no-such-repo-3429' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
exit=128
$ git -c core.sshCommand="ssh -o BatchMode=yes -o ConnectTimeout=5" ls-remote ssh://git@nonexistent-host-3429.invalid/x.git
ssh: Could not resolve hostname nonexistent-host-3429.invalid: Name or service not known
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
exit=128
$ git ls-remote git@github.com:stSoftwareAU/no-such-repo-3429.git   # rewritten to HTTPS by insteadOf
remote: Repository not found.
fatal: repository 'https://github.com/stSoftwareAU/no-such-repo-3429.git/' not found
exit=128
```

The rule depends on two things this output shows: the last two lines are the
same for both SSH and local-path causes, and the cause is on the first line.

Issue numbers the diff cites: #3429: Fleet failure reasons quote git's
boilerplate last line and tests assert only the prefix, so a recorded cause
can't tell auth from network from a missing repo (two private fleet PRs).

Related existing rules checked: **Never Fail Silently — Fail Loud** (both
surfaces; the new bullet extends "throw with context"), **Observe the real tool
before you rely on it** (cross-referenced, not changed), **A new test must go
red without its change** (the test rule points at it), **Choosing assertions**
(extended), **Secure Error Handling and Logging** (the new bullet's "redact any
credential the line carries" agrees with it), **Log Levels Are a Promise**
(no overlap). No conflicting rules found.

Applied the new rules to this PR's own diff: the diff adds no code that records
a failure reason. The drift test's assertion messages are fixed text, not tool
output, so neither rule applies. Nothing found.

**Docs sweep** — grep: "failure[- ]reason", "degrad\w* reason", "throw with context", "Never Fail Silently"; section: `CODING-STANDARDS.md#never-fail-silently--fail-loud`, `prompts/coding_guidelines/prompt.md#never-fail-silently--fail-loud`; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`; `docs/BEST-PRACTICES-SCAN.md:613` — still true because it describes the audit of merged stubs, which this change does not touch; `docs/CONFIGURATION.md:2627` and `docs/INTERNALS.md:4915` — still true because they describe specific worker-authored reasons, not the rule

## Test Plan

- Added `worker/deno/tests/failure_reason_cause_3429_test.ts`. Its four cases check:
  - both Never Fail Silently bullets carry the pins and are identical;
  - both test-rule paragraphs carry the pins, are identical, and sit between the observe-real-tool and workflow-validator paragraphs;
  - **Choosing assertions** carries the pointer;
  - the issue prompt's PR Raising Requirements carries the check.
- Pins absent on base: `deno task drift-pins-on-base origin/milestone/fleet-guidance-coding-standards-rules <doc> <section> <pins>` reported "absent on base" for every pin. It ran on both files' Never Fail Silently and Test Coverage Expectations sections, `CODING-STANDARDS.md` Choosing assertions, and the issue prompt's PR Raising Requirements.
- Red check: deleting the new bullet from `prompts/coding_guidelines/prompt.md` made the test fail with `section is missing pin "A failure reason names the cause, not just the failure"`. Restored afterwards.
- `deno task test:unit` passed (39 passed, 0 failed) on the new test and the neighbouring drift tests:
  - `worker/deno/tests/observe_real_tool_3082_test.ts`
  - `worker/deno/tests/third_party_tool_semantics_3235_test.ts`
  - `worker/deno/tests/workflow_validator_contract_3021_test.ts`
  - `worker/deno/tests/coding_guidelines_layers_2574_test.ts`
  - `worker/deno/tests/coding_guidelines_twin_drift_test.ts`
  - `worker/deno/tests/coding_guidelines_non_negotiables_3421_test.ts`
- No existing test was edited; no assertion removed.
- `./quality.sh < /dev/null` on the head: `Result: PASSED (with skipped checks)`. Only `config integration` was skipped.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
