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
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildAgentChildEnv,
  isDeniedAgentEnvVar,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "./agent_env.ts";

/**
 * Environment variables the `gemini` child must never inherit.
 *
 * The worker-only secrets (see {@link WORKER_ONLY_SECRET_ENV_VARS}) plus every
 * Anthropic, OpenAI and DeepSeek credential (the last since Issue #412):
 * Gemini authenticates with its own key, so another vendor's credential in its
 * environment is only ever an exfiltration target.
 */
export const GEMINI_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
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
