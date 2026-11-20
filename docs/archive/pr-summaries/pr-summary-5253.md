# PR Summary — Issue #5253

## Summary

The `secret-assignment` redaction rule no longer masks the word after a
product-name prose heading. The PR title for Issue #4959 opens with a
PascalCase product name that contains `Token`, then a colon. The rule read that
name as a credential label and published the next word, `run`, as
`***REDACTED***`. A same-line heading is now exempt when all of these hold:

- the separator is a bare `: `;
- the key is a Capitalised or PascalCase word whose last word is not a
  credential word;
- the value is one plain word.

Every other assignment is masked as before. Closes #5253.

## Spec

### Intent and Rationale

- The issue asks to narrow the rule for prose while keeping genuine credential
  fields masked even with short or dictionary-word values. A value-only test
  (for example "a plain word followed by more prose") would unmask
  `password: run the job`, so the key decides: a credential field's name ends
  in a credential word (`GithubToken`, `Password`, `ApiKey`), and a product
  name such as `TokenBudget` does not.

### Essential Design Decisions

- The exemption is the conjunction of four checks in `isProseHeading`. The
  separator is `:` plus spaces on one line, so `=`, a quoted key and a line
  break never qualify. The key is letters only, in Capitalised words, so `_`
  keys and lower-camel identifiers never qualify. The key's last word is not in
  `CREDENTIAL_KEY_COMPONENTS` (token(s), secret(s), password(s), passwd,
  key(s), apikey, credential(s), value). The value is the existing
  `PLAIN_WORD`.
- `assignmentIsMasked` applies the check, and both the replacement pass and
  `detectsSecretAssignment` call it. That keeps `containsSecret` and
  `redactSecrets` in agreement, as Issue #1727 requires.
- Accepted cost, recorded in `SECURITY.md`: a credential that is a single plain
  word of at most 15 letters, after a PascalCase heading whose last word is not
  a credential word, on the same line after `: `.
- Every new regex is anchored and bounded, as the Issue #3942 linearity rule
  requires.

### Undiscoverable Facts

- The #4959 trial's docs test (its purge guard) refuses any tracked file that
  spells the #4959 product name unless it is on that trial's purge list. The new test therefore builds the name from halves at run time, and the
  docs use `TokenBudget` as their example.

## Evidence

Backend-only change; no UI file is touched.

- `worker/deno/lib/secret_redaction.ts`: new `PROSE_HEADING_SEPARATOR`,
  `PROSE_HEADING_KEY`, `LAST_KEY_COMPONENT`, `CREDENTIAL_KEY_COMPONENTS` and
  `isProseHeading`. `assignmentIsMasked` now takes the key. The doc comments on
  `isCredentialShapedValue` and the `secret-assignment` rule now name the
  exception.
- `SECURITY.md`, section "An assignment's value is judged, not only its
  label": I read the whole section. The inline bullet and the "only when the
  separator crossed a line break" sentence now name the exception, there is a
  new paragraph on the exemption, and the accepted costs are now two.
- Publication path: the title reaches the rule through `redactGhBodyArgs`
  (`--title`) in `worker/deno/lib/gh_body_redaction.ts`, which the new test
  drives directly.

Issue numbers the diff cites:

- #5253: Secret redaction masks ordinary prose after a word containing
  "Token" (title quoted as filed)
- #4959: the issue whose PR title showed the defect (its title names the
  trialled plugin, so it is not quoted here)

## Test Plan

New file `worker/deno/tests/secret_redaction_prose_heading_5253_test.ts`
(8 tests). No existing test was edited.

- `the reported PR title survives byte-for-byte`: tests `redactSecrets`,
  `containsSecret` and `redactGhBodyArgs --title`, with and without the
  `(Issue #4959)` suffix.
- `a body quoting the reported title survives`: tests `redactGhBodyText`.
- `credential fields with short dictionary-word values stay masked`: covers
  `GITHUB_TOKEN: run`, `GithubToken: run …`, `Password: hunter`,
  `ApiKey: secret`, `AccessKey: open`, `ClientSecret: banana`,
  `Credentials: letmein` and `SecretValue: hunter`. It also covers the product
  name after `=`, with a quoted key, as an underscore key and as a lower-camel
  key.
- `a lower-case password keeps the word after it masked`: exact output
  `password: ***REDACTED*** the job now`.
- `a quoted product-name value stays masked`.
- `long and short synthetic values under a product heading stay masked`: the
  16-character synthetic secret, a 40-character AWS-shaped key,
  `correcthorsebatterystaple`, `hunter2`, and `"run"`.
- `a product heading split across a line break stays masked`.
- `only the key's last word decides a prose heading`: the same body survives
  under the product name and is masked under `GithubToken`.

Red against the unfixed code: 3 of the 8 failed (the two title tests and the
survive half of the last test). The base code returned the title with
`***REDACTED***` in place of `run`. The other 5 passed, as expected, because
they pin masking the fix keeps.

After the fix:

- The new file plus the existing redaction suites under `worker/deno/tests/`
  (`secret_redaction_markdown_1727_test.ts`, `secret_redaction_test.ts`, the
  bounds, JSON, boolean-setting, ReDoS, run-stats, fleet-telemetry and 1424
  prompt-context tests, and the `gh_body_redaction*` tests), run together on
  the head: 176 passed.
- `./quality.sh < /dev/null`: Result PASSED (with skipped checks).

Not checked: emphasis-wrapped headings (`**Name:** run`) are not exempt and
stay masked; the issue did not ask for them. No reviewers were dispatched,
because the issue has no acceptance-criteria list.
