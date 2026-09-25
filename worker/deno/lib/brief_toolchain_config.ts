/**
 * `.config.json` surface for the brief toolchain switch (Issue #2603, part of
 * #2581).
 *
 * One host-level switch, `brief_toolchain.enabled`, decides whether the
 * implementation run's codebase map asks brief for a Rust repository's Cargo
 * commands. It is **off by default**: a host that never mentions the block
 * spawns no brief and renders exactly today's map.
 *
 * ## Validation posture — fail loud
 *
 * Modelled on `lib/rtk_output_config.ts`, and stricter: a malformed block, a
 * non-boolean `enabled` **or an unknown key** is returned as a fault naming
 * `brief_toolchain`, and the config load throws it. An operator who wrote
 * `{"enable": true}` asked for the trial; reading it as off would leave a
 * setting that looks live and does nothing.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { BriefToolchainConfig, Result } from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

/** Recognised keys inside the `brief_toolchain` block. */
export const BRIEF_TOOLCHAIN_KEYS: ReadonlySet<string> = new Set([
  "enabled",
]);

/** The switch as an unconfigured host reads it — a fresh object each call. */
export function defaultBriefToolchain(): BriefToolchainConfig {
  return { enabled: OPERATIONAL_DEFAULTS.briefToolchain.enabled };
}

/**
 * Parse the raw `brief_toolchain` block from `.config.json`.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed switch, or the first fault naming the offending field.
 */
export function parseBriefToolchain(
  raw: unknown,
): Result<BriefToolchainConfig, string> {
  // Only an absent key means "this host said nothing"; an explicit `null` is
  // a written-out block and is refused like any other malformed one.
  if (raw === undefined) return { ok: true, value: defaultBriefToolchain() };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: `brief_toolchain must be an object carrying a boolean "enabled" ` +
        `(brief_toolchain.enabled), got ${describe(raw)}.`,
    };
  }

  const block = raw as Record<string, unknown>;
  const unknown = Object.keys(block).find((key) =>
    !BRIEF_TOOLCHAIN_KEYS.has(key)
  );
  if (unknown !== undefined) {
    return {
      ok: false,
      error: `brief_toolchain.${unknown} is not a recognised key; ` +
        `brief_toolchain accepts only "enabled".`,
    };
  }

  const enabled = block.enabled;
  if (enabled === undefined) {
    return { ok: true, value: defaultBriefToolchain() };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `brief_toolchain.enabled must be a boolean, got ${
        describe(enabled)
      }.`,
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
