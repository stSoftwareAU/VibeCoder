# Security sweep — Gemini CLI token-usage decoding (`gemini_token_usage.ts`)

**Issue:** [#1938](https://github.com/stSoftwareAU/VibeCoder/issues/1938)
(chunk top-up-1938) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12z) recorded their coverage:

- `worker/deno/lib/gemini_token_usage.ts` — added by #1938.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-1938**, and this file is the reading of it.

## `worker/deno/lib/gemini_token_usage.ts`

The module decodes the token counters out of one Gemini CLI run's stdout. That
stdout is **attacker-influenceable data**: an issue body a Gemini run was asked
to work on can steer what the model writes, and the model's text is interleaved
with the CLI's own JSONL envelopes on the same stream. The relevant shapes are
12c's untrusted-ingestion ones, not 12a's process ones — nothing here spawns,
reads or writes anything.

It deliberately implements no classification, no failure detection and no text
extraction: those stay in `agent_output.ts` and the per-provider adapters, and
this module only reads numbers.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; `decodeGeminiTokenUsage` is pure over the string it is given |
| no filesystem, no network, no `gh` | nothing is opened; the stdout arrives from the caller that already ran the CLI |
| no environment or secret sinks | no `Deno.env`; no value is logged, formatted into a message or returned as prose, so no fragment of the stream can reach an issue comment through this module |
| the parser cannot be made to throw | every line goes through the shared `parseJsonlEvents`, which counts a malformed or truncated line instead of throwing; a stream that is not JSON at all yields no events and decodes to `undefined` |
| no unbounded work on attacker input | one pass over the lines, then one pass over the last `result` event's `stats.models`; no regex, so no backtracking surface, and no recursion, so no depth to exhaust |
| a forged event cannot fabricate spend | the worst an injected `{"type":"result","stats":…}` line can do is misstate this run's own counters. The figures are credit-log bookkeeping for a fixed-price subscription, not a payment instruction, and a too-large count makes the run look *dearer*, tripping the spend ceiling early rather than hiding spend |
| the last event wins, and that is deliberate | the CLI's terminal `result` is its final totals, so scanning from the end reads the run's own summary. An injected earlier line is superseded, not merged |
| counters are read, never coerced | `readCounter` accepts only non-negative finite numbers and distinguishes an *absent* field from one *stated unusably*. A string, `null`, `NaN`, an object or a negative value condemns the whole model entry, so a partly-readable entry can never contribute a zero where a real count belongs |
| an absent count is never a zero | a stream with no `result` event, no `stats`, an empty `stats.models`, or no usable entry in any model returns `undefined`, which `provider_token_usage.ts` turns into the `usageUnknown` warning. An entry stating a prompt count but no candidates count is refused for the same reason — an unstated output is not a zero output. The fail-loud path of #366 is preserved, not routed around |
| a negative count cannot reach the totals | a stated counter below zero is refused outright by `readCounter`, so a garbled or forged figure makes the run UNKNOWN rather than *subtracting* from the day's totals and the spend ceiling. Where the CLI omits `input`, the uncached figure is its own `max(0, prompt - cached)`, so a `cached` larger than `prompt` floors at zero |
| the shape is verified, not assumed | the field names, and the fact that `input_tokens` already includes `cached`, were read out of the pinned `@google/gemini-cli@0.55.1` bundle (`StreamJsonFormatter.convertToStreamStats`, `uiTelemetry.js`), whose sha256 matches `container/tools.json` |

### Findings

None.

### Accepted residuals

- **A run's own counters are self-reported.** Every provider's are; there is no
  second source to reconcile against short of the vendor's billing API, which
  a fixed-price subscription does not expose. The mitigation is the direction
  of the error: a plausible-but-inflated count spends the ceiling faster, and a
  count below zero — the only direction that could *hide* spend — is refused,
  so the figures are bounded below by zero.
- **Thought tokens are only counted where the CLI reports them.** The
  stream-json projection omits `thoughts`, so a thinking-heavy run's output
  count is the candidates alone. Deriving it from `total_tokens` would be an
  inferred number, and this module does not guess; the under-count is the
  conservative direction for a spend guard.
- **The unprojected `tokens` shape is accepted although 0.55.1 never emits it
  here.** `convertToStreamStats` flattens the counters onto each entry, and the
  unprojected form is rendered only by `--output-format json` — one
  pretty-printed document, not NDJSON, which this decoder does not read. The
  nested branch is therefore unreachable under the pinned CLI: it is tolerance
  so a version that stops projecting decodes rather than silently reading as
  "no usage", and it is the one place a `thoughts` count can be honoured. It
  widens no attack surface — it reads the same counters, through the same
  `readCounter`, out of the same already-parsed event.
