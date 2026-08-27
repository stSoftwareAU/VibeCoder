/**
 * DeepSeek authentication classification (Issue #414, parent #396).
 *
 * The DeepSeek counterpart of `codex_auth.ts` / `gemini_auth.ts`: decide
 * whether CLI output is an authentication failure rather than ordinary work
 * failing, and give the operator a message that names the credential to set.
 * Both the credential preflight (`credential_preflight.ts`) and the mid-run
 * failure path (`issue_worker_wiring.ts`) classify through the provider
 * descriptor, so this module is the single definition of "DeepSeek could not
 * authenticate".
 *
 * `isClaudeAuthError` is deliberately **not** re-exported even though DeepSeek
 * rides the Anthropic CLI. The binary is Anthropic's but the 401 body is
 * DeepSeek's, and `claude_auth.ts` narrowed its patterns to phrases the
 * Anthropic CLI itself prints (Issue #45). Sharing that array would tie
 * DeepSeek's classification to a list curated for a different vendor's
 * wording; the overlap between the two lists is fine, the coupling is not.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

/**
 * Environment variables that carry a usable DeepSeek credential.
 *
 * One name only: `DEEPSEEK_API_KEY` is what the provisioned
 * `deepseek/provider.env` holds and what `deepseek_env.ts` maps onto the
 * `ANTHROPIC_AUTH_TOKEN` the Claude CLI reads. Anthropic's own variables are
 * not listed — a first-party Anthropic credential is denied to this child, not
 * accepted as a stand-in for DeepSeek's.
 */
export const DEEPSEEK_CREDENTIAL_ENV_VARS: readonly string[] = [
  "DEEPSEEK_API_KEY",
];

/**
 * Authentication failure patterns, matched case-insensitively.
 *
 * Covers what DeepSeek's Anthropic-compatible endpoint returns for a rejected
 * or absent key ("Authentication Fails, Your api key: **** is invalid", type
 * `authentication_error`), what the Anthropic CLI prints when the endpoint
 * refuses it, and the wording the credential preflight uses for a missing
 * provider credential.
 *
 * Every entry is an adjacent phrase one of those surfaces actually emits, so a
 * transcript merely *discussing* API keys is not read as an auth failure
 * (Issue #45).
 */
const AUTH_PATTERNS: readonly string[] = [
  "authentication fails",
  "authentication error",
  "authentication_error",
  "authentication required",
  "authentication failed",
  "invalid api key",
  "incorrect api key",
  "missing api key",
  "no api key",
  "api key is invalid",
  "api key not found",
  "please run /login",
  "session expired",
  "unauthorized",
  "unauthorised",
  ...DEEPSEEK_CREDENTIAL_ENV_VARS.map((name) => name.toLowerCase()),
];

/**
 * Check whether CLI output indicates a DeepSeek authentication failure.
 *
 * @param errorOutput - The stderr/stdout text from a failed DeepSeek command.
 * @returns true when the output looks like an auth failure.
 */
export function isDeepSeekAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();
  return AUTH_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Return a human-readable message telling the operator how to authenticate
 * DeepSeek.
 *
 * Names the credential variable and the file that carries it — never
 * `claude login`, which authenticates Anthropic's endpoint and cannot fix a
 * DeepSeek credential no matter how often it is run.
 *
 * @returns The actionable error message.
 */
export function deepSeekAuthActionableMessage(): string {
  return `DeepSeek authentication required — set ${
    DEEPSEEK_CREDENTIAL_ENV_VARS.join(" or ")
  } in the credential directory's deepseek/provider.env (the worker never ` +
    `performs an interactive login, and \`claude login\` authenticates ` +
    `Anthropic's endpoint rather than DeepSeek's)`;
}
