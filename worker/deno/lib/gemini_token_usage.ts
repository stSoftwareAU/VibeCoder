/**
 * Gemini CLI token-usage decoding (Issue #1938, parent #1930).
 *
 * `gemini_executor.ts` already runs the CLI with `--output-format stream-json`,
 * but nothing read the counts back: every Gemini run reached the credit log as
 * `usageUnknown`, so its tokens could never be shown or costed. This module is
 * the missing decoder, and only that — verdict and text parsing stay where
 * they are.
 *
 * ## The verified event shape (Gemini CLI 0.55.1)
 *
 * Read from the pinned package `@google/gemini-cli@0.55.1`
 * (`container/tools.json`; bundle sha256
 * `4587cc6f…4df7e`), which is not in the default image and so was read rather
 * than run. Every terminal `result` event — success, error, cancellation and
 * turn-limit alike — carries `stats` built by
 * `StreamJsonFormatter.convertToStreamStats()`:
 *
 * ```json
 * {"type":"result","timestamp":"…","status":"success","stats":{
 *   "total_tokens":1500,"input_tokens":1000,"output_tokens":200,
 *   "cached":400,"input":600,"duration_ms":1234,"tool_calls":2,
 *   "models":{"gemini-2.5-pro":{"total_tokens":1500,"input_tokens":1000,
 *     "output_tokens":200,"cached":400,"input":600}}}}
 * ```
 *
 * Each per-model entry is a projection of the CLI's own `ModelMetrics.tokens`
 * (`uiTelemetry.js`): `input_tokens` is `tokens.prompt`, `output_tokens` is
 * `tokens.candidates`, `cached` is `tokens.cached`, and `input` is
 * `Math.max(0, prompt - cached)`. So **`input_tokens` already includes the
 * cached prefix** — which is why `inputTokens` below is prompt *less* cached,
 * never the raw prompt.
 *
 * The same run under `--output-format json` reports the unprojected
 * `ModelMetrics` instead, nesting the counters under `tokens`
 * (`{input, prompt, candidates, total, cached, thoughts, tool}`). Both
 * per-model shapes are accepted here, because they are the same CLI's two
 * renderings of the same numbers and telling the worker about only one of them
 * would make the other read as "no usage". The nested shape is also the only
 * one carrying `thoughts`: Gemini 2.5 bills thinking as output, so where it is
 * present it is added to the output count. The stream-json projection does not
 * expose it, and a thought count is not inferred from `total_tokens` — an
 * inferred number is a guess, and this module never guesses.
 *
 * ```mermaid
 * flowchart LR
 *     S["stream-json NDJSON"] --> L["last result event"]
 *     L --> M["sum stats.models[*]"]
 *     M -->|"flat: input_tokens/cached"| U["TokenUsage"]
 *     M -->|"nested: tokens.prompt/thoughts"| U
 *     L -->|"no result / no stats"| N["undefined → usageUnknown"]
 *     M -->|"no readable counter"| N
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { parseJsonlEvents, readNumber, readObject } from "./agent_output.ts";
import type { TokenUsage } from "./token_usage.ts";

/** The terminal event kind carrying a run's session stats. */
const RESULT_EVENT = "result";

/** One model's counters, before they are folded into the run's totals. */
interface ModelCounters {
  /** Prompt tokens, cached prefix included — the CLI's `tokens.prompt`. */
  prompt: number;
  /** Model-generated tokens, thoughts included where the CLI reports them. */
  output: number;
  /** Tokens served from Gemini's context cache — the CLI's `tokens.cached`. */
  cached: number;
  /** Uncached prompt tokens, when the CLI stated them rather than implying. */
  uncached?: number;
}

/**
 * Read one entry of `stats.models`, under either of the CLI's two renderings.
 *
 * @param model - The per-model stats object from a `result` event.
 * @returns Its counters, or undefined when none of them is a finite number —
 *   an unreadable model contributes nothing rather than a fabricated zero.
 */
function readModelCounters(
  model: Record<string, unknown>,
): ModelCounters | undefined {
  // `--output-format json` nests the unprojected session metrics; stream-json
  // flattens them onto the entry itself.
  const nested = readObject(model.tokens);
  const prompt = nested
    ? readNumber(nested.prompt)
    : readNumber(model.input_tokens);
  const candidates = nested
    ? readNumber(nested.candidates)
    : readNumber(model.output_tokens);
  const cached = readNumber(nested ? nested.cached : model.cached);
  const uncached = readNumber(nested ? nested.input : model.input);
  // Only the nested rendering carries the thinking count.
  const thoughts = nested ? readNumber(nested.thoughts) : undefined;

  if (
    prompt === undefined && candidates === undefined &&
    cached === undefined && uncached === undefined
  ) {
    return undefined;
  }

  return {
    prompt: prompt ?? 0,
    // Gemini 2.5 bills thinking as output, so thoughts join the candidates.
    output: (candidates ?? 0) + (thoughts ?? 0),
    cached: cached ?? 0,
    ...(uncached !== undefined ? { uncached } : {}),
  };
}

/**
 * Decode the token usage of one Gemini CLI run.
 *
 * The stream is scanned from the end for the terminal `result` event, because
 * a run that emitted more than one (a retry, a resumed turn) is described by
 * its last set of totals.
 *
 * @param raw - Raw stdout from `gemini --output-format stream-json`.
 * @returns The run's counts, or undefined when the stream carries none.
 *   Undefined is the fail-loud path: the caller records the run as UNKNOWN
 *   rather than as a silent zero (Issue #366).
 */
export function decodeGeminiTokenUsage(raw: string): TokenUsage | undefined {
  const { events } = parseJsonlEvents(raw);

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.value;
    if (!event || event.type !== RESULT_EVENT) continue;

    const models = readObject(readObject(event.stats)?.models);
    if (!models) continue;

    let readable = false;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let inputTokens = 0;

    // A run may bill more than one model — a cheap tier for a sub-agent, the
    // routed tier for the turn itself — so the entries are summed.
    for (const model of Object.values(models)) {
      const object = readObject(model);
      const counters = object ? readModelCounters(object) : undefined;
      if (!counters) continue;
      readable = true;
      outputTokens += counters.output;
      cacheReadTokens += counters.cached;
      // The CLI's own `max(0, prompt - cached)`, reproduced when it did not
      // state the figure itself.
      inputTokens += counters.uncached ??
        Math.max(0, counters.prompt - counters.cached);
    }

    if (!readable) continue;

    return {
      inputTokens,
      outputTokens,
      // Gemini reports no cache-write counter, so the write count stays 0
      // rather than being invented from the read (as for Codex).
      cacheCreationTokens: 0,
      cacheReadTokens,
    };
  }

  return undefined;
}
