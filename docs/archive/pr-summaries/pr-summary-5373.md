## Summary

`SECRET_ASSIGNMENT_PATTERN`'s key group had an unbounded `[A-Za-z0-9_]*` run on
each side of the credential-keyword alternation. On one long run of key
characters that holds many keywords and has no separator after it, the engine
tried every keyword position and rescanned the rest of the run each time, which
was quadratic. The decode-then-rescan pass reaches the same shape when it joins
many short lines into one candidate. Both runs are now `{0,63}`, the bound
`secret-cli-flag` uses for its flag-name runs, so the pattern stays linear (the
Issue #3942 rule). Closes #5373.

## Spec

### Intent and Rationale

- The fix bounds the two runs, which is the first fix the issue suggests and is
  consistent with the sibling `secret-cli-flag` rule. A hand-written key scan
  would have touched the walk, `SECRET_ASSIGNMENT_AT` and every caller of the
  shared pattern.
- An atomic (lookahead-and-backreference) suffix alone would not have been
  enough: each keyword hit would still scan to the end of the run. Bounding both
  sides caps the work at each run start.

### Essential Design Decisions

- `\b` stays, so each run of key characters is tried from its start only.
  Dropping it would let every position in a run start a match, which costs about
  63 times more per character.
- Accepted limit: a key with more than 63 key characters before or after its
  keyword is no longer matched. Credential variable names are far shorter. The
  limit is recorded in `SECURITY.md` and in the rule's comment.
- The rest of the pattern (separator, value branches, lookaheads) is unchanged.
  `SECRET_ASSIGNMENT_AT` is built from the same source, so the walk picks up the
  bound too.

### Undiscoverable Facts

- Triage on the issue put the reviewer comment's joined-lines shape in scope, to
  be fixed in the same change. The new tests cover it.
- Measured on this host (shared and parallel, so indicative only),
  `redactSecrets` on base took 347, 1,231 and 4,654 ms for an unbroken keyword
  run of 24, 48 and 96 KB, and 175, 684 and 2,712 ms for the joined-lines shape
  at 36, 72 and 144 KB. With the fix, the joined-lines shape took 29, 111 and
  470 ms at 144 KB, 576 KB and 2.3 MB, which is linear.
- A long keyword-dense run still costs about 3 µs per character, and so does a
  plain run of letters (`abcdef` repeated) on base. The pattern itself takes
  about 1 ms on 384 KB, so that constant comes from another rule. It is linear,
  and outside this issue.

## Evidence

Backend-only change: no UI files are touched.

- `worker/deno/lib/secret_redaction.ts`: both key-character runs in
  `SECRET_ASSIGNMENT_PATTERN` are `{0,63}`, and the comment above the
  `secret-assignment` rule gains the Issue #5373 paragraph.
- `SECURITY.md`: the "Every rule must be linear in the input length" paragraph
  names this case and its limit. I read the whole "An assignment's value is
  judged" section after it, and nothing there describes the key length.
- Issue numbers the diff adds: #5373: secret-assignment pattern takes quadratic
  time on a long unbroken run of key characters that holds credential keywords.

## Test Plan

New tests in `worker/deno/tests/secret_redaction_redos_test.ts`. They are
output-only with no stopwatch, following the file's header (PR #1170):

- `a long unbroken run of credential keywords passes through unchanged (Issue #5373)`:
  a 512 KB run of `TOKENx` comes back unchanged and `containsSecret` is false. A
  real assignment placed after it is still masked.
- `line-wrapped credential keywords joined by the decode pass stay linear (Issue #5373)`:
  about 1 MB of `MY_TOKEN` lines comes back unchanged and `containsSecret` is
  false. A real assignment on the last line is still masked.
- `a key at the 63-character bound is still masked (Issue #5373)`: the positive
  control at the bound.

Results:

- On base production code (`lib/secret_redaction.ts` restored from
  `origin/milestone/secret-redaction-follow-ups`), the unbroken-run test and the
  joined-lines test each failed to return within the `timeout` (120 s and 90 s;
  exit 124). The fix returns them in well under a second.
- With the fix, every `tests/secret_redaction*_test.ts` file and
  `tests/secret_transform_redaction_test.ts` passed: 614 passed, 0 failed.
- The full `./quality.sh` passed on the head commit (Result: PASSED;
  `config integration` and `checkov` were skipped by the gate itself).
- No existing test or assertion was changed.

Not done or not checked: no reviewer sub-agents ran, because the issue has no
acceptance-criteria heading. The linear per-character cost of another rule on
long letter runs is not addressed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
