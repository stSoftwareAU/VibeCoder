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
 * **That projection omits `thoughts`.** The CLI keeps an unprojected
 * `ModelMetrics.tokens` internally — `{input, prompt, candidates, total,
 * cached, thoughts, tool}` — and `convertToStreamStats` drops all but five of
 * its fields, so a stream-json run's output count is its candidates alone.
 * Gemini 2.5 bills thinking as output, so that under-counts a thinking-heavy
 * run; the deficit is **not** inferred from `total_tokens`, because an
 * inferred number is a guess and this module never guesses. Under-counting is
 * the conservative direction for a spend guard, and a run whose stats are
 * absent entirely still takes the fail-loud path below.
 *
 * A per-model entry that *does* nest its counters under `tokens` is therefore
 * read as the unprojected shape, thoughts included. No envelope 0.55.1 emits
 * on this stream carries it — `--output-format json` renders the unprojected
 * metrics, but as one pretty-printed document rather than NDJSON, which this
 * decoder does not read — so the branch is tolerance for a future envelope,
 * not a second supported input format. It is here so a CLI that stops
 * projecting decodes rather than silently reading as "no usage".
 *
 * ```mermaid
 * flowchart LR
 *     S["stream-json NDJSON"] --> L["last result event"]
 *     L --> M["sum stats.models[*]"]
 *     M -->|"flat: input_tokens/cached"| U["TokenUsage"]
 *     M -->|"nested: tokens.prompt/thoughts"| U
 *     L -->|"no result / no stats"| N["undefined → usageUnknown"]
 *     M -->|"a counter missing or stated unusably"| N
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
 * A counter the CLI never stated, as distinct from one it stated unusably.
 *
 * `null` is the second case, and it is not a zero: a field carrying a string,
 * an object, `NaN` or a **negative** count means this entry cannot be read at
 * all, so the model is dropped rather than counted at whatever the other
 * fields happened to say. A negative token count is not a small number — it
 * would *subtract* from the day's totals and from the spend ceiling, so it is
 * refused here rather than propagated.
 *
 * @param source - The object carrying the counters.
 * @param key - The counter to read.
 * @returns The count, `undefined` when the field is absent, `null` when it is
 *   present but not a non-negative finite number.
 */
function readCounter(
  source: Record<string, unknown>,
  key: string,
): number | undefined | null {
  if (!(key in source)) return undefined;
  const value = readNumber(source[key]);
  return value === undefined || value < 0 ? null : value;
}

/**
 * Read one entry of `stats.models`, under either of the CLI's two renderings.
 *
 * @param model - The per-model stats object from a `result` event.
 * @returns Its counters, or undefined when the entry omits either billable
 *   counter or states any counter unusably — either way it contributes
 *   nothing rather than a fabricated zero.
 */
function readModelCounters(
  model: Record<string, unknown>,
): ModelCounters | undefined {
  // The unprojected metrics nest their counters; stream-json flattens the
  // five it keeps onto the entry itself.
  const nested = readObject(model.tokens);
  const source = nested ?? model;
  const prompt = readCounter(source, nested ? "prompt" : "input_tokens");
  const candidates = readCounter(
    source,
    nested ? "candidates" : "output_tokens",
  );
  const cached = readCounter(source, "cached");
  const uncached = readCounter(source, "input");
  // Only the unprojected shape carries the thinking count.
  const thoughts = nested ? readCounter(nested, "thoughts") : undefined;

  // One unusable counter condemns the entry: a partly-read model would put a
  // zero where a real count belongs, which is the silent failure this whole
  // seam exists to prevent (Issue #366).
  if (
    prompt === null || candidates === null || cached === null ||
    uncached === null || thoughts === null
  ) {
    return undefined;
  }
  // The two billable counters are the ones every real entry carries, so an
  // entry missing either is not a run this decoder can cost. `cached`,
  // `input` and `thoughts` may legitimately be absent — no cache, no
  // thinking — and only those default to zero.
  if (prompt === undefined || candidates === undefined) return undefined;

  return {
    prompt,
    // Gemini 2.5 bills thinking as output, so thoughts join the candidates.
    output: candidates + (thoughts ?? 0),
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
      // An entry missing a billable counter, or stating one unusably, is
      // skipped; when every entry is skipped the run decodes to undefined.
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
