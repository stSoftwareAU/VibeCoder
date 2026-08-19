/**
 * Per-run Claude generation stats extraction (Issue #2647).
 *
 * Scans the raw Claude CLI stream-json NDJSON output for the observability
 * fields that `ClaudeRunResult` would otherwise discard: the **served** model
 * IDs declared per assistant response by the API, plus the optional
 * `num_turns`, `duration_ms`, and `modelUsage` extras from the final `result`
 * line. Token usage is reused from `extractTokenUsage()` — parsing is never
 * duplicated (DRY).
 *
 * Every field beyond the served-model list is optional: older CLI versions may
 * omit them, and malformed or missing lines must degrade gracefully rather than
 * throw. This is the foundation for the per-plan-run stats comment and
 * degraded-model detection (#2646).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { extractTokenUsage, type TokenUsage } from "./token_usage.ts";
import {
  type CacheHitRate,
  computeCacheHitRate,
} from "./prompt_cache_telemetry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Stats parsed directly from the raw stream-json output.
 *
 * These are the fields that come from the NDJSON itself. The requested model,
 * effort, and wall-clock duration are layered on by the caller (which already
 * resolves them) to form the full {@link RunStats}.
 */
export interface StreamRunStats {
  /**
   * Distinct served model IDs, in first-seen order, collected from the
   * `message.model` field of every `assistant`-type line. The per-response
   * `model` returned by the API is the source of truth for "what was used".
   */
  servedModels: string[];
  /** Token usage from the `result` line (reused from extractTokenUsage). */
  tokenUsage?: TokenUsage;
  /** Number of turns from the `result` line, when present. */
  numTurns?: number;
  /** Duration in milliseconds from the `result` line, when present. */
  durationMs?: number;
  /** Per-model usage breakdown from the `result` line, when present. */
  modelUsage?: Record<string, unknown>;
}

/**
 * Full per-run generation stats surfaced on a Claude run result.
 *
 * Combines the parsed stream-json fields with the requested model, effort, and
 * worker wall-clock that the runner already computes.
 */
export interface RunStats {
  /** Distinct served model IDs declared per assistant response by the API. */
  servedModels: string[];
  /** The requested model, resolved from options/phase by the caller. */
  requestedModel: string;
  /** Effort level requested, passed through verbatim (e.g. "high", "xhigh"). */
  effort?: string;
  /** Token usage from the `result` line, when present. */
  tokenUsage?: TokenUsage;
  /** Number of turns from the `result` line, when present. */
  numTurns?: number;
  /**
   * Run duration in milliseconds: the `result` line's `duration_ms` when
   * present, otherwise the worker-measured wall-clock.
   */
  durationMs?: number;
  /** Per-model usage breakdown from the `result` line, when present. */
  modelUsage?: Record<string, unknown>;
  /** Worker-measured wall-clock duration in milliseconds. */
  wallClockMs: number;
  /**
   * Id of the coding-agent provider that produced this run (Issue #4109).
   *
   * A Quorum run makes several invocations on different vendors in one
   * process, so the stats say which agent each set of figures came from.
   * Optional for stats built before the per-invocation seam existed.
   */
  provider?: string;
}

// ---------------------------------------------------------------------------
// Served model extraction
// ---------------------------------------------------------------------------

/**
 * Collect the distinct served model IDs from assistant-type stream-json lines.
 *
 * The per-response `message.model` field is the source of truth for the model
 * the API actually served (the same field the Anthropic migration guide
 * verifies with `response.model.startsWith(...)`). Results preserve first-seen
 * order; unparseable lines are skipped silently.
 *
 * @param rawStreamOutput - Raw stream-json output from the Claude CLI
 * @returns Distinct served model IDs in first-seen order
 */
function extractServedModels(rawStreamOutput: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of rawStreamOutput.split("\n")) {
    const trimmed = line.trim();
    // Quick pre-check to avoid parsing every line.
    if (!trimmed.includes('"assistant"') || !trimmed.includes('"model"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const served = parsed?.message?.model;
      if (
        parsed?.type === "assistant" && typeof served === "string" && served
      ) {
        if (!seen.has(served)) {
          seen.add(served);
          ordered.push(served);
        }
      }
    } catch {
      // Skip malformed NDJSON lines.
      continue;
    }
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// Result-line extras
// ---------------------------------------------------------------------------

/**
 * Read the optional extras (`num_turns`, `duration_ms`, `modelUsage`) from the
 * final `result`-type line.
 *
 * All three are optional — older or partial CLI output may omit any of them, so
 * each is included only when present and well-typed. Missing result line or
 * malformed JSON degrades to an empty object, never an exception.
 *
 * @param rawStreamOutput - Raw stream-json output from the Claude CLI
 * @returns The present extras (any subset of the three)
 */
function extractResultExtras(
  rawStreamOutput: string,
): Pick<StreamRunStats, "numTurns" | "durationMs" | "modelUsage"> {
  const lines = rawStreamOutput.split("\n").filter((l) => l.trim());

  // Scan from the end — the result line is typically last.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"result"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type !== "result") continue;

      const extras: Pick<
        StreamRunStats,
        "numTurns" | "durationMs" | "modelUsage"
      > = {};
      if (typeof parsed.num_turns === "number") {
        extras.numTurns = parsed.num_turns;
      }
      if (typeof parsed.duration_ms === "number") {
        extras.durationMs = parsed.duration_ms;
      }
      if (
        parsed.modelUsage && typeof parsed.modelUsage === "object" &&
        !Array.isArray(parsed.modelUsage)
      ) {
        extras.modelUsage = parsed.modelUsage as Record<string, unknown>;
      }
      return extras;
    } catch {
      // Skip malformed result line and keep scanning earlier lines.
      continue;
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// Combined extraction
// ---------------------------------------------------------------------------

/**
 * Extract per-run stats from raw Claude CLI stream-json output.
 *
 * Combines the distinct served model IDs (from assistant lines), the token
 * usage (reused from {@link extractTokenUsage}), and the optional result-line
 * extras. Always returns a value — empty/malformed input yields a stats object
 * with whatever was parseable (at minimum an empty `servedModels` list).
 *
 * @param rawStreamOutput - Raw stream-json output from the Claude CLI
 * @returns The parseable stream stats
 */
export function extractRunStats(rawStreamOutput: string): StreamRunStats {
  const servedModels = extractServedModels(rawStreamOutput);
  const tokenUsage = extractTokenUsage(rawStreamOutput) ?? undefined;
  const extras = extractResultExtras(rawStreamOutput);

  return {
    servedModels,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...extras,
  };
}

/**
 * Assemble the full {@link RunStats} from parsed stream stats plus the
 * caller-resolved request context.
 *
 * `durationMs` prefers the result line's reported duration and falls back to
 * the worker wall-clock when the CLI did not report one. The effort string is
 * passed through verbatim so new levels (e.g. `xhigh`, #2620) flow untouched.
 *
 * @param rawStreamOutput - Raw stream-json output from the Claude CLI
 * @param context - Resolved requested model, effort, and wall-clock duration
 * @returns The full per-run stats object
 */
export function buildRunStats(
  rawStreamOutput: string,
  context: {
    requestedModel: string;
    effort?: string;
    wallClockMs: number;
    /** Provider that produced the run (Issue #4109). */
    provider?: string;
  },
): RunStats {
  const parsed = extractRunStats(rawStreamOutput);
  return {
    servedModels: parsed.servedModels,
    requestedModel: context.requestedModel,
    ...(context.effort ? { effort: context.effort } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
    ...(parsed.tokenUsage ? { tokenUsage: parsed.tokenUsage } : {}),
    ...(parsed.numTurns !== undefined ? { numTurns: parsed.numTurns } : {}),
    ...(parsed.modelUsage ? { modelUsage: parsed.modelUsage } : {}),
    // Result-line duration wins; otherwise fall back to wall-clock.
    durationMs: parsed.durationMs ?? context.wallClockMs,
    wallClockMs: context.wallClockMs,
  };
}

// ---------------------------------------------------------------------------
// Aggregation across multiple plan-generating calls (Issue #2653)
// ---------------------------------------------------------------------------

/**
 * Per-run stats aggregated across every plan-generating Claude call.
 *
 * A single planning run can make more than one plan-generating invocation (the
 * initial run plus the explicit `gh issue create` retry, and — once the
 * self-critique child of #2646 lands — the critique and revision turns). This
 * rolls the individual {@link RunStats} up into one set of figures for the
 * per-run stats comment.
 */
export interface AggregatedRunStats {
  /** Number of plan-generating calls aggregated. */
  callCount: number;
  /** Distinct served model IDs across all calls, in first-seen order. */
  servedModels: string[];
  /** Distinct requested models across all calls, in first-seen order. */
  requestedModels: string[];
  /** Distinct effort levels used across all calls, in first-seen order. */
  efforts: string[];
  /** Summed token usage across calls (zeroed when no call reported usage). */
  tokenUsage: TokenUsage;
  /** Summed turn count, or undefined if no call reported `num_turns`. */
  numTurns?: number;
  /** Summed run duration in milliseconds across calls. */
  durationMs: number;
  /** Summed worker wall-clock duration in milliseconds across calls. */
  wallClockMs: number;
  /**
   * Anthropic prompt-cache hit rate across the aggregated calls (Issue #4282).
   *
   * Derived from the same summed {@link tokenUsage}, so a prefix regression —
   * a volatile token pushing the cached share down — is visible in the run
   * stats instead of only on the bill. `measured: false` when no call reported
   * prompt tokens.
   */
  cacheHitRate: CacheHitRate;
}

/** Append a value to a list only when it is not already present (first-seen order). */
function pushDistinct(target: string[], value: string | undefined): void {
  if (value && !target.includes(value)) target.push(value);
}

/**
 * Aggregate per-run stats across all plan-generating calls in a run.
 *
 * Served models, requested models, and effort levels are unioned in first-seen
 * order (so a mid-run model downgrade stays visible); token counts, turn counts
 * and durations are summed. An empty input yields a zeroed aggregate with
 * `callCount: 0` so callers can decide whether a stats comment is warranted.
 *
 * @param statsList - Per-call stats in invocation order
 * @returns The aggregated stats
 */
export function aggregateRunStats(statsList: RunStats[]): AggregatedRunStats {
  const servedModels: string[] = [];
  const requestedModels: string[] = [];
  const efforts: string[] = [];
  const tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let numTurns: number | undefined;
  let durationMs = 0;
  let wallClockMs = 0;

  for (const stats of statsList) {
    for (const m of stats.servedModels) pushDistinct(servedModels, m);
    pushDistinct(requestedModels, stats.requestedModel);
    pushDistinct(efforts, stats.effort);

    if (stats.tokenUsage) {
      tokenUsage.inputTokens += stats.tokenUsage.inputTokens;
      tokenUsage.outputTokens += stats.tokenUsage.outputTokens;
      tokenUsage.cacheCreationTokens += stats.tokenUsage.cacheCreationTokens;
      tokenUsage.cacheReadTokens += stats.tokenUsage.cacheReadTokens;
    }
    if (stats.numTurns !== undefined) {
      numTurns = (numTurns ?? 0) + stats.numTurns;
    }
    if (stats.durationMs !== undefined) durationMs += stats.durationMs;
    wallClockMs += stats.wallClockMs;
  }

  return {
    callCount: statsList.length,
    servedModels,
    requestedModels,
    efforts,
    tokenUsage,
    ...(numTurns !== undefined ? { numTurns } : {}),
    durationMs,
    wallClockMs,
    cacheHitRate: computeCacheHitRate(tokenUsage),
  };
}
