# 🔎 Security sweep — `Prompt is too long` fresh-session retry (`prompt_too_long.ts`)

**Issue:** [#2682](https://github.com/stSoftwareAU/VibeCoder/issues/2682) (chunk
top-up-2682) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2682:

- `worker/deno/lib/prompt_too_long.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2682**, and this file is the reading of it.

## `worker/deno/lib/prompt_too_long.ts`

When the agent CLI refuses a resumed run with `Prompt is too long`, the execute
phase discards that session and retries once on a fresh one. The module decides
whether to retry and deletes two worker-owned state files. It spawns nothing and
makes no network call.

| Input                  | Source                         | Handling                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent output           | the agent CLI (untrusted text) | only tested against a fixed, case-insensitive regex, and only when the trimmed output is at most 500 characters, so a long run that quotes the phrase is not read as a refusal. The failure reason keeps at most 500 characters of it. That reason goes through the normal failure-comment path |
| session id             | the worker's own resume state  | used only in a log line and as a log field. Never used to build a path                                                                                                                                                                                                                          |
| repo, issue number     | the claimed issue              | passed to `deleteResumeState`, which builds the path through the existing resume-state store                                                                                                                                                                                                    |
| stream id, provider id | the run's joined stream        | passed to `deleteStreamSession`, which resolves the slot through the existing store. Only the refusing provider's slot is removed; other providers' sessions stay                                                                                                                               |

The retry is bounded to one per run by `promptTooLongRetried` on the phase
state, so a refusal cannot loop. A refusal on a fresh session, or after the
retry, fails loud with category `prompt_too_long` and enters the ordinary
`failed-once` → `failed` ladder. Nothing here masks a failure as success.
