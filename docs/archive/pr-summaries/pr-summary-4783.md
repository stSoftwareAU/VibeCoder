## Summary

`assemblePrBody` now neutralises every closing keyword in the committed summary that names an issue other than the run's governing issue, so a negated phrase copied from an acceptance criterion (`do not close #4674`) no longer closes that issue on merge. Closes #4783.

The keyword word alone is put in a code span (`` `close` #4674 ``). A backtick between keyword and `#N` stops GitHub and raw-regex readers (`extractClosingIssueNumbers` does not mask code) reading a closing reference, and the sentence still reads naturally. Code the summary already holds is left byte-identical. The governing issue's own reference is left to the existing #3177 / #4126 logic, including a qualified cross-repo reference. Text added to the live body by a human is not touched.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A mention was being treated as a fix (the #319 / #4478 bug class); the criterion wording is mandated by the issue prompt, so the agent cannot avoid it and the worker must neutralise at assembly time.
- Wrapping only the keyword (not the whole phrase) was chosen so both GitHub and `extractClosingIssueNumbers` agree the reference is inert.

### Essential Design Decisions

- Assumption: in a cross-repo PR an unqualified `Fixes #N` names the PR's repository, so it is not the governing issue (same rule as `rewriteReference`) and is neutralised. This changes the expectation in the #4644 test (`` `Fixes` #2422 ``).
- The "Not closing" note is built from the neutralised summary so its quoted criteria cannot carry a closing reference either; unmet-criterion detection still reads the raw summary.

### Undiscoverable Facts

- `gh pr view 4779 --json closingIssuesReferences` returned `[4637, 4674]` for the motivating PR.

## Evidence

Backend-only change; verified by tests (below). Related existing rules checked: #3177 / #4126 closing-keyword logic in `missing_criterion_close_guard.ts` and `pr_summary_check.ts`; #3403 marker neutralising. Applying the change to its own summary: this summary names no other issue after a closing keyword.

Callers of `assemblePrBody` (completion phase, summary sync) both go through the changed function, so both inherit it.

## Test Plan

- `worker/deno/tests/pr_body_sync_test.ts`: three new `assemblePrBody` tests (Issue #4783) — other issue not closed (`[4637]` only), governing `Closes #4637` kept, `Part of` with a `missing` entry leaves no closing reference. Red with the neutralise call removed: all three failed.
- `worker/deno/tests/closing_keyword_neutralise_4783_test.ts` (new): code spans/fences left identical, qualified other-repo reference, cross-repo identity, hard-wrapped `close\n#12`, hostile long whitespace input returns unchanged.
- Edited expectation in `worker/deno/tests/missing_criterion_close_guard_3177_test.ts` ("cross-repository partial body preserves unrelated issue links"):
  - Removed from `worker/deno/tests/missing_criterion_close_guard_3177_test.ts`: `assertStringIncludes(body, "Fixes #2422")`
    - Required by: "neutralise every closing keyword in the summary that names an issue other than the run's governing issue"
    - Replaced by: `assertStringIncludes(body, "`Fixes` #2422")` and `assertEquals(extractClosingIssueNumbers(body), [])`
  - Red check: with the neutralise call removed this test fails.
- Run: `deno task test:unit` over the four touched/related test files: 149 passed, 0 failed. `deno fmt`, `deno lint`, `deno check lib/pr_body_sync.ts` clean.
- Docs: `docs/INTERNALS.md` (assemblePrBody paragraph) updated.

Full gate: `./quality.sh` ran on the final head; every stage passed except `deno tests`, whose parallel pass had one failure unrelated to this change: `worker/deno/tests/merge_fast_checks_credentials_4705_test.ts` (spawnFastCheck argv gains the host's `HTTPS_PROXY`/`HTTP_PROXY` entries, i.e. the worker host's proxy environment leaks into the test). The serial pass did not run after that failure. Not checked: the serial test pass.
