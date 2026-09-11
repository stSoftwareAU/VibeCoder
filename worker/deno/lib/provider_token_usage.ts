/**
 * Provider-aware token-usage extraction (Issue #366, parent #357; #1701).
 *
 * `token_usage.ts` reads the Claude CLI `stream-json` shape — a `result` line
 * carrying `usage.input_tokens` and friends. Codex emits its own JSONL under
 * `--json`; Gemini its own `--output-format stream-json` events. The runner
 * used to turn an unparseable stream into "no usage", which the credit log
 * then recorded as **zero tokens and zero cost** — silently.
 *
 * This is the seam that makes the gap loud (fail-loud standard, Issue #3234).
 * One entry point dispatches on the active provider descriptor's id:
 *
 * - **Claude** keeps the existing behaviour byte-for-byte, including staying
 *   quiet when a run legitimately reports no usage line.
 * - **Codex** is decoded by {@link CODEX_OUTPUT_ADAPTER}: a `turn.completed`
 *   / `token_count` usage object is mapped onto the shared {@link TokenUsage}
 *   shape. Missing usage is still UNKNOWN, never zero (Issue #1701).
 * - **Gemini** is decoded by {@link decodeGeminiTokenUsage}: the terminal
 *   `result` event's `stats.models` counters are summed onto the same shape.
 *   Missing usage is still UNKNOWN, never zero (Issue #1938).
 * - **Any other provider** is offered the shared extractor first — a CLI whose
 *   output happens to be Claude-compatible is parsed rather than warned about
 *   — and when nothing is parseable the result is marked `usageUnknown` with a
 *   warning naming the provider and the run. An absent count, never a zero.
 *
 * ```mermaid
 * flowchart LR
 *     R["raw CLI stdout"] --> X["extractProviderTokenUsage()"]
 *     X -->|claude| C["extractTokenUsage()<br/>(unchanged)"]
 *     X -->|codex| D["CODEX_OUTPUT_ADAPTER.decode()"]
 *     X -->|gemini| G["decodeGeminiTokenUsage()"]
 *     X -->|other| T["try shared extractor"]
 *     D -->|usage| U["TokenUsage"]
 *     D -->|none| W["usageUnknown + warning"]
 *     G -->|usage| U
 *     G -->|none| W
 *     T -->|parsed| U
 *     T -->|nothing| W
 *     C --> U
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "./agent_provider.ts";
import { CODEX_OUTPUT_ADAPTER } from "./codex_output_adapter.ts";
import { decodeGeminiTokenUsage } from "./gemini_token_usage.ts";
import { extractTokenUsage, type TokenUsage } from "./token_usage.ts";

/** The run whose usage is being extracted, for the warning message. */
export interface ProviderUsageContext {
  /** Provider id that produced the output (e.g. `codex`). */
  provider: string;
  /** Operator-facing provider name (e.g. `Codex CLI`). */
  displayName?: string;
  /** Repository the run worked on, when known. */
  repo?: string;
  /** Phase the run served, when known. */
  phase?: string;
  /** Model id the run was billed under, when known. */
  model?: string;
}

/** The outcome of one provider-aware extraction. */
export interface ProviderUsageResult {
  /** The extracted counts, absent when nothing was parseable. */
  usage?: TokenUsage;
  /**
   * True when a non-Claude run yielded no parseable usage.
   *
   * Callers record this on the invocation so the figures read as **unknown**
   * rather than zero — the whole point of Issue #366.
   */
  usageUnknown: boolean;
  /** One operator-facing warning, present exactly when `usageUnknown`. */
  warning?: string;
}

/** Describe the run in the warning, skipping the parts that are unknown. */
function describeRun(context: ProviderUsageContext): string {
  const parts = [`provider=${context.provider}`];
  if (context.repo) parts.push(`repo=${context.repo}`);
  if (context.phase) parts.push(`phase=${context.phase}`);
  if (context.model) parts.push(`model=${context.model}`);
  return parts.join(" ");
}

/**
 * Extract token usage from one agent run, dispatching on its provider.
 *
 * @param rawOutput - Raw stdout from the provider's CLI.
 * @param context - The provider and the run, used to name an unparseable run.
 * @returns The counts, or an `usageUnknown` result carrying the warning.
 */
export function extractProviderTokenUsage(
  rawOutput: string,
  context: ProviderUsageContext,
): ProviderUsageResult {
  const usage = extractTokenUsage(rawOutput) ?? undefined;

  // Claude: unchanged. A Claude run with no usage line is the pre-existing
  // behaviour and stays quiet.
  if (context.provider === CLAUDE_PROVIDER_ID) {
    return { ...(usage ? { usage } : {}), usageUnknown: false };
  }

  // Codex: decode its own JSONL (Issue #1701). The shared Claude extractor
  // never matches, so without this branch every Codex run was UNKNOWN even
  // when `turn.completed` carried real counts.
  if (context.provider === CODEX_PROVIDER_ID) {
    const decoded = CODEX_OUTPUT_ADAPTER.decode(rawOutput).usage;
    if (decoded) return { usage: decoded, usageUnknown: false };
  } else if (context.provider === GEMINI_PROVIDER_ID) {
    // Gemini: decode its own `--output-format stream-json` stats
    // (Issue #1938). The shared Claude extractor never matches a `result`
    // event carrying `stats` rather than `usage`, so without this branch
    // every Gemini run was UNKNOWN even when it reported real counts.
    const decoded = decodeGeminiTokenUsage(rawOutput);
    if (decoded) return { usage: decoded, usageUnknown: false };
    // A Gemini CLI whose output is Claude-compatible is still parsed rather
    // than warned about, exactly as any other provider's would be.
    if (usage) return { usage, usageUnknown: false };
  } else if (usage) {
    // A non-Claude CLI whose output happens to be Claude-compatible is
    // parsed like any other: real counts, no warning.
    return { usage, usageUnknown: false };
  }

  const name = context.displayName ?? context.provider;
  return {
    usageUnknown: true,
    warning:
      `Token usage unavailable for this ${name} run (${
        describeRun(context)
      }): its output carries no usage the worker can parse, so this run's ` +
      `tokens and cost are recorded as UNKNOWN, not zero, and are excluded ` +
      `from the day's totals. Token extraction is Claude-shaped ` +
      `(worker/deno/lib/token_usage.ts), and this run's output matched ` +
      `neither that shape nor any provider-specific decoder (Issue #366).`,
  };
}
