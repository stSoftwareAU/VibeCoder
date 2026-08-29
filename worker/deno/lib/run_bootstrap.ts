/**
 * Bootstrap prelude orchestration for the Vibe Coder worker (Issue #3501).
 *
 * `worker/run_core.sh` historically ran a bash **bootstrap prelude** before
 * delegating the main loop to the Deno `run-core` command: PATH bootstrap,
 * run-id / `VIBE_RUN_ID` export, worker log initialisation, a git reset to the
 * default branch, and the periodic software-update check. Each individual step
 * already had a Deno implementation — the bash was only orchestration glue.
 *
 * This module moves that glue into Deno. {@link runBootstrap} performs the
 * prelude steps **in order** inside the Deno process, establishing the PATH,
 * `VIBE_RUN_ID`, the side-repo clone arguments (Issue #243) and the worker
 * log-file path in-process (so the software-update step and any future
 * in-process main loop inherit them) rather than relying on bash exports. The
 * resolved values are returned so the calling shell can still export them for
 * the remaining shell steps during the incremental migration.
 *
 * **The prelude never writes to the worker checkout (Issue #513).** The git
 * reset it used to perform — the last intentional in-container writer to
 * `/workspace`, and so the only reason that mount had to be read-write — now
 * runs on the host before the container launches, in
 * [checkout_update.ts](./checkout_update.ts) via the `worker-checkout-update`
 * command (Issue #512). The consecutive-failure escalation and the "active
 * development tree" diagnosis went with it: they are about the checkout, and
 * they now sit beside the code that updates it. Everything left here writes to
 * the mounted **log directory** only — `run_core.log`, the per-run worker log
 * — and the checkout is touched by exactly one read: resolving its default
 * branch from `origin/HEAD`, reported in the result for the housekeeping
 * branch clean-up. That read is not fatal: an unresolvable default branch is
 * logged loud and the prelude carries on.
 *
 * **Software-update gate (Issue #513).** With no reset left to gate it, the
 * update check runs on every prelude, unless the caller passes
 * `skipSoftwareUpdate` (`--skip-software-update`, or the documented
 * `SKIP_SOFTWARE_UPDATE` / per-tool `SKIP_*_UPDATE` variables the callers
 * resolve). It writes nothing to the checkout either: its check/attempt
 * timestamps go to `timestampDir` (the home directory unless
 * `SOFTWARE_UPDATE_TIMESTAMP_DIR` names another), and the `pull.log` the git
 * update writes now belongs to the host-side update, under the mounted log
 * directory.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Logger, Result } from "../types.ts";
import { applyDefaults } from "./path_bootstrap.ts";
import { getRunId } from "./run_id.ts";
import {
  checkSoftwareUpdates,
  type SoftwareUpdateOptions,
} from "./software_updates.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  resolveSideRepoCloneArgs,
  SIDE_REPO_CLONE_ARGS_ENV,
} from "./side_repo_clone_args.ts";
import { resolveLocalDefaultBranch } from "./git_push.ts";
import { createLogger } from "./logger.ts";
import {
  gzipOldWorkerLogs,
  type GzipWorkerLogsResult,
} from "./worker_log_gzip.ts";

/**
 * Resolve the worker checkout's own default branch from `origin/HEAD`.
 *
 * The prelude used to reset to a fixed branch name, which held only while
 * every host cloned the one repository that happened to use it. Nothing may
 * assume a repository or branch name: `git clone` records the remote's
 * default branch as `origin/HEAD`, and a clone that lacks it (older clones,
 * `git remote add` by hand) is asked to record it now with
 * `git remote set-head origin --auto`. Callers may still override through
 * `--default-branch`; a checkout whose default cannot be resolved fails loud
 * (there is no sensible guess).
 */
export async function resolveOriginDefaultBranch(
  repoDir: string,
): Promise<Result<string>> {
  const local = await resolveLocalDefaultBranch({ cwd: repoDir });
  if (local) return { ok: true, value: local };

  const setHead = await runGitCommand(
    ["remote", "set-head", "origin", "--auto"],
    { cwd: repoDir },
  );
  if (!setHead.ok) return { ok: false, error: setHead.error };
  if (setHead.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git remote set-head origin --auto failed (exit code ` +
          `${setHead.value.code}): ${
            setHead.value.stderr.trim() || setHead.value.stdout.trim()
          }`,
      ),
    };
  }
  const retried = await resolveLocalDefaultBranch({ cwd: repoDir });
  if (retried) return { ok: true, value: retried };
  return {
    ok: false,
    error: new Error(
      "cannot determine the default branch of origin: refs/remotes/origin/HEAD " +
        "is unset even after `git remote set-head origin --auto`",
    ),
  };
}

/**
 * The canonical prelude order (Issues #3501, #513). Exposed so tests and
 * callers can assert the sequence without hard-coding string literals. There
 * is no `git-reset` step: the checkout is updated host-side before the
 * container launches (see the module comment).
 */
export const PRELUDE_STEPS = [
  "path",
  "run-id",
  "side-repo-clone-args",
  "log-init",
  "default-branch",
  "software-update",
] as const;

/** A single prelude step identifier. */
export type PreludeStep = (typeof PRELUDE_STEPS)[number];

/** Environment/state the prelude establishes for the loop. */
export interface BootstrapEnv {
  /** Bootstrapped PATH value. */
  PATH: string;
  /** Canonical run id for this worker invocation. */
  VIBE_RUN_ID: string;
  /**
   * `git clone` arguments every gate and agent uses for side/data repos it
   * pulls in as `../<name>` (Issue #243) — blobless by default.
   */
  VIBE_SIDE_REPO_CLONE_ARGS: string;
  /** Per-PID worker log file path. */
  WORKER_LOG_FILE: string;
  /** Alias of {@link WORKER_LOG_FILE} exported as LOG_FILE for the loop. */
  LOG_FILE: string;
}

/** Options controlling the bootstrap prelude. */
export interface BootstrapOptions {
  /**
   * Worker checkout. Read-only to the prelude (Issue #513) — it is consulted
   * for the default branch and never written to.
   */
  repoDir: string;
  /** Directory holding worker logs (typically `~/logs`). */
  logDir: string;
  /** Home directory used for PATH resolution. */
  home: string;
  /** Current PATH value to bootstrap from. */
  currentPath: string;
  /** Optional colon-separated additional fallback paths. */
  fallbackPaths?: string;
  /**
   * The checkout's default branch. Omitted, it is read from the checkout's
   * own `origin/HEAD` — a read, never the self-healing repair the host-side
   * update performs (Issue #513).
   */
  defaultBranch?: string;
  /** PID stamped into the per-PID worker log file name. */
  pid: number;
  /** Options forwarded to the software-update check. */
  softwareUpdate?: SoftwareUpdateOptions;
  /** Skip the software-update step entirely. */
  skipSoftwareUpdate?: boolean;
}

/** Outcome of running the bootstrap prelude. */
export interface BootstrapResult {
  /** Whether every attempted step succeeded. */
  ok: boolean;
  /** Environment/state established for the loop. */
  env: BootstrapEnv;
  /** Steps that ran, in execution order. */
  stepsRun: PreludeStep[];
  /** Failure reason when {@link ok} is false. */
  error?: string;
  /**
   * The checkout's default branch — given, or read from `origin/HEAD` — so
   * later steps (housekeeping's orphaned-branch clean-up) use the same
   * answer. Empty when it could not be read; that is logged, not fatal.
   */
  defaultBranch: string;
}

/**
 * Injectable dependencies for {@link runBootstrap}. Every side effect flows
 * through this seam so unit tests can assert the prelude order and in-process
 * env establishment without touching the real filesystem, git, or network.
 */
export interface BootstrapDeps {
  /** Resolve the bootstrapped PATH. */
  resolvePath(
    currentPath: string,
    home: string,
    fallbackPaths: string | undefined,
  ): Promise<string>;
  /** Resolve the canonical run id (sets `VIBE_RUN_ID` when generating one). */
  resolveRunId(): string;
  /** Initialise the per-PID worker log file, returning its path. */
  initWorkerLog(logDir: string, pid: number): Promise<string>;
  /** Compress prior runs' worker logs to `.gz` (Issues #4027, #4227). */
  gzipPriorWorkerLogs(
    logDir: string,
    currentLogFile: string,
  ): Promise<GzipWorkerLogsResult>;
  /** Append a timestamped line to `run_core.log`. */
  appendRunCoreLog(logDir: string, message: string): Promise<void>;
  /** Read the checkout's default branch from `origin/HEAD` — no write. */
  resolveDefaultBranch(repoDir: string): Promise<Result<string>>;
  /** Run the periodic software-update check. */
  checkUpdates(options: SoftwareUpdateOptions | undefined): Promise<void>;
  /** Establish an environment variable in-process. */
  setEnv(name: string, value: string): void;
  /** Read an environment variable (`undefined` when unset). */
  readEnv?(name: string): string | undefined;
}

/** Format a UTC timestamp matching bash `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function utcTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Append a single line (newline-terminated) to a file, creating it if absent. */
/**
 * Append one timestamped line to `${logDir}/run_core.log` — best-effort,
 * never throws. Shared by the bootstrap prelude and the per-launch run-mode
 * record (Issue #4189).
 */
export async function appendRunCoreLogLine(
  logDir: string,
  message: string,
): Promise<void> {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await appendLine(`${logDir}/run_core.log`, `${utcTimestamp()} ${message}`);
  } catch {
    // Best-effort logging.
  }
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await Deno.writeTextFile(filePath, `${line}\n`, { append: true });
}

/**
 * Read the checkout's default branch from `origin/HEAD` (Issue #513).
 *
 * Deliberately *not* {@link resolveOriginDefaultBranch}: that repairs a clone
 * whose `origin/HEAD` is unset with `git remote set-head origin --auto`, a
 * write. The prelude writes nothing to the checkout, so it reads and reports
 * what is there; the host-side update does the repairing.
 */
async function readOriginDefaultBranch(
  repoDir: string,
): Promise<Result<string>> {
  const local = await resolveLocalDefaultBranch({ cwd: repoDir });
  if (local) return { ok: true, value: local };
  return {
    ok: false,
    error: new Error(
      "refs/remotes/origin/HEAD is unset in the worker checkout — the " +
        "host-side worker-checkout-update records it (Issue #512)",
    ),
  };
}

/** Build the production dependency set for {@link runBootstrap}. */
export function createDefaultBootstrapDeps(logger?: Logger): BootstrapDeps {
  const log = logger ??
    createLogger({ debug: Deno.env.get("DEBUG") === "true" });
  return {
    resolvePath: async (currentPath, home, fallbackPaths) =>
      (await applyDefaults(currentPath, home, fallbackPaths)).path,
    resolveRunId: () => getRunId(),
    resolveDefaultBranch: readOriginDefaultBranch,
    initWorkerLog: async (logDir, pid) => {
      await Deno.mkdir(logDir, { recursive: true });
      // Timestamp-named per run (Issue #4227): in container mode the worker
      // is always PID 1, so PID-keyed names piled every run into one eternal
      // worker-1.log that the rotation (keyed on OTHER pids) never touched.
      // The PID still lives in the header line below. Collisions are
      // impossible in practice (one supervisor, cycles minutes apart); the
      // pid suffix fallback keeps even a pathological same-second start safe.
      const compact = utcTimestamp()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .replace(/Z$/, "");
      let logFile = `${logDir}/worker-${compact}.log`;
      try {
        await Deno.lstat(logFile);
        logFile = `${logDir}/worker-${compact}-${pid}.log`;
      } catch {
        // Fresh name — the normal case.
      }
      const logFileName = logFile.slice(logDir.length + 1);
      const symlink = `${logDir}/worker.log`;
      await appendLine(
        logFile,
        `run_core pid=${pid} start=${utcTimestamp()} (Worker timestamps are UTC)`,
      );
      // Refresh the `worker.log` symlink to point at the current run's file.
      try {
        await Deno.remove(symlink);
      } catch {
        // No existing symlink — nothing to remove.
      }
      try {
        // Relative, never absolute (Issues #4222, #4227). The logs directory
        // is bind-mounted into the container, so an absolute target recorded
        // inside it (`/home/vibe/logs/worker-….log`) lands on the host as a
        // link to a path that exists only in the container. `tail -F` on a
        // dangling symlink waits forever without erroring, so the documented
        // "watch the worker" command showed a healthy worker as dead. The
        // link and its target always share a directory, so the bare filename
        // resolves correctly from both sides of the mount.
        await Deno.symlink(logFileName, symlink);
      } catch {
        // Best-effort — a missing symlink must not abort the prelude.
      }
      return logFile;
    },
    gzipPriorWorkerLogs: (logDir, currentLogFile) =>
      gzipOldWorkerLogs(logDir, { currentLogFile }),
    appendRunCoreLog: appendRunCoreLogLine,
    checkUpdates: (options) => checkSoftwareUpdates(log, options ?? {}),
    setEnv: (name, value) => {
      try {
        Deno.env.set(name, value);
      } catch {
        // Permission denied — value still returns to the caller.
      }
    },
    readEnv: safeEnvGet,
  };
}

/** Read an environment variable; a permission denial reads as unset. */
function safeEnvGet(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Run the bootstrap prelude in the canonical order (Issues #3501, #513):
 * PATH → run-id → side-repo clone args → log init → default branch →
 * software-update. Nothing here writes to the worker checkout.
 *
 * Each step establishes its state in-process (via {@link BootstrapDeps.setEnv})
 * and the resolved PATH, `VIBE_RUN_ID`, and log-file path are returned so the
 * caller can export them for any remaining shell steps.
 *
 * @param options - Bootstrap inputs.
 * @param depsOverride - Partial dependency overrides (production defaults fill
 *   the rest). Tests inject a recording set to assert order and env.
 * @returns The prelude outcome, including the ordered list of steps that ran.
 */
export async function runBootstrap(
  options: BootstrapOptions,
  depsOverride: Partial<BootstrapDeps> = {},
): Promise<BootstrapResult> {
  const deps: BootstrapDeps = {
    ...createDefaultBootstrapDeps(),
    ...depsOverride,
  };
  let branch = options.defaultBranch ?? "";
  const stepsRun: PreludeStep[] = [];
  const env: BootstrapEnv = {
    PATH: options.currentPath,
    VIBE_RUN_ID: "",
    VIBE_SIDE_REPO_CLONE_ARGS: "",
    WORKER_LOG_FILE: "",
    LOG_FILE: "",
  };

  // 1) PATH resolution — establish the bootstrapped PATH in-process.
  stepsRun.push("path");
  const path = await deps.resolvePath(
    options.currentPath,
    options.home,
    options.fallbackPaths,
  );
  deps.setEnv("PATH", path);
  env.PATH = path;
  await deps.appendRunCoreLog(options.logDir, `PATH bootstrapped: ${path}`);

  // 2) Run-id — generate once and export VIBE_RUN_ID in-process.
  stepsRun.push("run-id");
  const runId = deps.resolveRunId();
  deps.setEnv("VIBE_RUN_ID", runId);
  env.VIBE_RUN_ID = runId;
  await deps.appendRunCoreLog(
    options.logDir,
    `VIBE_RUN_ID=${runId || "unset"}`,
  );

  // 2b) Side-repo clone arguments (Issue #243) — established here so every
  //     gate and agent this run spawns inherits them and a re-fetched tier-2
  //     data repo costs its working tree, not its whole history.
  stepsRun.push("side-repo-clone-args");
  const cloneArgs = resolveSideRepoCloneArgs(deps.readEnv ?? safeEnvGet);
  deps.setEnv(SIDE_REPO_CLONE_ARGS_ENV, cloneArgs.value);
  env.VIBE_SIDE_REPO_CLONE_ARGS = cloneArgs.value;
  await deps.appendRunCoreLog(
    options.logDir,
    cloneArgs.source === "rejected"
      ? `${SIDE_REPO_CLONE_ARGS_ENV} override refused: ${cloneArgs.reason}`
      : `${SIDE_REPO_CLONE_ARGS_ENV}=${
        cloneArgs.value || "<none>"
      } (${cloneArgs.source})`,
  );

  // 3) Worker log initialisation — per-PID log file plus latest symlink.
  stepsRun.push("log-init");
  const logFile = await deps.initWorkerLog(options.logDir, options.pid);
  deps.setEnv("WORKER_LOG_FILE", logFile);
  deps.setEnv("LOG_FILE", logFile);
  env.WORKER_LOG_FILE = logFile;
  env.LOG_FILE = logFile;

  // 3b) Compress prior runs' worker logs (Issue #4027). Runs after the current
  //     run's log exists so that log — and only that log — stays plain text.
  //     Best-effort: a compression failure is logged loud (Issue #3234) but
  //     never blocks the worker from starting.
  try {
    const gzip = await deps.gzipPriorWorkerLogs(options.logDir, logFile);
    await deps.appendRunCoreLog(options.logDir, gzip.message);
    for (const failure of gzip.failures) {
      await deps.appendRunCoreLog(
        options.logDir,
        `worker log gzip failed: ${failure.path}: ${failure.error}`,
      );
    }
  } catch (err) {
    await deps.appendRunCoreLog(
      options.logDir,
      `worker log gzip threw (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 4) Default branch — a read of the checkout's origin/HEAD (Issue #513),
  //    reported so housekeeping's orphaned-branch clean-up works off the same
  //    answer. Never a write, and never fatal: the checkout is updated on the
  //    host now, so an unreadable origin/HEAD costs one housekeeping step,
  //    not the run. It is logged loud either way (Issue #3234).
  stepsRun.push("default-branch");
  if (branch === "") {
    const resolved = await deps.resolveDefaultBranch(options.repoDir);
    if (resolved.ok) {
      branch = resolved.value;
    } else {
      await deps.appendRunCoreLog(
        options.logDir,
        `Default branch unresolved: ${resolved.error.message} — the ` +
          `orphaned-branch clean-up will be skipped this run (pass ` +
          `--default-branch to name it)`,
      );
    }
  }
  if (branch !== "") {
    await deps.appendRunCoreLog(options.logDir, `Default branch: ${branch}`);
  }

  // 5) Software-update check — periodic, runs within the same process so it
  //    inherits the freshly bootstrapped PATH and VIBE_RUN_ID. With no reset
  //    left to gate it (Issue #513) the only gate is `skipSoftwareUpdate`.
  if (!options.skipSoftwareUpdate) {
    stepsRun.push("software-update");
    await deps.checkUpdates(options.softwareUpdate);
  }

  return { ok: true, env, stepsRun, defaultBranch: branch };
}

/**
 * Render the established environment as shell `export` lines for the calling
 * shell to `eval`. Values are single-quoted with embedded single quotes escaped
 * so arbitrary PATH contents are safe to eval.
 */
export function toShellExports(env: BootstrapEnv): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    `export PATH=${quote(env.PATH)}`,
    `export VIBE_RUN_ID=${quote(env.VIBE_RUN_ID)}`,
    `export VIBE_SIDE_REPO_CLONE_ARGS=${quote(env.VIBE_SIDE_REPO_CLONE_ARGS)}`,
    `export WORKER_LOG_FILE=${quote(env.WORKER_LOG_FILE)}`,
    `export LOG_FILE=${quote(env.LOG_FILE)}`,
  ].join("\n");
}
