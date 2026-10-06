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

  The other `*.secret.json` hits (grep rerun on the final head) name the glob-style path, not a regex. This change leaves that path set unchanged, so each stays true:
  - `CODING-STANDARDS.md:1095` lists `*.secret.json` among the paths the gate refuses, which is still the case.
  - `SECURITY.md:679` describes `*.secret.json` as files explicitly marked as secret; the suffix match still blocks them.
  - `prompts/coding_guidelines/prompt.md:1019` lists the same marked-secret glob; unchanged behaviour.
  - `worker/deno/lib/gitignore_enforcer.ts:9` (and its pattern list at `:79`) is the `.gitignore` entry the enforcer adds, not the staged-path regex.
  - `hooks/pre-commit:9`, `:33` and `:42` are comments beside the suffix check at `:43`.
  - `worker/deno/setup/config_writer.ts:358`, `:368` and `.gitignore:38` are `.gitignore` glob lines, which already match by suffix.

## Test Plan

- `worker/deno/tests/pre_commit_safety_test.ts`:
  - new: "classifyStagedPath - secret.json pattern stays linear on hostile input (Issue #3316)";
  - changed: the Issue #3311 secrets growth test now calls `classifyStagedPath`;
  - existing tests still pass: `foo.secret.json` and `api-key.secret.json` are classified as violations.
- Removed from `worker/deno/tests/pre_commit_safety_test.ts`: `assert(secretsPattern !== undefined, "expected a /.secrets/ pattern");` — #3316 says the #3311 secrets growth test "can go back to calling `classifyStagedPath` once this is fixed". The test no longer looks up the regex by hand, so there is no `secretsPattern` left to check. The `/.secrets/` entry is still covered by the violation tests for `.secrets/` paths.
- Removed from `worker/deno/tests/pre_commit_safety_test.ts`: `assertLinearGrowth( "FORBIDDEN_STAGED_PATTERNS secrets pattern, repeated /.secrets prefixes", (chars) => "/.secrets".repeat(chars) + "x", (input) => secretsPattern!.test(input), { baseChars: 10_000 }, );` — #3316 asks for this same check to go back through `classifyStagedPath`. It is replaced in place by `assertLinearGrowth("classifyStagedPath, repeated /.secrets prefixes", (chars) => "/.secrets".repeat(chars) + "x", classifyStagedPath, { baseChars: 10_000 })` in "classifyStagedPath - secrets pattern stays linear on hostile input (Issue #3311)". It uses the same hostile input and threshold, and it now covers every entry in `FORBIDDEN_STAGED_PATTERNS`, not just the one regex.
- **Mutation check.** With `.*` restored, the new test goes red. This is the base-branch run quoted under Evidence.
- **Branch outcomes:** none added. The change replaces one regex literal and adds no condition.
- **Quality gate:** `./quality.sh` gave `Result: PASSED (with skipped checks)`. The one skip was config integration (`deno or .config.json not available` in the sandbox). Every other check passed, including deno tests, lint, type check, fmt, markdownlint and semgrep.
