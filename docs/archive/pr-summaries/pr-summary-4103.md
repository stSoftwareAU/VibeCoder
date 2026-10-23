## Summary

Fixes the `aws-secret-access-key` redaction rule so an AWS secret access key
that starts or ends with `/` or `+` is masked when it sits beside its access
key id. The rule anchored the secret with `\b`, which does not fire beside `/`
or `+` because they are not word characters, so such a secret was passed
through verbatim. The anchors are now lookarounds over the secret alphabet, `_`
is in both context classes, and the hex-SHA guard no longer carries its own
trailing `\b`. The Issue #3857 escape alternative, the git-SHA exclusion and the
unchanged behaviour for `id=secret` and `secret=…` are all kept. Closes #4103.

- `worker/deno/lib/secret_redaction.ts`: the `aws-secret-access-key` regex
  (line 493) replaces both `\b` anchors with fixed-width lookarounds; the doc
  comment above the rule (lines 447-489) records the Issue #4103 change and the
  reason for the `_` and hex-guard shape.
- `worker/deno/tests/secret_redaction_test.ts`: seven new tests (lines 209, 220,
  230, 240, 250, 275, 286) for a leading `/` after a comma, a trailing `+` at end of
  text, a trailing `/` before a comma, a leading `+` after a colon, an
  AWS-alphabet run glued to the secret, an equals separator after the key ID,
  and a git SHA with a run character after it.
- `worker/deno/tests/secret_redaction_redos_test.ts`: one new test (line 141)
  that feeds a hostile run of comma-separated slash pads and asserts the rule
  stays linear.

Version bump: no `VERSION` change on this branch; the diff touches only
`worker/deno` library and test files.

## Spec

The rule matches an `AKIA` or `ASIA` access key id, then up to 120 characters
of anything (`[\s\S]{0,120}?`), then a 40-character secret drawn from
`[A-Za-z0-9/+=]`. Only the secret is replaced by the placeholder; the id and the
text between it and the secret are kept.

The secret must satisfy four context conditions:

- Leading: the character before it is not in `[A-Za-z0-9/+_]`, or it follows a
  literal `\n`, `\r` or `\t` escape (`(?<![A-Za-z0-9/+_])|(?<=\\[nrt])`). The
  escape alternative is the Issue #3857 case.
- Hex guard: the 40 characters are not all lowercase hex, `(?![0-9a-f]{40})`, so
  a git commit SHA beside a key is left alone. The trailing guard already rejects
  a SHA with a class character after it, so no inner trailing `\b` is needed.
- No leading equals: `(?!=)` rejects a candidate starting with `=`, preserving
  40-, 70- and 120-character separator lines after the key ID.
- Trailing: the character after it is not in `[A-Za-z0-9/+_]`, or there is no
  character after it (end of input), `(?![A-Za-z0-9/+_])`.

`=` is not in either context class, so `id=secret` and `secret=…` behave as they
did under `\b` when the adjacent character was a word character. The
leading-equals guard preserves separator lines that `\b` never matched. Every lookaround is constant width, and the `[\s\S]{0,120}?`
window is bounded, so the regex stays linear (the Issue #3942 rule).

## Evidence

- The implementation changes three library/test files (`worker/deno/lib/secret_redaction.ts`,
  `worker/deno/tests/secret_redaction_test.ts`,
  `worker/deno/tests/secret_redaction_redos_test.ts`); the archived summary and facts are updated too; no `VERSION` or manifest
  change.
- Test run (stdin from `/dev/null`):
  `deno test -A tests/secret_redaction_test.ts tests/secret_redaction_redos_test.ts tests/secret_redaction_bounds_test.ts tests/secret_redaction_markdown_1727_test.ts tests/secret_redaction_boolean_setting_test.ts`
  gave `118 passed | 0 failed`, exit 0 on the corrected head.
- Red-checks, recorded in `pr-summary-4103.facts.json`: dropping the leading
  lookbehind turned red "masks the AWS secret beside its access key id", "a
  temporary (ASIA) key's secret is masked too" and the four #4103 leading and
  trailing-context tests; removing `_` from the leading class turned the
  glued-run test red; dropping the escape alternative turned red the Issue #3857
  JSON-pair test and the backslash-t and backslash-r tests; dropping the hex guard
  turned the git-SHA test red; dropping the trailing lookahead turned red the
  glued-run test and "a word glued to the secret with no backslash is not masked
  (Issue #3857)"; removing `_` or `/` from the trailing class turned the
  glued-run test red; the trailing-`+`-at-end-of-text test turned red when the
  base `\b` rule was used. The new equals-separator test was run before
  adding `(?!=)` and failed because a 40-character separator was redacted;
  the same test passes with the guard, covering 40, 70 and 120 characters.
- Docs sweep: grep: `aws-secret-access-key`, `aws-access-key-id`, `github-token`
  over `worker/deno/lib`, `README.md`, `SECURITY.md`, `CODING-STANDARDS.md`,
  `DESIGN-PRINCIPLES.md` and non-archive `docs/`, and "AWS" over `SECURITY.md`,
  `docs/THREAT-MODEL.md` and `README.md`; section: `SECURITY.md`, "Secret
  Redaction — Every Outbound Sink" (line 301), whose known-shape list at lines
  477-485 still holds because the rule set is unchanged; siblings:
  `aws-access-key-id` (`secret_redaction.ts:498`) and `github-token` (`:402`) are
  unchanged, and no other RULES entry changed; hits: the rule's doc comment in
  `secret_redaction.ts` (lines 447-489) is updated in this PR; `SECURITY.md:480`
  ("AWS access-key ids") is still true; `docs/audits/security-sweep-1217-env-config-secrets.md:271-272`
  ("matched only through the `AKIA…` id that precedes it") is still true, and was
  found by that phrase rather than by the rule names; no other README, SECURITY,
  THREAT-MODEL or non-archive docs hit.

## Test Plan

- Callers checked: the rule is one entry in the RULES table applied by
  `redactSecrets`; no caller passes it a pattern. Other tests that touch
  `redactSecrets` were run and are green: `secret_redaction_bounds_test.ts`,
  `secret_redaction_markdown_1727_test.ts` and
  `secret_redaction_boolean_setting_test.ts` (all in the 118 passed run above).
- Twinned-rule search: none found. `worker/deno/lib/secret_transform_redaction.ts`
  exists and was grepped for `aws-secret-access-key` and `aws-access-key-id`; it
  has no matching rule.
- Persisted-data note: none. `redactSecrets` is a pure function; nothing it
  returns is stored by this change.
- Deno regression: none needed. The change is in a Deno module and uses no Node
  tooling.
- Security self-check: no real secrets are added. The test fixtures are the AWS
  documentation example id (`AKIAIOSFODNN7EXAMPLE`) and synthetic 40-character
  strings. ReDoS: all lookarounds are constant width and the window is bounded;
  the hostile-input linearity test is at `worker/deno/tests/secret_redaction_redos_test.ts:141`.
- Real-tool observation: the behaviour was observed by running the real
  `redactSecrets` in the tests listed under Evidence; no separate `deno eval` run
  was made.
- Not checked in this repair: the full quality gate and full test suite.
  The five redaction suites, Deno formatting and lint were checked locally.
  The existing head's GitHub Quality and Dependency Review workflows passed;
  CI must check the new commit after publication.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
