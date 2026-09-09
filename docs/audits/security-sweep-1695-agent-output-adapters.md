# 🔎 Security sweep — the agent output adapters (Issue #1695)

**Issue:** [#1695](https://github.com/stSoftwareAU/VibeCoder/issues/1695) (chunk
12m) · **Parent:** #1209

The written record for the three modules that entered `worker/deno/lib/` _after_
the chunk-12 slices (12a–12l) recorded their coverage:

- `worker/deno/lib/agent_output.ts` — the provider-neutral output contract.
- `worker/deno/lib/claude_output_adapter.ts` — the Claude Code decoder and
  failure classifier.
- `worker/deno/lib/codex_output_adapter.ts` — the Codex CLI decoder and failure
  classifier.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed makes
`diffCoverage` green on a false record — the failure 12f's own record documents.
These three are claimed by **12m**, and this file is the reading of them.

## What they are exposed to

All three read **untrusted input**: the stdout and stderr of a coding-agent CLI,
which carries the agent's own prose, the text of any file or web page it read,
and whatever an upstream API returned. None of them spawns a process, touches
the filesystem, reads the environment, or makes a network call — 12a's, 12b's
and 12d's shapes do not apply. 12c's does: they `JSON.parse` untrusted lines.

Shapes checked (12c's — a module ingesting untrusted data — and 12e's):

| Property                                         | Result                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| untrusted JSON cannot crash the decode           | ✅ `parseJsonlEvents` wraps every `JSON.parse` in a `try`, counts the failures on `malformedLines`, and rejects a scalar or array line as "not an event". A truncated final line — what a killed CLI leaves — is counted, never thrown on (`codex adapter - malformed and truncated JSONL is skipped, never thrown on`)                |
| untrusted JSON cannot be trusted into a decision | ✅ every field read goes through `str()` / `num()` / `obj()` type guards, so a `session_id` that is an object, or a `usage` that is a string, is absent rather than coerced. An unknown event kind is counted as progress and otherwise ignored                                                                                        |
| the agent's own prose cannot forge a refusal     | ✅ classification runs only on a **failed** process: `classify` returns `undefined` on `exitCode === 0` before it reads a single byte of output, so an agent quoting "429 Too Many Requests" in a successful answer is a quotation. On a failure, the worker's own process facts (cancellation, watchdog) outrank the streams entirely |
| a credential cannot leak into a failure message  | ✅ every message excerpt is built by `redactedEvidence`, which redacts the **whole** text before cutting the tail (Issue #1257's order, via `redactedLineTail`); the gate's `redact before truncate` check covers the module                                                                                                           |
| unbounded input or state                         | ✅ no module holds state across calls — no module-level mutable, no cache, no `Set`. The decode is linear in the stream the runner already holds in memory, and the evidence excerpt is capped at five lines                                                                                                                           |
| catastrophic backtracking                        | ✅ every added pattern is a literal alternation or a bounded `[^\n]{0,N}` span — no nested quantifier over a repeatable group, so a hostile 10 MB line cannot be made super-linear. The Claude adapter's prose tests are the existing `claude_executor.ts` predicates, already swept in 12a                                            |
| no path, argv or shell is built from the output  | ✅ nothing decoded here reaches a filesystem path, a command line or a URL; the outputs are a text string, typed enums, counts and a preserved `raw` object                                                                                                                                                                            |
| a preserved unknown field cannot be executed     | ✅ `AgentStructuredError.raw` is data only — it is read for `resets_in_seconds` / `retry_after_seconds` through `num()` and otherwise carried for a human to read. No prototype is trusted from it (`JSON.parse` produces a plain object; the modules never spread it into an options object that reaches a spawn)                     |

No findings.

## Accepted residual

`AgentStructuredError.raw` deliberately carries provider fields this worker does
not understand, so a consumer can read them before the adapter is taught about
them. Anything a future consumer does with that object is that consumer's
boundary: it is untrusted data, and this record is the reason it is labelled as
such in the type's own documentation.
