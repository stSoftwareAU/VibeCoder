# 🔎 Security sweep — the Codex budget adapter

**Issue:** [#1697](https://github.com/stSoftwareAU/VibeCoder/issues/1697)
(chunk 12w) · **Parent:** #1209

The written record for the three modules that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12v) recorded their coverage:

- `worker/deno/lib/codex_budget_source.ts` — the verified Codex telemetry
  shapes and their parsers.
- `worker/deno/lib/codex_auth_mode.ts` — subscription login versus API-key
  billing.
- `worker/deno/lib/codex_budget.ts` — the bounded, read-only budget adapter.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record — the failure 12f's own
record documents. These three are claimed by **12w**, and this file is the
reading of them.

## `worker/deno/lib/codex_budget_source.ts`

Pure parsing: it takes `unknown` values decoded from a rollout session file and
returns a budget or an explicit unknown. No I/O, no spawn, no environment, no
state.

Shapes checked (12c's — a module ingesting data it did not produce — and 12e's):

| Property | Result |
| -------- | ------ |
| untrusted JSON cannot be trusted into a decision | ✅ every field is narrowed before use: `isRecord` rejects arrays and `null`, `finiteNumber` rejects strings and `NaN`, `nonEmptyString` rejects non-strings and blanks. A snapshot with no parseable window returns `unrecognised-snapshot-shape`, never a number |
| an unparseable line cannot crash a scan | ✅ `parseCodexRolloutLine` wraps `JSON.parse` in a `try` and answers `null`, so a truncated final line — the normal state of a file the CLI is still appending to — is skipped rather than thrown |
| a wrong unit cannot inflate the budget | ✅ `codexResetAtToEpochMs` rejects non-integral, non-positive and beyond-2100 values, so a millisecond `resets_at` drops the reset instead of reading as a rollover a thousand times too far away. `used_percent` is clamped to `[0, 100]` on the way to a fraction |
| no fabricated figure | ✅ there is no default, no zero and no fallback percentage anywhere: an absent or malformed window produces `{ known: false, reason }` |
| regular-expression cost | ✅ one anchored-enough lazy pattern (`hit your usage limit for (.+?)\.(?:\s\|$)`) over a bounded CLI message; no nested quantifier, no user-supplied pattern, so no catastrophic-backtracking shape. `EXHAUSTION_PATTERNS` are literal `includes` needles |
| no credential can pass through | ✅ the module never reads a token; the only strings it retains are `limit_id`, `limit_name` and `plan_type`. The credit **balance** is deliberately dropped rather than carried into a snapshot a caller might log |
| unbounded state | ✅ none — every function is pure and allocates only its own result |

No findings.

## `worker/deno/lib/codex_auth_mode.ts`

Reads `$CODEX_HOME/auth.json` to answer one question: subscription or API key.

Shapes checked (12d's — an environment, configuration and secret sink — and
12b's — filesystem and path handling):

| Property | Result |
| -------- | ------ |
| no credential value leaves the module | ✅ only *presence* is inspected. The env branch returns `"<NAME> is set"`, never the value; the file branch tests `typeof parsed.OPENAI_API_KEY === "string"` and `isRecord(parsed.tokens)` without reading either. The JWT in `tokens.id_token` is never decoded, and `CodexAuthModeResult` has no field that could hold one — the tests assert the serialised result contains neither the env value nor the file value |
| a failure is never a silent pass | ✅ a missing file is `absent`, unreadable or malformed JSON is `read-error`, and an unrecognised `auth_mode` is `unknown` with the mode named. None of them yields `chatgpt` or `api-key` by default, so a broken file cannot be read as "subscription, plenty of budget" |
| an exception message cannot leak a path or a secret | ✅ the catch records `error.name` only, not the message or stack |
| path construction | ✅ one join of the caller-supplied `codexHome` with a fixed `auth.json`, trailing slashes normalised. The directory comes from the worker's own configuration, not from GitHub data or a CLI response |
| no spawn, no network | ✅ one `Deno.readTextFileSync`; nothing else |

No findings. Accepted residual: `resolveCodexAuthMode` trusts the *presence* of
`OPENAI_API_KEY` over `auth.json`, so a host with both an exported key and a
ChatGPT login is reported `api-key` and gets no budget percentage. That is the
conservative direction — an honest unknown rather than a window that may belong
to the credential the CLI is not using.

## `worker/deno/lib/codex_budget.ts`

The adapter: caching, deduplication, bounded reads, exhaustion recording.

Shapes checked (12b's — filesystem, path and temp-file handling — and 12e's):

| Property | Result |
| -------- | ------ |
| unbounded read | ✅ triply bounded: at most `MAX_DAY_DIRECTORIES` (14) day directories descended, at most 3 session files opened, and at most `tailBytes` (256 KiB by default) read from each. A `CODEX_HOME` with years of sessions and a multi-gigabyte rollout file costs the same as a fresh one |
| unbounded state | ✅ one snapshot and one in-flight promise per instance; nothing accumulates across refreshes |
| a directory it cannot read | ✅ `entryNames` returns `[]` **only** for `Deno.errors.NotFound` — a `CODEX_HOME` that has never run a session — and rethrows every other failure, which `#read` converts to `read-error`. A permissions error or a broken mount can no longer be reported as `no-session-file`, which would have read as an ordinary empty directory. A run where every candidate *file* was unreadable is likewise `read-error` — never "no budget", never a silent pass |
| the file handle is always closed | ✅ `readFileTail` closes in a `finally`, including on the decode path |
| path construction from untrusted names | ✅ directory and file names come from `Deno.readDirSync` of the worker's own `CODEX_HOME`, are filtered to a `rollout-*.jsonl` prefix/suffix, and are only ever concatenated for a read. Nothing is spawned, and no name reaches a shell |
| exhaustion cannot be inflated into a reset | ✅ `exhaustionSnapshot` leaves `resetAt` undefined, because the CLI renders the reset in host-local time with no offset; a guessed instant would let a caller retry into a still-closed window. It also declines to name the **window**, since the message never says which one is spent, and reports a bare `429` as `transient-rate-limit` rather than a spent window — the pinned CLI words a genuine limit as `UsageLimitReached`, so a raw 429 is a per-request throttle |
| newer evidence cannot be overwritten by older | ✅ every snapshot carries `evidenceAt`, and `#store` refuses a replacement resting on older evidence. This closes two ways an exhaustion record was lost: a `refresh()` already in flight completing after it, and the next due `refresh()` re-reading an unchanged rollout file. `readAt` still advances on a refused replacement, so the recheck stays bounded |
| a rejected credential is not zero budget | ✅ `recordAuthRejected` stores `{ known: false, reason: "auth-rejected" }` under its own `auth-rejection` source, so a 401 is neither ranked as an exhausted subscription nor filed as exhaustion evidence |
| concurrency | ✅ `refresh()` returns the in-flight promise to every concurrent caller and clears it in `finally`, so a rejection cannot wedge the adapter into permanently returning a dead promise |
| no credential is read or logged | ✅ the only credential fact it touches is `resolveCodexAuthMode`'s answer; no token value is opened, returned or logged. `commands/codex_budget.ts` additionally passes its whole rendered message through `redactSecrets` |
| cost to the vendor | ✅ no `fetch`, no `Deno.Command`, no Codex turn: every reading comes from a file the CLI already wrote. A probe cannot spend the quota it measures because there is no probe |

No findings. Accepted residual: a snapshot is only as fresh as the last turn
the CLI completed, so a long-idle credential reports an old percentage. That is
surfaced rather than hidden — `isStale()` answers on the configured maximum
age, and the reading is never downgraded to unknown by age alone, because a
stale real figure beats a fabricated fresh one.
