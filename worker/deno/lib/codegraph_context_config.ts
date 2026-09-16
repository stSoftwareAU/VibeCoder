/**
 * `.config.json` surface for the CodeGraph repo-context switch
 * (Issue #2154, part of #2145).
 *
 * One host-level switch, `codegraph_context.enabled`, decides whether a run
 * indexes the repository with CodeGraph and offers that index to the agent. It
 * is off by default, so a host that never mentions the block behaves exactly
 * as it does today.
 *
 * ## Validation posture — fail loud
 *
 * A spend-and-toolchain switch must never be half-understood: reading a
 * malformed block as "off" would leave an operator who asked for the trial
 * with a setting that looks live and does nothing. So, matching
 * `lib/container_extension_config.ts` rather than the warn-and-default
 * `idle_task_cadence` parser, {@link parseCodegraphContext} returns the fault
 * as an error naming the offending field and the config load throws it.
 *
 * An **unknown key inside** the block is a different case: it changes no
 * behaviour, so it is reported by `lib/config_unknown_keys.ts` as a warning,
 * the way an unknown top-level key is.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { CodegraphContextConfig, Result } from "../types.ts";

/** Recognised keys inside the `codegraph_context` block. */
export const CODEGRAPH_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "enabled",
]);

/** The switch as an unconfigured host reads it: off. */
export function defaultCodegraphContext(): CodegraphContextConfig {
  return { enabled: false };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the raw `codegraph_context` block from `.config.json`.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed switch, or the first fault naming the offending field.
 */
export function parseCodegraphContext(
  raw: unknown,
): Result<CodegraphContextConfig, string> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: defaultCodegraphContext() };
  }

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error:
        `codegraph_context must be an object with an "enabled" boolean, got ${
          Array.isArray(raw) ? "array" : typeof raw
        }.`,
    };
  }

  const enabled = raw.enabled;
  if (enabled === undefined) return { ok: true, value: { enabled: false } };
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `codegraph_context.enabled must be a boolean, got ${
        Array.isArray(enabled) ? "array" : typeof enabled
      }.`,
    };
  }

  return { ok: true, value: { enabled } };
}
