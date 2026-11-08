## Summary

`formatWorkerOwnedArchive` now puts each linkage-only line
(`Closes`/`Fixes`/`Resolves #N` or `Part of #N`, optional `owner/repo` prefix,
optional trailing full stop) in a paragraph of its own before `deno fmt` runs,
so `deno fmt` can no longer join `Part of #A` / `Part of #B` into one mid-line
mention. Prose is still re-wrapped. Closes #4802.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- `deno fmt` treats adjacent lines as one paragraph; the reviewer reads
  `Part of #N` only from a line of its own. Fixing it in the worker's own
  pre-format step (beside `canonicalArchiveJson`) keeps the reviewer's rule
  unchanged.

### Essential Design Decisions

- The line is trimmed before matching, so the regex has no overlapping
  whitespace quantifiers (no backtracking risk).
- Lines inside fenced code blocks are left alone.
- The Markdown rewrite shares the JSON rewrite loop, so it is bounded the same
  way: `listPushedFiles` already drops symlinks and paths that resolve outside
  the checkout (it `lstat`s and `realPath`s each name), and the loop now
  `lstat`s each file and skips, with a warning, anything over
  `MAX_ARCHIVE_REWRITE_BYTES` (1 MiB). Skipped files are also left out of the
  `deno fmt` argument list.
- Only the shapes `PART_OF_SAME`/`PART_OF_OTHER` match, plus the closing
  keywords the issue names. Recognising code-formatted or wrapped references is
  owned by #4808, not here.

### Undiscoverable Facts

None.

## Evidence

Backend only. `worker/deno/tests/repo_formatters_4129_test.ts` runs the real
`deno fmt` through `formatBeforeGate`.

## Test Plan

- Added
  `formatBeforeGate keeps adjacent linkage lines on lines of their own and still re-wraps prose (Issue #4802)`
  in `worker/deno/tests/repo_formatters_4129_test.ts`: red with
  `isolateLinkageLines` returning its input (`Part of #1 Part of #2` produced);
  green with the fix.
- Added
  `formatBeforeGate leaves linkage-looking lines inside a code fence adjacent (Issue #4802)`
  in the same file: guards against over-isolation (stays green without the fix
  by design).
- Added unit tests for the exported `isolateLinkageLines` (blank lines only
  where a linkage line touches another line; prose, `` ``` `` and `~~~` fences
  untouched), and real-runner tests for: adjacent prose lines still joined,
  `.markdown` and `.jsonc` files rewritten, an already-canonical file not
  rewritten (mtime unchanged), a symlinked archive file whose outside target is
  left alone, and an over-limit file skipped with a warning. Each of the six
  surviving mutants (`~~~` operand, linkage test, next-line-blank condition,
  `.markdown`, `.jsonc`, `rewritten !== current`) was applied by hand and turns
  a test red.
- `deno task test:unit tests/repo_formatters_4129_test.ts`: 14 passed, 0 failed.
- Verifier finding on symlinks and size: `listPushedFiles` already excludes
  symlinks and symlinked parents, so a symlinked `.md` never reaches the loop
  (covered by the symlink test); the 1 MiB cap is new and covered by the
  over-limit test. The extra `isFile` check was not added because it is
  unreachable after that filter and so cannot be tested.
- Callers of the changed loop: only `formatWorkerOwnedArchive` (via
  `formatBeforeGate`); JSON behaviour unchanged and still covered by the
  existing real-runner test.
- Not checked: other twinned copies of the linkage regex (reviewer's `PART_OF_*`
  in `.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`) were read,
  not changed.
- `./quality.sh`: lint, type check, fmt, markdownlint and semgrep passed; the
  deno test step reported 6 failures (`tests/pr_maintenance_command_test.ts` ×5,
  `tests/merge_fast_checks_credentials_4705_test.ts` ×1). The same 6 fail on an
  untouched checkout of the base commit (28 passed, 6 failed there too), and
  neither file touches `repo_formatters.ts`. Not fixed here (out of scope).
