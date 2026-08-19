/**
 * Environment allow-list for the `codex` agent subprocess (Issue #4106).
 *
 * The Codex CLI is spawned with approvals and its own sandbox bypassed — the
 * container is the sandbox — so the child can read whatever the worker
 * exports. It therefore gets exactly the same treatment as the Claude child
 * (Issue #3203, #3707): inherit the parent environment minus the worker-only
 * secrets, minus every other vendor's agent credential, and minus anything
 * whose name merely *looks* like a credential unless Codex genuinely needs it.
 *
 * The cross-vendor denial is the point of the explicit denylist: the Anthropic
 * credential must not reach the Codex child by convention or by luck of the
 * shape pattern, but because it is named here.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildAgentChildEnv,
  isDeniedAgentEnvVar,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "./agent_env.ts";

/**
 * Environment variables the `codex` child must never inherit.
 *
 * The worker-only secrets (see {@link WORKER_ONLY_SECRET_ENV_VARS}) plus every
 * other vendor's credential — Anthropic's, and Google's since Issue #4107:
 * Codex authenticates with its own key, so another vendor's credential in its
 * environment is only ever an exfiltration target.
 */
export const CODEX_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/**
 * Secret-shaped names the Codex child genuinely needs.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` authenticate the agent's `gh` calls;
 * `OPENAI_API_KEY` / `CODEX_API_KEY` are the two variables the Codex CLI
 * itself reads (`codex-rs/login`). Everything else secret-shaped is dropped.
 */
export const CODEX_ENV_SECRET_ALLOWLIST: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

/**
 * Report whether a variable must be withheld from the `codex` child.
 *
 * @param name - Environment variable name.
 * @param denylist - Explicitly denied names (defaults to
 *   {@link CODEX_ENV_DENYLIST}).
 * @returns true when the variable is denied by name or by secret-ish shape.
 */
export function isDeniedCodexEnvVar(
  name: string,
  denylist: readonly string[] = CODEX_ENV_DENYLIST,
): boolean {
  return isDeniedAgentEnvVar(name, {
    denylist,
    secretAllowlist: CODEX_ENV_SECRET_ALLOWLIST,
  });
}

/**
 * Build the environment for the `codex` child subprocess.
 *
 * @param parentEnv - The environment to inherit from (defaults to the current
 *   process environment).
 * @param denylist - Variable names to strip (defaults to
 *   {@link CODEX_ENV_DENYLIST}).
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildCodexChildEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
  denylist: readonly string[] = CODEX_ENV_DENYLIST,
): Record<string, string> {
  return buildAgentChildEnv(parentEnv, {
    denylist,
    secretAllowlist: CODEX_ENV_SECRET_ALLOWLIST,
  });
}
