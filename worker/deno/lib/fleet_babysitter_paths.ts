import { resolveCredentialDir } from "./credential_preflight.ts";
import { expandHome } from "./service_account_env.ts";

/**
 * Credential paths for the fleet PR babysitter (Issue #4770).
 *
 * These name the paths the babysitter's Claude review verifier must not read:
 * the GitHub App private key, the babysitter's own entries under
 * `~/.vibe-coder`, and the host's credential locations. The container
 * launcher's key guard (`fleet_babysitter_container.ts`) resolves the same
 * paths. Each path is normalised, and symlink targets and missing tails are
 * resolved, so a spelling cannot reach a protected file under another name.
 */

/** Entries under `~/.vibe-coder` that belong to the babysitter, by name prefix. */
const BABYSITTER_ENTRY_PREFIX = "fleet-pr-babysitter";

function assertAbsolute(path: string, what: string): void {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error(`${what} must be an absolute path`);
  }
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export function normaliseAbsolutePath(path: string): string {
  assertAbsolute(path, "A protected path");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export async function canonicalPathIncludingMissingTail(
  path: string,
): Promise<string> {
  let prefix = path;
  const missing: string[] = [];
  while (true) {
    const real = await realPathOrUndefined(prefix);
    if (real !== undefined) {
      return normaliseAbsolutePath(`${real}/${missing.reverse().join("/")}`);
    }
    const slash = prefix.lastIndexOf("/");
    if (prefix === "/") {
      throw new Error(`Could not resolve protected path prefix for ${path}`);
    }
    missing.push(prefix.slice(slash + 1));
    prefix = prefix.slice(0, slash) || "/";
  }
}

/** Read credential-bearing locations from the same config file used by the worker. */
export async function babysitterHostCredentialPaths(
  configPath: string,
  home: string,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<string[]> {
  assertAbsolute(home, "HOME");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(configPath));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Worker configuration must be an object");
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // JSON primitives and arrays have no private_key_path property.
  const reviewerKey = (config.pr_reviewer_app as
    | Record<string, unknown>
    | null
    | undefined)?.private_key_path;
  const pathValues = [
    resolveCredentialDir((name) => name === "HOME" ? home : env(name)),
    `${home}/.vibe-coder/credentials`,
    config.gh_config_dir,
    env("GH_CONFIG_DIR"),
    `${home}/.config/gh`,
    config.github_app_private_key_path,
    reviewerKey,
    config.ssh_key_path,
  ];
  const paths: string[] = [];
  for (const value of pathValues) {
    if (typeof value !== "string" || value.trim() === "") continue;
    paths.push(expandHome(value.trim(), home));
  }
  return paths;
}

/**
 * Every path the agent must not read: babysitter entries, its private key,
 * host credential locations supplied by the caller, and the resolved paths
 * behind symlinks and missing tails below existing symlinked parents.
 */
export async function babysitterProtectedPaths(
  home: string,
  privateKeyPath: string,
  additionalPaths: readonly string[],
): Promise<string[]> {
  assertAbsolute(home, "HOME");
  assertAbsolute(privateKeyPath, "The private-key path");
  const root = `${home}/.vibe-coder`;
  const candidates = [privateKeyPath, ...additionalPaths];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith(BABYSITTER_ENTRY_PREFIX)) {
        candidates.push(`${root}/${entry.name}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const normalised = normaliseAbsolutePath(candidate);
    paths.add(normalised);
    // Resolve the configured spelling too: '..' after a directory symlink
    // refers to the target's parent, which lexical normalisation would lose.
    paths.add(await canonicalPathIncludingMissingTail(candidate));
    paths.add(await canonicalPathIncludingMissingTail(normalised));
  }
  return [...paths].sort();
}
