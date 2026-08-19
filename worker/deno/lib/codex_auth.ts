/**
 * Codex CLI authentication classification (Issue #4106).
 *
 * The Codex counterpart of `claude_auth.ts`: decide whether CLI output is an
 * authentication failure rather than ordinary work failing, and give the
 * operator a message that names the credential to set. Both the credential
 * preflight (`credential_preflight.ts`) and the mid-run failure path
 * (`issue_worker_wiring.ts`) classify through the provider descriptor, so this
 * module is the single definition of "Codex could not authenticate".
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

/** Environment variables the Codex CLI accepts as an API credential. */
export const CODEX_CREDENTIAL_ENV_VARS: readonly string[] = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

/**
 * Authentication failure patterns, matched case-insensitively.
 *
 * Covers what the Codex CLI emits when it has no usable credential (it names
 * the variables it looked for, and tells the operator to run `codex login`),
 * what the Responses API returns for a rejected key, and the wording the
 * credential preflight uses for a missing provider credential.
 */
const AUTH_PATTERNS: readonly string[] = [
  "codex login",
  "not logged in",
  "please log in",
  "authentication required",
  "authentication failed",
  "session expired",
  "unauthorized",
  "unauthorised",
  "invalid api key",
  "incorrect api key",
  "missing api key",
  ...CODEX_CREDENTIAL_ENV_VARS.map((name) => name.toLowerCase()),
];

/**
 * Check whether CLI output indicates a Codex authentication failure.
 *
 * "invalid token" is matched as two words that need not be adjacent, matching
 * the Claude predicate's behaviour, because the CLI and the API word an
 * expired credential differently.
 *
 * @param errorOutput - The stderr/stdout text from a failed Codex command.
 * @returns true when the output looks like an auth failure.
 */
export function isCodexAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();
  if (lower.includes("invalid") && lower.includes("token")) return true;
  if (lower.includes("expired") && lower.includes("token")) return true;
  return AUTH_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Return a human-readable message telling the operator how to authenticate
 * the Codex CLI.
 *
 * Names the credential variables rather than an interactive login: the worker
 * runs unattended, so `codex login` is not something it can wait for.
 *
 * @returns The actionable error message.
 */
export function codexAuthActionableMessage(): string {
  return `Codex CLI authentication required — set ${
    CODEX_CREDENTIAL_ENV_VARS.join(" or ")
  } in the credential directory's codex/provider.env (the worker never ` +
    `performs an interactive login)`;
}
