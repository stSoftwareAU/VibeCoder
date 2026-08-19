/**
 * Wrapper model-tier reader (Issue #4010).
 *
 * The cadence bias (#4003) files an idle-task wrapper for a specific tier —
 * a cheap weekly `sonnet` scan, an expensive monthly `fable` one. The filing
 * process and the worker that later claims the wrapper are different runs, so
 * the intended tier travels in the wrapper body: the attribution footer's
 * model segment (`· Model: \`sonnet\``, Issue #4007). This module is the
 * reading side.
 *
 * Security boundary: an issue body is user-editable, so the parsed value is
 * allowlisted against {@link MODEL_TIERS} before it can reach `--model`. A
 * hand-edited or prompt-injected wrapper can therefore only ever *select among
 * existing tiers* — never route a run to an arbitrary model string, and never
 * raise spend above `fable`. Anything unrecognised is ignored with a warning
 * and the run falls back to the template's phase default.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Logger } from "../types.ts";
import { isModelTier, type ModelTier } from "./token_usage.ts";
import {
  ATTRIBUTION_FOOTER_PREFIX,
  ATTRIBUTION_MODEL_LABEL,
} from "./idle_task_attribution.ts";

/** Cap on the tier text echoed into a warning, so junk cannot flood the log. */
const MAX_LOGGED_TIER_CHARS = 64;

/** Options for {@link parseWrapperModelTier}. */
export interface ParseWrapperModelTierOptions {
  /** Sink for the "ignored tier" warning. Omit to parse silently. */
  logger?: Logger;
  /** Structured context merged into the warning (e.g. repo, issue number). */
  context?: Record<string, unknown>;
}

/**
 * Return the raw model segment of a footer line, or null when the line
 * carries no model stamp at all.
 *
 * Accepts an empty stamp (`Model: \`\``) so a present-but-unusable segment is
 * reported as invalid rather than read as "unstamped" — a silent fallback
 * would hide a broken filer.
 */
function extractRawTier(line: string): string | null {
  const idx = line.indexOf(ATTRIBUTION_MODEL_LABEL);
  if (idx < 0) return null;
  const rest = line.slice(idx + ATTRIBUTION_MODEL_LABEL.length).trim();
  const quoted = /^`([^`]*)`/.exec(rest);
  return quoted ? quoted[1]! : rest;
}

/**
 * Recover the model tier an idle-task wrapper was filed for.
 *
 * Reads the **last** attribution footer in the body: templates may embed a
 * footer inside their prompt (the stamp Claude copies onto each finding it
 * files), and the filer appends the authoritative one to the end of the body.
 *
 * @param body - Raw wrapper issue body.
 * @param opts - Optional logger + context for the ignored-tier warning.
 * @returns The honoured tier, or `undefined` when the wrapper carries no
 *   stamp or an unrecognised one — callers then leave `model` unset and the
 *   run keeps its existing phase default.
 */
export function parseWrapperModelTier(
  body: string,
  opts: ParseWrapperModelTierOptions = {},
): ModelTier | undefined {
  const footerLine = body
    .split("\n")
    .filter((line) => line.trim().startsWith(ATTRIBUTION_FOOTER_PREFIX))
    .at(-1);
  if (footerLine === undefined) return undefined;

  const raw = extractRawTier(footerLine);
  if (raw === null) return undefined;

  const normalised = raw.trim().toLowerCase();
  if (isModelTier(normalised)) return normalised;

  opts.logger?.warn("idle-task wrapper carries an unknown model tier", {
    ...opts.context,
    tier: raw.slice(0, MAX_LOGGED_TIER_CHARS),
  });
  return undefined;
}
