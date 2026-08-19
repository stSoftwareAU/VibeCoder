/**
 * Startup housekeeping orchestration and signal-driven cleanup (Issue #3502).
 *
 * `worker/run_core.sh` historically ran a block of one-time startup housekeeping
 * (disk-space reclaim, log rotation, worker-log retention, stale temp-file /
 * work-dir / worktree / session sweeps, and a once-at-startup branch cleanup)
 * and installed a bash
 * `trap` (`cleanup_on_exit`) that terminated descendant processes and removed
 * the PID file on SIGINT/SIGTERM/exit. Each individual step already had a Deno
 * implementation — the bash was only orchestration glue.
 *
 * This module moves that glue into Deno:
 *
 * - {@link runStartupHousekeeping} runs the housekeeping steps **in order**,
 *   each best-effort (a failing step is logged loud, Issue #3234, but never
 *   aborts the sequence — disk/workdir buildup is self-healing, not fatal).
 * - {@link runSignalCleanup} performs the one-shot cleanup the old bash trap
 *   did: terminate the current process's descendants (orphan-prone `claude` /
 *   `deno test` children) and remove the PID file.
 * - {@link installCleanupHandlers} registers real Deno SIGINT/SIGTERM handlers
 *   that run {@link runSignalCleanup} and then exit, replacing the bash trap.
 *
 * Every side effect flows through an injectable dependency seam so unit tests
 * assert the step order and the cleanup behaviour without touching the real
 * filesystem, git, network, or process table.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Logger, WorkerConfig } from "../types.ts";
import { auditChainVerifyCommand } from "../commands/audit_chain_verify.ts";
import { diskSpaceCommand } from "../commands/disk_space.ts";
import { logRotationCommand } from "../commands/log_rotation.ts";
import { cleanupStaleTempFilesCommand } from "../commands/cleanup_stale_temp_files.ts";
import { staleWorkDirCommand } from "../commands/stale_workdir.ts";
import { worktreeCleanupCommand } from "../commands/worktree_cleanup.ts";
import { sessionSweepCommand } from "../commands/session_sweep.ts";
import { denoCacheGuardCommand } from "../commands/deno_cache_guard.ts";
import { branchCleanupCommand } from "../commands/branch_cleanup.ts";
import { workerLogCleanupCommand } from "../commands/worker_log_cleanup.ts";
import {
  DEFAULT_HARD_CAP_COUNT,
  DEFAULT_MAX_AGE_DAYS,
} from "./worker_log_cleanup.ts";
import { terminateDescendants } from "./pid_guard.ts";
import { createLogger } from "./logger.ts";

/**
 * Canonical housekeeping step order (Issue #3502). Exposed so tests and callers
 * can assert the sequence without hard-coding string literals. Mirrors the bash
 * order in `run_core.sh` steps 6.1 → 6.4 / 6f.
 *
 * `audit-chain-verify` runs **first** (Issue #3712): it is the scheduled
 * re-verification of the worker's own audit trail, and it must observe the
 * journals before any cleanup step touches the work directory.
 *
 * `worker-log-cleanup` follows `log-rotation` (Issue #4027): size-based
 * rotation runs first, then age-based retention deletes the worker-PID logs
 * (plain or gzipped) that have aged out. This step was orphaned by the Deno
 * housekeeping migration (#3484) when `run_core.sh` was deleted.
 */
export const HOUSEKEEPING_STEP_IDS = [
  "audit-chain-verify",
  "disk-space",
  "log-rotation",
  "worker-log-cleanup",
  "cleanup-stale-temp-files",
  "stale-workdir",
  "worktree-cleanup",
  "session-sweep",
  "deno-cache-guard",
  "branch-cleanup-orphaned",
  "branch-cleanup-stale",
] as const;

/** A single housekeeping step identifier. */
export type HousekeepingStepId = (typeof HOUSEKEEPING_STEP_IDS)[number];

/** A resolved housekeeping step: which command to run with which arguments. */
export interface HousekeepingStep {
  /** Stable identifier (one of {@link HOUSEKEEPING_STEP_IDS}). */
  id: HousekeepingStepId;
  /** Registered command name invoked for this step. */
  command: string;
  /** Arguments passed to the command's `execute`. */
  args: Record<string, unknown>;
}

/** Inputs controlling the startup housekeeping sequence. */
export interface HousekeepingOptions {
  /** Work directory swept for stale clones / worktrees / sessions. */
  workDir: string;
  /** Directory holding worker logs (typically `~/logs`). */
  logDir: string;
  /** Temp directory swept for orphaned temp files. */
  tmpDir: string;
  /** Default branch used by the orphaned-branch cleanup. */
  defaultBranch: string;
  /** GitHub user whose stale remote branches are cleaned up. */
  githubUser: string;
}

/** Outcome of a single housekeeping step. */
export interface HousekeepingStepResult {
  /** Step identifier. */
  id: HousekeepingStepId;
  /** Whether the underlying command reported success. */
  success: boolean;
  /** Human-readable message from the command (or the failure reason). */
  message: string;
}

/** Outcome of the full startup housekeeping sequence. */
export interface HousekeepingResult {
  /** Steps that ran, in execution order. */
  stepsRun: HousekeepingStepId[];
  /** Per-step results, in execution order. */
  results: HousekeepingStepResult[];
  /** Identifiers of steps that failed (best-effort — never aborts the run). */
  failures: HousekeepingStepId[];
}

/**
 * Injectable dependency seam for {@link runStartupHousekeeping}. Tests inject a
 * recording {@link HousekeepingDeps.runStep} to assert the order and arguments
 * without dispatching to the real commands.
 */
export interface HousekeepingDeps {
  /** Run a single housekeeping step, returning the command's success/message. */
  runStep(
    step: HousekeepingStep,
    config: WorkerConfig,
  ): Promise<{ success: boolean; message: string }>;
  /** Log an informational line. */
  log(message: string): void;
  /** Log an error line (used for failing steps — fail loud, Issue #3234). */
  logError(message: string): void;
  /** Environment reader — injectable so suites pass with and without the
   * container image stamp (Issue #4245). */
  env?(name: string): string | undefined;
}

/**
 * Volatile agent-CLI runtime state, relative to the CLI config dir
 * (Issue #4245). The config dir is durable on the vibe-work volume so
 * transcripts (`projects/`) survive container death (#4171) — but these
 * registries are per-boot runtime state: `sessions/` is keyed by PID with
 * a recorded procStart (the CLI's own stale-instance management), and a
 * fresh VM's recycled PID space makes dead generations' records describe
 * innocent live processes. One worker per container is structural
 * (#4241), so at container start every record here belongs to a dead run.
 */
export const VOLATILE_CLI_STATE_SUBDIRS = [
  "sessions",
  "session-env",
  "shell-snapshots",
  "tasks",
] as const;

/**
 * Container-mode sweep of the CLI's volatile runtime state (Issue #4245).
 * Best-effort: a missing directory is the normal case, and no failure here
 * may block worker start. Returns a summary line for the housekeeping log.
 */
export async function sweepVolatileCliState(
  workDir: string,
  env: (name: string) => string | undefined,
): Promise<string> {
  if (env("VIBE_IMAGE_AGENT_PROVIDERS") === undefined) {
    // Not inside the worker image (a host-side invocation of the housekeeping
    // command): the volatile CLI state is not this process's to sweep.
    return "skipped (not inside the worker container)";
  }
  const configDir = `${workDir}/.claude-config`;
  const removed: string[] = [];
  for (const sub of VOLATILE_CLI_STATE_SUBDIRS) {
    try {
      await Deno.remove(`${configDir}/${sub}`, { recursive: true });
      removed.push(sub);
    } catch {
      // Absent (fresh volume) or unreadable — nothing to sweep.
    }
  }
  return removed.length > 0
    ? `swept dead-run CLI state: ${removed.join(", ")} (transcripts kept)`
    : "no dead-run CLI state to sweep";
}

/** Read an integer environment variable, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Build the ordered list of housekeeping steps from the supplied options,
 * resolving the same tunable thresholds (and their defaults) that the bash
 * `run_core.sh` block used via environment variables.
 */
export function buildHousekeepingSteps(
  options: HousekeepingOptions,
): HousekeepingStep[] {
  return [
    {
      id: "audit-chain-verify",
      command: "audit-chain-verify",
      args: { "base-dir": `${options.workDir}/audit` },
    },
    {
      id: "disk-space",
      command: "disk-space",
      args: {
        "work-dir": options.workDir,
        "threshold": envInt("DISK_CLEANUP_THRESHOLD", 90),
        "gentle-threshold": envInt("DISK_CLEANUP_GENTLE_THRESHOLD", 80),
      },
    },
    {
      id: "log-rotation",
      command: "log-rotation",
      args: {
        "log-dir": options.logDir,
        "max-size-mb": envInt("LOG_MAX_SIZE_MB", 10),
        "max-rotations": envInt("LOG_MAX_ROTATIONS", 3),
      },
    },
    {
      id: "worker-log-cleanup",
      command: "worker-log-cleanup",
      args: {
        "log-dir": options.logDir,
        "max-age-days": envInt("WORKER_LOG_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS),
        "hard-cap-count": envInt(
          "WORKER_LOG_HARD_CAP_COUNT",
          DEFAULT_HARD_CAP_COUNT,
        ),
      },
    },
    {
      id: "cleanup-stale-temp-files",
      command: "cleanup-stale-temp-files",
      args: {
        "directory": options.tmpDir,
        "max-age-minutes": envInt("STALE_TEMP_MAX_AGE_MINUTES", 1440),
      },
    },
    {
      id: "stale-workdir",
      command: "stale-workdir",
      args: {
        "work-dir": options.workDir,
        "max-age-days": envInt("STALE_WORKDIR_DAYS", 7),
      },
    },
    {
      id: "worktree-cleanup",
      command: "worktree-cleanup",
      args: {
        "work-dir": options.workDir,
        "max-age-hours": envInt("WORKTREE_MAX_AGE_HOURS", 24),
      },
    },
    {
      id: "session-sweep",
      command: "session-sweep",
      args: {
        "work-dir": options.workDir,
        "max-age-days": envInt("SESSION_SWEEP_MAX_AGE_DAYS", 7),
        "max-session-size-bytes": envInt(
          "SESSION_SWEEP_MAX_SESSION_BYTES",
          52428800,
        ),
        "max-cumulative-size-bytes": envInt(
          "SESSION_SWEEP_MAX_CUMULATIVE_BYTES",
          524288000,
        ),
      },
    },
    {
      // Bound the durable Deno cache the entrypoint keeps on the work
      // volume (Issue #4302) — over the cap it is wiped, and the next
      // launch pays one cold start instead of the disk filling.
      id: "deno-cache-guard",
      command: "deno-cache-guard",
      args: {
        "work-dir": options.workDir,
        "max-bytes": envInt("DENO_CACHE_MAX_BYTES", 2147483648),
      },
    },
    {
      id: "branch-cleanup-orphaned",
      command: "branch-cleanup",
      args: {
        "operation": "cleanup-orphaned",
        "default-branch": options.defaultBranch,
      },
    },
    {
      id: "branch-cleanup-stale",
      command: "branch-cleanup",
      args: {
        "operation": "cleanup-stale",
        "github-user": options.githubUser,
      },
    },
  ];
}

/** Map from command name to the registered command object for dispatch. */
const HOUSEKEEPING_COMMANDS = {
  "audit-chain-verify": auditChainVerifyCommand,
  "disk-space": diskSpaceCommand,
  "log-rotation": logRotationCommand,
  "worker-log-cleanup": workerLogCleanupCommand,
  "cleanup-stale-temp-files": cleanupStaleTempFilesCommand,
  "stale-workdir": staleWorkDirCommand,
  "worktree-cleanup": worktreeCleanupCommand,
  "session-sweep": sessionSweepCommand,
  "deno-cache-guard": denoCacheGuardCommand,
  "branch-cleanup": branchCleanupCommand,
} as const;

/** Build the production dependency set for {@link runStartupHousekeeping}. */
export function createDefaultHousekeepingDeps(
  logger?: Logger,
): HousekeepingDeps {
  const log = logger ??
    createLogger({ debug: Deno.env.get("DEBUG") === "true" });
  return {
    runStep: async (step, config) => {
      const command = HOUSEKEEPING_COMMANDS[
        step.command as keyof typeof HOUSEKEEPING_COMMANDS
      ];
      if (!command) {
        return {
          success: false,
          message: `Unknown housekeeping command: ${step.command}`,
        };
      }
      const result = await command.execute(step.args, config);
      return { success: result.success, message: result.message };
    },
    log: (message) => log.info(message),
    logError: (message) => log.error(message),
  };
}

/**
 * Run the startup housekeeping sequence in the canonical order (Issue #3502).
 *
 * Every step is best-effort: a failing step is logged loud and recorded in
 * {@link HousekeepingResult.failures}, but the sequence continues so a single
 * cleanup failure never blocks the worker from starting. A thrown step is
 * caught and treated as a failure (never propagated).
 *
 * @param options - Housekeeping inputs (directories, branch, user).
 * @param config - Worker configuration (forwarded to each command).
 * @param depsOverride - Partial dependency overrides (production defaults fill
 *   the rest). Tests inject a recording set to assert order and arguments.
 * @returns The sequence outcome, including the ordered steps that ran.
 */
export async function runStartupHousekeeping(
  options: HousekeepingOptions,
  config: WorkerConfig,
  depsOverride: Partial<HousekeepingDeps> = {},
): Promise<HousekeepingResult> {
  const deps: HousekeepingDeps = {
    ...createDefaultHousekeepingDeps(),
    ...depsOverride,
  };
  // Volatile CLI runtime state first (Issue #4245): the registries must be
  // gone before anything can spawn the agent this cycle.
  const envFn = deps.env ?? ((name: string) => Deno.env.get(name));
  try {
    const summary = await sweepVolatileCliState(options.workDir, envFn);
    deps.log(`[housekeeping] cli-state-sweep: ${summary}`);
  } catch (err) {
    deps.logError(
      `[housekeeping] cli-state-sweep failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const steps = buildHousekeepingSteps(options);
  const stepsRun: HousekeepingStepId[] = [];
  const results: HousekeepingStepResult[] = [];
  const failures: HousekeepingStepId[] = [];

  for (const step of steps) {
    stepsRun.push(step.id);
    try {
      const outcome = await deps.runStep(step, config);
      results.push({
        id: step.id,
        success: outcome.success,
        message: outcome.message,
      });
      if (outcome.success) {
        deps.log(`[housekeeping] ${step.id}: ${outcome.message}`);
      } else {
        failures.push(step.id);
        deps.logError(
          `[housekeeping] ${step.id} failed (continuing): ${outcome.message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: step.id, success: false, message });
      failures.push(step.id);
      deps.logError(
        `[housekeeping] ${step.id} threw (continuing): ${message}`,
      );
    }
  }

  return { stepsRun, results, failures };
}

// ---------------------------------------------------------------------------
// Signal-driven cleanup (replaces the bash `cleanup_on_exit` trap).
// ---------------------------------------------------------------------------

/** Inputs controlling the one-shot signal cleanup. */
export interface CleanupOptions {
  /**
   * PID whose descendants are terminated. This must be the current worker
   * process (`Deno.pid`) so the orphan-prone `claude` / `deno test` subtree it
   * spawned is torn down — never the shell parent (which is an ancestor).
   */
  selfPid: number;
  /** PID file to remove (best-effort). Omit to skip removal. */
  pidFile?: string;
  /** Max seconds to wait for graceful descendant exit before SIGKILL. */
  maxWaitSeconds?: number;
}

/**
 * Injectable seam for {@link runSignalCleanup} and
 * {@link installCleanupHandlers}. Every seam defaults to a real OS-backed
 * implementation; tests override them to assert the cleanup behaviour without
 * touching the process table or filesystem.
 */
export interface CleanupDeps {
  /** Terminate all descendants of a PID (SIGTERM then SIGKILL escalation). */
  terminateDescendants(
    pid: number,
    maxWaitSeconds: number,
  ): Promise<{ targetedPids: number[]; message: string }>;
  /** Remove a file (best-effort). */
  removeFile(path: string): Promise<void>;
  /** Log an informational line. */
  log(message: string): void;
}

/** Build the production dependency set for the signal-cleanup helpers. */
export function createDefaultCleanupDeps(logger?: Logger): CleanupDeps {
  const log = logger ??
    createLogger({ debug: Deno.env.get("DEBUG") === "true" });
  return {
    terminateDescendants: (pid, maxWait) => terminateDescendants(pid, maxWait),
    removeFile: async (path) => {
      try {
        await Deno.remove(path);
      } catch {
        // Best-effort — a missing PID file is the normal case.
      }
    },
    log: (message) => log.info(message),
  };
}

/**
 * Perform the one-shot cleanup the bash `cleanup_on_exit` trap did: terminate
 * the worker's descendant processes and remove the PID file.
 *
 * The PID file is removed **first**, before descendant termination. When this
 * runs from a short-lived cleanup process targeting an ancestor PID (the trap
 * path passing the shell PID), that process may itself appear in the ancestor's
 * descendant set and be terminated mid-run; removing the PID file first
 * guarantees it is gone regardless (no stale PID file after an interrupted run,
 * Issue #3502). Best-effort throughout — a failure to remove or terminate is
 * logged but never thrown, so the exiting process is never wedged by its own
 * cleanup.
 *
 * @param options - Cleanup inputs (self PID, optional PID file).
 * @param depsOverride - Partial dependency overrides for testing.
 */
export async function runSignalCleanup(
  options: CleanupOptions,
  depsOverride: Partial<CleanupDeps> = {},
): Promise<void> {
  const deps: CleanupDeps = {
    ...createDefaultCleanupDeps(),
    ...depsOverride,
  };
  const maxWait = options.maxWaitSeconds ?? 5;

  if (options.pidFile) {
    await deps.removeFile(options.pidFile);
    deps.log(`[cleanup] removed PID file ${options.pidFile}`);
  }

  try {
    const result = await deps.terminateDescendants(options.selfPid, maxWait);
    deps.log(`[cleanup] ${result.message}`);
  } catch (err) {
    deps.log(
      `[cleanup] terminate-descendants failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Signals that trigger the Deno-native cleanup, mirroring the bash traps. */
export const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Conventional exit codes for the handled signals (128 + signal number). */
const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Injectable seam for {@link installCleanupHandlers}. Extends {@link CleanupDeps}
 * with signal registration and process exit so the integration test can drive
 * the handler path deterministically.
 */
export interface SignalHandlerDeps extends CleanupDeps {
  /** Register a signal handler. */
  addSignalListener(signal: string, handler: () => void): void;
  /** Remove a signal handler. */
  removeSignalListener(signal: string, handler: () => void): void;
  /** Exit the process with the given code. */
  exit(code: number): void;
}

/** Build the production dependency set for {@link installCleanupHandlers}. */
export function createDefaultSignalHandlerDeps(
  logger?: Logger,
): SignalHandlerDeps {
  return {
    ...createDefaultCleanupDeps(logger),
    addSignalListener: (signal, handler) =>
      Deno.addSignalListener(signal as Deno.Signal, handler),
    removeSignalListener: (signal, handler) =>
      Deno.removeSignalListener(signal as Deno.Signal, handler),
    exit: (code) => Deno.exit(code),
  };
}

/**
 * Install Deno SIGINT/SIGTERM handlers that run {@link runSignalCleanup} and
 * then exit — the Deno-native replacement for the bash `cleanup_on_exit` trap
 * (Issue #3502). Each handler is idempotent: a second signal while cleanup is
 * already in flight is ignored so descendant termination is not restarted.
 *
 * @param options - Cleanup inputs (self PID, optional PID file).
 * @param depsOverride - Partial dependency overrides for testing.
 * @returns A disposer that removes the installed handlers.
 */
export function installCleanupHandlers(
  options: CleanupOptions,
  depsOverride: Partial<SignalHandlerDeps> = {},
): () => void {
  const deps: SignalHandlerDeps = {
    ...createDefaultSignalHandlerDeps(),
    ...depsOverride,
  };

  let cleaningUp = false;
  const handlers = new Map<string, () => void>();

  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => {
      if (cleaningUp) return;
      cleaningUp = true;
      deps.log(`[cleanup] received ${signal} — cleaning up`);
      runSignalCleanup(options, deps)
        .catch((err) =>
          deps.log(
            `[cleanup] failed (exiting anyway): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        )
        .finally(() => deps.exit(SIGNAL_EXIT_CODES[signal] ?? 1));
    };
    deps.addSignalListener(signal, handler);
    handlers.set(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      try {
        deps.removeSignalListener(signal, handler);
      } catch {
        // Best-effort — removal after exit can throw.
      }
    }
    handlers.clear();
  };
}
