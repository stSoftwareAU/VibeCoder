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
import { CLAUDE_CREDENTIAL_ENV_VARS } from "./claude_env.ts";

/**
 * Environment variables the `codex` child must never inherit.
 *
 * The worker-only secrets (see {@link WORKER_ONLY_SECRET_ENV_VARS}) plus every
 * other vendor's credential — Anthropic's, Google's since Issue #4107 and
 * DeepSeek's since Issue #412: Codex authenticates with its own key, so
 * another vendor's credential in its environment is only ever an exfiltration
 * target.
 *
 * The Anthropic names come from {@link CLAUDE_CREDENTIAL_ENV_VARS} rather than
 * a second copy of them, so a name Anthropic adds later is denied here the day
 * it is accepted there. A pooled host holds several Anthropic tokens
 * (Issue #920, parent #902); this child sees none of them, selected or not,
 * and `agent_env.ts` denies the suffixed and indexed variants too, so the
 * denial does not rest on the shape pattern happening to match.
 */
export const CODEX_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  ...CLAUDE_CREDENTIAL_ENV_VARS,
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
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

/**
 * Per-invocation Codex environment (Issue #1698): only the selected
 * account's secrets and `CODEX_HOME` reach the child. Other Codex
 * accounts, Claude credentials and worker-only secrets stay out.
 *
 * A selected `CODEX_HOME` means this invocation is deliberately using the
 * CLI's persisted ChatGPT login. In that mode API-key variables are withheld
 * even when they are present in the worker environment or the selected
 * credential context (Issue #1924). This is the billing guard: a stale or
 * revoked subscription must fail authentication rather than silently turn an
 * unattended run into metered API spend. The legacy API-key path remains
 * available only when no `CODEX_HOME` was selected, preserving existing
 * explicit API-key deployments while subscription-only routing is introduced.
 *
 * Does not mutate the parent object or process-global HOME / CODEX_HOME.
 */
export function buildIsolatedCodexChildEnv(
  parentEnv: Record<string, string>,
  selected: {
    readonly openaiApiKey?: string;
    readonly codexApiKey?: string;
    readonly codexHome?: string;
  },
): Record<string, string> {
  const stripped = { ...parentEnv };
  delete stripped.OPENAI_API_KEY;
  delete stripped.CODEX_API_KEY;
  delete stripped.CODEX_HOME;
  const child = buildCodexChildEnv(stripped);

  const codexHome = selected.codexHome?.trim();
  if (codexHome) {
    // Subscription mode is intentionally fail-closed: CODEX_HOME owns
    // authentication and no metered credential reaches the child as a backup.
    child.CODEX_HOME = codexHome;
    return child;
  }

  if (selected.openaiApiKey !== undefined) {
    child.OPENAI_API_KEY = selected.openaiApiKey;
  }
  if (selected.codexApiKey !== undefined) {
    child.CODEX_API_KEY = selected.codexApiKey;
  }
  return child;
}
