## Summary

The `aws-secret-access-key` rule in `worker/deno/lib/secret_redaction.ts` (line 477) required `\b` before the 40-character secret. In JSON-encoded or escaped text, such as `"AKIA…\nwJalr…"`, the secret follows a literal `\n`, `\r` or `\t`. The escape letter is a word character beside the secret, so `\b` never fired and the secret leaked. The boundary is now `(?:\b|(?<=\\[nrt]))`. Closes #3857.

## Spec

### Intent and Rationale

- Mask the secret wherever the id-adjacent pairing is real, including inside escaped strings.
- Do not loosen the boundary for arbitrary glued words.

### Essential Design Decisions

- A fixed-length lookbehind on exactly `\n`, `\r` and `\t`, not dropping the boundary entirely. Dropping the boundary would let a 40-character run inside a longer word match.
- The lookbehind is fixed-length and adds no quantifier, so the bounded `{0,120}?` window from Issue #3942 still bounds the backtracking.
- The hex-SHA negative lookahead still applies after the escape.

### Undiscoverable Facts

- A ReDoS fixture made of `a`s after `\n` must be shorter than 39 characters. The `n` of the escape is itself a secret-class character, so `n` plus 39 `a`s forms a 40-character match. The hostile test uses 38 `a`s.

## Evidence

Tests changed:

- `worker/deno/tests/secret_redaction_test.ts`: six new tests:
  - "redactSecrets - a JSON-encoded AWS key pair has its secret masked (Issue #3857)"
  - "redactSecrets - a secret after a literal backslash-t escape is masked (Issue #3857)"
  - "redactSecrets - a secret after a literal backslash-r escape is masked (Issue #3857)"
  - "redactSecrets - a git SHA after a literal backslash-n escape is left alone (Issue #3857)"
  - "redactSecrets - a word glued to the secret with no backslash is not masked (Issue #3857)"
  - "redactSecrets - a backslash before a non-escape letter does not unmask as an escape (Issue #3857)"
- `worker/deno/tests/secret_redaction_redos_test.ts`: one new test, "redactSecrets - a hostile run of escaped AWS key pairs is linear (aws-secret-access-key escape lookbehind, Issue #3857)". It asserts output only, with no stopwatch.

**Docs sweep** — grep: `aws-secret-access-key`, `aws-access-key-id`, `AKIA`, "secret access key" over `*.md` excluding `docs/archive/`; still true: `docs/audits/security-sweep-1217-env-config-secrets.md:140,271-272` (a historical audit; the secret is still matched only beside its id); unrelated to the boundary: `prompts/best_practices/buckets/terraform.md:30`, `prompts/security_scan/prompt.md:676`, `docs/audits/security-sweep-2183-lib-delta-12d-12f.md:419`; section: none; siblings: none — no existing set gained a member (the rule list is unchanged; sibling rules grepped: `aws-access-key-id`, `secret-assignment`); updated: the doc comment above the rule in `secret_redaction.ts`. Related existing rules checked: none. No prompt or standard rule changed.

## Test Plan

- Regression, red on base: 97 passed and 3 failed (JSON, `\t`, `\r`) against the unfixed rule. With the fix: 100 passed.
- Mutations:
  - Revert the lookbehind to `\b`: red on the JSON, `\t` and `\r` tests.
  - Drop `r` from `[nrt]`: red on the `\r` test only.
  - Widen `[nrt]` to `[a-z]`: red on the backslash-before-non-escape-letter test.
- `deno fmt`, `deno lint` and `deno check` are clean.

QUALITY_GATE_RESULT_PLACEHOLDER

<!-- vibe-branch-outcomes -->

Not done or not checked: other escape sequences (`\\`, `\"`, `\uXXXX`) before a secret are not handled. Only `\n`, `\r` and `\t` are accepted, by design. No other redaction rule was audited for the same escape issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
