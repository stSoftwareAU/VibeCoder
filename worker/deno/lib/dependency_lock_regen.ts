/**
 * Lock-file regeneration for merge conflicts (Issue #465, part of #456).
 *
 * A conflicted lock file is **never** text-merged. `deno.lock`,
 * `package-lock.json`, `Cargo.lock` and `go.sum` carry integrity hashes over a
 * resolved dependency graph, so picking hunks produces a file that looks clean
 * — no conflict markers — while describing a graph that never existed. The
 * only correct resolution is to throw the conflicted lock away and let the
 * ecosystem's own tool regenerate it from the already-merged manifest.
 *
 * The sequence for one lock file is:
 *
 * ```mermaid
 * flowchart TD
 *     A[Conflicted lock file] --> B{Manifest rule-resolved<br/>or never conflicted?}
 *     B -- no --> U[unresolved]
 *     B -- yes --> C{Toolchain on PATH?}
 *     C -- no --> U
 *     C -- yes --> D[git checkout --ours -- lock]
 *     D --> E[Run the ecosystem tool<br/>bounded by a timeout]
 *     E -- non-zero --> R[git checkout --merge -- lock] --> U
 *     E -- zero --> F{Marker-free lock on disk?}
 *     F -- no --> R
 *     F -- yes --> G[git add -- lock] --> H[regenerated]
 * ```
 *
 * Every deferral returns `unresolved`, which routes the file to the existing
 * AI-fallback and `needs-human` escalation path in
 * `pr_merge_conflict_processor.ts` — a failed regeneration is visible on the
 * PR rather than silent, and never leaves a half-written lock staged.
 *
 * `container/tools.json` registers `deno`, `node`/`npm` and `rust`/`cargo` but
 * has **no Go entry**, so `go.sum` falls through the toolchain probe today.
 * That is the probe working, not a special case: the rule is registered and
 * starts working the day the image ships Go.
 *
 * The command runner, toolchain probe and lock-file reader are all injected,
 * so the module is fully unit-testable without shelling out.
 *
 * Australian English is used throughout (behaviour, normalised, organisation).
 */

import type { RuleOutcome } from "./dependency_conflict_rules.ts";
import { truncateLogTail } from "./log_tail.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Package ecosystem owning a lock file. */
export type LockEcosystem = "deno" | "npm" | "cargo" | "go";

/** One regeneration invocation, as data so it can be asserted on and stubbed. */
export interface RegenCommand {
  bin: string;
  args: readonly string[];
}

/**
 * How a paired manifest came out of the deterministic rule pass.
 *
 * Derived from `RuleOutcome` so this seam cannot drift from the rule core in
 * `dependency_conflict_rules.ts`.
 */
export type ManifestStatus = RuleOutcome["kind"];

/** What a lock file needs to be regenerated. */
export interface LockFileSpec {
  ecosystem: LockEcosystem;
  /** Basename of the lock file this spec owns. */
  lockFile: string;
  /** Binary that must be on `PATH` before anything is run. */
  binary: string;
  /** Manifest basenames beside the lock, in preference order. */
  manifests: readonly string[];
  /**
   * Regeneration commands, tried in order until one exits zero.
   *
   * Only `cargo` has more than one: the offline refresh is preferred, and the
   * network-permitted refresh is the fallback when the offline cache cannot
   * satisfy the merged manifest.
   */
  commands: readonly RegenCommand[];
}

/** A command the runner is asked to execute. */
export interface RunnerCall {
  bin: string;
  args: readonly string[];
  /** Absolute directory to run in — the lock file's own directory. */
  cwd: string;
  /** Hard ceiling on the run, in milliseconds. */
  timeoutMs: number;
  /** Repository-relative lock file this call is part of, for logging. */
  lockPath: string;
}

/** Result of running a {@link RunnerCall}. */
export interface RunnerOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command. Injected so tests never shell out. */
export type LockCommandRunner = (call: RunnerCall) => Promise<RunnerOutcome>;

/** Whether a binary is available in the container. Injected for tests. */
export type ToolProbe = (bin: string) => Promise<boolean>;

/**
 * The logging surface this module needs.
 *
 * Structurally satisfied by the worker's `Logger`, so callers pass theirs
 * straight through; tests pass a one-method stub.
 */
export interface LockRegenLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
}

/** Options for {@link regenerateLockFile}. */
export interface LockRegenOptions {
  /** Absolute path of the repository working directory. */
  workingDir: string;
  /**
   * Rule outcome per **conflicted** manifest, keyed on repository-relative
   * path. A manifest that was not conflicted at all is simply absent.
   */
  manifestOutcomes: ReadonlyMap<string, ManifestStatus>;
  /** Command runner — defaults to a real, timeout-bounded subprocess runner. */
  runner?: LockCommandRunner;
  /** Toolchain probe — defaults to a `PATH` lookup. */
  hasTool?: ToolProbe;
  /** Lock-file reader — defaults to reading under `workingDir`. */
  readLockFile?: (path: string) => Promise<string | null>;
  /** Per-command timeout; defaults to {@link DEFAULT_LOCK_REGEN_TIMEOUT_MS}. */
  timeoutMs?: number;
  logger?: LockRegenLogger;
}

/** Options for {@link regenerateLockFiles}. */
export interface LockRegenBatchOptions extends LockRegenOptions {
  /** Repository-relative paths of the conflicted lock files. */
  lockFiles: readonly string[];
}

/**
 * Outcome for one lock file.
 *
 * There is deliberately **no text field**: the ecosystem tool is the only
 * writer of lock content, so no caller can be handed hunk-derived text to
 * write. That is the "never text-merge" rule expressed in the type.
 */
export type LockRegenOutcome =
  | {
    kind: "regenerated";
    path: string;
    ecosystem: LockEcosystem;
    /** The command that actually succeeded. */
    command: RegenCommand;
  }
  | { kind: "unresolved"; path: string; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default ceiling on a single regeneration command (5 minutes). */
export const DEFAULT_LOCK_REGEN_TIMEOUT_MS = 300_000;

/** Lines of command output kept in a failure reason. */
export const LOCK_REGEN_OUTPUT_TAIL_LINES = 20;

/** Byte ceiling on that tail, so one runaway line cannot flood the log. */
export const LOCK_REGEN_OUTPUT_TAIL_BYTES = 2048;

/**
 * Any conflict marker at the start of a line.
 *
 * Deliberately a literal — it is the same shape the CI "Check for merge
 * conflict markers" step greps for, and a dynamically built regex would be the
 * wrong primitive for a fixed set of four markers.
 */
const CONFLICT_MARKER_PATTERN = /^(<{7}|\|{7}|={7}|>{7})/m;

/** The lock files this module knows how to regenerate. */
export const LOCK_FILE_SPECS: readonly LockFileSpec[] = [
  {
    ecosystem: "deno",
    lockFile: "deno.lock",
    binary: "deno",
    manifests: ["deno.json", "deno.jsonc"],
    commands: [{ bin: "deno", args: ["install"] }],
  },
  {
    ecosystem: "npm",
    lockFile: "package-lock.json",
    binary: "npm",
    manifests: ["package.json"],
    commands: [{ bin: "npm", args: ["install", "--package-lock-only"] }],
  },
  {
    ecosystem: "cargo",
    lockFile: "Cargo.lock",
    binary: "cargo",
    manifests: ["Cargo.toml"],
    commands: [
      { bin: "cargo", args: ["update", "--workspace", "--offline"] },
      { bin: "cargo", args: ["update", "--workspace"] },
    ],
  },
  {
    ecosystem: "go",
    lockFile: "go.sum",
    binary: "go",
    manifests: ["go.mod"],
    commands: [{ bin: "go", args: ["mod", "tidy"] }],
  },
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Whether a path is a safe repository-relative path.
 *
 * Exported because the deterministic pass (Issue #466) guards the manifest
 * paths it writes with exactly the same rule — one definition, not two.
 *
 * The paths arrive from `git diff --name-only` on a conflicted merge, but they
 * decide a `cwd` and a filesystem read, so they are validated rather than
 * trusted: no absolute path, no drive letter, no backslash, and no `.`/`..`
 * segment that could escape the working directory.
 */
export function isSafeRepoRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".."
  );
}

/** Basename of a repository-relative path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directory of a repository-relative path, `""` at the repository root. */
function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Join a working directory with a repository-relative path. */
function joinPath(workingDir: string, relative: string): string {
  const base = workingDir.replace(/\/+$/, "");
  return relative === "" ? base : `${base}/${relative}`;
}

/** The spec owning a lock-file path, or undefined when there is none. */
export function lockSpecForPath(path: string): LockFileSpec | undefined {
  const name = basename(path);
  return LOCK_FILE_SPECS.find((spec) => spec.lockFile === name);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Redact and bound a command's combined output before it is reported.
 *
 * Redaction runs over the **whole** text before truncation — the
 * redact-before-truncate standard in SECURITY.md — so a secret straddling the
 * cut cannot survive in the kept tail. Both the line and the byte ceiling are
 * announced when they bite, so a bounded tail is never mistaken for the whole
 * output.
 */
export function formatLockRegenOutput(
  stdout: string,
  stderr: string,
): string {
  const combined = [stdout ?? "", stderr ?? ""].filter((part) =>
    part.trim().length > 0
  ).join("\n");
  const redacted = redactSecrets(combined).trimEnd();
  if (redacted.length === 0) return "";

  const lines = redacted.split("\n");
  const dropped = Math.max(0, lines.length - LOCK_REGEN_OUTPUT_TAIL_LINES);
  const marker = dropped > 0
    ? `[...truncated ${dropped} lines — showing tail...]\n`
    : "";
  const tail = lines.slice(-LOCK_REGEN_OUTPUT_TAIL_LINES).join("\n");
  return truncateLogTail(marker + tail, LOCK_REGEN_OUTPUT_TAIL_BYTES);
}

/** Render a command for a message: `` `deno install` ``. */
function describe(command: RegenCommand): string {
  return `\`${[command.bin, ...command.args].join(" ")}\``;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default runner — spawns the command, bounded by an abort signal.
 *
 * A spawn failure throws rather than being reported as a clean exit: the
 * caller turns it into `unresolved`, so a missing or broken toolchain can
 * never look like a successful regeneration.
 */
export const defaultRunner: LockCommandRunner = async (call) => {
  const output = await new Deno.Command(call.bin, {
    args: [...call.args],
    cwd: call.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    // `npm install`, `deno install`, `cargo update` and `go mod tidy` run
    // install hooks declared by a manifest the repository controls, so this
    // is code the worker did not write. Its environment is BUILT from the
    // allowlist rather than inherited (Issues #572, #1214) — a postinstall
    // script has no credential in scope to echo.
    env: buildUntrustedCommandEnv(),
    clearEnv: true,
    signal: AbortSignal.timeout(call.timeoutMs),
  }).output();

  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

/**
 * Default probe — whether `bin` is an executable entry on `PATH`.
 *
 * POSIX `PATH` semantics; the worker container is Linux. An unexpected stat
 * error is re-raised rather than being read as "absent".
 */
const defaultToolProbe: ToolProbe = async (bin) => {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (dir === "") continue;
    try {
      const info = await Deno.stat(`${dir}/${bin}`);
      if (info.isFile || info.isSymlink) return true;
    } catch (error) {
      const absent = error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied;
      if (!absent) throw error;
    }
  }
  return false;
};

/** Default reader — reads the lock file under `workingDir`, null when absent. */
function defaultReader(
  workingDir: string,
): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      return await Deno.readTextFile(joinPath(workingDir, path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

/**
 * Regenerate one conflicted lock file from its already-merged manifest.
 *
 * Returns `regenerated` only when the ecosystem's tool wrote a marker-free
 * lock file that is now staged. Every other path — an unresolved manifest, an
 * absent toolchain, a failing command, a lock that still carries markers —
 * returns `unresolved` with a reason, having staged nothing.
 */
export async function regenerateLockFile(
  lockPath: string,
  options: LockRegenOptions,
): Promise<LockRegenOutcome> {
  const {
    workingDir,
    manifestOutcomes,
    runner = defaultRunner,
    hasTool = defaultToolProbe,
    readLockFile = defaultReader(workingDir),
    timeoutMs = DEFAULT_LOCK_REGEN_TIMEOUT_MS,
    logger,
  } = options;

  const defer = (reason: string): LockRegenOutcome => {
    logger?.warn(`Lock file left for the AI fallback: ${reason}`, {
      lockPath,
      reason,
    });
    return { kind: "unresolved", path: lockPath, reason };
  };

  if (!isSafeRepoRelativePath(lockPath)) {
    return defer(`unsafe path outside the working directory: ${lockPath}`);
  }

  const spec = lockSpecForPath(lockPath);
  if (!spec) return defer(`no lock-file rule for ${lockPath}`);

  const directory = dirname(lockPath);

  // A lock is only regenerated against a manifest that is actually merged.
  for (const manifest of spec.manifests) {
    const manifestPath = directory === ""
      ? manifest
      : `${directory}/${manifest}`;
    if (manifestOutcomes.get(manifestPath) === "unresolved") {
      return defer(
        `its manifest ${manifestPath} is unresolved, so a regenerated lock ` +
          `would describe the wrong dependency set`,
      );
    }
  }

  if (!await hasTool(spec.binary)) {
    return defer(
      `the ${spec.ecosystem} toolchain binary \`${spec.binary}\` is not on ` +
        `PATH in this container`,
    );
  }

  const cwd = joinPath(workingDir, directory);
  const run = async (
    command: RegenCommand,
  ): Promise<RunnerOutcome | { thrown: string }> => {
    try {
      return await runner({
        bin: command.bin,
        args: command.args,
        cwd,
        timeoutMs,
        lockPath,
      });
    } catch (error) {
      return { thrown: (error as Error).message };
    }
  };

  /** Restore the conflicted lock so the AI fallback sees the real conflict. */
  const restore = async (): Promise<void> => {
    await run({ bin: "git", args: ["checkout", "--merge", "--", lockPath] });
  };

  // Check the lock out to a known state: a marker-riddled file is not valid
  // input for any of these tools.
  const checkout = await run({
    bin: "git",
    args: ["checkout", "--ours", "--", lockPath],
  });
  if ("thrown" in checkout) {
    return defer(`git checkout of ${lockPath} failed: ${checkout.thrown}`);
  }
  if (checkout.code !== 0) {
    return defer(
      `git checkout --ours of ${lockPath} exited ${checkout.code}: ` +
        formatLockRegenOutput(checkout.stdout, checkout.stderr),
    );
  }

  let succeeded: RegenCommand | undefined;
  let lastFailure = "";
  for (const command of spec.commands) {
    const result = await run(command);
    if ("thrown" in result) {
      lastFailure = `${describe(command)} could not be run: ${result.thrown}`;
      continue;
    }
    if (result.code === 0) {
      succeeded = command;
      break;
    }
    lastFailure = `${describe(command)} exited non-zero (exit ${result.code})` +
      `: ${formatLockRegenOutput(result.stdout, result.stderr)}`;
  }

  if (!succeeded) {
    await restore();
    return defer(`regenerating ${lockPath} failed — ${lastFailure}`);
  }

  const content = await readLockFile(lockPath);
  if (content === null) {
    await restore();
    return defer(
      `${describe(succeeded)} exited zero but ${lockPath} could not be read`,
    );
  }
  if (CONFLICT_MARKER_PATTERN.test(content)) {
    await restore();
    return defer(
      `${describe(succeeded)} exited zero but ${lockPath} still contains ` +
        `conflict markers`,
    );
  }

  const staged = await run({ bin: "git", args: ["add", "--", lockPath] });
  if ("thrown" in staged || staged.code !== 0) {
    await restore();
    const detail = "thrown" in staged
      ? staged.thrown
      : `exit ${staged.code}: ${
        formatLockRegenOutput(staged.stdout, staged.stderr)
      }`;
    return defer(`staging the regenerated ${lockPath} failed — ${detail}`);
  }

  logger?.info?.(`Regenerated ${lockPath} from its merged manifest`, {
    lockPath,
    ecosystem: spec.ecosystem,
    command: [succeeded.bin, ...succeeded.args].join(" "),
  });

  return {
    kind: "regenerated",
    path: lockPath,
    ecosystem: spec.ecosystem,
    command: succeeded,
  };
}

/**
 * Regenerate every conflicted lock file, in the order given.
 *
 * Each lock file is independent: one deferral never blocks another, and the
 * caller decides what to do with a mixed set — today, any `unresolved` sends
 * the whole merge to the AI fallback.
 */
export async function regenerateLockFiles(
  options: LockRegenBatchOptions,
): Promise<LockRegenOutcome[]> {
  const outcomes: LockRegenOutcome[] = [];
  for (const lockPath of options.lockFiles) {
    outcomes.push(await regenerateLockFile(lockPath, options));
  }
  return outcomes;
}
