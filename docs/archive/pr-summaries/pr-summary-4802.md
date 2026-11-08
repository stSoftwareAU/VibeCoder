## Summary

`formatWorkerOwnedArchive` now puts each linkage-only line
(`Closes`/`Fixes`/`Resolves #N` or `Part of #N`, optional `owner/repo` prefix,
optional full stop, with optional spaces before it) in a paragraph of its own
before `deno fmt` runs, so `deno fmt` can no longer join `Part of #A` /
`Part of #B` into one mid-line mention. Prose is still re-wrapped. Closes #4802.

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
- Lines inside fenced code blocks are left alone. The fence is tracked with the
  shared `parseFenceLine` / `isClosingFence` helpers
  (`worker/deno/lib/markdown_code_spans.ts`), so it closes only on the opener's
  character with a run at least as long.
- The Markdown rewrite shares the JSON rewrite loop, so it is bounded the same
  way: `listPushedFiles` already drops symlinks and paths that resolve outside
  the checkout (it `lstat`s and `realPath`s each name), and the loop now
  `lstat`s each file and skips, with a warning, anything over
  `MAX_ARCHIVE_REWRITE_BYTES` (1 MiB). Skipped files are also left out of the
  `deno fmt` argument list, the diff and the commit; when every archive file is
  skipped the step returns before `deno fmt` runs, because `deno fmt` with no
  paths formats the whole repository.
- The linkage line accepts the shapes `PART_OF_SAME`/`PART_OF_OTHER` match
  (including spaces before the full stop), plus the closing keywords the issue
  names. Recognising code-formatted or wrapped references is owned by #4808, not
  here.

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
  untouched; a fence closes only on the opener's character and length), and
  real-runner tests for: adjacent prose lines still joined, `.markdown` and
  `.jsonc` files rewritten, an already-canonical file not rewritten (mtime
  unchanged), a symlinked archive file whose outside target is left alone, and a
  `~~~` block holding a `` ``` `` line followed by adjacent linkage lines plus a
  nested `` ```` / `` ``` `` sample that stays byte-for-byte unchanged.
- PR #4940 review fixes, each red on the previous head:
  - All archive files over the cap:
    `formatBeforeGate skips an archive file over the size limit and never formats the rest of the repository (Issue #4802)`
    uses a root `deno.json`, an unformatted `src/main.ts` and a README with
    adjacent `Part of` lines; it checks every file is unchanged, no formatter
    commit, `git status --porcelain` empty and no `deno fmt` log. Reverting
    `lib/repo_formatters.ts` makes the run not finish within 200 s (the whole
    repository, including the 2 MiB file, is formatted). The sibling
    `formatBeforeGate still formats the other archive files when one is over the size limit (Issue #4802)`
    covers the partial skip.
  - Fence tracking:
    `isolateLinkageLines closes a fence only on the opener's character and length`
    and
    `formatBeforeGate keeps linkage lines apart after a mixed-fence block and leaves a nested sample untouched`
    fail with the old `inFence` toggle (`Part of #3 Part of #4` produced).
  - Twinned rule:
    `isolateLinkageLines accepts the same Part of shapes as the reviewer's PART_OF_SAME and PART_OF_OTHER`
    runs both matchers over one table of variants (space before the full stop,
    `owner/repo` prefix, letter case, rejects); it fails on `Part of #5 .` with
    the old regex. `PART_OF_SAME` and `PART_OF_OTHER` are now exported from
    `test_change_policy.ts` for it. Reviewer patterns accept only `Part of`; the
    formatter also isolates `Closes`/`Fixes`/`Resolves`, so the table is
    `Part of` only.
- `deno test -A tests/repo_formatters_4129_test.ts` plus the two
  `review_fleet_prs_test_policy_*_4655_test.ts` files that load
  `test_change_policy.ts`: 145 passed, 0 failed at head
  (`worker/deno/tests/repo_formatters_4129_test.ts` holds 18 tests at head).
- Verifier finding on symlinks and size: `listPushedFiles` already excludes
  symlinks and symlinked parents, so a symlinked `.md` never reaches the loop
  (covered by the symlink test); the 1 MiB cap is new and covered by the
  over-limit test. The extra `isFile` check was not added because it is
  unreachable after that filter and so cannot be tested.
- Callers of the changed loop: only `formatWorkerOwnedArchive` (via
  `formatBeforeGate`); JSON behaviour unchanged and still covered by the
  existing real-runner test.
- Twinned copy of the linkage regex: the reviewer's `PART_OF_*` in
  `.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`, now pinned to
  the formatter by the drift test above.
- `./quality.sh`: lint, type check, fmt, markdownlint and semgrep passed; the
  deno test step reported 6 failures (`tests/pr_maintenance_command_test.ts` ×5,
  `tests/merge_fast_checks_credentials_4705_test.ts` ×1). The same 6 fail on an
  untouched checkout of the base commit (28 passed, 6 failed there too), and
  neither file touches `repo_formatters.ts`. Not fixed here (out of scope).
