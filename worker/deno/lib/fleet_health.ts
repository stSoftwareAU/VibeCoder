/**
 * FLEET health reporting — clone/sync private-repo-6 repository and report
 * worker health at the end of each run.
 *
 * Issue #1124: Migrated from run_core.sh (lines 1118–1141) to Deno TypeScript
 * as part of the run-core primary executor wiring.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import {
  formatInaccessibleReposReason,
  getInaccessibleRepos,
  logRepoAccessOnce,
} from "./monitored_repo_access.ts";
import {
  EXTENDED_SUBPROCESS_TIMEOUT_MS,
  runWithTimeout,
} from "./subprocess_timeout.ts";

/**
 * Timeout for the FLEET health-report subprocess (`helpers/repos.sh`): 10
 * minutes (Issue #3127).
 *
 * The report script clones/syncs every monitored repo and can legitimately
 * take several minutes on a slow network or large working set. The previous
 * 60s `EXTENDED_SUBPROCESS_TIMEOUT_MS` was far too short — a slow-but-healthy
 * run was killed and the host wrongly reported as dead. 10 minutes gives the
 * script room to finish while still bounding a genuine hang.
 */
export const DEFAULT_FLEET_HEALTH_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for FLEET health reporting. */
export interface FleetHealthConfig {
  /** Directory where the private-repo-6 repository is cloned. */
  healthDir: string;
  /**
   * Git clone URL for the private-repo-6 repository (`FLEET_HEALTH_REPO`),
   * used only when `healthDir` does not exist yet. Undefined when the operator
   * has not named one: the worker never clones an assumed URL — on a host
   * without access to it that only ever produced a failed clone every
   * heartbeat.
   */
  healthRepo: string | undefined;
  /** Host identifier for health reports (e.g., hostname without domain). */
  hostId: string;
  /**
   * Timeout in milliseconds for the `helpers/repos.sh` report subprocess.
   * Defaults to {@link DEFAULT_FLEET_HEALTH_TIMEOUT_MS}; overridable via the
   * `FLEET_HEALTH_TIMEOUT_MS` environment variable (Issue #3127).
   */
  reportTimeoutMs: number;
}

/**
 * FLEET health tracking is not configured on this host: the checkout does not
 * exist and no `FLEET_HEALTH_REPO` names a repository to clone it from.
 */
export class FleetHealthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetHealthNotConfiguredError";
  }
}

/** Dependency injection for FLEET health operations. */
export interface FleetHealthDeps {
  /** Log an informational message. */
  log: (message: string) => void;
  /** Log a warning message. */
  logWarning: (message: string) => void;
  /** Check whether a directory exists. */
  directoryExists: (path: string) => Promise<boolean>;
  /** Check whether a file exists and is executable. */
  fileIsExecutable: (path: string) => Promise<boolean>;
  /** Run a shell command and return its exit code. */
  runCommand: (
    cmd: string[],
    options?: {
      cwd?: string;
      quiet?: boolean;
      timeoutMs?: number;
      /** Receives the command's stdout on completion (Issue #4243). */
      onOutput?: (stdout: string) => void;
    },
  ) => Promise<Result<void>>;
  /**
   * Run a command and return its trimmed stdout (Issue #4218). Used to
   * verify a "successful" health report actually landed: rev-parse/rev-list
   * probes around the script run.
   */
  captureCommand: (
    cmd: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<Result<string>>;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * The directory name a health repository's checkout takes: the last path
 * segment of its URL without `.git` (`git@github.com:org/GRQ-health.git` and
 * `https://github.com/org/GRQ-health` both give `GRQ-health`).
 */
export function healthRepoCheckoutName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name.length > 0 ? name : "fleet-health";
}

/**
 * Build a FleetHealthConfig from environment variables and defaults.
 *
 * @param repoDir - Base repository directory for default healthDir
 */
export function buildFleetHealthConfig(repoDir: string): FleetHealthConfig {
  // Container fallback (Issue #4165): the sibling default resolves to the
  // root-owned "/" inside the container ("could not create work tree dir
  // '/workspace/../private-repo-6'" observed live), so the clone lands under the
  // writable work-dir mount instead. Disposable by design — the remote is
  // the repository of record. An explicit FLEET_HEALTH_DIR always wins.
  const inContainer = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined;
  const workDir = Deno.env.get("WORK_DIR") ??
    `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;
  const healthRepo = Deno.env.get("FLEET_HEALTH_REPO") || undefined;
  // The checkout is named after the repository (git@host:org/GRQ-health.git
  // -> GRQ-health), so the operator sees the name they know and no name is
  // assumed. With no repository configured there is nothing to clone and the
  // default only ever appears in the "tracking is off" line.
  const checkoutName = healthRepo
    ? healthRepoCheckoutName(healthRepo)
    : "private-repo-6";
  const healthDir = Deno.env.get("FLEET_HEALTH_DIR") ??
    (inContainer
      ? `${workDir}/${checkoutName}`
      : `${repoDir}/../${checkoutName}`);

  // Host identity. Inside the container `Deno.hostname()` is the ephemeral
  // container name (a fresh one every cycle), which would leave the real
  // host permanently "dead" on the private-repo-6 board and register a phantom
  // host per run — so the launcher passes the host's own name through
  // VIBE_HOST_ID and it wins when present. Domain suffix trimmed either way.
  let hostId: string;
  const passedHostId = Deno.env.get("VIBE_HOST_ID")?.trim();
  if (passedHostId) {
    hostId = passedHostId;
  } else {
    try {
      hostId = Deno.hostname();
    } catch {
      hostId = "unknown";
    }
  }
  // Trim domain suffix (e.g. .local)
  const dotIndex = hostId.indexOf(".");
  if (dotIndex > 0) {
    hostId = hostId.substring(0, dotIndex);
  }

  // Report-subprocess timeout — env override, else the 10-minute default.
  // A non-numeric or non-positive value falls back to the default so a
  // typo'd env var never disables the timeout entirely (Issue #3127).
  const rawTimeout = Deno.env.get("FLEET_HEALTH_TIMEOUT_MS");
  let reportTimeoutMs = DEFAULT_FLEET_HEALTH_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (Number.isFinite(parsed) && parsed > 0) {
      reportTimeoutMs = parsed;
    }
  }

  return { healthDir, healthRepo, hostId, reportTimeoutMs };
}

// ---------------------------------------------------------------------------
// Failure diagnostics
// ---------------------------------------------------------------------------

/**
 * Maximum characters of each captured stream included in a failure error.
 *
 * `helpers/repos.sh` prints a status line per monitored repo, so its stdout can
 * be large; capping keeps the worker log bounded. The useful diagnostics (the
 * `git push` rejection) are at the END of stdout, so the tail is retained.
 */
export const MAX_FAILURE_STREAM_CHARS = 4000;

/**
 * Build the Error for a failed health subprocess, surfacing BOTH stderr and
 * (the tail of) stdout.
 *
 * private-repo-6's `helpers/repos.sh` prints the real `git push` rejection — e.g.
 * the GH006 "Protected branch update failed" message — to **stdout**, while
 * only a terse `status=failed reason=push-failed` trap line goes to stderr.
 * Earlier code ran the report with `quiet: true` (stdout discarded) and built
 * the error from stderr alone, so the actual cause of a `push-failed`
 * heartbeat was invisible in the logs (Issues #3173, #3174). Including the
 * stdout tail restores the diagnostic.
 */
export function buildCommandFailureError(
  code: number,
  stdout: string,
  stderr: string,
): Error {
  const tail = (stream: string): string => {
    const trimmed = stream.trim();
    if (trimmed.length <= MAX_FAILURE_STREAM_CHARS) return trimmed;
    return `…${trimmed.slice(-MAX_FAILURE_STREAM_CHARS)}`;
  };

  const segments: string[] = [];
  const errTail = tail(stderr);
  if (errTail) segments.push(errTail);
  const outTail = tail(stdout);
  if (outTail) segments.push(`stdout:\n${outTail}`);

  const detail = segments.join("\n");
  return new Error(
    detail
      ? `Command failed with code ${code}: ${detail}`
      : `Command failed with code ${code}`,
  );
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

/**
 * Create production dependencies for FLEET health reporting.
 *
 * When invoked from the run-core priority loop, callers pass the shared
 * worker `Logger` so heartbeat output reaches `~/logs/worker-*.log` via the
 * same file handle the rest of the loop uses. Without the logger the
 * heartbeat's `console.log` goes only to the inherited tty (Issue #2015).
 *
 * Standalone invocations (`deno mod.ts private-repo-6`) can omit the logger to
 * keep their plain stdout/stderr output for operators running the command
 * interactively.
 */
export function createProductionFleetHealthDeps(
  logger?: Logger,
): FleetHealthDeps {
  return {
    log: logger
      ? (message: string) => logger.info(message)
      : (message: string) => console.log(message),
    logWarning: logger
      ? (message: string) => logger.warn(message)
      : (message: string) => console.error(`WARNING: ${message}`),

    async directoryExists(path: string): Promise<boolean> {
      try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
      } catch {
        return false;
      }
    },

    async fileIsExecutable(path: string): Promise<boolean> {
      try {
        const stat = await Deno.stat(path);
        if (!stat.isFile) return false;
        // On Unix, check executable bit; on Windows, file existence suffices
        if (Deno.build.os !== "windows" && stat.mode !== null) {
          return (stat.mode & 0o111) !== 0;
        }
        return true;
      } catch {
        return false;
      }
    },

    async runCommand(
      cmd: string[],
      options?: {
        cwd?: string;
        quiet?: boolean;
        timeoutMs?: number;
        onOutput?: (stdout: string) => void;
      },
    ): Promise<Result<void>> {
      const executable = cmd[0];
      if (!executable) {
        return { ok: false, error: new Error("Empty command") };
      }

      const result = await runWithTimeout(executable, cmd.slice(1), {
        cwd: options?.cwd,
        quiet: options?.quiet,
        timeoutMs: options?.timeoutMs ?? EXTENDED_SUBPROCESS_TIMEOUT_MS,
      });

      if (!result.ok) {
        return result;
      }

      // Both streams (Issue #4243 follow-up): repos.sh prints the human
      // "Skipping update…" line to stdout but the machine-readable
      // `status=skipped reason=rate-limited` to STDERR — scanning stdout
      // alone missed the skip and the false-positive warning survived.
      options?.onOutput?.(
        `${result.value.stdout}\n${result.value.stderr}`,
      );

      if (result.value.timedOut) {
        return {
          ok: false,
          error: new Error(
            `Command timed out: ${cmd.join(" ")}`,
          ),
        };
      }

      if (!result.value.success) {
        return {
          ok: false,
          // Surface stdout as well as stderr — repos.sh prints the real git
          // push rejection to stdout (Issues #3173, #3174). When stdout was
          // suppressed (quiet:true, e.g. the fetch/reset calls) it is empty
          // and the message matches the historical stderr-only form.
          error: buildCommandFailureError(
            result.value.code,
            result.value.stdout,
            result.value.stderr,
          ),
        };
      }

      return { ok: true, value: undefined };
    },

    async captureCommand(
      cmd: string[],
      options?: { cwd?: string; timeoutMs?: number },
    ): Promise<Result<string>> {
      const executable = cmd[0];
      if (!executable) {
        return { ok: false, error: new Error("Empty command") };
      }
      // quiet:false is what makes this a *capture*: quiet nulls stdout at
      // the OS level (subprocess_timeout.ts), so the captured value would
      // always be "" — the #4219 verification then read every HEAD as
      // unchanged and warned 'did not land' on every successful report
      // (Issue #4252). Piped stdout is captured, not printed.
      const result = await runWithTimeout(executable, cmd.slice(1), {
        cwd: options?.cwd,
        quiet: false,
        timeoutMs: options?.timeoutMs ?? EXTENDED_SUBPROCESS_TIMEOUT_MS,
      });
      if (!result.ok) return result;
      if (result.value.timedOut || !result.value.success) {
        return {
          ok: false,
          error: new Error(`Command failed: ${cmd.join(" ")}`),
        };
      }
      return { ok: true, value: result.value.stdout.trim() };
    },
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Ensure the private-repo-6 repository is cloned and up to date.
 *
 * Clones the repository if missing, otherwise fetches from remote and
 * hard-resets to match — following the model_fetch.sh "never merge"
 * pattern. This self-heals diverged state that would cause `git pull`
 * to fail silently, leaving health updates stuck locally.
 *
 * Both operations are best-effort — failures are logged but do not
 * prevent health reporting from being attempted.
 */
export async function ensureFleetHealthRepo(
  config: FleetHealthConfig,
  deps: FleetHealthDeps,
): Promise<Result<void>> {
  const exists = await deps.directoryExists(config.healthDir);

  if (!exists) {
    if (!config.healthRepo) {
      // Optional feature, not configured on this host: no checkout and no
      // repository to clone it from. Say so once per call and stop — the
      // report itself is skipped by the caller, so this is the whole story
      // in the log rather than a failed clone plus a "script not found".
      const message =
        `FLEET health tracking is off: ${config.healthDir} does not exist ` +
        "and FLEET_HEALTH_REPO is not set (optional; clone your fleet's " +
        "health repository there or set FLEET_HEALTH_REPO to enable it)";
      deps.log(message);
      return { ok: false, error: new FleetHealthNotConfiguredError(message) };
    }
    deps.log("Cloning private-repo-6 repository...");
    const cloneResult = await deps.runCommand(
      ["git", "clone", "--depth=1", config.healthRepo, config.healthDir],
      { quiet: true },
    );
    if (!cloneResult.ok) {
      deps.logWarning(
        `Failed to clone private-repo-6 repository: ${cloneResult.error.message}`,
      );
      return cloneResult;
    }
    return { ok: true, value: undefined };
  }

  // Fetch + hard-reset (never merge) — self-heals diverged repos.
  // Matches the model_fetch.sh pattern used by FLEET worker processes.
  const fetchResult = await deps.runCommand(
    ["git", "-C", config.healthDir, "fetch", "origin"],
    { quiet: true },
  );
  if (!fetchResult.ok) {
    deps.logWarning(
      `Failed to fetch private-repo-6 repository: ${fetchResult.error.message}`,
    );
    // Non-fatal — we can still attempt to report with stale data
    return { ok: true, value: undefined };
  }

  // Reset to remote default branch — try Develop first, fall back to main
  const developResult = await deps.runCommand(
    ["git", "-C", config.healthDir, "reset", "--hard", "origin/Develop"],
    { quiet: true },
  );
  if (!developResult.ok) {
    const mainResult = await deps.runCommand(
      ["git", "-C", config.healthDir, "reset", "--hard", "origin/main"],
      { quiet: true },
    );
    if (!mainResult.ok) {
      deps.logWarning(
        "Failed to reset private-repo-6 to remote branch (tried Develop and main)",
      );
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Report worker health to the private-repo-6 repository.
 *
 * Calls the `helpers/repos.sh` script in the private-repo-6 repository
 * with the worker identity string "Vibe Coder:{hostId}".
 */
export async function reportFleetHealth(
  config: FleetHealthConfig,
  deps: FleetHealthDeps,
): Promise<Result<void>> {
  const healthScript = `${config.healthDir}/helpers/repos.sh`;

  // Issue #4039: an unhealthy host must say *which* repos went dark —
  // "this host is unhealthy" alone is not actionable (#4031). Read the
  // access store (#4036) once and use it for both the operator log line
  // and the report payload below. Emitted before the script check so the
  // state reaches the log even on a host with no private-repo-6 checkout.
  const inaccessibleRepos = getInaccessibleRepos();
  logRepoAccessOnce(inaccessibleRepos, deps.logWarning, {
    hostId: config.hostId,
  });

  const isExecutable = await deps.fileIsExecutable(healthScript);
  if (!isExecutable) {
    deps.logWarning(`FLEET health script not found at ${healthScript}`);
    return {
      ok: false,
      error: new Error(`FLEET health script not found at ${healthScript}`),
    };
  }

  const identity = `Vibe Coder:${config.hostId}`;
  deps.log(`Reporting health as ${identity}`);

  // Issue #4039: name the inaccessible repos on the payload. `--message`
  // is an ADDITIVE flag `helpers/repos.sh` already parses — the identity
  // argument is untouched and no existing `docs/repos.json` field is
  // repurposed — and it is omitted entirely on a healthy host, so a
  // healthy report is byte-identical to the historical invocation.
  const args = [healthScript, identity];
  if (inaccessibleRepos.length > 0) {
    args.push("--message", formatInaccessibleReposReason(inaccessibleRepos));
  }

  // Do NOT pass quiet:true here (Issues #3173, #3174). repos.sh prints the
  // real git push rejection — e.g. the GH006 "Protected branch update failed"
  // message — to stdout; quiet:true discarded it, hiding the cause of every
  // push-failed heartbeat. The output is captured into a buffer (not echoed
  // live) and only surfaced on failure, so healthy runs stay quiet.
  // Outcome verification (Issue #4218): the containerised report was
  // observed exiting 0 three times in one cycle while docs/repos.json
  // stayed 25 hours stale — every local signal green, the fleet-health tile
  // dead. The exit code is not the outcome; the clone's git state is.
  // Best-effort throughout: a probe that cannot answer adds no noise, and
  // verification never changes the report's result.
  const gitCwd = { cwd: config.healthDir };
  const headBefore = await deps.captureCommand(
    ["git", "rev-parse", "HEAD"],
    gitCwd,
  );

  let scriptOutput = "";
  const result = await deps.runCommand(args, {
    timeoutMs: config.reportTimeoutMs,
    onOutput: (stdout) => {
      scriptOutput = stdout;
    },
  });
  if (!result.ok) {
    deps.logWarning(`FLEET health report failed: ${result.error.message}`);
    return result;
  }

  // The script's own rate limit is a deliberate no-commit (Issue #4243):
  // `repos.sh status=skipped reason=rate-limited` — exit 0, HEAD unchanged,
  // by design. Verifying that as "did not land" cried wolf three seconds
  // after the pipeline's first fully-working heartbeat.
  if (
    /status=skipped|reason=rate-limited|Skipping update .* threshold/.test(
      scriptOutput,
    )
  ) {
    return result;
  }

  if (headBefore.ok) {
    const headAfter = await deps.captureCommand(
      ["git", "rev-parse", "HEAD"],
      gitCwd,
    );
    if (headAfter.ok && headAfter.value === headBefore.value) {
      deps.logWarning(
        `FLEET health script exited 0 without committing a heartbeat — the ` +
          `report for ${identity} did not land (Issue #4218)`,
      );
    } else if (headAfter.ok) {
      const ahead = await deps.captureCommand(
        ["git", "rev-list", "--count", "@{u}..HEAD"],
        gitCwd,
      );
      if (ahead.ok && Number.parseInt(ahead.value, 10) > 0) {
        deps.logWarning(
          `FLEET health report exited 0 but ${ahead.value} commit(s) remain ` +
            `unpushed — the report for ${identity} did not land ` +
            `(Issue #4218)`,
        );
      }
    }
  }

  return result;
}

/**
 * Full FLEET health reporting workflow — sync repo and report.
 *
 * This is the top-level function called at the end of each worker run.
 * All errors are caught and logged; health reporting never causes the
 * worker to exit with a non-zero code.
 */
export async function runFleetHealthReporting(
  config: FleetHealthConfig,
  deps: FleetHealthDeps,
): Promise<Result<void>> {
  // Ensure repo is cloned/updated (best-effort). Not configured at all —
  // no checkout, nothing to clone from — means there is nothing to report
  // into either, so stop here rather than add a "script not found" warning.
  const ensured = await ensureFleetHealthRepo(config, deps);
  if (
    !ensured.ok && ensured.error instanceof FleetHealthNotConfiguredError
  ) {
    return ensured;
  }

  // Report health
  return await reportFleetHealth(config, deps);
}
