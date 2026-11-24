/**
 * Gemini CLI authentication classification (Issue #4107).
 *
 * The Gemini counterpart of `claude_auth.ts` and `codex_auth.ts`: decide
 * whether CLI output is an authentication failure rather than ordinary work
 * failing, and give the operator a message that names the credential to set.
 * Both the credential preflight (`credential_preflight.ts`) and the mid-run
 * failure path (`issue_worker_wiring.ts`) classify through the provider
 * descriptor, so this module is the single definition of "Gemini could not
 * authenticate".
 *
 * It also records how a Google-account login is recognised (Issue #5339), so
 * a fixed-price Gemini subscription can be told apart from a metered API key.
 * Verified against the pinned Gemini CLI 0.68.0 bundle (npm
 * `@google/gemini-cli-0.68.0.tgz`, sha256
 * `325099ddcb56937c27d119e7297bfa8a5e29b529bae3c92fdf3b71a36d5fa006`, the pin
 * in `container/tools.json`):
 *   - `homedir()` returns `process.env["GEMINI_CLI_HOME"]` when set, else
 *     `os.homedir()`; the global directory is `<home>/.gemini`
 *     (`Storage.getGlobalGeminiDir`).
 *   - The Google login is `Storage.getOAuthCredsPath()`, i.e.
 *     `<home>/.gemini/oauth_creds.json` (`OAUTH_FILE = "oauth_creds.json"`),
 *     plain JSON written by `cacheCredentials` unless
 *     `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` (encrypted storage is not
 *     supported by this probe). It is google-auth-library `Credentials`
 *     (`refresh_token`, `access_token`, `expiry_date`, ...); unattended use
 *     needs the `refresh_token`.
 *   - User settings are `<home>/.gemini/settings.json`. The non-interactive
 *     auth type is `settings.merged.security.auth.selectedType` first, else
 *     `getAuthTypeFromEnv()`, which checks `GOOGLE_GENAI_USE_GCA === "true"`
 *     (`"oauth-personal"`) FIRST, then Vertex, gateway, then `GEMINI_API_KEY`
 *     (`"gemini-api-key"`). AuthType values: LOGIN_WITH_GOOGLE =
 *     `"oauth-personal"`, USE_GEMINI = `"gemini-api-key"`, USE_VERTEX_AI =
 *     `"vertex-ai"`, COMPUTE_ADC = `"compute-default-credentials"`,
 *     LEGACY_CLOUD_SHELL = `"cloud-shell"`. With no type at all the CLI
 *     refuses ("Please set an Auth method ...").
 *   - A free-tier and a paid Google login are the same file shape; the probe
 *     does not distinguish tiers.
 *
 * Only authentication metadata is ever returned, never a credential value.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

import type { EnvLookup } from "./env_lookup.ts";

/** The Gemini CLI's home override; the login lives under `<home>/.gemini`. */
export const GEMINI_CLI_HOME_ENV_VAR = "GEMINI_CLI_HOME";

/**
 * The CLI's environment selector for the Google login. Set to `"true"` in the
 * child so a home without a `settings.json` still uses the login.
 */
export const GEMINI_LOGIN_SELECTOR_ENV_VAR = "GOOGLE_GENAI_USE_GCA";

/** File name of the Google-account login inside `<home>/.gemini`. */
export const GEMINI_OAUTH_CREDS_FILE = "oauth_creds.json";

/**
 * Environment variables the Gemini CLI accepts as an API credential.
 *
 * This list is the pasteable API-key contract (like `CODEX_CREDENTIAL_ENV_VARS`),
 * so `GEMINI_CLI_HOME` — a pointer to login state, not a credential — is
 * deliberately NOT in it.
 */
export const GEMINI_CREDENTIAL_ENV_VARS: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/**
 * Authentication failure patterns, matched case-insensitively.
 *
 * Covers what the Gemini CLI emits with no usable credential (it names the
 * variables it looked for and asks the operator to choose an auth method),
 * what the Generative Language API returns for a rejected key
 * (`API_KEY_INVALID`, "API key not valid"), and the wording the credential
 * preflight uses for a missing provider credential.
 */
const AUTH_PATTERNS: readonly string[] = [
  "not logged in",
  "please log in",
  "authentication required",
  "authentication failed",
  "session expired",
  "unauthorized",
  "unauthorised",
  "unauthenticated",
  "invalid api key",
  "incorrect api key",
  "missing api key",
  "api key not valid",
  "api_key_invalid",
  "select an auth method",
  "set an auth method",
  ...GEMINI_CREDENTIAL_ENV_VARS.map((name) => name.toLowerCase()),
];

/**
 * Check whether CLI output indicates a Gemini authentication failure.
 *
 * "invalid token" and "expired token" are matched as two words that need not
 * be adjacent, matching the Claude and Codex predicates, because the CLI and
 * the API word a rejected credential differently.
 *
 * @param errorOutput - The stderr/stdout text from a failed Gemini command.
 * @returns true when the output looks like an auth failure.
 */
export function isGeminiAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();
  if (lower.includes("invalid") && lower.includes("token")) return true;
  if (lower.includes("expired") && lower.includes("token")) return true;
  return AUTH_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Return a human-readable message telling the operator how to authenticate
 * the Gemini CLI.
 *
 * Names the API-key variables and the Google-account login path rather than
 * an interactive login: the worker runs unattended, so the CLI's `/auth` flow
 * is not something it can wait for.
 *
 * @returns The actionable error message.
 */
export function geminiAuthActionableMessage(): string {
  return `Gemini CLI authentication required — set ${
    GEMINI_CREDENTIAL_ENV_VARS.join(" or ")
  } in the credential directory's gemini/provider.env, or set ` +
    `${GEMINI_CLI_HOME_ENV_VAR} there to a home holding a Google-account ` +
    `login (<${GEMINI_CLI_HOME_ENV_VAR}>/.gemini/${GEMINI_OAUTH_CREDS_FILE}, ` +
    `seeded once from gemini/${GEMINI_OAUTH_CREDS_FILE}) (the worker never ` +
    `performs an interactive login)`;
}

/** How Gemini is authenticated, as far as the billing question is concerned. */
export type GeminiAuthMode =
  /** A Google-account login with a refresh token: fixed-price subscription. */
  | "login"
  /** settings.json selects an API key: metered. */
  | "api-key"
  /** Nothing provable: absent login or a type with no subscription meaning. */
  | "unknown"
  /** A login or settings file exists but cannot be used: a fault. */
  | "read-error";

/** The resolved credential kind. */
export interface GeminiAuthModeResult {
  readonly mode: GeminiAuthMode;
  /** Operator-facing context; never a credential value. */
  readonly detail?: string;
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one `oauth_creds.json` and say whether it is a usable login.
 *
 * @param path - Path of the file.
 * @returns `login` with a non-blank `refresh_token`; `unknown` when absent;
 *   `read-error` for anything else (a login that cannot refresh unattended is
 *   a fault, not an absent login). Never throws.
 */
export function readGeminiOAuthLogin(path: string): GeminiAuthModeResult {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return { mode: "unknown", detail: `no ${GEMINI_OAUTH_CREDS_FILE}` };
    }
    return {
      mode: "read-error",
      detail: `${GEMINI_OAUTH_CREDS_FILE} unreadable: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      mode: "read-error",
      detail: `${GEMINI_OAUTH_CREDS_FILE} is not valid JSON`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      mode: "read-error",
      detail: `${GEMINI_OAUTH_CREDS_FILE} is not an object`,
    };
  }
  if (
    typeof parsed.refresh_token === "string" &&
    parsed.refresh_token.trim().length > 0
  ) {
    return { mode: "login" };
  }
  return {
    mode: "read-error",
    detail: `${GEMINI_OAUTH_CREDS_FILE} holds no refresh_token`,
  };
}

/**
 * Resolve which Gemini credential kind a home holds.
 *
 * Reads only the home (no environment): `settings.json`'s selected auth type
 * first, then the Google login. Synchronous and never throws.
 *
 * @param home - The `GEMINI_CLI_HOME` directory.
 * @returns The mode and operator-facing detail.
 */
export function resolveGeminiAuthMode(home: string): GeminiAuthModeResult {
  const root = `${home.replace(/\/+$/, "")}/.gemini`;
  let selectedType = "";
  try {
    const raw = Deno.readTextFileSync(`${root}/settings.json`);
    let parsed: unknown;
    try {
      // The CLI tolerates comments in settings.json; this strict parse does
      // not, so such a file fails closed as a read-error here.
      parsed = JSON.parse(raw);
    } catch {
      return { mode: "read-error", detail: "settings.json is not valid JSON" };
    }
    if (!isRecord(parsed)) {
      return { mode: "read-error", detail: "settings.json is not an object" };
    }
    const security = parsed.security;
    const auth = isRecord(security) ? security.auth : undefined;
    const type = isRecord(auth) ? auth.selectedType : undefined;
    if (typeof type === "string") selectedType = type.trim();
  } catch (error: unknown) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        mode: "read-error",
        detail: `settings.json unreadable: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      };
    }
  }
  if (selectedType === "gemini-api-key") {
    return { mode: "api-key", detail: "settings.json selects gemini-api-key" };
  }
  if (selectedType !== "" && selectedType !== "oauth-personal") {
    return {
      mode: "unknown",
      detail: `auth type "${selectedType}" carries no subscription meaning`,
    };
  }
  return readGeminiOAuthLogin(`${root}/${GEMINI_OAUTH_CREDS_FILE}`);
}

/** Seed a new durable Gemini home once; never overwrite the CLI's refreshed login. */
export async function initialiseGeminiHome(
  credentialDirectory: string,
  env: EnvLookup,
): Promise<void> {
  const home = env(GEMINI_CLI_HOME_ENV_VAR)?.trim();
  if (!home) return;
  const target = `${home}/.gemini/${GEMINI_OAUTH_CREDS_FILE}`;
  try {
    await Deno.stat(target);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const seed = `${credentialDirectory}/${GEMINI_OAUTH_CREDS_FILE}`;
  if (readGeminiOAuthLogin(seed).mode !== "login") {
    throw new Error(
      `Gemini Google-account login missing: initialise ${target} or provision a Google-account ${GEMINI_OAUTH_CREDS_FILE} at ${seed}`,
    );
  }
  const info = await Deno.stat(seed);
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(`Gemini login seed ${seed} must be owner-only (0600)`);
  }
  await Deno.mkdir(`${home}/.gemini`, { recursive: true, mode: 0o700 });
  const login = await Deno.readTextFile(seed);
  try {
    await Deno.writeTextFile(target, login, { createNew: true, mode: 0o600 });
  } catch (error) {
    // A concurrent initialiser won; never overwrite a login another CLI owns.
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
}
