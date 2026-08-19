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
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

/** Environment variables the Gemini CLI accepts as an API credential. */
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
 * Names the credential variables rather than an interactive login: the worker
 * runs unattended, so the CLI's `/auth` flow is not something it can wait for.
 *
 * @returns The actionable error message.
 */
export function geminiAuthActionableMessage(): string {
  return `Gemini CLI authentication required — set ${
    GEMINI_CREDENTIAL_ENV_VARS.join(" or ")
  } in the credential directory's gemini/provider.env (the worker never ` +
    `performs an interactive login)`;
}
