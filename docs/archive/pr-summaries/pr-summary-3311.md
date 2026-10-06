# PR Summary — Issue #3311

## Summary

The pre-commit safety gate now refuses a dotenv file, a `.config*.json` file or a `.secrets/` directory in a subdirectory as well as at the repository root. `services/api/.env` was classified as safe, because three of the `FORBIDDEN_STAGED_PATTERNS` were anchored to the root.

Closes #3311

## Spec

### Intent and Rationale

- The `.gitignore` entries `.env`, `.env.*`, `.config*.json` and `.secrets/` have no slash, so they apply at every depth. The gate's patterns now apply at every depth too.
- `services/api/.env`, `a/b/.env.local`, `services/api/.config.json` and `services/.secrets/api.key` are now violations.

### Essential Design Decisions

- Each pattern matches one whole path segment, using `(^|\/)` before it and `(\/|$)` after it. `[^/]*` keeps the match inside a single segment, so the match time stays linear.
- `(\/|$)` also catches a directory named like the file, such as `a/.env.d/x` or `a/.config.local.json/x`.
- `src/foo.env`, `src/app.config.json`, `a/secrets/x` and `a/.secretsx/y` stay safe.

### Undiscoverable Facts

- A nested `pkg/.config/dotnet-tools.json` is now safe, as it is under `.gitignore`. The old regex `/^\.config.*\.json$/` would have matched a root `.config/x.json`; that path is still refused, through the hidden top-level directory check.
- The existing `/.*\.secret\.json$/` pattern is quadratic on long input (1.5 s at 10k characters). It is out of scope here, so it is tracked in follow-up issue #3316. The secrets growth test calls the `.secrets/` regex directly so that the old pattern does not affect its timing.

## Evidence

- Before the fix, the new unit tests failed (50 passed, 4 failed), and integration Scenario C failed with "should have refused the commit but returned Ok". After the fix, 54 unit tests and 3 integration tests pass.
- **Docs sweep:** I grepped for `FORBIDDEN_STAGED_PATTERNS`, `.secrets/`, `.config*.json` and `.env.*`. No update was needed: CODING-STANDARDS.md:1094, SECURITY.md:678-680, prompts/coding_guidelines/prompt.md:1017-1020, prompts/security_scan/prompt.md:919, docs/ADD-REPO.md:291 and worker/deno/lib/gitignore_enforcer.ts:9 list the slash-free `.gitignore` forms, which already apply at any depth. hooks/pre-commit:13,32,37,58 already matches these names at any depth or by basename. docs/audits/security-sweep-1661-worker-state-paths.md:63 is a historical audit.

## Test Plan

- `worker/deno/tests/pre_commit_safety_test.ts`:
  - nested dotenv, config and secrets paths are violations;
  - nested look-alikes stay safe;
  - one `assertLinearGrowth` hostile-input test for each of the three changed patterns.
- `worker/deno/tests/hidden_files_safety_integration_test.ts`, Scenario C: in a real git repository, `assertSafeToCommit` refuses force-staged `services/api/.env`, `services/api/.config.local.json` and `services/api/.secrets/token`, names each one, and nothing is committed.
- `deno fmt --check`, `deno lint` and `deno check --frozen` are clean. QUALITY_GATE_RESULT
- **Branch outcomes:**
  - `worker/deno/lib/pre_commit_safety.ts:46` — nested dotenv is a violation — nested-violations test and dotenv growth test — restoring the root-anchored pattern went red.
  - `worker/deno/lib/pre_commit_safety.ts:46` — dotenv-named directory (`a/.env.d/x`) is a violation — nested-violations test — changing `(\/|$)` to `$` went red.
  - `worker/deno/lib/pre_commit_safety.ts:48` — nested config file is a violation — nested-violations test and config growth test — restoring the root-anchored pattern went red.
  - `worker/deno/lib/pre_commit_safety.ts:48` — config-named directory (`a/.config.local.json/x`) is a violation — nested-violations test — changing `(\/|$)` to `$` went red.
  - `worker/deno/lib/pre_commit_safety.ts:51` — nested `.secrets/` is a violation — nested-violations test — restoring the root-anchored pattern went red.
  - Look-alike paths stay safe — nested look-alikes test.
