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
 * it comes from, has any use for the GitHub App PEM or the ImgBB key, both of
 * which the worker uses in-process.
 *
 * A host may hold a POOL of credentials for one vendor, of which a run selects
 * exactly one (Issue #920). The unselected ones must not reach the child by
 * any route, so the allowlist exemption is exact-match and a suffixed or
 * indexed variant of any listed name is denied outright — see
 * {@link isDeniedAgentEnvVar}.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Secrets the worker owns and no coding agent ever needs.
 *
 * The GitHub App private-key material (the PEM path and the raw PEM, should a
 * deployment pass it inline) plus the ImgBB key (screenshots are uploaded
 * worker-side by `pr_evidence.ts`). Neither is reachable from anything an
 * agent does.
 *
 * This list names only secrets **core itself** holds. A private extension
 * brings its own credentials, and they are covered by the credential-shaped
 * name rule below rather than by an entry here (Issue #3707) — core cannot
 * enumerate what it does not know about, and must not try.
 *
 * `GH_TOKEN` is deliberately absent — it is the short-lived installation token
 * the model legitimately uses via `gh`. What that token may *do* is
 * constrained by the `gh` PATH shim (`gh_guard_shim.ts`, Issue #3643).
 */
export const WORKER_ONLY_SECRET_ENV_VARS: readonly string[] = [
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_PRIVATE_KEY",
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

/**
 * The first character of a suffixed or indexed variant of a credential name
 * (Issue #920).
 *
 * A host that holds a pool of credentials for one vendor grows names by
 * appending to the base one: `_2`, `2`, `_SECONDARY`, `-BACKUP`. Anything the
 * lists below have an opinion about is decided for the *base* name, so a
 * variant is a DIFFERENT credential wearing a familiar prefix — never the one
 * the allowlist exempted.
 */
const ENV_VARIANT_SUFFIX_START = /^[_\-0-9]/;

/**
 * Report whether `name` is a suffixed or indexed variant of `base`.
 *
 * @param name - Environment variable name under test.
 * @param base - A name one of the policy lists states an opinion about.
 * @returns true when `name` is `base` plus a variant suffix.
 */
function isEnvVariantOf(name: string, base: string): boolean {
  if (name.length <= base.length || !name.startsWith(base)) return false;
  return ENV_VARIANT_SUFFIX_START.test(name.slice(base.length));
}

/** The per-provider lists that decide what its child inherits. */
export interface AgentEnvPolicy {
  /** Names the child must never inherit, whatever they look like. */
  denylist: readonly string[];
  /** Secret-shaped names this provider's child genuinely needs. */
  secretAllowlist: readonly string[];
  /**
   * The credential-shape rule (defaults to
   * {@link AGENT_ENV_SECRET_NAME_PATTERN}).
   *
   * Injectable so a test can prove a denial holds on its own rather than by
   * accident of this pattern's current wording (Issue #920): narrow the
   * pattern and the explicit rules above it must still deny.
   */
  secretNamePattern?: RegExp;
}

/**
 * Report whether a variable must be withheld from an agent child.
 *
 * The denylist is checked first, so a cross-vendor credential stays denied
 * even when the other vendor's descriptor allowlists it.
 *
 * A *variant* of any listed name — the name plus `_2`, `2`, `_SECONDARY`,
 * `-BACKUP` — is denied outright, whichever list it extends (Issue #920).
 * That closes the pooled-credential case in both directions: a host may hold
 * several credentials for one vendor, and only the one the run selected is
 * exported under the base name. A variant extending the denylist is another
 * copy of something already refused; a variant extending the *allowlist* is
 * the sharper case, because the allowlist is the only way out of this
 * function — exempting it by prefix would hand the child a second, unselected
 * credential. The exemption is therefore exact-match, and stated here rather
 * than left to {@link AGENT_ENV_SECRET_NAME_PATTERN} to catch: a variant must
 * stay denied even if that pattern is narrowed later.
 *
 * @param name - Environment variable name.
 * @param policy - The provider's denylist and secret allowlist.
 * @returns true when the variable is denied by name, as a variant of a named
 *   one, or by secret-ish shape.
 */
export function isDeniedAgentEnvVar(
  name: string,
  policy: AgentEnvPolicy,
): boolean {
  if (policy.denylist.includes(name)) return true;
  for (const base of policy.denylist) {
    if (isEnvVariantOf(name, base)) return true;
  }
  for (const base of policy.secretAllowlist) {
    if (isEnvVariantOf(name, base)) return true;
  }
  if (policy.secretAllowlist.includes(name)) return false;
  return (policy.secretNamePattern ?? AGENT_ENV_SECRET_NAME_PATTERN).test(name);
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
