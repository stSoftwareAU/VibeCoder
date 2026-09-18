# 🔎 Security sweep — the stream join seam (`stream_session.ts`)

**Incident:** [#2333](https://github.com/stSoftwareAU/VibeCoder/issues/2333)
(chunk top-up-2333) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the stream join seam:

- `worker/deno/lib/stream_session.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2333**, and this file is the reading of it.

## `worker/deno/lib/stream_session.ts`

The module decides which run kinds join their stream's conversation, turns a
stream record into the `SessionResumeState` the CLI flags are built from, and
writes the adopted session back. Its only I/O is through
`resume_state_store.ts`; it spawns nothing and opens no socket.

| Input                      | Source                                                                     | How it is handled                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`                     | the worker's own configured repository slug                                | passed straight to `resolveStreamId`, which validates `owner/name` and throws otherwise (#2331); `primeStreamSession` turns that throw into a logged degrade, never a bad key                                   |
| `milestoneTitle`           | fetched back from GitHub — **untrusted**: anyone with write access sets it | never interpolated into a command, a path or Markdown. It reaches the filesystem only through `streamKey`, which reduces it to a single safe path segment (#2331)                                               |
| `runKind`                  | derived in-process from the issue's labels                                 | compared against a closed union; an unknown value cannot reach `STREAM_JOIN_POLICY` past the type, and `joinsStream` treats anything but an explicit `true` as "does not join"                                  |
| a persisted `sessionId`    | a stream record on the durable work volume                                 | never executed, never a path component. `isPersistableSessionId` gates both the read (`lookupStreamSession`) and the write (`recordStreamSession`), so an id the CLI would refuse is reset rather than replayed |
| `repoConfig.agentProvider` | the operator's own `.config.json`                                          | resolved through `repoPinnedAgentProvider`, which throws on an unregistered id; the throw degrades to the default provider with a warning                                                                       |

| Property                   | Result                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path safety                | builds no path of its own — every filesystem address comes from `streamSessionPath`, whose segment is `streamKey`'s (`[a-z0-9_-]`, no `/`, no `..`, no leading `.`)                                                                                              |
| cross-provider containment | a session is read and written under one provider id. `sessionResumeForProvider` drops a state whose provider does not match, and a single-provider write leaves every sibling entry intact, so one provider cannot hijack another's thread                       |
| cross-stream containment   | a run reads only the record its own `(repository, milestone)` keys to, so one repository's conversation can never be replayed into another's                                                                                                                     |
| fail direction             | degrade, loudly: a malformed repository, an unreadable record or a refused write logs a warning naming the consequence and the run continues on a per-issue session. Resume is an optimisation, never control flow — an issue is never failed for a stream fault |
| privilege                  | none granted or checked here; the module neither spawns nor reads credentials                                                                                                                                                                                    |
| spawn, network             | none                                                                                                                                                                                                                                                             |
| filesystem                 | only via `resume_state_store.ts`, under `${workDir}/.claude-sessions/resume/`                                                                                                                                                                                    |
| secret surface             | holds no credential. `credentialScope` is a label, never a secret, and is copied between records without being logged                                                                                                                                            |
| regex safety               | none of its own                                                                                                                                                                                                                                                  |
| blast radius               | the setup, execute and planning phases; a fault in it costs conversation continuity and nothing else                                                                                                                                                             |
