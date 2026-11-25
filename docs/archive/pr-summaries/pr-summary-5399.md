# Record the quoted-credential-word prose mask as an accepted cost (Issue #5399)

## Summary

The triage decision on the issue keeps the `secret-assignment` mask on prose
that quotes a credential word, then a colon, then more prose (the title of #5253
is the reported case). This PR changes no production code. It records that false
positive in the secret-assignment section of `SECURITY.md` and pins the current
masking with tests, so the choice is visible and is not reported again. Closes
#5399.

## Spec

### Intent and Rationale

- A quoted credential word followed by a colon and a word cannot be told apart
  from a JSON or YAML field with a bare value, and a missed credential costs
  more than a corrupted word in a title, so the mask stays (the issue's
  2026-11-23 triage decision).

### Essential Design Decisions

- No prose exemption is added to `SECRET_ASSIGNMENT_PATTERN`; quoted keys stay
  never exempt, as `SECURITY.md` already says.
- The new `SECURITY.md` paragraph sits after the existing "The accepted costs
  are two rules." paragraph and is worded as a separate accepted false positive.
  That paragraph's two rules describe credentials left unmasked, so its count is
  unchanged.

### Undiscoverable Facts

- The scope narrowing to "record it and pin it" comes from the triage section of
  the issue body. The dependency #5363 is closed.

## Evidence

Backend/docs only; no UI file is touched. On the milestone head, before any
edit, a probe of `redactSecrets` returned
`… containing "Token": ***REDACTED*** #5251's title …` and
`The word "Tokens": ***REDACTED*** are shown below`, with `containsSecret` true
for both, so the reported behaviour holds and the tests pin it.

## Test Plan

- Added `worker/deno/tests/secret_redaction_quoted_word_prose_5399_test.ts` (4
  tests, no change to existing tests). They drive `redactSecrets` and
  `containsSecret` with literal expectations:
  - the reported title shape masks `PR`, and `containsSecret` is true;
  - the plural `"Tokens":` and single-quoted `'Token':` forms are masked the
    same way;
  - a JSON/YAML field holding a quoted `Token` key and a bare value is masked;
  - control: the bare product heading `TokenBudget: run the agreed trial`
    survives, while its quoted form is masked.
- These tests pin current behaviour (no fix), so they are green on the base
  branch by design.
- `deno test` on the new file: 4 passed.
- `./quality.sh < /dev/null` ran at the head commit: PASSED. The gate itself
  skipped `config integration` and `checkov`.
- Docs: I read the whole secret-assignment section of `SECURITY.md`. Its "quoted
  keys … are never exempt" sentence still holds. I also checked the doc comments
  in `worker/deno/lib/secret_redaction.ts` that say quoted keys stay masked
  (around lines 309 and 720) and the module doc of
  `worker/deno/tests/secret_redaction_prose_heading_5253_test.ts`. All still
  hold, so none was edited.

Not checked: none beyond the gate's own skips.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
