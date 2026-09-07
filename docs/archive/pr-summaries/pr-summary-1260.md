# Console redaction masks `Error` message, stack and cause (Issue #1260)

## Summary

`installConsoleRedaction` redacted string arguments only, so the everyday
`console.error(err)` spelling printed an `Error` unmasked — and several modules
build error messages by interpolating raw subprocess stderr
(`lib/repo_credentials.ts`, `lib/security_tree_sweep.ts`, `lib/benchmark.ts`),
which is exactly the shape that carries a tokenised clone URL.

`worker/deno/lib/console_redaction.ts` now routes each argument through
`redactArgument`: strings are redacted as before, an `Error` is replaced by a
redacted **copy** (`message`, `stack` and a `cause` chain masked), and every
other value still passes through untouched so `console.log(obj)` keeps its
structured formatting. Both `message` and `stack` are masked because the stack
normally repeats the message — masking either alone still leaks.

Design notes:

- **The caller's error is never mutated.** The copy carries the original's
  prototype and own property descriptors, so a subclass keeps its identity and
  the inspector renders the same shape; control flow that inspects the original
  error still sees the unmasked value.
- **`cause` is followed to a fixed depth of 4**, not tracked with a cycle set: a
  rethrow that reuses the same error is self-referential in the wild, and a
  depth cap terminates on that without identity bookkeeping. Deno's inspector
  prints `cause`, so leaving it unmasked would have reopened the same hole.

Closes #1260.

## Evidence

Backend-only change with no web interface to screenshot. Evidence is the test
run — the four new `Error` cases fail against the unfixed code and pass after
the fix:

```text
# before the fix (unfixed lib/console_redaction.ts)
FAILED | 7 passed | 4 failed (16ms)
  installConsoleRedaction - masks a secret in an Error message and stack
  installConsoleRedaction - masks a secret in a nested Error cause
  installConsoleRedaction - keeps the Error subclass and its own properties
  installConsoleRedaction - a self-referencing cause chain terminates

# after the fix
ok | 11 passed | 0 failed (5ms)
```

**Regression test linkage.** Added
`worker/deno/tests/console_redaction_test.ts::installConsoleRedaction - masks a secret in an Error message and stack`,
which constructs `new Error("clone failed with ghp_…")`, pushes it through the
patched `console.error`, and asserts the token is absent from both `message` and
`stack`. It was observed **failing against the unfixed code** (the raw `Error`
was passed through) and **passing after the fix**.

**Original trigger closed, no trivial bypass.** The reported trigger —
`console.error(err)` where `err.message` interpolates raw subprocess stderr — is
now masked: `redactArgument` intercepts every `Error` before the original
console method is applied, and `redactError` masks `message`, `stack` and the
`cause` chain, which are the only text surfaces Deno's inspector renders for an
error. The near-miss bypasses are covered too: a secret hidden in `stack` rather
than `message` (both are masked), a secret in a wrapped `cause` (followed to
depth 4), an `Error` subclass (`instanceof Error` matches subclasses, and the
copy preserves the prototype), and a self-referencing `cause` (the depth cap
terminates). Non-`Error` objects remain unredacted by design — that is the
pre-existing structured-output trade recorded in the module docstring and it is
unchanged by this PR.

## Test Plan

Added to `worker/deno/tests/console_redaction_test.ts` (existing tests
unmodified):

- `installConsoleRedaction - masks a secret in an Error message and stack`
- `installConsoleRedaction - leaves the caller's Error unmutated`
- `installConsoleRedaction - masks a secret in a nested Error cause`
- `installConsoleRedaction - keeps the Error subclass and its own properties`
- `installConsoleRedaction - a self-referencing cause chain terminates`

Run: `deno test --allow-all tests/console_redaction_test.ts` → 11 passed.
