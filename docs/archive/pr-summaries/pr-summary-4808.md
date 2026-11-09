## Summary

`ensurePrReferencesIssue` now decides whether the PR body already closes the
issue the way GitHub does: Markdown code (code spans and fences) is masked out
first (each in-code character becomes a non-space placeholder, so a code span
between the keyword and `#N` cannot join them), and the keyword and `#N` must
sit on the same line. A summary whose only `Closes #N` is in backticks, in a
fenced block, or wrapped as `Closes` / `#N` now gets `Closes #N` appended, as
`prompts/issue/prompt.md` promises. Closes #4808.

## Spec

### Intent and Rationale

- GitHub ignores a closing keyword in code and one split from `#N` by a line
  break, so the appender wrongly counted both and the PR merged without closing
  its issue.
- The fix lives in the appender's own check (a private same-line pattern over
  `maskMarkdownCode` output). The shared `hasClosingKeyword`,
  `closingKeywordLine` and `extractClosingIssueNumbers` keep their looser
  behaviour, because other readers (for example the hard-wrapped phrase in
  `closingKeywordLine`) rely on it.

### Essential Design Decisions

- When the body ends inside an unclosed fence, an appended `Closes #N` would be
  swallowed by the fence, so the keyword is placed first instead; the result is
  re-checked with the same masked test.
- The appender's reference test no longer guards with `Number.isSafeInteger`:
  the equality against a real (safe) issue number makes it dead.
- `pr_summary_check.ts` route 1 ends in a single conditional return, so no
  unreachable `return undefined` remains.

- A qualified `owner/repo#N` reference never matched the pattern, so a body that
  only has one still gets the plain `Closes #N` appended (pinned by test).
- The withheld-close path (`withholdIssueClose`) and the cross-repo early return
  in `assemblePrBody` are unchanged and still run before the appender.
- `pr_summary_check.ts` route 1 (#4126) calls the same function, so a summary
  saying `Part of #N` with a closing keyword only in code is now correctly
  reported as blocked: the worker would append `Closes #N`. The one existing
  test that expected a pass for that input was updated.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. Behaviour is pinned by tests in
`worker/deno/tests/pr_body_test.ts` and
`worker/deno/tests/pr_body_sync_test.ts`.

## Test Plan

- `worker/deno/tests/pr_body_test.ts`: code span, fenced block, `Closes\n#42`,
  plain same-line close (unchanged), code span plus real close (unchanged),
  qualified reference, long whitespace run, a code span between keyword and `#N`
  (`Closes \`x\` #42`), and a body ending in an unclosed fence (the close is led
  with and survives masking).
- `worker/deno/tests/pr_body_sync_test.ts`: `assemblePrBody` with a code-span
  close yields a body where `extractClosingIssueNumbers(maskMarkdownCode(body))`
  includes 42; a withheld (`partial`) closure does not gain a prose close.
- `worker/deno/tests/pr_summary_check_test.ts`: the #4126 code-span-close case
  moved to its own test and now expects `blocked`; `lib/pr_summary_check.ts` doc
  comment updated to match.
- Red check: with the appender's decision reverted to
  `hasClosingKeyword(prBody,
  issueNumber)`, the code-span, fence, line-break
  and `assemblePrBody` tests fail; restored, they pass.
- Not checked: nothing outstanding beyond the full gate result recorded by the
  worker.
