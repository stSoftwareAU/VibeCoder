# PR Summary — Issue #5215

## Summary

The dummy-test scan now judges a test registered with a callback by the
callback's body, not by the registration's argument span. It handles
`Deno.test("x", check)`, `Deno.test({ name, fn: check })` and a registration
helper such as `Deno.test({ name, ignore: cond, fn })`. Before this change the
scan gave a definitive `no-assertion` finding for every registration helper,
whatever its callers passed. For a helper, the scan now judges the callback
argument at each call of the helper in view. A callback defined in view that
asserts nothing is still refused. A callback the diff cannot resolve becomes an
`unseen` checklist note, never a finding. Closes #5215.

## Spec

### Intent and Rationale

- The base scanner passed the whole registration argument span to `judge`. For a
  wrapper, that span holds only `{ name, ignore, fn }`, so a useful test was
  refused (PR #5214, `aws_emulator_run_5109_test.ts:283`).
- The fix resolves the callback where the scan already resolves helpers: from
  function definitions in view (`definitionSpans`). The scan stays deterministic
  and diff-only.

### Essential Design Decisions

- A registration whose callback is a parameter of the enclosing function
  (`registrarOf`) is not judged at the registration. Each call of that helper in
  the same file is judged instead: an inline callback by its body, a named one
  by its definition. A helper with no call in view is an `unseen` note on its
  `Deno.test` line.
- A callback passed by name that is not defined in view (imported, say) is an
  `unseen` note. This reuses the existing uncertain path and its checklist item,
  whose wording now also names "the callback it registers".
- Wrappers are not suppressed. A helper call whose callback asserts nothing is
  refused on the call line.

### Undiscoverable Facts

- The issue's reproduction (a new-file diff of the `register` helper) gave
  `no-assertion` on line 3 against the base scanner. The first test below
  reproduces it.

## Evidence

Backend/CLI-only change: no UI files.

```mermaid
flowchart TD
    R["Deno.test(...) in view"] --> C{"callbackName"}
    C -- "inline callback" --> J["judge the inline body (as before)"]
    C -- "named, not a parameter" --> D{"defined in view?"}
    D -- yes --> JB["judge that definition's body"]
    D -- no --> N["unseen note"]
    C -- "parameter of the enclosing helper" --> H{"helper called in view?"}
    H -- yes --> JC["judge each call's callback argument"]
    H -- no --> N
```

- Corpus run, before and after: every tracked `worker/deno/tests/*_test.ts` and
  `.claude/**/*_test.ts` file was scanned as a new-file diff, first with the
  base `dummy_test_scan.ts` and then with the head copy.
  - Base: 144 findings and 268 notes. Head: 141 findings and 268 notes.
  - The only difference is three base findings that are gone at head:
    `aws_emulator_run_5109_test.ts:283` (the issue's case),
    `setup_ps1_test.ts:116` and `setup_ps1_update_mode_test.ts:151`.
  - Each of the three is a `pwshTest` or `testAsOrdinaryUser` wrapper whose call
    sites pass asserting callbacks, so all three were false positives. The run
    added no finding and no note.
- Regexes on untrusted text that the change adds: `CALL_NAME`, `PARAM_NAME`,
  `FN_PROPERTY` and `FUNCTION_HEAD` (`IDENT` is fully anchored).
  - `CALL_NAME`'s lookbehind allows one start per identifier run. `PARAM_NAME`
    and `FN_PROPERTY` are anchored. `FUNCTION_HEAD` runs on a 40-character
    slice.
  - A hostile case with a 50,000-character run covers the first three; each one
    asserts its result.

## Test Plan

Tests added to `worker/deno/tests/dummy_test_scan_5016_test.ts`. No existing
assertion was edited or removed.

- `a registration helper's asserting callback is accepted (Issue #5215)`: the
  issue's own reproduction.
- `a helper with the issue's options shape and an asserting callback is
  accepted (Issue #5215)`:
  the `testAsOrdinaryUser` shape from PR #5214.
- `a registration helper's dummy call is refused on its call line, not the
  helper's (Issue #5215)`:
  an assertion-free callback passed through a helper is still refused, beside an
  accepted asserting call.
- Named callbacks:
  - `a named callback defined in view and asserting is accepted (Issue #5215)`
    covers the positional, `fn:` and helper forms.
  - `a named callback defined in view that asserts nothing is refused on each
    registration (Issue #5215)`
    and
    `a helper call passing a named callback
    that asserts nothing is refused on the call line (Issue #5215)`
    cover a resolved callback that really asserts nothing.
- Unresolved callbacks:
  - `a callback not defined in view is a note, not a finding (Issue #5215)`.
  - `a registration helper whose calls are not in view is a note on its
    Deno.test line (Issue #5215)`.
- `an inline options callback is judged as before (Issue #5215)`: the existing
  inline path, positive and negative.
- `a registration helper call nested in another call is judged (Issue #5215)`
  and
  `a helper call directly inside a call's parentheses is judged (Issue
  #5215)`:
  helper calls that are not at statement level.
- `registration patterns stay linear on long hostile runs (Issue #5215)`: the
  hostile regex cases described under Evidence.

Results:

- Red against base: with the base `worker/deno/lib/dummy_test_scan.ts` restored
  and the new tests kept, `deno test
  tests/dummy_test_scan_5016_test.ts`
  reported 9 failures. Those are the nine tests above whose expectation differs
  on base.
  `a named callback defined in
  view that asserts nothing is refused on each registration`
  and the inline test pass on base too, as intended: the base scanner already
  refused them. The hostile test was added after this run.
- Head: `deno test tests/dummy_test_scan_5016_test.ts` gave 38 passed and 0
  failed. `tests/dummy_test_scan_wiring_5016_test.ts` gave 3 passed.
- `./quality.sh < /dev/null` passed on the final code head, with the
  config-integration and checkov stages skipped. `deno task
  pr-summary-check`
  reported 0 gates blocked.

Docs updated: `CODING-STANDARDS.md` (the dummy-test scan bullets under **Dummy
tests and "how" tests are refused**) and `docs/review-checklists.md` (the
dummy-test-scan paragraph), plus the module doc in `dummy_test_scan.ts`. The
checklist item text and the review intro in `dummyTestNotesReview` now name the
registered-callback case. The consumers in
`.claude/skills/review-fleet-prs/scripts/gate.ts`, `post.ts` and
`worker/deno/lib/pre_pr_verifier.ts` use the unchanged `scanDummyTests` API.

Issue numbers cited: #5215: Dummy-test scan mistakes a callback registration
wrapper for an assertion-free test; #5065: Dummy-test scan reads a helper's
object-literal return type as its body…; #5016: Review refuses dummy tests and
"how" tests, with a deterministic dummy-test scan; #5109: Container: add the
official AWS Emulator with an isolated test runner.

Not done or not checked:

- Rust registrations are unchanged: the issue concerns Deno only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
