# 🔎 Security sweep — setup repo-settings hardening (`repo_settings_harden_sync.ts`)

**Issue:** [#2628](https://github.com/stSoftwareAU/VibeCoder/issues/2628)
(chunk top-up-2628) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/setup/` under #2628:

- `worker/deno/setup/repo_settings_harden_sync.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2628**, and this file is the reading of it.

## `worker/deno/setup/repo_settings_harden_sync.ts`

The setup step that hardens every monitored repository's GitHub settings. It
writes nothing itself: every GitHub read and write goes through
`hardenRepo` (`worker/deno/lib/repo_settings_harden.ts`, swept under #2626) or
the injected CODEOWNERS writer and audit-issue closer, all on the injected
argv-array `gh` seam. In production, that seam is setup's
`createSetupGhJson`, which routes through the `runGhOrThrow` chokepoint with
the operator's `gh_config_dir`.

| Input | Source | Handling |
| ----- | ------ | -------- |
| repo slug | `.config.json` `repos` | checked with `isValidRepoSlug` before any path is derived from it (`<WORK_DIR>/<name>`) or any call made; a failure is a failed line printed through `renderInertRepoSlug`, never a `..` reaching the disk |
| `WORK_DIR` | host environment | used only as the parent of each checkout; `hardenRepo` reads workflows under it and never writes there |
| CODEOWNERS lookup | GitHub contents API | a `present` answer is the only thing that turns code-owner review on; an `error` is reported and treated as "do not require", so a flaky read never demands owners that may not exist |
| hardening results / GitHub error text | `hardenRepo` | printed on the operator's own terminal; setup's console redaction still applies |
| closer outcome | the injected closer | its warnings are printed and a throw is caught, so a closer fault never fails or aborts the step |

Two guarantees hold whatever the inputs: `requireReviews` is always `false`, so
no request can require an approving review and stop the fleet's merges; and
each repository runs in its own `try`/`catch`, so one repository's failure
never stops the next and the step never throws out of `runAll`.
