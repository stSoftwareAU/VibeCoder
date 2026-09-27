# 🔎 Security sweep — Copilot code review setup question (`copilot_review_setup.ts`)

**Issue:** [#2701](https://github.com/stSoftwareAU/VibeCoder/issues/2701) (chunk
top-up-2701) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/setup/`
under #2701:

- `worker/deno/setup/copilot_review_setup.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2701**, and this file is the reading of it.

## `worker/deno/setup/copilot_review_setup.ts`

The setup conversation that asks whether `repo-settings-harden` turns Copilot
code review on, off, or leaves it, and records the answer as
`copilot_code_review` in `.config.json`. It makes no network call and spawns no
process: the terminal is its only input, and `.config.json` its only output,
through `config_writer.ts`.

| Input                          | Source                                    | Handling                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typed answer                   | operator's terminal (`prompt`)            | trimmed, lower-cased and accepted only when it is one of `on`, `off`, `leave`; anything else is refused by name and asked again, at most five times, then the run fails with nothing written. The answer is never interpolated into a path, a command or an API call |
| existing `copilot_code_review` | `.config.json`                            | parsed by `parseCopilotCodeReview` (`lib/config_validator.ts`), the same fail-loud parser the config load uses; an invalid value stops the conversation rather than being asked over                                                                                 |
| `.config.json` path            | setup CLI `--config-path` / `CONFIG_FILE` | read and rewritten by `config_writer.ts`'s `readConfigRecord` and atomic, owner-only (`0o600`) write, so every other key is kept and an interrupted write never leaves a partial file                                                                                |

Two guarantees hold whatever the inputs: a non-interactive run
(`Deno.stdin.isTerminal()` false) never prompts and never writes; and the answer
only ever selects one of three fixed values, so it cannot widen what
`repo-settings-harden` does beyond adding or removing the one
`copilot_code_review` ruleset rule.
