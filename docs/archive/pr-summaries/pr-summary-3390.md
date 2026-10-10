## Summary

`hooks/pre-commit` now refuses a force-added dotenv file (`.env`, `.env.*`) at
any depth. Before this change the hook had no dotenv check, so
`git add -f .env.local && git commit` went through locally. The new check uses
the same regex as the TypeScript gate's `FORBIDDEN_STAGED_PATTERNS` entry
(`worker/deno/lib/pre_commit_safety.ts:70`), `(^|/)\.env(\.[^/]*)?(/|$)`. It
matches a whole path segment, so look-alikes such as `src/env.ts`, `.envrc` and
`.envrc-docs/README.md` still pass. Closes #3390.

## Spec

### Intent and Rationale

- The repo hook is the local gate for direct pushes, which the PR-only
  gitleaks workflow never sees. Dotenv files are the most common secret-bearing
  file, and they were the one class in `FORBIDDEN_STAGED_PATTERNS` with no
  matching check in the hook.

### Essential Design Decisions

- The regex is identical to the TypeScript pattern, so both gates agree on
  every path. The hook keeps it as its own copy instead of sharing it, because
  the hook is a standalone bash script.

### Reviews

- Spec reviewer: all three acceptance criteria are met. The extras (the hook
  header line, a `SECURITY.md` bullet and extra test paths) are low risk.
- Standards reviewer: no violations. The regex is anchored and linear: the only
  quantifier is `[^/]*` between fixed tokens.

## Acceptance Criteria

- [x] The hook loop has `[[ "$file" =~ (^|/)\.env(\.[^/]*)?(/|$) ]]`
  (`hooks/pre-commit:86`).
- [x] Root and nested `.env` / `.env.local` are refused. Covered by
  `worker/deno/tests/hooks_pre_commit_test.ts::pre-commit hook - blocks force-added dotenv files at any depth (Issue #3390)`.
- [x] `src/env.ts` and `.envrc-docs/README.md` are not refused. Covered by
  `worker/deno/tests/hooks_pre_commit_test.ts::pre-commit hook - allows dotenv look-alikes (Issue #3390)`.

## Evidence

Backend-only change: no UI files are touched.

- Red against the unfixed hook: the block test failed with
  `expected hook to block '.env'` (15 passed, 1 failed). With the fix, all 16
  tests in `worker/deno/tests/hooks_pre_commit_test.ts` pass.
- Issue numbers this diff adds as provenance: #3390, "Repo pre-commit hook lets
  a force-added .env or .env.* file through".

**Docs sweep** — grep: `\.env`, `dotenv`, `Protected Patterns`. `SECURITY.md`
Protected Patterns gains a `.env`, `.env.*` bullet. `SECURITY.md:748-749`
already lists `.env*`, so it is still true. The C26 entry in
`docs/THREAT-MODEL.md` describes the hook in general terms, so it is also still
true.

## Standards Review

No departures found.

## Test Plan

- Added two tests to `worker/deno/tests/hooks_pre_commit_test.ts`:
  - **Block test:** `.env`, `.env.local`, `.env.production`,
    `services/api/.env`, `services/api/.env.production`, `config/.env.local`
    and `.env/secret` each exit 1. The output names the path and the
    "Attempting to commit sensitive" banner.
  - **Look-alike test:** `src/env.ts`, `.envrc-docs/README.md`, `.envrc`,
    `docs/dotenv.md`, `env.example` and `config/my.env` each exit 0.
- **Flip 1, regex widened to `\.env`:** the look-alike test went red
  (`hook wrongly blocked '.envrc-docs/README.md'`).
- **Flip 2, regex narrowed to `(^|/)\.env(/|$)`:** the block test went red
  (`expected hook to block '.env.local'`). With the regex restored, 16 tests
  pass.
- `shellcheck` and `bash -n` on `hooks/pre-commit` were clean. `deno fmt --check`
  and `deno lint` on the test file were clean. Markdownlint found 0 issues.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`. The only
  skip is config integration ("deno or .config.json not available"), because
  this container has no `.config.json`. The deno tests, lint, type check, fmt,
  markdownlint, mermaid and semgrep stages all passed.

Branch outcomes:

- `hooks/pre-commit:86` matched → path blocked: covered by `worker/deno/tests/hooks_pre_commit_test.ts::pre-commit hook - blocks force-added dotenv files at any depth (Issue #3390)`. Flip 2 went red.
- `hooks/pre-commit:86` not matched → path allowed: covered by `worker/deno/tests/hooks_pre_commit_test.ts::pre-commit hook - allows dotenv look-alikes (Issue #3390)`. Flip 1 went red.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
