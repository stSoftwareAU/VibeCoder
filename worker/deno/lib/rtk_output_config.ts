/**
 * `.config.json` surface for the RTK output switch (Issue #2380, part of
 * #2328).
 *
 * One host-level switch, `rtk_output.enabled`, decides whether a run installs
 * the RTK `PreToolUse` Bash rewrite hook and tells the agent about it. It is
 * on by default (Issue #2432): a host that never mentions the block filters,
 * and a host that wants the raw output back writes `enabled: false`.
 *
 * ## Validation posture — fail loud
 *
 * A switch that changes how every Bash call is run must never be
 * half-understood: reading a malformed block as "off" would leave an operator
 * who asked for the trial with a setting that looks live and does nothing. So,
 * matching `lib/codegraph_context_config.ts` rather than the warn-and-default
 * `idle_task_cadence` parser, {@link parseRtkOutput} returns the fault as an
 * error naming the offending field and the config load throws it.
 *
 * An **unknown key inside** the block is a different case: it changes no
 * behaviour, so it is reported by `lib/config_unknown_keys.ts` as a warning,
 * the way an unknown top-level key is.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result, RtkOutputConfig } from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

/** Recognised keys inside the `rtk_output` block. */
export const RTK_OUTPUT_KEYS: ReadonlySet<string> = new Set([
  "enabled",
]);

/**
 * The switch as an unconfigured host reads it.
 *
 * The value itself lives in `OPERATIONAL_DEFAULTS` — the one place config
 * defaults are written — and a fresh object is returned each call so no caller
 * can mutate the shared default.
 */
export function defaultRtkOutput(): RtkOutputConfig {
  return { enabled: OPERATIONAL_DEFAULTS.rtkOutput.enabled };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the raw `rtk_output` block from `.config.json`.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed switch, or the first fault naming the offending field.
 */
export function parseRtkOutput(
  raw: unknown,
): Result<RtkOutputConfig, string> {
  // Only an **absent** key means "this host said nothing". An explicit `null`
  // is a written-out block, so it is refused like any other malformed one
  // rather than quietly reading as off.
  if (raw === undefined) return { ok: true, value: defaultRtkOutput() };

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: `rtk_output must be an object carrying a boolean "enabled" ` +
        `(rtk_output.enabled), got ${describe(raw)}.`,
    };
  }

  const enabled = raw.enabled;
  if (enabled === undefined) {
    return { ok: true, value: defaultRtkOutput() };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `rtk_output.enabled must be a boolean, got ${describe(enabled)}.`,
    };
  }

  return { ok: true, value: { enabled } };
}

/** Name a rejected value's JSON type, distinguishing null and array. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
