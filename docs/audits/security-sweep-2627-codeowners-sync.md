# 🔎 Security sweep — default CODEOWNERS writer (`codeowners_sync.ts`)

**Issue:** [#2627](https://github.com/stSoftwareAU/VibeCoder/issues/2627) (chunk
top-up-2627) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/setup/` under #2627:

- `worker/deno/setup/codeowners_sync.ts`

## `worker/deno/setup/codeowners_sync.ts`

`syncCodeowners` writes a three-rule `.github/CODEOWNERS` into one repo's
`WORK_DIR` checkout when neither the checkout nor the default branch has a
CODEOWNERS file. It runs no subprocess itself; the default-branch lookup is
injected (`findCodeownersOnDefaultBranch`, already swept with
`repo_settings_harden.ts`).

| Input | Source | Handling |
| ----- | ------ | -------- |
| `repo` slug | host `.config.json` (operator) | checked with `isValidRepoSlug` before any path is derived; a `..` or empty segment is an `error`, never a path. The checkout is `${workDir}/<name>`, the same rule as `gitignore_sync.ts` |
| `owners` | host `.config.json` `codeowners_owners` (operator) | every entry must match the literal pattern `^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$`; `[bot]` logins, `@stservice`, `@VibeCoderST` and `@stSoftwareAU/developers` are refused case-insensitively. An empty list is refused. Checked again in the writer, so a caller that skips `resolveCodeownersOwners` still cannot write a bot owner or inject a newline into the file |
| checkout contents | repository-derived | only `lstat`ed at the three CODEOWNERS locations; a dangling symlink counts as present, so the writer never follows a link planted at one of them |
| default-branch lookup | GitHub API via injected function | `present` and `error` both skip; a thrown lookup is treated as `error`. A failed read is never taken as absent |

The write uses `createNew`, so a file that appears between the check and the
write is refused rather than replaced. The writer never edits, renames or
deletes an existing file. Nothing it returns is secret: results carry only a
repo-relative path, a fixed reason or an error message from the filesystem or
the lookup.

The `codeowners_owners` validation in `config_setup.ts` (already swept) calls
the same `codeownersOwnersErrors`, so setup refuses a bad owner list at config
load, naming each offending entry.
