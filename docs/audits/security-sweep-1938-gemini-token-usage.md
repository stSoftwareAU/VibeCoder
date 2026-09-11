# Security sweep — Gemini CLI token-usage decoding (`gemini_token_usage.ts`)

**Issue:** [#1938](https://github.com/stSoftwareAU/VibeCoder/issues/1938)
(chunk 12aa) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12z) recorded their coverage:

- `worker/deno/lib/gemini_token_usage.ts` — added by #1938.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12aa**, and this file is the reading of it.

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
| counters are read, never coerced | `readNumber` accepts only finite numbers, so a string, `null`, `NaN` or an object in a counter field is absent — never `Number("1e400")`, never a silent `0` |
| an absent count is never a zero | a stream with no `result` event, no `stats`, an empty `stats.models`, or no readable counter in any model returns `undefined`, which `provider_token_usage.ts` turns into the `usageUnknown` warning. The fail-loud path of #366 is preserved, not routed around |
| a negative input count cannot be produced | the uncached figure is `max(0, prompt - cached)` — the CLI's own formula — so a `cached` larger than `prompt` floors at zero rather than subtracting from the day's totals |
| the shape is verified, not assumed | the field names, and the fact that `input_tokens` already includes `cached`, were read out of the pinned `@google/gemini-cli@0.55.1` bundle (`StreamJsonFormatter.convertToStreamStats`, `uiTelemetry.js`), whose sha256 matches `container/tools.json` |

### Findings

None.

### Accepted residuals

- **A run's own counters are self-reported.** Every provider's are; there is no
  second source to reconcile against short of the vendor's billing API, which
  a fixed-price subscription does not expose. The mitigation is the direction
  of the error: an inflated count spends the ceiling faster, and a deflated one
  is bounded below by zero.
- **Thought tokens are only counted where the CLI reports them.** The
  stream-json projection omits `thoughts`, so a thinking-heavy run's output
  count is the candidates alone. Deriving it from `total_tokens` would be an
  inferred number, and this module does not guess; the under-count is the
  conservative direction for a spend guard.
- **Both of the CLI's renderings are accepted.** `--output-format json` nests
  the counters under `tokens` and `stream-json` flattens them. Accepting only
  one would make the other read as "no usage", so both are read; neither is
  more trusted than the other, because both come from the same stream.
