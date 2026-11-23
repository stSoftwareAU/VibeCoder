# PR Summary — Issue #5363

## Summary

When a bare `secret-assignment` value starts at the closing quote of a
credential flag's quoted value, the assignment mask now keeps that quote in
front of the placeholder. This lets `secret-cli-flag` pair the flag's quotes and
mask the whole value. Before the fix, `--password 'alpha beta TOKEN='tail`
redacted to `--password ***REDACTED*** beta TOKEN=***REDACTED***` and published
`beta`. It now redacts to `--password ***REDACTED******REDACTED***`. Closes
#5363.

## Spec

### Intent and Rationale

- The issue suggested two fixes: run the flag rule's quoted branch first, or
  keep the quote in front of the placeholder. This PR keeps the quote, which
  changes only `redactAssignmentsOnce` and leaves the rule order alone. The
  `#5310` walk logic reasons about the flag rule running after the assignment
  rule.
- An unrestricted "keep any leading unclosed quote" was tried first. It changed
  the exact output of 44 existing `#5310` tests, so the quote is kept only where
  it really closes a flag value.

### Essential Design Decisions

- A quote is kept only when (a) the masked value is not a matched quoted value,
  (b) the value **starts** at a quote that ends a `secret-cli-flag` quoted value
  (`CLI_FLAG_RULE_G`, read once per walk), and (c) that flag's opening quote
  lies outside every mask of the walk (`flagClosingQuotes`). Widening (b) to a
  quote inside the value, or dropping (c), broke the `#5310 round 13` cases in
  `worker/deno/tests/secret_redaction_label_as_value_5310_test.ts`, and one of
  them published `hunter2abc`. Those cases depend on the walk's own reading of
  where the flag rule closes.
- No new regex was added. The scan reuses `CLI_FLAG_RULE_G`, and one pointer
  walks the in-order masks, so the work stays linear (Issue #3942).
- `containsSecret` is defined as `redactSecrets(text) !== text`, so it follows
  automatically. `detectsSecretAssignment` (the walk's verdicts) did not change.

### Undiscoverable Facts

- The issue leaves the lead-in form to PR #5322 ("that part is reported on the
  PR"), and it stays as it was: `--token 'alpha beta credentials: TOKEN='tail`
  still publishes `beta credentials:`. In that form the walk masks the outer
  `credentials:` value whole (main's result, via `flagQuoteReaches`). One
  attempt to exempt that case in `flagQuoteReaches` broke 7 round-13 tests and
  did not fix the leak, so it was dropped. `SECURITY.md` and the rule comment
  both record this limit.
- The issue's shape only occurs when no later `'` exists in the text. If one
  does, the assignment's quoted branch pairs with it. Repeating the shape on
  several lines takes the other path. That path has its own existing behaviour
  and is the same on the base branch: a quoted value runs across the next line's
  `--password '`, takes the flag's name, and the second line's flag value is
  published. That is a separate defect from this one, and this PR does not
  change it.

## Evidence

Backend-only change, with no UI files. Behaviour was observed by running the
library directly (`deno run`) before and after the change:

| Input                                                              | Base output                                                       | After                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `--password 'alpha beta TOKEN='tail`                               | `--password ***REDACTED*** beta TOKEN=***REDACTED***`             | `--password ***REDACTED******REDACTED***`             |
| `deploy --password 'correct horse battery staple TOKEN:'tail more` | `… ***REDACTED*** horse battery staple TOKEN:***REDACTED*** more` | `deploy --password ***REDACTED******REDACTED*** more` |
| `x TOKEN='tail` (control)                                          | `x TOKEN=***REDACTED***`                                          | unchanged                                             |

A scratch base-vs-fix comparison was run over 200,000 generated inputs built
from flag, quote, label and word fragments, then deleted. It found no input
where the fix's output showed more of a word than the base output, and no
non-idempotent output under either version. The 628 templated single-quote
inputs (`--flag 'alpha beta KEY='…`) that published `beta` on base published
nothing after the fix. The generator never produced the lead-in form.

Provenance numbers in the diff: #5363 (this issue); #5310 (checked:
"secret-assignment rule publishes a credential when its label is consumed as the
value of an earlier credential label", whose round-13 tests are cited); #3942 is
the linearity rule the module header already cites. It could not be re-viewed
this run because the GitHub API rate limit was exhausted.

## Test Plan

- Added `worker/deno/tests/secret_redaction_flag_closing_quote_5363_test.ts`,
  which goes through `redactSecrets` and `containsSecret`. Each case asserts the
  exact output, `containsSecret(input)` true, `containsSecret(output)` false,
  idempotence, and that the leaked words are absent.
  - Five issue-shape cases (`=` and `:` separators, `--password`, `--api-key`
    and `--token`, a cross-line label) and a size case (20,000 closed flag
    values before one instance; output only, no stopwatch). **Red on the unfixed
    code:** all six failed; the first returned
    `--password ***REDACTED*** beta TOKEN=***REDACTED***`. They are green after
    the fix.
  - Three controls, green on base and after the fix: an unclosed quote that
    closes no flag value is still masked with the value; a flag value that
    closed earlier; and a double-quoted flag value, which the bare branch never
    takes.
- No existing test was edited.
  `deno test -A tests/secret_redaction*_test.ts tests/secret_transform_redaction_test.ts tests/prompt_context_secret_redaction_1424_test.ts tests/security_scan_secret_redaction_3047_test.ts`
  (from `worker/deno`): 555 passed, 0 failed.
  `tests/cache_secret_redaction_1261_test.ts` passed too.
- `./quality.sh < /dev/null` on the final code:
  `Result: PASSED (with skipped
  checks)`. The skipped checks were
  `config integration` and `checkov`, which the gate skips here. Deno tests,
  lint, type check, fmt, markdownlint, semgrep and gitleaks all passed.
- Docs: the `secret-assignment` comment in `RULES`, the JSDoc of
  `redactAssignmentsOnce` and the new `flagClosingQuotes`, and a new paragraph
  in `SECURITY.md` → "An assignment's value is judged, not only its label". The
  existing `SECURITY.md` sentence on flags whose quote the walk's mask removes
  (the `--token 'alpha credentials: DEPLOY_TOKEN = 'tail` example) still holds,
  because that shape is not changed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
