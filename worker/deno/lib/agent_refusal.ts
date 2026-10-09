/**
 * Safety-refusal detection for agent stream-json output (Issue #3406).
 *
 * A model can end a turn with `stop_reason: "refusal"` (for example a Haiku
 * tier model declining on a `cyber` or `frontier_llm` classifier hit). This
 * module scans the raw NDJSON for those refusals so the caller can fail loudly
 * and retry once instead of treating the empty turn as success.
 *
 * Shapes were observed in the Claude Code 2.1.293 CLI's own SDK schema:
 * - `{"type":"system","subtype":"model_refusal_no_fallback","original_model",
 *   "api_refusal_category",…}` is emitted when a turn ended with
 *   `stop_reason: "refusal"` and no CLI-side retry ran.
 * - `{"type":"system","subtype":"model_refusal_fallback",…}` is emitted when
 *   the CLI itself retried the turn on a fallback model (so it recovered).
 * - `{"type":"assistant","message":{"stop_reason":"refusal","model",
 *   "stop_details":{"category"}}}` is the assistant error frame; older CLIs
 *   emit only this.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseClaudeModernVersion } from "./token_usage.ts";

/** One safety refusal an agent run ended a turn with (Issue #3406). */
export interface AgentRefusal {
  /** The model that refused, as the stream named it; "unknown" when absent. */
  model: string;
  /** The refusal category (`cyber`, `frontier_llm`, …); "unspecified" when the stream gave none. */
  category: string;
}

const MAX_CATEGORY_LENGTH = 64;

/** Model ids are API-sourced and later rendered into Markdown: keep them inert. */
function cleanModel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:@/-]/g, "");
  return cleaned || "unknown";
}

/** Lower-case, restrict to a safe alphabet and cap the length. */
function cleanCategory(value: unknown): string {
  if (typeof value !== "string") return "unspecified";
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(
    0,
    MAX_CATEGORY_LENGTH,
  );
  return cleaned || "unspecified";
}

/**
 * Extract the safety refusals a raw stream-json run recorded.
 *
 * When a structured system refusal event (either subtype) is present, only the
 * `model_refusal_no_fallback` entries are returned: newer CLIs also emit the
 * assistant frame for the same refusal (avoiding a double count), and a
 * `model_refusal_fallback` turn was recovered by the CLI itself. Otherwise the
 * assistant-frame refusals are returned (older CLIs).
 *
 * @param rawStreamOutput - Raw stream-json output from the agent CLI
 * @returns The refusals, in stream order; empty when there were none
 */
export function extractAgentRefusals(rawStreamOutput: string): AgentRefusal[] {
  const systemRefusals: AgentRefusal[] = [];
  const assistantRefusals: AgentRefusal[] = [];
  let sawStructuredSignal = false;

  for (const line of rawStreamOutput.split("\n")) {
    const trimmed = line.trim();
    // Cheap pre-check to avoid parsing every line.
    if (!trimmed.includes("refusal")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.type === "system") {
      if (parsed.subtype === "model_refusal_no_fallback") {
        sawStructuredSignal = true;
        systemRefusals.push({
          model: cleanModel(parsed.original_model),
          category: cleanCategory(parsed.api_refusal_category),
        });
      } else if (parsed.subtype === "model_refusal_fallback") {
        sawStructuredSignal = true;
      }
    } else if (
      parsed?.type === "assistant" && parsed.message?.stop_reason === "refusal"
    ) {
      assistantRefusals.push({
        model: cleanModel(parsed.message.model),
        category: cleanCategory(parsed.message.stop_details?.category),
      });
    }
  }

  return sawStructuredSignal ? systemRefusals : assistantRefusals;
}

/** True for a Haiku-tier model id (`haiku`, `claude-haiku-5-5`, …). */
export function isHaikuModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "haiku" || parseClaudeModernVersion(m)?.tier === "haiku";
}
