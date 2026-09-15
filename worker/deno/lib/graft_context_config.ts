/**
 * The `.config.json` `graft_context` block — the host switch for Graft
 * repo-context injection (Issue #2098, part of #2060).
 *
 * ```json
 * {
 *   "graft_context": {
 *     "enabled": true
 *   }
 * }
 * ```
 *
 * The block is optional and the switch is **off**: a host that never writes
 * it behaves exactly as it does today. The operator turns it on per host, so
 * the cost of building and injecting a Graft code graph is opted into
 * deliberately rather than arriving with an update.
 *
 * ## Validation posture — fail loud on the switch, warn on a stray key
 *
 * A malformed block **stops the worker** at config load, the way
 * `assertCallbacksConfig` does for `callbacks`: an operator who wrote
 * `"enabled": "yes"` believes the feature is on, and silently reading that as
 * off is the class of failure this repo refuses to ship. The error names the
 * key so the fix is obvious.
 *
 * An *unrecognised* key inside the block is a different case — it changes no
 * behaviour — so it warns and is ignored, exactly the way an unknown
 * top-level key does (`detectUnknownConfigKeys`).
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import type { Result } from "../types.ts";
import {
  detectUnknownNestedKeys,
  formatUnknownKeyWarnings,
} from "./config_unknown_keys.ts";

/** The `.config.json` key this block lives under. */
export const GRAFT_CONTEXT_CONFIG_KEY = "graft_context";

/** Keys recognised inside the `graft_context` block. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(["enabled"]);

/** The validated `graft_context` block. */
export interface GraftContextConfig {
  /** Whether Graft repo-context injection runs on this host. */
  enabled: boolean;
}

/**
 * The default block — Graft off.
 *
 * A fresh object each call, so a caller mutating a built config can never
 * corrupt a shared default.
 */
export function graftContextOff(): GraftContextConfig {
  return { enabled: false };
}

/** Options for {@link parseGraftContextConfig}. */
export interface ParseGraftContextOptions {
  /** Warning sink for unrecognised nested keys. Defaults to `console.error`. */
  warn?: (message: string) => void;
}

/** Short description of a value for an error message. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Validate the raw `graft_context` block from `.config.json`.
 *
 * Absent or null yields {@link graftContextOff}; a block that is not an
 * object, or an `enabled` that is not a boolean, is reported rather than
 * repaired. Unrecognised nested keys are warned about and ignored.
 */
export function parseGraftContextConfig(
  raw: unknown,
  options: ParseGraftContextOptions = {},
): Result<GraftContextConfig, string> {
  const warn = options.warn ?? ((message: string) => console.error(message));

  if (raw === undefined || raw === null) {
    return { ok: true, value: graftContextOff() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        `${GRAFT_CONTEXT_CONFIG_KEY} must be an object with an "enabled" boolean, got ${
          show(raw)
        }`,
    };
  }

  const block = raw as Record<string, unknown>;
  const warnings = detectUnknownNestedKeys(
    block,
    GRAFT_CONTEXT_CONFIG_KEY,
    KNOWN_KEYS,
  );
  if (warnings.length > 0) warn(formatUnknownKeyWarnings(warnings));

  const config = graftContextOff();
  if (block.enabled !== undefined) {
    if (typeof block.enabled !== "boolean") {
      return {
        ok: false,
        error: `${GRAFT_CONTEXT_CONFIG_KEY}.enabled must be a boolean, got ${
          show(block.enabled)
        }`,
      };
    }
    config.enabled = block.enabled;
  }
  return { ok: true, value: config };
}

/**
 * {@link parseGraftContextConfig}, but throwing — the fail-loud entry point
 * used at config load, so a malformed block stops the worker rather than
 * reading as off on a host the operator believes has Graft on.
 */
export function assertGraftContextConfig(
  raw: unknown,
  options: ParseGraftContextOptions = {},
): GraftContextConfig {
  const parsed = parseGraftContextConfig(raw, options);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
