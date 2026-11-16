## Summary

Restore effective closing references and trusted live markers when the babysitter
rewrites a PR body. Use the shared GitHub-effective reference reader so
line-wrapped or code-split impostors cannot suppress restoration.

Closes #5039.

## Design

If a proposal contains a backtick or tilde fence delimiter, put restored
references and live markers before the proposal. This avoids relying on a
partial Markdown scanner to decide which fence, if any, needs closing. Normal
bodies without fence delimiters retain their trailing reference block. No
synthetic fence is emitted; proposal code remains unchanged. Existing trust,
withholding, marker neutralisation and body-size checks remain in force.

## Review repair and validation

Removed the newly introduced unclosed-fence scanner and its direct unit test:
it was inaccurate across list exits and invalid backtick info strings and is no
longer needed by production. A pinned CommonMark renderer independently checks
both reported cases through the real production guard: the restored close is a
paragraph and the live marker is an HTML comment, never escaped code.

Two existing tests adapt to the deliberate block placement: the restored close
may start the body, and the partial-work block precedes a fenced proposal. Their
closing-reference and verbatim-proposal contracts remain. Governing issue #5039
requires: "Compose restored references and worker markers outside code fences
(or safely close the fence before appending)." The new renderer regression and
existing withholding tests cover that requirement.

## Acceptance Criteria

- **met** — Unclosed trailing fences preserve effective closes and live markers,
  including list-exit and invalid-info cases — evidence: renderer regression in
  `worker/deno/tests/babysitter_pr_body_guard_5039_test.ts`.
- **met** — Hard-wrapped and code-split impostors cannot suppress restoration —
  evidence: production-guard regressions in the same file.
- **met** — Supported colon, URL and qualified references remain effective and
  unduplicated — evidence: shared-reference and guard regressions.
- **met** — Partial work remains non-closing; code cannot forge trusted markers —
  evidence: existing withholding and hostile-input guard tests.

## Test Plan

Run the guard, issue-5039 regressions, Markdown-code and PR-body suites. The
independent renderer reproduced the list-exit failure before the correction.
All 152 focused tests pass after the correction. Full hosted CI remains required. CommonMark 0.31.2 is a test-only dependency.
