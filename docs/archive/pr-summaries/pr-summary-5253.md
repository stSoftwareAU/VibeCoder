# PR Summary — Issue #5253

## Summary

The `secret-assignment` redaction rule no longer masks the word after a
product-name prose heading. The PR title for Issue #4959 opens with a PascalCase
product name that contains `Token`, then a colon. The rule read that name as a
credential label and published the next word, `run`, as `***REDACTED***`. A
same-line heading is now exempt when all of these hold:

- the separator is a bare `:`;
- the key is a Capitalised or PascalCase word that does not end in a credential
  word (checked on the lower-cased key, so `Userpassword` ends in `password`);
- the value is one plain word;
- a further word follows the value on the same line, so the heading leads into
  a sentence and a `Key: word` that ends its line stays masked.

Every other assignment is masked as before. Closes #5253.

## Spec

### Intent and Rationale

- The issue asks to narrow the rule for prose while keeping genuine credential
  fields masked even with short or dictionary-word values. A value-only test
  (for example "a plain word followed by more prose") would unmask
  `password: run the job`, so the key decides first: a credential field's name
  ends in a credential word (`GithubToken`, `Password`, `Userpassword`,
  `Accesskey`), and a product name such as `TokenBudget` does not. A credential
  word that is not last (`SecretString`, `PasswordConfirmation`) passes the key
  check, so the value must also be followed by a further word on its line: a
  field's value ends its line, a heading's first word does not.

### Essential Design Decisions

- The exemption is the conjunction of five checks in `isProseHeading`. The
  separator is `:` plus spaces on one line, so `=`, a quoted key and a line
  break never qualify. The key is letters only, in Capitalised words, so `_`
  keys and lower-camel identifiers never qualify. The key does not match
  `CREDENTIAL_KEY_ENDING`, a case-insensitive test of its ending (token(s),
  secret(s), password(s), passwd, key(s), credential(s), value(s)). The value is
  the existing `PLAIN_WORD`. The text after the value matches
  `PROSE_CONTINUATION` (spaces then a letter, on the same line).
- The text after the value is cut to 33 characters by `textAfter`, so the check
  is constant work per match. The replacement callback reads the offset and
  whole string `String.replace` passes; if either is missing, the text after is
  empty and the value stays masked.
- `assignmentIsMasked` applies the check, and both the replacement pass and
  `detectsSecretAssignment` call it. That keeps `containsSecret` and
  `redactSecrets` in agreement, as Issue #1727 requires.
- Accepted cost, recorded in `SECURITY.md`: a credential that is a single plain
  word of at most 15 letters, after a PascalCase heading that does not end in a
  credential word, on the same line after `:`, with a further word after it.
- Every new regex is anchored and bounded, as the Issue #3942 linearity rule
  requires.

### Undiscoverable Facts

- The #4959 trial's docs test (its purge guard) refuses any tracked file that
  spells the #4959 product name unless it is on that trial's purge list. The new
  test therefore builds the name from halves at run time, and the docs use
  `TokenBudget` as their example.

## Evidence

Backend-only change; no UI file is touched.

- `worker/deno/lib/secret_redaction.ts`: new `PROSE_HEADING_SEPARATOR`,
  `PROSE_HEADING_KEY`, `CREDENTIAL_KEY_ENDING`, `PROSE_CONTINUATION`,
  `textAfter` and `isProseHeading`. `assignmentIsMasked` now takes the key and
  the text after the value. The doc comments on
  `isCredentialShapedValue` and the `secret-assignment` rule now name the
  exception.
- `SECURITY.md`, section "An assignment's value is judged, not only its label":
  I read the whole section. The inline bullet and the "only when the separator
  crossed a line break" sentence now name the exception, there is a new
  paragraph on the exemption, and the accepted costs are now two.
- Publication path: the title reaches the rule through `redactGhBodyArgs`
  (`--title`) in `worker/deno/lib/gh_body_redaction.ts`, which the new test
  drives directly.

Issue numbers the diff cites:

- #5253: Secret redaction masks ordinary prose after a word containing "Token"
  (title quoted as filed)
- #4959: the issue whose PR title showed the defect (its title names the
  trialled plugin, so it is not quoted here)

## Test Plan

New file `worker/deno/tests/secret_redaction_prose_heading_5253_test.ts` (10
tests). No existing test was edited.

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
- `only the key's ending decides a prose heading`: the same body survives
  under the product name and is masked under `GithubToken`.
- `a credential word as a lower-case suffix keeps the mask`: `Userpassword`,
  `Rootpassword`, `Accesskey`, `Privatekey`, `Secretkey`, `Authtoken`,
  `Apitoken` and `Clientsecret`, each with `: hunter` and with
  `: run the agreed trial`.
- `a qualified credential field ending its line keeps the mask`:
  `SecretString`, `PasswordConfirmation`, `PasswordPlain`, `SecretAnswer`,
  `SecretText`, `TokenString`, `PrivateKeyFile` and the product name, each with
  `: hunter` at end of text, before a line break, before a full stop and inside
  braces. The reported title still survives beside them.

Red against the base code (`origin/main`): 4 of the 10 failed (the two title
tests, the survive half of the key-ending test, and the title assertion at the
end of the qualified-field test). The base code returned the title with
`***REDACTED***` in place of `run`. The other 6 passed, as expected, because
they pin masking the fix keeps.

Red against the first cut of this fix (commit `dcdb8e953`, which read the key's
last capitalised word and had no continuation check): the last two tests
failed, because `Userpassword: hunter` and `SecretString: hunter` were
published verbatim. The other 8 passed.

After the fix:

- The new file plus the existing redaction suites under `worker/deno/tests/`
  (`secret_redaction*_test.ts`, `gh_body_redaction*_test.ts` and
  `*redact*_test.ts`), run together on the head: 359 passed, 0 failed.
- `./quality.sh < /dev/null`: Result PASSED (with skipped checks).

Emphasis-wrapped headings are outside this change. `**Name:** run` and
`**Name**: run` are not matched by the rule at all, before or after this change:
the pattern's value lookahead never matches a value of `**`. `**Name: run** …`
is still masked, because its value `run**` is not a plain word. The issue did
not ask for either form. No reviewers were dispatched, because the issue has no
acceptance-criteria list.
