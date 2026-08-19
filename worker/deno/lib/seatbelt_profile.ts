/**
 * macOS Seatbelt containment profile for the native worker (Issue #4300).
 *
 * The containment goal is a FILESYSTEM boundary — the agent must not read
 * directories it has no business in — but container mode buys that
 * boundary by statically partitioning compute (a 6-of-10-core, 16-of-24 GiB
 * VM that stalls wholesale under host contention, with no GPU). The
 * operator philosophy is the opposite: generous resources, strict boundary.
 *
 * `seatbelt` mode runs the worker natively under a Seatbelt profile
 * (`sandbox-exec -f`, the mechanism Claude Code's own bash sandbox uses):
 * deny-by-default, then allow the same set of host paths the container
 * plan mounts — work dir, logs, run-config, credentials, the checkout —
 * plus the system/toolchain paths the tools need, and outbound network.
 * Everything else on the machine (`~/Documents`, other checkouts, mail,
 * browser profiles, `~/.ssh`) is unreadable, which is the actual
 * requirement — on the native scheduler with every core, the GPU, unified
 * memory, no virtiofs, no VM boot.
 *
 * Trade-off, stated plainly: Seatbelt confines file access, not kernel
 * attack surface. It is weaker than a VM against a malicious-code escape,
 * so it is a per-host choice (`run_mode: seatbelt`), never the default,
 * and container mode remains for hosts that run untrusted repositories.
 *
 * The profile is generated, not hand-written, so the allowlist and the
 * container mount set cannot drift apart: both derive from the same host
 * paths. Every path is validated before it lands in the profile — a Seatbelt
 * profile is code, and a path with a quote or newline in it must never be
 * spliced in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Host paths the profile grants, mirroring the container mount set. */
export interface SeatbeltProfileInputs {
  /** The worker checkout the driver runs from (read-only). */
  baseDir: string;
  /** Work directory: clones, sessions, state (read-write). */
  workDir: string;
  /** Log directory (read-write). */
  logDir: string;
  /** Directory holding the run configuration (read-only). */
  configDir: string;
  /** Credential root, e.g. `~/.vibe-coder/credentials` (read-only). */
  credentialsDir: string;
  /** Home directory — used to allow the tool caches under it (read-write). */
  homeDir: string;
  /**
   * The per-user temp directory (`TMPDIR`, e.g.
   * `/var/folders/xx/.../T`). Granted read-write. NOT the whole
   * `/private/var/folders` tree — that would open every user's temp
   * space, and on macOS the tester's own HOME fixtures may live there.
   */
  tmpDir: string;
  /**
   * Extra read-write paths. Optional; validated like the rest.
   */
  extraWritable?: string[];
  /**
   * Extra read-only paths (e.g. an operator's toolchain root). Optional.
   */
  extraReadable?: string[];
}

/**
 * System paths every process needs to run at all: dyld, frameworks, the
 * toolchain roots (Homebrew, MacPorts), device nodes, and the resolver
 * databases. Read-only.
 */
export const SEATBELT_SYSTEM_READ_PATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/private/etc",
  "/private/var/select",
  "/private/var/db",
  "/private/var/run",
  "/dev",
  "/opt/homebrew",
  "/opt/local",
  "/Applications",
];

/**
 * Per-user cache directories under HOME that deno, git, gh, node and the
 * agent CLI write to. Granted read-write, relative to `homeDir`.
 */
export const SEATBELT_HOME_CACHE_SUBPATHS: readonly string[] = [
  ".cache",
  ".deno",
  ".npm",
  ".config/gh",
  ".config/git",
  ".claude",
  ".claude.json",
  ".gitconfig",
  // Nothing under ~/.vibe-coder is writable: credentials/ and run-config/
  // are read-only grants, and the worker's own caches moved to
  // ${WORK_DIR}/.vibe-cache (Issue #4318), which the work-dir grant covers.
  "Library/Caches",
  "Library/Preferences",
  "Library/Application Support/Claude",
];

/** Characters that may not appear in a path spliced into a profile. */
const UNSAFE_PATH_RE = /[\r\n"\\]/;

/**
 * Validate a path for inclusion. Absolute, no quotes/backslashes/newlines,
 * no `..` segments. Returns the normalised path (trailing slash removed).
 */
export function validateProfilePath(path: string, label: string): string {
  let trimmed = path.trim();
  // Seatbelt matches the KERNEL path: on macOS `/var`, `/tmp` and `/etc`
  // are symlinks into `/private`, so a grant written as `/var/folders/…`
  // never matches the `/private/var/folders/…` the kernel sees. Resolve
  // symlinks for paths that exist; a not-yet-created path is kept as
  // written (the launcher creates the mounted set before running).
  try {
    trimmed = Deno.realPathSync(trimmed);
  } catch {
    // Absent or unreadable — validate the literal below.
  }
  if (!trimmed.startsWith("/")) {
    throw new Error(
      `Seatbelt profile: ${label} must be absolute: ${JSON.stringify(path)}`,
    );
  }
  if (UNSAFE_PATH_RE.test(trimmed)) {
    throw new Error(
      `Seatbelt profile: ${label} contains a character that cannot be spliced into a profile: ${
        JSON.stringify(path)
      }`,
    );
  }
  if (trimmed.split("/").some((segment) => segment === "..")) {
    throw new Error(
      `Seatbelt profile: ${label} must not contain '..': ${
        JSON.stringify(path)
      }`,
    );
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function subpath(path: string): string {
  return `(subpath "${path}")`;
}

/**
 * Build the Seatbelt profile text.
 *
 * Deny by default; allow process/exec/signal/sysctl/mach so tools can run;
 * read the system paths; read the checkout, config and credentials; read
 * AND write the work dir, logs, home caches and any extras; outbound
 * network only. Reads of anything else — the rest of HOME included — are
 * refused by the kernel.
 */
export function buildSeatbeltProfile(inputs: SeatbeltProfileInputs): string {
  const baseDir = validateProfilePath(inputs.baseDir, "baseDir");
  const workDir = validateProfilePath(inputs.workDir, "workDir");
  const logDir = validateProfilePath(inputs.logDir, "logDir");
  const configDir = validateProfilePath(inputs.configDir, "configDir");
  const credentialsDir = validateProfilePath(
    inputs.credentialsDir,
    "credentialsDir",
  );
  const homeDir = validateProfilePath(inputs.homeDir, "homeDir");
  const tmpDir = validateProfilePath(inputs.tmpDir, "tmpDir");
  const extraWritable = (inputs.extraWritable ?? []).map((p, i) =>
    validateProfilePath(p, `extraWritable[${i}]`)
  );
  const extraReadable = (inputs.extraReadable ?? []).map((p, i) =>
    validateProfilePath(p, `extraReadable[${i}]`)
  );

  const readOnly = [
    ...SEATBELT_SYSTEM_READ_PATHS,
    baseDir,
    configDir,
    credentialsDir,
    ...extraReadable,
  ];
  const readWrite = [
    workDir,
    logDir,
    ...SEATBELT_HOME_CACHE_SUBPATHS.map((sub) => `${homeDir}/${sub}`),
    tmpDir,
    "/private/tmp",
    "/dev",
    ...extraWritable,
  ];

  const lines = [
    "(version 1)",
    ";; Generated by the Vibe Coder launcher (Issue #4300). Do not edit —",
    ";; the allowlist derives from the same host paths container mode mounts.",
    "(deny default)",
    "",
    ";; Process plumbing every tool needs.",
    "(allow process-exec process-fork signal)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow file-read-metadata)",
    "",
    ";; Root directory entry only — not its contents.",
    '(allow file-read* (literal "/"))',
    "",
    ";; Read-only: system, toolchains, the checkout, config, credentials.",
    `(allow file-read* ${readOnly.map(subpath).join(" ")})`,
    "",
    ";; Read-write: work dir, logs, tool caches, temp.",
    `(allow file-read* file-write* ${readWrite.map(subpath).join(" ")})`,
    "",
    ";; Network: outbound only (GitHub, Anthropic, FLEET-health).",
    "(allow network-outbound)",
    "(allow system-socket)",
    "",
  ];
  return lines.join("\n");
}
