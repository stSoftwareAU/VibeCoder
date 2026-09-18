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

import type { Result, WorkerConfig } from "../types.ts";
import {
  detectUnknownNestedKeys,
  formatUnknownKeyWarnings,
} from "./config_unknown_keys.ts";

/** The `.config.json` key this block lives under. */
export const GRAFT_CONTEXT_CONFIG_KEY = "graft_context";

/** Keys recognised inside the `graft_context` block. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(["enabled", "deep"]);

/** Keys recognised inside `graft_context.deep` (Issue #2315). */
const KNOWN_DEEP_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "model",
  "base_url",
  "api_key_env",
  "timeout_seconds",
  "concurrency",
]);

/**
 * The wire formats Graft's summary pass can speak (Issue #2315).
 *
 * Graft is vendor-neutral: `openai` is any OpenAI-compatible endpoint (a
 * `base_url` picks OpenRouter, Fireworks, Groq, a local server or OpenAI
 * itself), `anthropic` the native API, `litellm` and `orcarouter` their
 * gateways. The provider is the format, never a company.
 */
export const GRAFT_DEEP_PROVIDERS = [
  "anthropic",
  "openai",
  "litellm",
  "orcarouter",
] as const;

export type GraftDeepProvider = (typeof GRAFT_DEEP_PROVIDERS)[number];

/**
 * The environment variable each provider's key is read from unless
 * `api_key_env` names another. Always a NAME — the key itself never enters
 * `.config.json`.
 */
export const GRAFT_DEEP_DEFAULT_API_KEY_ENV: Readonly<
  Record<GraftDeepProvider, string>
> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  litellm: "LITELLM_API_KEY",
  orcarouter: "ORCAROUTER_API_KEY",
};

/**
 * How long a `graft build --deep` may run before the structural build takes
 * over (Issue #2315). Graft checkpoints every summary by body hash, so a pass
 * cut here keeps what it paid for and the next run continues from there.
 */
export const GRAFT_DEEP_DEFAULT_TIMEOUT_SECONDS = 1800;

/** The validated `graft_context.deep` block (Issue #2315). */
export interface GraftDeepConfig {
  /** Wire format the summaries are written through. */
  provider: GraftDeepProvider;
  /** Model id as the provider names it; Graft's per-provider default otherwise. */
  model?: string;
  /** Base URL for the `openai` wire format — how a gateway is picked. */
  baseUrl?: string;
  /** Environment variable holding the key; never the key itself. */
  apiKeyEnv: string;
  /** Limit on the summary pass, in seconds. */
  timeoutSeconds: number;
  /** Files summarised in parallel (Graft's `-j`); Graft's default otherwise. */
  concurrency?: number;
}

/** The validated `graft_context` block. */
export interface GraftContextConfig {
  /** Whether Graft repo-context injection runs on this host. */
  enabled: boolean;
  /** The Tier-2 summary pass (Issue #2315); absent means structural only. */
  deep?: GraftDeepConfig;
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

/**
 * Whether this host has Graft repo-context injection switched on.
 *
 * The one read point for the switch, so a caller never reaches into the block
 * itself and the default — off — is stated in exactly one place.
 */
export function isGraftContextEnabled(config: WorkerConfig): boolean {
  return config.graftContext.enabled;
}

/**
 * The summary-pass settings a run should build with, or `undefined` for a
 * structural build (Issue #2315).
 *
 * Read through the switch: a `deep` block on a host whose `enabled` is off is
 * configuration for a day the switch is on, not a reason to spend a key now.
 */
export function graftDeepConfig(
  config: WorkerConfig,
): GraftDeepConfig | undefined {
  return config.graftContext.enabled ? config.graftContext.deep : undefined;
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
  if (block.deep !== undefined && block.deep !== null) {
    const deep = parseGraftDeepConfig(block.deep, warn);
    if (!deep.ok) return deep;
    config.deep = deep.value;
  }
  return { ok: true, value: config };
}

/** A positive whole number, or a message naming the key that is not one. */
function positiveInteger(
  value: unknown,
  key: string,
): Result<number, string> {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: `${key} must be a positive whole number, got ${show(value)}`,
  };
}

/** A non-empty string, or a message naming the key that is not one. */
function nonEmptyString(value: unknown, key: string): Result<string, string> {
  if (typeof value === "string" && value.trim() !== "") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: `${key} must be a non-empty string, got ${show(value)}`,
  };
}

/**
 * Validate the raw `graft_context.deep` block (Issue #2315).
 *
 * `provider` is required and must be one of {@link GRAFT_DEEP_PROVIDERS}; the
 * rest are optional and typed. Unrecognised keys warn and are ignored. A key
 * *value* is never accepted here: `api_key_env` names a variable, and a value
 * that looks like a credential rather than a name is rejected so a key pasted
 * into the configuration by mistake stops the worker instead of being logged.
 */
function parseGraftDeepConfig(
  raw: unknown,
  warn: (message: string) => void,
): Result<GraftDeepConfig, string> {
  const key = `${GRAFT_CONTEXT_CONFIG_KEY}.deep`;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `${key} must be an object with a "provider", got ${show(raw)}`,
    };
  }
  const block = raw as Record<string, unknown>;
  const warnings = detectUnknownNestedKeys(block, key, KNOWN_DEEP_KEYS);
  if (warnings.length > 0) warn(formatUnknownKeyWarnings(warnings));

  const provider = block.provider;
  if (
    typeof provider !== "string" ||
    !(GRAFT_DEEP_PROVIDERS as readonly string[]).includes(provider)
  ) {
    return {
      ok: false,
      error: `${key}.provider must be one of ${
        GRAFT_DEEP_PROVIDERS.join(", ")
      }, got ${show(provider)}`,
    };
  }
  const config: GraftDeepConfig = {
    provider: provider as GraftDeepProvider,
    apiKeyEnv: GRAFT_DEEP_DEFAULT_API_KEY_ENV[provider as GraftDeepProvider],
    timeoutSeconds: GRAFT_DEEP_DEFAULT_TIMEOUT_SECONDS,
  };
  if (block.model !== undefined) {
    const model = nonEmptyString(block.model, `${key}.model`);
    if (!model.ok) return model;
    config.model = model.value;
  }
  if (block.base_url !== undefined) {
    const baseUrl = nonEmptyString(block.base_url, `${key}.base_url`);
    if (!baseUrl.ok) return baseUrl;
    config.baseUrl = baseUrl.value;
  }
  if (block.api_key_env !== undefined) {
    const name = block.api_key_env;
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      return {
        ok: false,
        error: `${key}.api_key_env must be the NAME of an environment ` +
          `variable (letters, digits and underscores), never a key; got ${
            typeof name === "string" ? "a value that is not a name" : show(name)
          }`,
      };
    }
    config.apiKeyEnv = name;
  }
  if (block.timeout_seconds !== undefined) {
    const timeout = positiveInteger(
      block.timeout_seconds,
      `${key}.timeout_seconds`,
    );
    if (!timeout.ok) return timeout;
    config.timeoutSeconds = timeout.value;
  }
  if (block.concurrency !== undefined) {
    const concurrency = positiveInteger(
      block.concurrency,
      `${key}.concurrency`,
    );
    if (!concurrency.ok) return concurrency;
    config.concurrency = concurrency.value;
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
