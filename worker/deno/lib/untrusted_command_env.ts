/**
 * The environment repository-controlled code runs with (Issue #572).
 *
 * The worker executes code it did not write: the repo's own quality command,
 * its test suite, its build, and every install hook those reach —
 * `deno install`, `npm install --package-lock-only`, `cargo generate-lockfile`.
 * Those spawns inherited the worker's whole environment, which carries the
 * provider credentials the run exports:
 *
 *     [SECURITY] provider credentials exported to the run environment:
 *     CLAUDE_CODE_OAUTH_TOKEN
 *
 * and, on the fleets that maintain repositories whose checks need them, cloud
 * credentials too. So `echo $AWS_SECRET_ACCESS_KEY` in a postinstall script
 * was the whole exploit — no compromise of the model required, just an
 * ordinary supply-chain dependency in a public repository the fleet builds.
 *
 * An environment variable is also the hardest kind of secret to contain: every
 * descendant inherits it, any same-uid process can read `/proc/<pid>/environ`,
 * and it lands in crash dumps, `ps` output and diagnostic bundles. It cannot
 * be revoked mid-run. A file can be permission-scoped and taken away.
 *
 * So the environment for those spawns is BUILT, never inherited. This is an
 * allowlist by name: a variable the build genuinely needs is named here, and
 * anything else — including every credential — is simply absent. A denylist
 * would have to predict the next credential's name, and would be wrong the
 * first time one is added.
 *
 * Scope note: this bounds what UNTRUSTED code sees. It does not separate the
 * worker from its own coding agent, which still runs as the same uid and can
 * read the credential files directly (Issue #571). That is the control that
 * actually holds, and it is a different change.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Variables a build legitimately needs, by name.
 *
 * Deliberately short. Anything not here is absent from the child, so adding a
 * name is a decision about what repository-controlled code may see.
 */
export const ALLOWED_ENV_NAMES: readonly string[] = [
  // Finding and running tools at all.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  // Where temporary files go — the container relocates this (Issue #515).
  "TMPDIR",
  // Locale and terminal: test output and date formatting depend on them.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  // Toolchain caches. Without these every quality run re-downloads its
  // dependencies, which is slow enough to change behaviour under a timeout.
  "DENO_DIR",
  "DENO_INSTALL_ROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "PNPM_HOME",
  "npm_config_cache",
  // Ruby: without these `bundle exec` cannot resolve the gems the repository
  // pinned, and the check that needs them reports SKIPPED (Issue #1226).
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
  "BUNDLE_APP_CONFIG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Egress, where the host requires a proxy to reach a registry at all.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Tools branch on this, and a build that behaves differently under CI than
  // under the worker is a build whose result does not transfer.
  "CI",
];

/** Name fragments that mark a variable as carrying a credential. */
const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /\bkey\b/i,
  /api[_-]?key/i,
  /credential/i,
  /auth/i,
  /session/i,
];

/**
 * Whether a variable's NAME marks it as a credential.
 *
 * Used by the guard test rather than by the builder: the allowlist is the
 * control, and this is how "no credential survived" is asserted without
 * naming each one.
 */
export function isCredentialVariableName(name: string): boolean {
  return CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** Options for {@link buildUntrustedCommandEnv}. */
export interface UntrustedCommandEnvOptions {
  /**
   * Extra variable names this repository's checks declare a need for.
   *
   * Per-repo credential scoping is Issue #573; this is the seam it will use,
   * so a repository that genuinely needs a cloud credential names it there
   * rather than every repository inheriting it.
   */
  extraNames?: readonly string[];
  /** Values to set outright, after the allowlist is applied. */
  overrides?: Record<string, string>;
  /** Environment source. Injected for tests. */
  source?: Record<string, string>;
}

/**
 * Build the environment for a command the worker does not control.
 *
 * @returns Only the allowlisted names present in the source, plus overrides.
 */
export function buildUntrustedCommandEnv(
  options: UntrustedCommandEnvOptions = {},
): Record<string, string> {
  const source = options.source ?? readEnvironment();
  const allowed = new Set<string>([
    ...ALLOWED_ENV_NAMES,
    ...(options.extraNames ?? []),
  ]);

  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...(options.overrides ?? {}) };
}

/** The process environment, or an empty object where it cannot be read. */
function readEnvironment(): Record<string, string> {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Running as a different account (Issue #571)
// ---------------------------------------------------------------------------

/**
 * The unprivileged account untrusted commands run as.
 *
 * Separate from the worker's own account so that file permissions actually
 * separate them. The worker's credentials are `0700 vibe`, so the moment the
 * command runs as somebody else it cannot read them — which is the whole
 * point, and something no environment allowlist can achieve on its own: same
 * uid means same access to every credential file, whatever the environment
 * says.
 */
export const UNTRUSTED_USER = "agent";

/**
 * Wrap a command so it runs as {@link UNTRUSTED_USER}.
 *
 * The container process holds NO capabilities (`CapEff: 0`), so it cannot
 * change uid by itself — a setuid helper is required, and `sudo` with a
 * single narrow rule is the one the operator chose:
 *
 *     vibe ALL=(agent) NOPASSWD: <the pinned binaries>
 *
 * `-n` never prompts: without the rule the command fails immediately and
 * loudly rather than hanging on a password nobody can type.
 *
 * @param cmd - The command as spawned today.
 * @param options.enabled - False leaves the command untouched, which is the
 *   behaviour on any host whose image predates the `agent` account.
 * @returns The command to spawn.
 */
export function asUntrustedUser(
  cmd: readonly string[],
  options: { enabled: boolean; user?: string } = { enabled: false },
): string[] {
  if (!options.enabled || cmd.length === 0) return [...cmd];
  return ["sudo", "-n", "-u", options.user ?? UNTRUSTED_USER, "--", ...cmd];
}

/**
 * Whether this container can run a command as the separate account.
 *
 * Both halves are required and both are checked, because either alone fails
 * at spawn time with a message that does not name the cause: the account must
 * exist, and `sudo` must be present to reach it.
 */
export async function canRunAsUntrustedUser(
  probe: (cmd: string[]) => Promise<boolean> = defaultProbe,
): Promise<boolean> {
  if (!await probe(["id", "-u", UNTRUSTED_USER])) return false;
  return await probe(["sudo", "-n", "-u", UNTRUSTED_USER, "--", "true"]);
}

/** Runs a command, reporting only whether it succeeded. */
async function defaultProbe(cmd: string[]): Promise<boolean> {
  try {
    const output = await new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).output();
    return output.success;
  } catch {
    return false;
  }
}
