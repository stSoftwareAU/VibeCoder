/**
 * Which kind of Codex credential is in use — subscription or API key
 * (Issue #1697, parent #1694).
 *
 * The distinction is not cosmetic: a ChatGPT subscription login has rolling
 * usage windows the backend reports as percentages, while an API key has **no
 * such window at all** — its spend is bounded by the account's own rate limits
 * and billing. Inventing a weekly allowance for an API-key account, so the
 * pool has a number to rank on, would be a fabricated figure of exactly the
 * kind `provider_token_usage.ts` exists to prevent. So the budget adapter asks
 * this module first, and answers `api-key-account` rather than a percentage.
 *
 * Verified against the pinned CLI (`openai/codex` at `rust-v0.147.0`):
 * `AuthDotJson` (`codex-rs/login/src/auth/storage.rs`) is
 * `$CODEX_HOME/auth.json` with an optional `auth_mode`, an `OPENAI_API_KEY`
 * string and an optional `tokens` object; `AuthMode`
 * (`codex-rs/protocol/src/auth.rs`) serialises `rename_all = "lowercase"` with
 * explicit renames for the camelCase variants.
 *
 * **No credential value is ever read.** Only the presence of a key is
 * inspected, so nothing this module returns can carry a token, and a caller
 * cannot accidentally log one.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { CODEX_API_KEY_ENV_VARS } from "./codex_auth.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** How Codex is authenticated, as far as the budget question is concerned. */
export type CodexAuthMode =
  /** An API key: metered spend, no subscription window. */
  | "api-key"
  /** A ChatGPT login: rolling percentage windows exist. */
  | "chatgpt"
  /** Neither could be established. */
  | "unknown";

/** Where the answer came from — recorded so an operator can check it. */
export type CodexAuthModeSource =
  | "env"
  | "auth-json-field"
  | "auth-json-shape"
  | "absent"
  | "read-error";

/** The resolved credential kind and its provenance. */
export interface CodexAuthModeResult {
  readonly mode: CodexAuthMode;
  readonly source: CodexAuthModeSource;
  /** Operator-facing context; never a credential value. */
  readonly detail?: string;
}

/** `AuthMode` spellings that mean "metered API key, no subscription window". */
const API_KEY_AUTH_MODES: readonly string[] = ["apikey", "bedrockapikey"];

/** `AuthMode` spellings that mean "ChatGPT login, windows exist". */
const CHATGPT_AUTH_MODES: readonly string[] = ["chatgpt", "chatgptauthtokens"];

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve which Codex credential kind is in play.
 *
 * Precedence, most authoritative first:
 *   1. `OPENAI_API_KEY` / `CODEX_API_KEY` in the environment — metered API
 *      authentication. `CODEX_HOME` is deliberately NOT in this check: it is
 *      only a pointer to the file-backed login inspected below (#1924).
 *   2. `auth.json`'s own `auth_mode` field, when it names a mode.
 *   3. `auth.json`'s shape: a `tokens` object is a ChatGPT login; a non-empty
 *      `OPENAI_API_KEY` is an API key.
 *
 * @param codexHome - The `CODEX_HOME` directory holding `auth.json`.
 * @param env - Environment lookup; defaults to the process environment.
 * @returns The mode and where it was established, never throwing.
 */
export function resolveCodexAuthMode(
  codexHome: string,
  env: EnvLookup = processEnvLookup,
): CodexAuthModeResult {
  for (const name of CODEX_API_KEY_ENV_VARS) {
    if ((env(name) ?? "").trim().length > 0) {
      return { mode: "api-key", source: "env", detail: `${name} is set` };
    }
  }

  const authPath = `${codexHome.replace(/\/+$/, "")}/auth.json`;
  let raw: string;
  try {
    raw = Deno.readTextFileSync(authPath);
  } catch (error: unknown) {
    // A missing file is the ordinary "not logged in yet" case, not a fault.
    if (error instanceof Deno.errors.NotFound) {
      return { mode: "unknown", source: "absent", detail: "no auth.json" };
    }
    return {
      mode: "unknown",
      source: "read-error",
      detail: `auth.json unreadable: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      mode: "unknown",
      source: "read-error",
      detail: "auth.json is not valid JSON",
    };
  }
  if (!isRecord(parsed)) {
    return {
      mode: "unknown",
      source: "read-error",
      detail: "auth.json is not an object",
    };
  }

  const declared = typeof parsed.auth_mode === "string"
    ? parsed.auth_mode.trim().toLowerCase()
    : "";
  if (API_KEY_AUTH_MODES.includes(declared)) {
    return { mode: "api-key", source: "auth-json-field" };
  }
  if (CHATGPT_AUTH_MODES.includes(declared)) {
    return { mode: "chatgpt", source: "auth-json-field" };
  }

  if (isRecord(parsed.tokens)) {
    return { mode: "chatgpt", source: "auth-json-shape" };
  }
  if (
    typeof parsed.OPENAI_API_KEY === "string" &&
    parsed.OPENAI_API_KEY.trim().length > 0
  ) {
    return { mode: "api-key", source: "auth-json-shape" };
  }

  return {
    mode: "unknown",
    source: "auth-json-shape",
    detail: declared.length > 0
      ? `auth_mode "${declared}" carries no subscription-window meaning`
      : "auth.json names neither tokens nor an API key",
  };
}
