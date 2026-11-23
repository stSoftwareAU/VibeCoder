## Summary

The `secret-cli-flag` rule read a credential flag's quoted value as
`"[^"]+"|'[^']+'|\S+`, so a `--token` flag followed by the value
`"ab\"cdSECRETtail"` had only `"ab\"` masked, and `cdSECRETtail"` (the rest of
the credential) was published. The rule and the walk's two copies of it
(`CLI_FLAG_AT`, `CLI_FLAG_RULE_G`) are now built from one shared value pattern,
`CLI_FLAG_VALUE`. It carries the escape-aware quoted branches Issue #5327 gave
`SECRET_ASSIGNMENT_PATTERN`, so a flag value holding an escaped quote of its own
kind is masked whole. Closes #5435.

## Spec

### Intent and Rationale

- This is the flag-rule twin of #5327. It reuses #5327's branches unchanged: a
  backslash pair in either quote kind, plus `''` and `'\''` in single quotes,
  each bounded at 4,096, with the old branches kept as the fallback.
- The three copies of the value pattern now share one constant, so the walk
  always reads a flag's value the same way the rule masks it, and the copies
  cannot drift apart again.

### Essential Design Decisions

- The flag-name runs, lookaheads, capture groups and flags (`gi`, `iy`, `gi`) of
  all three regexes are unchanged. Only the value alternation differs.
- The mask still removes the quotes (`--token ***REDACTED***`), as it did before
  for a plain quoted flag value.
- A value whose escape never closes (the value `"C:\dir\"` after `--token`), or
  one past the 4,096 bound, still ends at the first quote. That is the base
  behaviour.

### Undiscoverable Facts

- Triage comment on the issue: #5435 covers only escaped quotes inside a flag
  value. #5456 (nested assignment consuming the closing quote) and #5457
  (unterminated assignment across a line break) are separate issues, so this PR
  does not touch them.
- Triage also asked for fixtures that do not trip gitleaks (#5434). The new
  tests use low-entropy values (`cdSECRETtail`), and
  `gitleaks dir --config .github/gitleaks.toml` reports no leaks on the new
  file.

## Evidence

This is a backend-only change (`worker/deno/lib/secret_redaction.ts`).

- **Failing first:** the new test file was run against the unfixed rule. The six
  escaped-quote cases, the three walk cases and the many-flags linearity case
  failed. For example, the issue's own input left `cdSECRETtail"` unmasked.
  After the fix, all 15 tests pass.
- **Walk stays in step:** on the unfixed code, a `--password` flag whose value
  is `'al\'pha beta`, followed by a `TOKEN=` label, published `pha beta`. With
  the fix, every copy reads the same value, so the whole value is masked.
- **Linearity (Issue #3942):** each escape-aware branch is bounded. Hostile
  inputs (20,000 unclosed `\"`, 20,000 `''`, 10,000 `'\''`, and 5,000 flags)
  each returned in milliseconds on a scratch copy. That timing is indicative
  only, from a shared host. The tests assert output only.
- **Docs:** `SECURITY.md` gains a paragraph after the Issue #5327 one, stating
  that a credential flag's quoted value is masked whole, with the same two
  limits. I grepped the repo for `secret-cli-flag` and for the old
  `"[^"]+"|'[^']+'|\S+` value outside `docs/archive/`. The only hits are this
  file and `SECURITY.md`. I also re-read the doc comments of `CLI_FLAG_AT`,
  `CLI_FLAG_RULE_G`, `flagClosingQuotes` and `flagQuoteReaches`, and they are
  still accurate.
- **Issue numbers this diff cites:** #5435: secret-cli-flag rule masks a quoted
  flag value only up to an escaped quote and publishes the rest; #5327:
  secret-assignment rule masks a quoted value only up to an escaped quote and
  publishes the rest.

## Test Plan

- Added
  `worker/deno/tests/secret_redaction_cli_flag_escaped_quote_5435_test.ts`, with
  15 tests that go through `redactSecrets` and `containsSecret`:
  - **Escaped quotes:** a backslash-escaped `"` and `'`, a doubled `''`, and the
    `'\''` idiom (the following flag is kept).
  - **Whitespace:** an escaped quote followed by whitespace. This is the issue's
    `\S+` fallback half.
  - **Glued text:** text right after the closing quote is kept.
  - **Walk in step:** three cases where the `secret-assignment` walk meets an
    escaped flag value.
  - **Controls:** a plain quoted value, an escape that never closes, and an
    escaped backslash before the closing quote.
  - **Linearity:** three output-only cases.
  - Each case asserts the exact output, `containsSecret` false on that output,
    that a second pass changes nothing, and that the secret tail is gone.
- No existing test was edited.
- `deno test -A tests/secret_redaction_*_test.ts tests/redacted_text_test.ts`:
  554 passed, 0 failed.
- `./quality.sh`: every stage passed up to and including `deno tests` (841.9s)
  and `deno lint`. Then my 900s timeout stopped the gate before its last two
  stages. I ran those directly on the same head: `deno task check` passed (exit
  0), and `deno fmt --check` passed (3,905 files).

<!-- vibe-quality-gate-skipped reason="./quality.sh hit the run's 900s bound after deno tests and deno lint passed; its remaining type-check and fmt stages were run directly (deno task check, deno fmt --check) and passed" -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
