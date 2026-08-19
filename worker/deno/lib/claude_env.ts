/**
 * Environment allow-list for the `claude` agent subprocess (Issue #3203).
 *
 * `runClaude` spawns the `claude` CLI with `--dangerously-skip-permissions`
 * (unrestricted bash), so the child can read any environment variable the
 * worker exports. Inheriting the worker's entire environment needlessly hands
 * the model the highest-value secret it owns: `GITHUB_APP_PRIVATE_KEY_PATH`,
 * which points at the GitHub App PEM that mints installation tokens. A prompt
 * injection could steer the model to `cat` that file and leak it.
 *
 * The model never needs the raw PEM — `gh` authenticates with the already-minted
 * installation token in `GH_TOKEN`. This module names Claude's three lists and
 * hands the filtering itself to `agent_env.ts`, which every provider shares: the
 * child inherits the parent's environment minus the named denylist and minus
 * anything whose name looks like a credential (Issue #3707), so a worker-side
 * secret added later is withheld by default rather than inherited until
 * somebody notices. Root-cause fix: the secret is not exposed to the agent at
 * all, so it cannot be exfiltrated regardless of any downstream redaction.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  AGENT_ENV_SECRET_NAME_PATTERN,
  buildAgentChildEnv,
  isDeniedAgentEnvVar,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "./agent_env.ts";

/**
 * Environment variables the `claude` child must never inherit.
 *
 * The worker-only secrets (the GitHub App private-key material, the Jenkins
 * API credentials and the ImgBB key — see
 * {@link WORKER_ONLY_SECRET_ENV_VARS}), plus every *other* vendor's agent
 * credential — OpenAI's (Issue #4106) and Google's (Issue #4107). The
 * cross-vendor names are denied explicitly rather than left to the
 * secret-shape pattern, so no future allowlist edit can hand the Anthropic
 * child another vendor's key.
 *
 * `GH_TOKEN` is deliberately NOT denied — it is the short-lived installation
 * token the model legitimately uses via `gh`. What that token may *do* is
 * constrained by the `gh` PATH shim (`gh_guard_shim.ts`, Issue #3643), not by
 * this denylist.
 */
export const CLAUDE_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/**
 * Names that look like a credential (Issue #3707).
 *
 * The provider-independent shape rule, re-exported under Claude's name for the
 * callers that already import it from here.
 */
export const CLAUDE_ENV_SECRET_NAME_PATTERN = AGENT_ENV_SECRET_NAME_PATTERN;

/**
 * Secret-shaped names the child genuinely needs (Issue #3707).
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` authenticate the agent's `gh` calls; the
 * Anthropic credentials authenticate the `claude` CLI itself. Without these
 * the child cannot do its job at all, so they are exempt from the
 * shape-based denial above.
 */
export const CLAUDE_ENV_SECRET_ALLOWLIST: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * Report whether a variable must be withheld from the `claude` child.
 *
 * @param name - Environment variable name.
 * @param denylist - Explicitly denied names (defaults to
 *   {@link CLAUDE_ENV_DENYLIST}).
 * @returns true when the variable is denied by name or by secret-ish shape.
 */
export function isDeniedClaudeEnvVar(
  name: string,
  denylist: readonly string[] = CLAUDE_ENV_DENYLIST,
): boolean {
  return isDeniedAgentEnvVar(name, {
    denylist,
    secretAllowlist: CLAUDE_ENV_SECRET_ALLOWLIST,
  });
}

/**
 * Build the environment for the `claude` child subprocess.
 *
 * Returns a copy of `parentEnv` with every denied variable removed — the
 * explicit `denylist` plus anything whose name looks like a credential and is
 * not on {@link CLAUDE_ENV_SECRET_ALLOWLIST}. Intended for use with
 * `Deno.Command`'s `clearEnv: true` so the child receives exactly this map.
 *
 * @param parentEnv - The environment to inherit from (defaults to the current
 *   process environment).
 * @param denylist - Variable names to strip (defaults to
 *   {@link CLAUDE_ENV_DENYLIST}).
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildClaudeChildEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
  denylist: readonly string[] = CLAUDE_ENV_DENYLIST,
): Record<string, string> {
  const env = buildAgentChildEnv(parentEnv, {
    denylist,
    secretAllowlist: CLAUDE_ENV_SECRET_ALLOWLIST,
  });

  // Durable transcripts inside the container (Issue #4170): claude stores
  // the session transcripts `--resume` replays under CLAUDE_CONFIG_DIR.
  // Left at the default ~/.claude they die with the ephemeral VM — observed
  // live as 70 minutes of execute-phase work unrecoverable after a kill.
  // The work dir is the host-mounted durable surface, so the child's
  // transcripts land there. Container only: on the host ~/.claude is
  // already durable and carries the operator's own login state. An explicit
  // CLAUDE_CONFIG_DIR always wins.
  if (
    env["CLAUDE_CONFIG_DIR"] === undefined &&
    env["VIBE_IMAGE_AGENT_PROVIDERS"] !== undefined
  ) {
    const workDir = env["WORK_DIR"] ??
      (env["HOME"] ? `${env["HOME"]}/auto-issue-work` : undefined);
    if (workDir) {
      env["CLAUDE_CONFIG_DIR"] = `${workDir}/.claude-config`;
    }
  }
  return env;
}
