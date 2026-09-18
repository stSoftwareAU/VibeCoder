# 🔎 Security sweep — the issue-executor split resolver (`issue_executor_split.ts`)

**Incident:** [#2341](https://github.com/stSoftwareAU/VibeCoder/issues/2341)
(chunk top-up-2341) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the `issue_executor_split` config key:

- `worker/deno/lib/issue_executor_split.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2341**, and this file is the reading of it.

## `worker/deno/lib/issue_executor_split.ts`

The module is one exported pure function, `isIssueExecutorSplitEnabled`. It
reads the phase name, the active repository's `repo_config` entry and the loaded
worker config, and returns a boolean. Nothing reads that boolean yet — the key
is registered ahead of the sub-issues that consume it.

| Input        | Source                                                                                | How it is handled                                                        |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `phase`      | the worker's own phase dispatch                                                       | compared with the literal `"issue"`; every other value returns `false`   |
| `repoConfig` | operator-written `.config.json` `repo_config` — **trusted**, but not schema-validated | used only when it is a boolean; any other type warns and is ignored      |
| `config`     | operator-written `.config.json`, validated by `validateConfigFileJson`                | compared with `=== true`, so a malformed value can never read as enabled |

| Property          | Result                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none — no subprocess, no `gh`, no `git`                                                                                                   |
| prompt injection  | no untrusted text reaches it; it neither builds nor reads a prompt                                                                        |
| network           | none                                                                                                                                      |
| filesystem        | none                                                                                                                                      |
| regex safety      | no regular expressions                                                                                                                    |
| secret surface    | holds no credential. The one warning prints the offending value's `typeof`, never the value, so a mis-set config cannot leak into the log |
| fail direction    | fail-closed: an absent, malformed or non-boolean value resolves `false`, which is today's behaviour                                       |
| blast radius      | no production caller yet; when wired, it can only widen or narrow which executor an `issue`-phase run uses                                |
