# PR Summary — Issue #3316

## Summary

Closes #3316

The pre-commit safety gate's `/.*\.secret\.json$/` entry in `FORBIDDEN_STAGED_PATTERNS` backtracked quadratically on a long staged path that did not end in `.secret.json`. It is now the plain suffix match `/\.secret\.json$/`. The Issue #3311 secrets growth test, which had to call its regex directly to step round this entry, now goes through `classifyStagedPath` again.

## Spec

### Intent and Rationale

`classifyStagedPath` runs every staged path through `FORBIDDEN_STAGED_PATTERNS`. An unanchored leading `.*` followed by a literal and `$` restarts at every offset and rescans to the end each time. That cost about 1.5 s at 10k characters and 23.6 s at 40k, so a hostile or accidental long path could stall a commit.

### Essential Design Decisions

- **`/\.secret\.json$/`, not `/(^|\/)[^/]*\.secret\.json$/`.** Both appear in the issue. They match the same set as the old pattern: any path whose input ends in `.secret.json`. Without the `m` flag, `$` matches only at the end of the input, and `.*` could already be empty. The plain suffix has no quantifier left to backtrack, so it is the simplest linear form.
- **One hostile case through the real entry point.** The new test calls `classifyStagedPath` on `"x".repeat(n)`, a long run with no `.secret.json` suffix. That is the input that drove every start offset of the old pattern to rescan to the end.

### Undiscoverable Facts

- The Issue #3311 secrets growth test and the comment on its config growth test both worked round this entry. Both are now restored to the plain `classifyStagedPath` form.

## Evidence

- **Red on base.** I added the new growth test before the fix and ran it alone against the unfixed pattern:
  `AssertionError: classifyStagedPath, long path with no .secret.json suffix: 5000 chars took 10 ms but 20000 chars (4.0x) took 167 ms, over the 82 ms a linear rule allows — the rule is super-linear`.
- **Green after the fix:** `ok | 1 passed` in 2 ms. The whole file gave `ok | 55 passed | 0 failed`.
- **Docs sweep** — grep: `\.\*\\?\.secret`, `secret\\\.json`, `secret\.json`. Section: `SECURITY.md` "Protected Patterns". Updated: none. Only two places quote a regex for this rule:
  - `worker/deno/lib/pre_commit_safety.ts:50` is the change itself.
  - `hooks/pre-commit:43` already uses the suffix form.

  The other `*.secret.json` hits list the same glob-style path set, which this change leaves unchanged, so each stays true: CODING-STANDARDS.md:1094, SECURITY.md:678-680, prompts/coding_guidelines/prompt.md:1017-1020, prompts/security_scan/prompt.md:919, docs/ADD-REPO.md:291 and worker/deno/lib/gitignore_enforcer.ts:9.

## Test Plan

- `worker/deno/tests/pre_commit_safety_test.ts`:
  - new: "classifyStagedPath - secret.json pattern stays linear on hostile input (Issue #3316)";
  - changed: the Issue #3311 secrets growth test now calls `classifyStagedPath`;
  - existing tests still pass: `foo.secret.json` and `api-key.secret.json` are classified as violations.
- **Mutation check.** With `.*` restored, the new test goes red. This is the base-branch run quoted under Evidence.
- **Branch outcomes:** none added. The change replaces one regex literal and adds no condition.
- **Quality gate:** `./quality.sh` gave `Result: PASSED (with skipped checks)`. The one skip was config integration (`deno or .config.json not available` in the sandbox). Every other check passed, including deno tests, lint, type check, fmt, markdownlint and semgrep.
