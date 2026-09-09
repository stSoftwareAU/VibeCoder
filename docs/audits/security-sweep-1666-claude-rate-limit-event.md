# 🔎 Security sweep — the stream-json `rate_limit_event` parser (`claude_rate_limit_event.ts`)

**Issue:** [#1666](https://github.com/stSoftwareAU/VibeCoder/issues/1666)
(chunk 12n) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12m) recorded their coverage:

- `worker/deno/lib/claude_rate_limit_event.ts` — added by #1666.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12n**, and this file is the
reading of it.

## `worker/deno/lib/claude_rate_limit_event.ts`

The module parses Claude CLI stream-json lines of `type: "rate_limit_event"`
into `{ status, rateLimitType, resetsAtEpochMs, windows }`. It is a pure
function of a string: no filesystem, no subprocess, no environment, no network,
and no token value ever reaches it. The runner feeds it the child's raw stdout
(the same bytes already JSON-parsed by `extractStreamJsonText` for
`result`/`assistant` lines).

Shapes checked (12e's — a closing-pass module with no taint sink of its own):

| Property | Result |
| -------- | ------ |
| no I/O | ✅ the only export that takes data is `parseRateLimitEvents(rawStreamJson)`; `isUsageLimitRejection` is a predicate on an already-parsed value |
| malformed input cannot take the process down | ✅ `JSON.parse` is inside `try/catch`; a non-object, a missing `rate_limit_info`, a non-string status/type, or a non-finite `resetsAt` skips the line and returns no event. Pinned by `parseRateLimitEvents - a corrupt line is skipped, never thrown on` |
| untrusted numbers cannot become an infinite wait | ✅ `resetsAt` and each window's `resetsAt` must be a finite JSON number; `NaN`/`Infinity` are skipped. The runner still caps the pause at `USAGE_LIMIT_MAX_WAIT_SECONDS` |
| no secret material | ✅ the event carries utilisation fractions and epoch seconds only; nothing from the environment or a credential file is an input |
| no argv / shell | ✅ none |
| blast radius of a wrong parse | ✅ a skipped line falls through to the existing prose regex (Issue #1665); a false rejection would pause the worker until the capped wait, which is the same outcome as today's stderr-only usage-limit path |

No findings. The accepted residual: a hostile CLI could emit a well-formed
rejected event and force the usage-limit pause. That is the same trust
boundary as the CLI's stderr prose the runner already treats as authoritative
— the parser does not widen it.
