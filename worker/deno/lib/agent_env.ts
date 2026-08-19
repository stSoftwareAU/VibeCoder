/**
 * Shared child-environment filtering for coding-agent providers (Issue #4106).
 *
 * Every provider spawns a CLI that can read whatever the worker exports, so
 * every provider needs the same defence: inherit the parent environment minus
 * an explicit denylist and minus anything whose *name* looks like a credential
 * (Issue #3707), with a short allowlist for the secrets that provider genuinely
 * needs. Only the three lists differ per provider — the filtering itself is one
 * implementation here rather than one copy per vendor.
 *
 * The worker-only secrets are provider-independent: no agent, whichever vendor
 * it comes from, has any use for the GitHub App PEM, the Jenkins API token or
 * the ImgBB key, all of which the worker uses in-process.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Secrets the worker owns and no coding agent ever needs.
 *
 * The GitHub App private-key material (the PEM path and the raw PEM, should a
 * deployment pass it inline) plus the worker-only service credentials: the
 * Jenkins API user and token (CI logs are fetched in-process by
 * `jenkins_log_fetcher.ts`) and the ImgBB key (screenshots are uploaded
 * worker-side by `pr_evidence.ts`). None of them are reachable from anything
 * an agent does, and a bare Jenkins token has no prefix for `redactSecrets`
 * to catch on the way out (Issue #3707).
 *
 * `GH_TOKEN` is deliberately absent — it is the short-lived installation token
 * the model legitimately uses via `gh`. What that token may *do* is
 * constrained by the `gh` PATH shim (`gh_guard_shim.ts`, Issue #3643).
 */
export const WORKER_ONLY_SECRET_ENV_VARS: readonly string[] = [
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_PRIVATE_KEY",
  "JENKINS_USER",
  "JENKINS_TOKEN",
  "VIBE_IMGBB_API_KEY",
];

/**
 * Names that look like a credential (Issue #3707).
 *
 * Enumerating secrets one at a time fails open: every new worker-side
 * credential is inherited by the agent until somebody remembers to extend the
 * list. Denying by *shape* inverts that default — an unknown secret-shaped
 * variable is dropped unless the provider allowlists it.
 */
export const AGENT_ENV_SECRET_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;

/** The per-provider lists that decide what its child inherits. */
export interface AgentEnvPolicy {
  /** Names the child must never inherit, whatever they look like. */
  denylist: readonly string[];
  /** Secret-shaped names this provider's child genuinely needs. */
  secretAllowlist: readonly string[];
}

/**
 * Report whether a variable must be withheld from an agent child.
 *
 * The denylist is checked first, so a cross-vendor credential stays denied
 * even when the other vendor's descriptor allowlists it.
 *
 * @param name - Environment variable name.
 * @param policy - The provider's denylist and secret allowlist.
 * @returns true when the variable is denied by name or by secret-ish shape.
 */
export function isDeniedAgentEnvVar(
  name: string,
  policy: AgentEnvPolicy,
): boolean {
  if (policy.denylist.includes(name)) return true;
  if (policy.secretAllowlist.includes(name)) return false;
  return AGENT_ENV_SECRET_NAME_PATTERN.test(name);
}

/**
 * Build the environment for an agent child subprocess.
 *
 * Returns a copy of `parentEnv` with every denied variable removed. Intended
 * for use with `Deno.Command`'s `clearEnv: true` so the child receives exactly
 * this map.
 *
 * @param parentEnv - The environment to inherit from.
 * @param policy - The provider's denylist and secret allowlist.
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildAgentChildEnv(
  parentEnv: Record<string, string>,
  policy: AgentEnvPolicy,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (isDeniedAgentEnvVar(key, policy)) continue;
    out[key] = value;
  }
  return out;
}
