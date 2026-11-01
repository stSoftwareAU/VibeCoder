/**
 * Filesystem boundary for the fleet babysitter's Codex agent (Issue #4593).
 *
 * The runner and the agent share an OS user, so file modes cannot keep the
 * GitHub App private key and App settings from the agent, and `--sandbox
 * workspace-write` lets it read the whole disk. The agent therefore runs under
 * a Codex permissions profile that grants read access broadly but marks the
 * babysitter's credential paths `none`.
 */

/** Name of the Codex permissions profile the babysitter defines per spawn. */
export const BABYSITTER_PERMISSIONS_PROFILE = "babysitter-agent";

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

/**
 * Every path the agent must not read: each `~/.vibe-coder/fleet-pr-babysitter*`
 * entry (the App settings directory and the default key), the configured
 * private-key file, and the real path behind each when it is a symlink.
 */
export async function babysitterProtectedPaths(
  home: string,
  privateKeyPath: string,
): Promise<string[]> {
  assertAbsolute(home, "HOME");
  assertAbsolute(privateKeyPath, "The private-key path");
  const root = `${home}/.vibe-coder`;
  const candidates = [privateKeyPath];
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
    paths.add(candidate);
    const real = await realPathOrUndefined(candidate);
    if (real !== undefined) paths.add(real);
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
 * clone's `.git`, and no access at all to `protectedPaths`.
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
    }
  }
  const prefix = `permissions.${BABYSITTER_PERMISSIONS_PROFILE}.filesystem`;
  const grants: [string, "read" | "write" | "none"][] = [
    ["/", "read"],
    [options.dir, "write"],
    [`${options.dir}/.git`, "read"],
    [options.scratch, "write"],
    ...options.protectedPaths.map((path): [string, "none"] => [path, "none"]),
  ];
  return [
    "-c",
    `default_permissions=${tomlString(BABYSITTER_PERMISSIONS_PROFILE)}`,
    ...grants.flatMap(([path, access]) => [
      "-c",
      `${prefix}.${tomlString(path)}=${tomlString(access)}`,
    ]),
  ];
}
