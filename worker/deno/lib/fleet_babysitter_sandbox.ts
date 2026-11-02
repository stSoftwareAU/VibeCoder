import { runWithTimeout } from "./subprocess_timeout.ts";
import { resolveCredentialDir } from "./credential_preflight.ts";
import { expandHome } from "./service_account_env.ts";

/**
 * Filesystem boundary for the fleet babysitter's Codex agent (Issue #4593).
 *
 * The runner and the agent share an OS user, so file modes cannot keep the
 * GitHub App private key and App settings from the agent, and `--sandbox
 * workspace-write` lets it read the whole disk. The agent therefore runs under
 * a Codex permissions profile that grants read access broadly but marks the
 * host's configured write-capable credential paths `none`.
 */

/** Name of the Codex permissions profile the babysitter defines per spawn. */
export const BABYSITTER_PERMISSIONS_PROFILE = "babysitter-agent";

/** Dot-free `-c` key of the profile's filesystem table. */
export const BABYSITTER_FILESYSTEM_KEY =
  `permissions.${BABYSITTER_PERMISSIONS_PROFILE}.filesystem`;

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

function normaliseAbsolutePath(path: string): string {
  assertAbsolute(path, "A protected path");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

async function canonicalPathIncludingMissingTail(
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

function tomlString(value: string): string {
  // JSON string escapes are valid TOML basic-string escapes.
  return JSON.stringify(value);
}

/**
 * Codex `-c` overrides that select the babysitter permissions profile: read
 * everywhere, write only the clone and scratch directory, no write to the
 * clone's `.git`, no access at all to `protectedPaths`, and network access for
 * the agent's read-only GitHub requests.
 */
export function buildBabysitterSandboxArgs(options: {
  dir: string;
  scratch: string;
  protectedPaths: string[];
}): string[] {
  assertAbsolute(options.dir, "The clone directory");
  assertAbsolute(options.scratch, "The scratch directory");
  if (options.protectedPaths.length === 0) {
    throw new Error(
      "Refusing to start the babysitter agent with no protected paths",
    );
  }
  for (const path of options.protectedPaths) {
    assertAbsolute(path, "A protected path");
    for (const writable of [options.dir, options.scratch]) {
      if (writable === path || writable.startsWith(`${path}/`)) {
        throw new Error(
          `Refusing to start the babysitter agent: ${writable} is inside protected path ${path}`,
        );
      }
      if (path.startsWith(`${writable}/`)) {
        throw new Error(
          `Refusing to start the babysitter agent: protected path ${path} overlaps writable path ${writable}`,
        );
      }
    }
  }
  // One inline-table value rather than one `-c` per path: Codex splits a `-c`
  // key on every `.`, even inside quotes, and every protected path has dots
  // (`.vibe-coder`, `.git`, `.pem`). The value is parsed as TOML, so quoted
  // keys survive intact and the key path stays dot-free.
  const grants: [string, "read" | "write" | "none"][] = [
    ["/", "read"],
    [options.dir, "write"],
    [`${options.dir}/.git`, "read"],
    [options.scratch, "write"],
    ...options.protectedPaths.map((path): [string, "none"] => [path, "none"]),
  ];
  const table = grants
    .map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`)
    .join(", ");
  return [
    "-c",
    `default_permissions=${tomlString(BABYSITTER_PERMISSIONS_PROFILE)}`,
    "-c",
    `${BABYSITTER_FILESYSTEM_KEY}={ ${table} }`,
    "-c",
    `permissions.${BABYSITTER_PERMISSIONS_PROFILE}.network={ enabled = true }`,
  ];
}

/** Oldest Codex CLI that enforces the agent permissions profile. */
export const BABYSITTER_CODEX_FLOOR = "0.164.0";

/**
 * Whether `codex --version` output is at or above the floor. A pre-release
 * counts only when its base version is above the floor, since under semver
 * `0.164.0-beta.1` precedes `0.164.0` but `0.166.0-alpha.5.1` follows it.
 */
export function codexVersionMeetsFloor(version: string): boolean {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(
    version,
  );
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return false;
  const floor = BABYSITTER_CODEX_FLOOR.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== floor[i]!) return parts[i]! > floor[i]!;
  }
  return match[4] === undefined;
}

/** Read `<binary> --version`, failing on a spawn error or non-zero exit. */
export async function readCodexVersion(binary = "codex"): Promise<string> {
  const result = await runWithTimeout(binary, ["--version"], {
    timeoutMs: 30_000,
  });
  if (!result.ok) throw result.error;
  if (!result.value.success) {
    throw new Error(
      `${binary} --version failed: ${result.value.stderr.trim()}`,
    );
  }
  return result.value.stdout.trim();
}
