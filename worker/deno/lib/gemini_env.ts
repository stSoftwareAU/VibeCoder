/**
 * Environment allow-list for the `gemini` agent subprocess (Issue #4107).
 *
 * The Gemini CLI is spawned with its approval prompts bypassed — the container
 * is the sandbox — so the child can read whatever the worker exports. It
 * therefore gets exactly the same treatment as the Claude and Codex children
 * (Issues #3203, #3707, #4106): inherit the parent environment minus the
 * worker-only secrets, minus every other vendor's agent credential, and minus
 * anything whose name merely *looks* like a credential unless Gemini genuinely
 * needs it.
 *
 * The cross-vendor denial is the point of the explicit denylist: the Anthropic
 * and OpenAI credentials must not reach the Gemini child by convention or by
 * luck of the shape pattern, but because they are named here.
 *
 * A Google-account login (Issue #5339) is selected through `GEMINI_CLI_HOME`,
 * which is deliberately not denied: {@link buildIsolatedGeminiChildEnv} owns
 * it and withholds every API key when it is set.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildAgentChildEnv,
  isDeniedAgentEnvVar,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "./agent_env.ts";
import { CLAUDE_CREDENTIAL_ENV_VARS } from "./claude_env.ts";
import {
  GEMINI_CLI_HOME_ENV_VAR,
  GEMINI_LOGIN_SELECTOR_ENV_VAR,
} from "./gemini_auth.ts";

/**
 * Environment variables the `gemini` child must never inherit.
 *
 * The worker-only secrets (see {@link WORKER_ONLY_SECRET_ENV_VARS}) plus every
 * Anthropic, OpenAI and DeepSeek credential (the last since Issue #412):
 * Gemini authenticates with its own key, so another vendor's credential in its
 * environment is only ever an exfiltration target.
 *
 * The Anthropic names come from {@link CLAUDE_CREDENTIAL_ENV_VARS} rather than
 * a second copy of them, so a name Anthropic adds later is denied here the day
 * it is accepted there. A pooled host holds several Anthropic tokens
 * (Issue #920, parent #902); this child sees none of them, selected or not,
 * and `agent_env.ts` denies the suffixed and indexed variants too, so the
 * denial does not rest on the shape pattern happening to match.
 */
export const GEMINI_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  ...CLAUDE_CREDENTIAL_ENV_VARS,
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "DEEPSEEK_API_KEY",
];

/**
 * Secret-shaped names the Gemini child genuinely needs.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` authenticate the agent's `gh` calls;
 * `GEMINI_API_KEY` / `GOOGLE_API_KEY` are the two variables the Gemini CLI
 * itself reads for an API credential. Everything else secret-shaped is
 * dropped.
 */
export const GEMINI_ENV_SECRET_ALLOWLIST: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/**
 * Report whether a variable must be withheld from the `gemini` child.
 *
 * @param name - Environment variable name.
 * @param denylist - Explicitly denied names (defaults to
 *   {@link GEMINI_ENV_DENYLIST}).
 * @returns true when the variable is denied by name or by secret-ish shape.
 */
export function isDeniedGeminiEnvVar(
  name: string,
  denylist: readonly string[] = GEMINI_ENV_DENYLIST,
): boolean {
  return isDeniedAgentEnvVar(name, {
    denylist,
    secretAllowlist: GEMINI_ENV_SECRET_ALLOWLIST,
  });
}

/**
 * Build the environment for the `gemini` child subprocess.
 *
 * @param parentEnv - The environment to inherit from (defaults to the current
 *   process environment).
 * @param denylist - Variable names to strip (defaults to
 *   {@link GEMINI_ENV_DENYLIST}).
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildGeminiChildEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
  denylist: readonly string[] = GEMINI_ENV_DENYLIST,
): Record<string, string> {
  return buildAgentChildEnv(parentEnv, {
    denylist,
    secretAllowlist: GEMINI_ENV_SECRET_ALLOWLIST,
  });
}

/**
 * Build the `gemini` child environment with the billing guard applied
 * (Issue #5339).
 *
 * When a `GEMINI_CLI_HOME` is selected, the Google-account login under it owns
 * authentication: the home and `GOOGLE_GENAI_USE_GCA=true` are set and no API
 * key reaches the child as a backup. A stale or revoked login must fail
 * authentication rather than silently turn an unattended run into metered API
 * spend. With no non-blank home the API keys and the parent's own
 * `GOOGLE_GENAI_USE_GCA` pass through as {@link buildGeminiChildEnv} passes
 * them; a blank `GEMINI_CLI_HOME` is dropped rather than handed to the CLI.
 *
 * Does not mutate the parent object.
 *
 * @param parentEnv - The environment to inherit from.
 * @param selected - The credential values selected for this child.
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildIsolatedGeminiChildEnv(
  parentEnv: Record<string, string>,
  selected: {
    readonly geminiApiKey?: string;
    readonly googleApiKey?: string;
    readonly geminiCliHome?: string;
  },
): Record<string, string> {
  const stripped = { ...parentEnv };
  delete stripped.GEMINI_API_KEY;
  delete stripped.GOOGLE_API_KEY;
  delete stripped[GEMINI_CLI_HOME_ENV_VAR];
  delete stripped[GEMINI_LOGIN_SELECTOR_ENV_VAR];
  const child = buildGeminiChildEnv(stripped);

  const home = selected.geminiCliHome?.trim();
  if (home) {
    // Fail closed: the login owns authentication, no key as a backup.
    child[GEMINI_CLI_HOME_ENV_VAR] = home;
    child[GEMINI_LOGIN_SELECTOR_ENV_VAR] = "true";
    return child;
  }

  if (selected.geminiApiKey !== undefined) {
    child.GEMINI_API_KEY = selected.geminiApiKey;
  }
  if (selected.googleApiKey !== undefined) {
    child.GOOGLE_API_KEY = selected.googleApiKey;
  }
  const parentSelector = parentEnv[GEMINI_LOGIN_SELECTOR_ENV_VAR];
  if (parentSelector !== undefined) {
    child[GEMINI_LOGIN_SELECTOR_ENV_VAR] = parentSelector;
  }
  return child;
}
