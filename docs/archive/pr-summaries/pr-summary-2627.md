# PR Summary — Issue #2627: a default CODEOWNERS writer and its owners key

## Summary

Closes #2627 (part of #2611)

- **`worker/deno/setup/codeowners_sync.ts`** exports `syncCodeowners(opts)`.
  For one repo, it writes `.github/CODEOWNERS` into the `WORK_DIR` checkout
  only when the file is absent from all three places GitHub reads
  (`.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`) in the checkout
  **and** on the default branch (the check is injected; the caller binds
  `findCodeownersOnDefaultBranch`). It returns one of:
  - `written` with the path;
  - `skipped` with `present at <path>`, `no local checkout` or
    `default-branch check failed: <error>`;
  - `error`, for an invalid slug, an invalid owner list or a write failure.

  The file has exactly three rules (`/.github/workflows/`, `/.github/actions/`,
  `/.github/CODEOWNERS`), each owned by the configured owners. The write uses
  `createNew`, so an existing file is never replaced.
- **Checkout path rule:** `${workDir}/<name>`, where `<name>` is the part of
  the slug after the last `/`. This is exactly the rule `gitignore_sync.ts`
  uses.
- **`codeowners_owners`** is a new setup config key in `config_setup.ts`. It
  defaults to `["@nleck", "@Green-Beret"]`, and `buildOverridesOnly` writes it
  only when it differs from that default. `resolveCodeownersOwners(config)`
  returns the default when the key is missing. It throws, naming each bad
  entry, for:
  - a non-array or an empty list;
  - an entry that does not match `^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$`;
  - a login ending `[bot]`;
  - `@stservice`, `@VibeCoderST` or `@stSoftwareAU/developers` (compared
    case-insensitively).

  `loadExistingConfig` runs this validation, so setup refuses a bad list at
  load. The key is also in `KNOWN_CONFIG_KEYS`, so the worker does not warn
  about it, and it is documented in `docs/CONFIGURATION.md`.
- **Security-sweep ledger:** adds slice `top-up-2627` and
  `docs/audits/security-sweep-2627-codeowners-sync.md` for the new module.

## Acceptance Criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Tests written first; with the default config the written file is byte-for-byte the three-rule file owned by `@nleck @Green-Beret` | ✅ met | `codeowners_sync_test.ts` "default config writes the exact three-rule file" compares the file to a literal string. The tests failed to type-check (the module did not exist) before the implementation |
| For each of the three locations, in the checkout and on the default branch, the existing file is untouched (same bytes and mtime) and the result is `skipped` with its path | ✅ met | Six generated tests: "existing `<loc>` in the checkout is untouched" checks bytes and mtime; "`<loc>` on the default branch blocks the write" checks that nothing was written |
| When the default-branch check returns `error`, nothing is written and the result is `skipped` with the error | ✅ met | "a failed default-branch check writes nothing", plus "a thrown default-branch check writes nothing" |
| Running the writer twice gives `written`, then `skipped` | ✅ met | "running twice gives written, then skipped" |
| `setup_config_setup_test.ts`: a missing key yields the default owners; `@foo[bot]`, `@stservice`, `@stSoftwareAU/developers` and `nleck` are each rejected with an error naming the entry | ✅ met | `resolveCodeownersOwners - a missing key yields the default owners`, plus four `rejects <entry>, naming it` tests and a `loadExistingConfig` refusal test |
| `deno task` quality gate passes | ✅ met (CI) | Targeted local run: `deno test` on the touched test files passes. The wide gate runs in CI on this PR |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
