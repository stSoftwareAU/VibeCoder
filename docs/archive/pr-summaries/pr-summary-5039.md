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

Run the guard, issue-5039 regressions, Markdown-code and PR-body suites:
`deno task test tests/babysitter_pr_body_guard_5039_test.ts
tests/babysitter_pr_body_guard_test.ts tests/markdown_code_spans_test.ts
tests/pr_body_test.ts` from `worker/deno`. At the pushed head all 154 tests in
those four files pass. The independent CommonMark 0.31.2 renderer (a test-only
dependency) reproduced each reported failure before its correction. Full hosted
CI remains required.

## Babysitting review repair

The shared fence reader makes two corrections, each covered by a CommonMark
renderer regression in `worker/deno/tests/babysitter_pr_body_guard_5039_test.ts`
that failed before the fix:

- A backtick in a backtick info string no longer opens a fence, so a real
  trailing code fence cannot masquerade as prose and suppress restoration. The
  regression covers both governing and additional closing references.
- A fence opened inside a list item now ends when a later nonblank line is
  indented less than that item's content, matching CommonMark's container
  rule, and that line is read again as prose or a new opener. Without this, a
  list-exit line followed by a new fence was paired with the old fence's
  closer, so the real trailing fence looked closed and restored closes were
  suppressed or mis-placed. The regression is "list exit followed by a new
  fence cannot suppress restored closes".

Local validation used Deno 2.9.6 and a temporary import map to cached published
standard-library dependencies because direct JSR downloads fail here. Repository
dependency files are unchanged. Full hosted CI and fresh review remain required.

## Thematic-break review repair

The shared Markdown reader now gives thematic breaks precedence over list
markers, as CommonMark requires. A break cannot create a fictitious list
container that exposes fenced closing references or a quoted assignment marker.
The new production-guard regression failed before the fix and passes afterwards;
all 155 tests in the guard, issue-5039, Markdown-code and PR-body suites pass.
Validation used the cached standard-library import map on this host. Hosted CI
remains required.
