# 🔎 Security sweep — the stream compaction seam (`stream_compaction.ts`)

**Incident:** [#2337](https://github.com/stSoftwareAU/VibeCoder/issues/2337)
(chunk top-up-2337) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the pre-issue stream compaction:

- `worker/deno/lib/stream_compaction.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2337**, and this file is the reading of it.

## `worker/deno/lib/stream_compaction.ts`

The module compacts the stream's conversation before an issue's first phase. It
spawns one agent CLI run (`/compact` on a `--resume` print run) through
`claude_runner.ts`, and it reads — never writes — the session transcript files
under the child's own `CLAUDE_CONFIG_DIR` to decide whether that run achieved
anything.

| Input            | Source                                                          | How it is handled                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerId`     | the anticipated provider (`.config.json` pin or the active one) | tested against a closed two-member list before any lever is pulled; anything else returns `unavailable` without a spawn. Passed to `resolveAgentProvider`, which throws on an unregistered id                                              |
| `sessionId`      | a stream record on the durable work volume                      | never executed and never interpolated into a path. It is compared by **file name equality** while walking the transcript tree, so a traversal-shaped id matches nothing rather than escaping                                               |
| `outcome`        | derived in-process by `adoptStreamSession`                      | only `resumed` reaches the levers; `new` and `reset` return before any spawn or read                                                                                                                                                       |
| `transcriptRoot` | the provider's own child environment (`CLAUDE_CONFIG_DIR`)      | read from `provider.buildChildEnv()` rather than composed here, so Claude's and DeepSeek's separate directories are each found without this module inventing a path                                                                        |
| `cwd`/`workDir`  | the worker's own repository checkout and work volume            | passed through to the runner verbatim; neither is parsed nor joined here                                                                                                                                                                   |
| the run outcome  | the CLI's exit code and the bytes appended to the transcript    | only a clean exit **and** a `compact_boundary` system record appended after the pre-run offset is read as success (Issue #4116: the transcript is append-only, so size is never the verdict); every other shape falls back and records why |

| Property       | Result                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path safety    | builds one path, `${transcriptRoot}/projects`, from a directory the provider's child environment supplies. Entries below it are walked, not constructed from external input, and only exact `<sessionId>.jsonl` names are snapshotted                   |
| prompt         | a fixed constant (`/compact`); no issue, comment or milestone text reaches the spawned run                                                                                                                                                              |
| fail direction | degrade, loudly: a failed spawn, a non-zero exit, an unreadable or truncated transcript or an unreadable directory all resolve to the `--autocompact` fallback with the reason recorded on the single log line. No outcome can fail an issue            |
| silent success | impossible by construction — the absence of a failure is never read as a compaction. Only a parsed `compact_boundary` record appended after the pre-run offset yields `compacted`; a transcript that cannot be located skips the `/compact` turn unpaid |
| spawn          | one, and only for Claude/DeepSeek on a resumed session: the same guarded `runClaudeWithTimeout` path every other agent run uses, under a 180 s cap                                                                                                      |
| network        | none of its own                                                                                                                                                                                                                                         |
| filesystem     | read-only. It lists and stats transcript files and reads the bytes appended during the run (at most 16 MiB from each copy of the session's transcript); it creates, writes and deletes nothing                                                                                                  |
| privilege      | none granted or checked here; the child environment is the provider's own, unmodified by this module                                                                                                                                                    |
| secret surface | holds no credential. The appended bytes are parsed in memory for the boundary record only; the log line carries offsets, a byte count, a boundary count, an exit code and an error message — never transcript content                                   |
| regex safety   | none of its own                                                                                                                                                                                                                                         |
| blast radius   | the setup and planning phases. A fault costs one wasted CLI turn and the `--autocompact` flag; the issue's own work is untouched                                                                                                                        |
