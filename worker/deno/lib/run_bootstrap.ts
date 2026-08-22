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
 * Fail-loud (Issue #3234): a failed git reset returns `ok: false` and the
 * software-update step is skipped, exactly mirroring the old bash path where a
 * non-zero git reset exited the script before the update check ran.
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
import { spawnGh } from "./gh_spawn.ts";
import { GH_RUNTIME_CONFIG_SUFFIX } from "./credential_preflight.ts";
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
 * Consecutive reset failures before the bootstrap escalates through the
 * control plane (Issue #4204). One transient blip stays a log line; a
 * crash-loop becomes a GitHub issue the operator actually sees — the
 * observed failure mode was a worker silently absent for an hour while its
 * checkout was occupied by interactive development work.
 */
export const BOOTSTRAP_ESCALATION_THRESHOLD = 3;

/** File under the log directory persisting the consecutive-failure count. */
export const BOOTSTRAP_FAILURE_STREAK_FILE = "bootstrap-failure-streak";

/** What the worker checkout looks like, for collision diagnosis (#4204). */
export interface CheckoutState {
  /** Currently checked-out branch (or `HEAD` when detached). */
  branch: string;
  /** Number of uncommitted paths reported by `git status --porcelain`. */
  dirtyFiles: number;
}

/** Everything the escalation hook needs to name the failure (#4204). */
export interface BootstrapEscalationContext {
  /** The worker checkout that could not be reset. */
  repoDir: string;
  /** Worker log directory (for any escalation-side logging). */
  logDir: string;
  /** Consecutive failures, including this one. */
  streak: number;
  /** The enriched failure detail. */
  error: string;
  /** Checkout state at failure time, when it could be read. */
  checkout: CheckoutState | null;
}

/**
 * The canonical prelude order (Issue #3501). Exposed so tests and callers can
 * assert the sequence without hard-coding string literals.
 */
export const PRELUDE_STEPS = [
  "path",
  "run-id",
  "side-repo-clone-args",
  "log-init",
  "git-reset",
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
  /** Repository directory to reset to the default branch. */
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
   * Branch to reset to. Omitted, it is resolved from the checkout's own
   * `origin/HEAD` (see {@link resolveOriginDefaultBranch}).
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
   * The branch the checkout was reset to — given, or resolved from
   * `origin/HEAD` — so later steps (housekeeping's branch clean-up) use the
   * same answer. Empty when the prelude failed before it was known.
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
  /** Resolve the checkout's default branch from `origin/HEAD`. */
  resolveDefaultBranch(repoDir: string): Promise<Result<string>>;
  /** Reset the checkout to `origin/<branch>`; fail-loud on any git failure. */
  resetToDefaultBranch(
    repoDir: string,
    branch: string,
    logDir: string,
  ): Promise<Result<void>>;
  /** Run the periodic software-update check. */
  checkUpdates(options: SoftwareUpdateOptions | undefined): Promise<void>;
  /** Establish an environment variable in-process. */
  setEnv(name: string, value: string): void;
  /** Read an environment variable (`undefined` when unset). */
  readEnv?(name: string): string | undefined;
  /**
   * Describe the checkout for collision diagnosis (Issue #4204). Best-effort:
   * `null` when the state cannot be read — diagnosis is enrichment, never a
   * new failure mode.
   */
  describeCheckoutState(repoDir: string): Promise<CheckoutState | null>;
  /** Read the persisted consecutive-failure count (0 when absent). */
  readBootstrapFailureStreak(logDir: string): Promise<number>;
  /** Persist the consecutive-failure count. */
  writeBootstrapFailureStreak(logDir: string, count: number): Promise<void>;
  /**
   * Raise the crash-loop through the control plane (Issue #4204) — the
   * default files (or comments on) a deduplicated GitHub issue against the
   * checkout's origin repository. Best-effort: a throw is logged and never
   * masks the underlying bootstrap failure.
   */
  escalateBootstrapFailure(context: BootstrapEscalationContext): Promise<void>;
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
 * Default git reset sequence, mirroring the old bash chain:
 *   git fetch origin && git checkout <branch> &&
 *   git reset --hard origin/<branch> && git clean -fd
 *
 * Output is appended to `pull.log`. The first failing command short-circuits
 * and returns a fail-loud error (Issue #3234).
 */
async function defaultResetToDefaultBranch(
  repoDir: string,
  branch: string,
  logDir: string,
): Promise<Result<void>> {
  const pullLog = `${logDir}/pull.log`;
  const steps: string[][] = [
    ["fetch", "origin"],
    ["checkout", branch],
    ["reset", "--hard", `origin/${branch}`],
    ["clean", "-fd"],
  ];

  for (const args of steps) {
    const result = await runGitCommand(args, { cwd: repoDir });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const { code, stdout, stderr } = result.value;
    const output = `${stdout}${stderr}`;
    if (output.length > 0) {
      try {
        await appendLine(pullLog, output.replace(/\n$/, ""));
      } catch {
        // Best-effort logging — never masks the git outcome.
      }
    }
    if (code !== 0) {
      return {
        ok: false,
        error: new Error(
          `git ${args.join(" ")} failed (exit code ${code}): ${
            stderr.trim() || stdout.trim()
          }`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Read the checkout's branch and dirty-file count (Issue #4204). Best-effort:
 * any git failure returns `null` — diagnosis must never add a failure mode.
 */
async function defaultDescribeCheckoutState(
  repoDir: string,
): Promise<CheckoutState | null> {
  try {
    const branchResult = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir },
    );
    if (!branchResult.ok || branchResult.value.code !== 0) return null;
    const statusResult = await runGitCommand(["status", "--porcelain"], {
      cwd: repoDir,
    });
    if (!statusResult.ok || statusResult.value.code !== 0) return null;
    const dirtyFiles = statusResult.value.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    return { branch: branchResult.value.stdout.trim(), dirtyFiles };
  } catch {
    return null;
  }
}

/** Path of the persisted consecutive-failure count. */
function streakFilePath(logDir: string): string {
  return `${logDir}/${BOOTSTRAP_FAILURE_STREAK_FILE}`;
}

/** Read the persisted streak; absent or unreadable reads as zero. */
async function defaultReadBootstrapFailureStreak(
  logDir: string,
): Promise<number> {
  try {
    const text = await Deno.readTextFile(streakFilePath(logDir));
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Persist the streak. Best-effort — a write failure only loses the count. */
async function defaultWriteBootstrapFailureStreak(
  logDir: string,
  count: number,
): Promise<void> {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(streakFilePath(logDir), `${count}\n`);
  } catch {
    // Best-effort persistence.
  }
}

/** Parse `owner/repo` out of a git origin URL (SSH or HTTPS). */
export function parseOriginRepo(url: string): string | null {
  const match = url.trim().match(
    /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  return match ? match[1]! : null;
}

/** The host's own identity for the escalation title. */
function escalationHostId(): string {
  const fromEnv = Deno.env.get("VIBE_HOST_ID")?.trim();
  if (fromEnv) return fromEnv;
  try {
    return Deno.hostname().split(".")[0] || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

/**
 * File (or comment on) a deduplicated GitHub issue naming the crash-loop
 * (Issue #4204). Goes through the `spawnGh` chokepoint like every other
 * worker write. The bootstrap runs before the worker's configuration is
 * loaded, so `GH_CONFIG_DIR` may not be established yet — inside the
 * container the entrypoint stages a runtime copy under the home directory,
 * which is pointed at explicitly when present.
 */
async function defaultEscalateBootstrapFailure(
  context: BootstrapEscalationContext,
): Promise<void> {
  const origin = await runGitCommand(["remote", "get-url", "origin"], {
    cwd: context.repoDir,
  });
  if (!origin.ok || origin.value.code !== 0) {
    throw new Error("cannot resolve the checkout's origin remote");
  }
  const repo = parseOriginRepo(origin.value.stdout);
  if (!repo) {
    throw new Error(
      `origin is not a GitHub repository: ${origin.value.stdout.trim()}`,
    );
  }

  const env: Record<string, string> = {};
  if (!Deno.env.get("GH_CONFIG_DIR")) {
    const home = Deno.env.get("HOME");
    if (home) {
      const runtimeDir = `${home}/${GH_RUNTIME_CONFIG_SUFFIX}`;
      try {
        await Deno.stat(`${runtimeDir}/hosts.yml`);
        env.GH_CONFIG_DIR = runtimeDir;
      } catch {
        // No staged runtime copy — let gh resolve its own configuration.
      }
    }
  }

  const host = escalationHostId();
  const title = `Worker bootstrap failing on ${host}`;
  const body = [
    `The worker bootstrap on \`${host}\` has failed ` +
    `${context.streak} consecutive runs — the worker is claiming nothing ` +
    `while this persists (Issue #4204).`,
    "",
    "```",
    context.error,
    "```",
    "",
    context.checkout
      ? `Checkout state: branch \`${context.checkout.branch}\`, ` +
        `${context.checkout.dirtyFiles} uncommitted change(s).`
      : "Checkout state could not be read.",
    "",
    "If this checkout doubles as a development tree, commit or stash the " +
    "in-flight work, or give the worker its own dedicated clone — see " +
    "docs/DEPLOYMENT.md (Dedicated clone).",
  ].join("\n");

  // Dedup by exact title: comment on an existing open report, else create.
  const listed = await spawnGh(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `in:title \"${title}\"`,
      "--json",
      "number,title",
    ],
    { env },
  );
  let existing: number | undefined;
  if (listed.code === 0) {
    try {
      const issues = JSON.parse(listed.stdout) as {
        number: number;
        title: string;
      }[];
      existing = issues.find((issue) => issue.title === title)?.number;
    } catch {
      // Unparseable listing — fall through to creation.
    }
  }

  const result = existing
    ? await spawnGh(
      [
        "issue",
        "comment",
        `${existing}`,
        "--repo",
        repo,
        "--body",
        body,
      ],
      { env },
    )
    : await spawnGh(
      ["issue", "create", "--repo", repo, "--title", title, "--body", body],
      { env },
    );
  if (result.code !== 0) {
    throw new Error(
      `gh issue ${
        existing ? "comment" : "create"
      } exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
}

/** Build the production dependency set for {@link runBootstrap}. */
export function createDefaultBootstrapDeps(logger?: Logger): BootstrapDeps {
  const log = logger ??
    createLogger({ debug: Deno.env.get("DEBUG") === "true" });
  return {
    resolvePath: async (currentPath, home, fallbackPaths) =>
      (await applyDefaults(currentPath, home, fallbackPaths)).path,
    resolveRunId: () => getRunId(),
    resolveDefaultBranch: resolveOriginDefaultBranch,
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
    resetToDefaultBranch: defaultResetToDefaultBranch,
    describeCheckoutState: defaultDescribeCheckoutState,
    readBootstrapFailureStreak: defaultReadBootstrapFailureStreak,
    writeBootstrapFailureStreak: defaultWriteBootstrapFailureStreak,
    escalateBootstrapFailure: defaultEscalateBootstrapFailure,
    checkUpdates: (options) => checkSoftwareUpdates(log, options ?? {}),
    setEnv: (name, value) => {
      try {
        Deno.env.set(name, value);
      } catch {
        // Permission denied — value still returns to the caller.
      }
    },
    readEnv: (name) => {
      try {
        return Deno.env.get(name);
      } catch {
        // Permission denied — read as unset so the default applies.
        return undefined;
      }
    },
  };
}

/**
 * Run the bootstrap prelude in the canonical order (Issue #3501):
 * PATH → run-id → log init → git reset → software-update.
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
  const cloneArgs = resolveSideRepoCloneArgs(
    deps.readEnv ?? ((name) => Deno.env.get(name)),
  );
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

  // 4) Git reset to the default branch — fail-loud on any git failure. The
  //    branch is whatever origin says it is unless the caller named one.
  stepsRun.push("git-reset");
  let reset: Result<void>;
  if (branch === "") {
    const resolved = await deps.resolveDefaultBranch(options.repoDir);
    if (resolved.ok) {
      branch = resolved.value;
    } else {
      reset = {
        ok: false,
        error: new Error(
          `cannot resolve the checkout's default branch: ` +
            `${resolved.error.message} (pass --default-branch to name it)`,
        ),
      };
    }
  }
  if (branch !== "") {
    await deps.appendRunCoreLog(
      options.logDir,
      `Resetting repo to origin/${branch}`,
    );
    reset = await deps.resetToDefaultBranch(
      options.repoDir,
      branch,
      options.logDir,
    );
  }
  if (!reset!.ok) {
    // Collision diagnosis (Issue #4204): when the checkout looks like an
    // active development tree — dirty, or parked on another branch — say so,
    // instead of the bare "Git reset failed" that let a crash-loop run for
    // an hour unexplained. Best-effort: an unreadable state adds nothing.
    let checkout: CheckoutState | null = null;
    try {
      checkout = await deps.describeCheckoutState(options.repoDir);
    } catch {
      checkout = null;
    }
    let detail = reset!.error.message;
    if (
      checkout && branch !== "" &&
      (checkout.dirtyFiles > 0 || checkout.branch !== branch)
    ) {
      detail += ` — the worker checkout looks like an active development ` +
        `tree (branch ${checkout.branch}, ${checkout.dirtyFiles} ` +
        `uncommitted change(s)). Commit or stash that work, or give the ` +
        `worker its own dedicated clone (Issue #4204).`;
    }
    await deps.appendRunCoreLog(options.logDir, `Git reset failed: ${detail}`);

    // Consecutive-failure escalation (Issue #4204): one blip stays a log
    // line; a crash-loop is raised through the control plane exactly once
    // per streak, so an unattended host's absence is visible where the
    // operator actually looks. Every step is best-effort — nothing here may
    // mask the underlying failure.
    let streak: number;
    try {
      streak = (await deps.readBootstrapFailureStreak(options.logDir)) + 1;
    } catch {
      streak = 1;
    }
    try {
      await deps.writeBootstrapFailureStreak(options.logDir, streak);
    } catch {
      // Best-effort persistence.
    }
    if (streak === BOOTSTRAP_ESCALATION_THRESHOLD) {
      await deps.appendRunCoreLog(
        options.logDir,
        `Bootstrap has failed ${streak} consecutive runs — escalating ` +
          `through the control plane (Issue #4204)`,
      );
      try {
        await deps.escalateBootstrapFailure({
          repoDir: options.repoDir,
          logDir: options.logDir,
          streak,
          error: detail,
          checkout,
        });
      } catch (escalationError) {
        await deps.appendRunCoreLog(
          options.logDir,
          `Bootstrap escalation failed (continuing): ${
            escalationError instanceof Error
              ? escalationError.message
              : String(escalationError)
          }`,
        );
      }
    }

    return {
      ok: false,
      env,
      stepsRun,
      error: detail,
      defaultBranch: branch,
    };
  }

  // A successful reset ends any failure streak (Issue #4204).
  try {
    await deps.writeBootstrapFailureStreak(options.logDir, 0);
  } catch {
    // Best-effort persistence.
  }

  // 5) Software-update check — periodic, runs within the same process so it
  //    inherits the freshly bootstrapped PATH and VIBE_RUN_ID.
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
