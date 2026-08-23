/**
 * Full worker driver — the Deno replacement for the bash `run_core.sh`
 * conductor (Issue #3504).
 *
 * `container/entrypoint.sh` `exec`s Deno on the `run-entrypoint` command
 * inside the worker container, which calls {@link runWorker} — `run.sh` and
 * `run.ps1` only launch that container. This function sequences the entire
 * every-run runtime path in a single Deno process, with no bash on the runtime
 * path:
 *
 *   PID guard → claim PID → bootstrap prelude → config validation →
 *   GitHub-user resolution → gh-scope publication → startup housekeeping →
 *   memory-pressure watchdog (macOS) → run-core main loop → cleanup.
 *
 * The individual steps were migrated to Deno by the earlier #3484 sub-issues
 * (#3501 bootstrap, #3502 housekeeping + signal cleanup, #1124 main loop). This
 * module is the missing conductor that ties them together, letting
 * `worker/run_core.sh` and its shadow-copy be deleted.
 *
 * Because Deno compiles and loads every module at process start, the running
 * driver is immune to the mid-run `git reset` the bootstrap performs — exactly
 * the property the old `worker/.run_core.sh` shadow-copy provided, now for free.
 *
 * Every side effect flows through {@link RunWorkerDeps} so the orchestration
 * order and fail-loud behaviour can be unit-tested without touching git, the
 * process table, or the network.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import type { WorkerConfig } from "../types.ts";
import { createLogger } from "./logger.ts";
import { validateConfig as validateWorkerConfig } from "./config.ts";
import {
  DEFAULT_MAX_RUN_SECONDS,
  evaluateRunGuard as defaultEvaluateRunGuard,
  formatPidFileContent,
  readBootId,
  type RunGuardResult,
} from "./run_entrypoint.ts";
import {
  appendRunCoreLogLine,
  type BootstrapOptions,
  type BootstrapResult,
  runBootstrap,
} from "./run_bootstrap.ts";
import {
  type HousekeepingOptions,
  runSignalCleanup,
  runStartupHousekeeping,
} from "./run_housekeeping.ts";
import {
  skipSoftwareUpdateFromEnv,
  softwareUpdateOptionsFromEnv,
} from "./software_updates.ts";
import {
  applyProviderCredentialEnv,
  checkCredentialPreflight,
  credentialPreflightMessage,
} from "./credential_preflight.ts";
import { getGithubUser } from "./claude_runner.ts";
import { formatRunModeRecord, resolveRunHostId } from "./run_mode_record.ts";
import { assertWorkerIdentity } from "./identity_guard.ts";
import { getGhTokenScopes } from "./gh_auth.ts";
import { runCoreCommand } from "../commands/run_core.ts";
import { applyOptionalFeatureEnv } from "./optional_feature_env.ts";
import {
  QUOTA_PAUSE_EXIT_STATUS,
  type QuotaPauseMarker,
  writeQuotaPauseMarker,
} from "./quota_pause.ts";

/** Distinct outcomes of a worker driver invocation. */
export type RunWorkerOutcome =
  | "blocked"
  | "bootstrap-failed"
  | "config-invalid"
  | "credentials-invalid"
  | "github-user-failed"
  | "identity-mismatch"
  | "completed"
  | "quota-paused"
  | "failed";

/** Result of {@link runWorker}. Carries the process exit code to surface. */
export interface RunWorkerResult {
  /** What happened. */
  outcome: RunWorkerOutcome;
  /** Process exit code the launcher should surface. */
  exitCode: number;
  /** Human-readable reason. */
  reason: string;
}

/** Options controlling a worker driver invocation. */
export interface RunWorkerOptions {
  /** Repository root (the `--base-dir` passed by `run.sh`). */
  baseDir: string;
  /** Fully-loaded worker configuration. */
  config: WorkerConfig;
  /** Maximum run duration before a stale prior instance is terminated. */
  maxRunSeconds?: number;
  /** Overrides {@link Deno.pid} (tests inject a fixed PID). */
  pid?: number;
  /** Reads an environment variable (tests inject a fixed map). */
  env?: (name: string) => string | undefined;
}

/**
 * Injectable side effects for {@link runWorker}. Every seam defaults to a real
 * implementation via {@link createDefaultRunWorkerDeps}; tests override only
 * the seams they assert on.
 */
export interface RunWorkerDeps {
  /** Evaluate the PID guard (proceed / blocked). */
  evaluateRunGuard(
    pidFile: string,
    maxRunSeconds: number,
  ): Promise<RunGuardResult>;
  /** Claim the PID file for this process. */
  claimPidFile(pidFile: string, pid: number): Promise<void>;
  /** Run the bootstrap prelude (PATH, run-id, logging, git reset, updates). */
  bootstrap(options: BootstrapOptions): Promise<BootstrapResult>;
  /** Validate the worker configuration (throws on invalid config). */
  validateConfig(config: WorkerConfig): void;
  /**
   * Credential preflight (Issue #4064). Returns null when the worker's
   * GitHub and provider credentials are present and usable, or an actionable
   * failure message when they are not.
   */
  checkCredentials(): Promise<string | null>;
  /** Resolve the authenticated GitHub user, or null on failure. */
  resolveGithubUser(): Promise<string | null>;
  /**
   * Fail-loud identity guard (Issue #3528). Returns null when the resolved
   * login is an allowed service account (or the allowlist is inactive);
   * returns a reason string when it is a mismatch, so the caller aborts.
   */
  assertIdentity(githubUser: string, config: WorkerConfig): string | null;
  /** Publish the active gh token's OAuth scopes (best-effort). */
  logGhScopes(): Promise<void>;
  /** Run the one-time startup housekeeping sequence (best-effort). */
  runHousekeeping(
    options: HousekeepingOptions,
    config: WorkerConfig,
  ): Promise<void>;
  /** Start the macOS memory-pressure watchdog, or null when not applicable. */
  /** Run the run-core main event loop. */
  runMainLoop(
    input: {
      repoDir: string;
      workDir: string;
      githubUser: string;
      config: WorkerConfig;
    },
  ): Promise<{
    success: boolean;
    message: string;
    /** The loop stopped because the host is out of quota (Issue #342). */
    quotaPaused?: boolean;
    /** When that quota window reopens, in epoch milliseconds, when known. */
    quotaResetEpochMs?: number;
  }>;
  /**
   * Declare a quota pause to the host supervisor (Issue #342) by writing the
   * marker into the host-visible log directory. Best-effort: a marker that
   * cannot be written is reported loudly, and the exit status still carries
   * the declaration.
   */
  declareQuotaPause(logDir: string, marker: QuotaPauseMarker): Promise<void>;
  /**
   * Remove the PID file and terminate descendant processes (exit cleanup).
   * `liveSlots` is the configured concurrent-slot count (Issue #4182): the
   * descendant-termination wait scales with it, so a pool's abandoned
   * agent subprocesses each get the single-slot grace rather than sharing
   * one flat 5 seconds.
   */
  cleanup(pidFile: string, pid: number, liveSlots?: number): Promise<void>;
  /** Establish an environment variable in-process. */
  setEnv(name: string, value: string): void;
  /**
   * Apply the optional-feature settings in `.config.json` to the process
   * environment (Issue #535 keys). Optional so older dependency sets keep
   * working; the production set always has it.
   */
  applyOptionalFeatureEnv?(configPath: string): Promise<unknown>;
  /** Log an informational line. */
  log(message: string): void;
  /** Log an error line. */
  logError(message: string): void;
  /**
   * Record this launch's run mode durably (Issue #4189): one line in
   * `run_core.log` the green-gate report counts launches by. Optional so
   * older dependency sets keep working; the production set always has it.
   */
  recordRunMode?(record: {
    logDir: string;
    mode: string;
    host: string;
    runId: string;
  }): Promise<void>;
}

/** Build the production dependency set for {@link runWorker}. */
export function createDefaultRunWorkerDeps(): RunWorkerDeps {
  const logger = createLogger({ debug: Deno.env.get("DEBUG") === "true" });
  return {
    evaluateRunGuard: (pidFile, maxRunSeconds) =>
      defaultEvaluateRunGuard(pidFile, maxRunSeconds),
    claimPidFile: async (pidFile, pid) => {
      // Boot id beside the PID: inside a container the worker is always
      // PID 1, so the guard needs the boot to tell a live claim from a
      // stale file left by a dead VM (see evaluateRunGuard).
      await Deno.writeTextFile(
        pidFile,
        formatPidFileContent(pid, await readBootId()),
      );
    },
    bootstrap: (options) => runBootstrap(options),
    recordRunMode: ({ logDir, mode, host, runId }) =>
      appendRunCoreLogLine(logDir, formatRunModeRecord({ mode, host, runId })),
    validateConfig: (config) => validateWorkerConfig(config),
    checkCredentials: async () => {
      const result = await checkCredentialPreflight();
      const message = credentialPreflightMessage(result);
      if (result.ok) {
        logger.info(`[SECURITY] ${message}`);
        // The runtime half of Issue #4064: the preflight proved the material
        // exists; exporting it is what lets the agent spawns (health check
        // included) authenticate — child envs are built from this process's
        // env. Names only in the log, never values.
        const exported = await applyProviderCredentialEnv();
        if (exported.length > 0) {
          logger.info(
            `[SECURITY] provider credentials exported to the run ` +
              `environment: ${exported.join(", ")}`,
          );
        }
        return null;
      }
      return message;
    },
    resolveGithubUser: async () => {
      const result = await getGithubUser();
      return result.ok && result.value ? result.value : null;
    },
    assertIdentity: (githubUser, config) => {
      try {
        assertWorkerIdentity(githubUser, config.serviceAccounts ?? [], {
          log: (message) => logger.info(message),
          logError: (message) => logger.error(message),
        });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    logGhScopes: async () => {
      try {
        const result = await getGhTokenScopes();
        if (!result.ok) {
          logger.info(
            `[SECURITY] gh token scope detection failed: ${result.error.message}`,
          );
          return;
        }
        const { scopes, hasWorkflowScope, hasRepoScope, isAppAuth } =
          result.value;
        const summary = isAppAuth
          ? "scopes=<github-app> (OAuth scopes not applicable)"
          : `scopes=${scopes.join(",") || "<none>"} workflow=${
            hasWorkflowScope ? "yes" : "NO"
          } repo=${hasRepoScope ? "yes" : "NO"}`;
        // Issue #2382 (Rule of Two): tag with [SECURITY] so the worker's true
        // capability footprint is greppable in every run log.
        logger.info(`[SECURITY] gh token: ${summary}`);
        Deno.env.set("GH_TOKEN_SCOPE_SUMMARY", summary);
        if (!isAppAuth) {
          Deno.env.set(
            "GH_TOKEN_HAS_WORKFLOW_SCOPE",
            hasWorkflowScope ? "true" : "false",
          );
          if (!hasWorkflowScope) {
            logger.info(
              "WARNING: gh token lacks 'workflow' scope — pushes touching " +
                ".github/workflows/ will be rejected",
            );
          }
        }
      } catch (err) {
        logger.info(
          `[SECURITY] gh token scope detection threw (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    runHousekeeping: async (options, config) => {
      await runStartupHousekeeping(options, config);
    },
    runMainLoop: async ({ repoDir, workDir, githubUser, config }) => {
      const result = await runCoreCommand.execute({
        operation: "run",
        "repo-dir": repoDir,
        "work-dir": workDir,
        "github-user": githubUser,
      }, config);
      const data = result.data as
        | { quotaPaused?: boolean; quotaResetEpochMs?: number }
        | undefined;
      return {
        success: result.success,
        message: result.message,
        quotaPaused: data?.quotaPaused === true,
        quotaResetEpochMs: data?.quotaResetEpochMs,
      };
    },
    declareQuotaPause: async (dir, marker) => {
      const written = await writeQuotaPauseMarker(dir, marker);
      if (!written.ok) {
        // Loud, never silent: without the marker a runtime that loses the
        // container's exit status leaves the supervisor reading this pause
        // as a crash — the exact misclassification Issue #342 is about.
        logger.error(`[run-worker] ${written.error.message}`);
      }
    },
    cleanup: async (pidFile, pid, liveSlots) => {
      await runSignalCleanup({
        selfPid: pid,
        pidFile,
        maxWaitSeconds: cleanupWaitSeconds(liveSlots),
      });
    },
    setEnv: (name, value) => {
      try {
        Deno.env.set(name, value);
      } catch {
        // Best-effort — a permission denial must not abort the run.
      }
    },
    applyOptionalFeatureEnv: (configPath) =>
      applyOptionalFeatureEnv(configPath, (name, value) => {
        try {
          Deno.env.set(name, value);
        } catch {
          // Best-effort — a permission denial must not abort the run.
        }
      }),
    log: (message) => logger.info(message),
    logError: (message) => logger.error(message),
  };
}

/** Single-slot descendant-termination wait, seconds (today's flat value). */
export const CLEANUP_WAIT_SECONDS_PER_SLOT = 5;

/**
 * Descendant-termination wait for the exit cleanup (Issue #4182): the
 * single-slot 5 s multiplied by the live slot count, so N abandoned agent
 * subprocesses are each given the same grace one used to get. Capped so a
 * misconfigured slot count cannot stall the exit for minutes.
 */
export function cleanupWaitSeconds(liveSlots: number | undefined): number {
  const slots = Math.max(1, Math.floor(liveSlots ?? 1));
  return Math.min(60, CLEANUP_WAIT_SECONDS_PER_SLOT * slots);
}

/**
 * Drive one full worker run in a single Deno process.
 *
 * Fail-loud (Issue #3234): a bootstrap failure, invalid configuration, or an
 * unresolvable GitHub user aborts with a non-zero exit code rather than running
 * on stale code or degraded state. A blocked PID guard is a normal, expected
 * outcome (another instance is active) and exits cleanly (0) without claiming
 * the PID file or running any further step.
 *
 * @param options - Driver inputs (base dir, config, optional PID/env seams).
 * @param depsOverride - Partial dependency overrides (production defaults fill
 *   the rest).
 * @returns The outcome plus the process exit code to surface.
 */
export async function runWorker(
  options: RunWorkerOptions,
  depsOverride: Partial<RunWorkerDeps> = {},
): Promise<RunWorkerResult> {
  const deps: RunWorkerDeps = {
    ...createDefaultRunWorkerDeps(),
    ...depsOverride,
  };

  const pid = options.pid ?? Deno.pid;
  const maxRunSeconds = options.maxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;
  const repoDir = options.baseDir;
  const pidFile = `${repoDir}/.run.pid`;
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const home = env("HOME") ?? env("USERPROFILE") ?? "";
  const logDir = `${home}/logs`;
  const workDir = env("WORK_DIR") ?? `${home}/auto-issue-work`;
  const tmpDir = env("TMPDIR") ?? "/tmp";

  // Step 1: PID guard. A blocked guard means another instance is active — exit
  // cleanly without claiming the PID file or doing any work.
  //
  // ONE PID file per checkout stays correct with concurrent issue slots
  // (Issue #4182, part of #4168): the slot pool lives INSIDE this single
  // process, so exactly one driver holds the file however many slots it
  // runs. Do not "fix" this into N PID files — the guard bounds drivers,
  // not work items, and `maxRunSeconds` bounds the whole pool because the
  // pool drains every slot before the driver returns.
  const guard = await deps.evaluateRunGuard(pidFile, maxRunSeconds);
  if (guard.action === "blocked") {
    deps.log(`[run-worker] blocked: ${guard.reason}`);
    return { outcome: "blocked", exitCode: 0, reason: guard.reason };
  }
  deps.log(`[run-worker] proceeding: ${guard.reason}`);

  // Step 2: Claim the PID file for this Deno process.
  await deps.claimPidFile(pidFile, pid);

  // Baseline environment the bash conductor established at the top of
  // run_core.sh (colourless output, no interactive git prompts, absolute
  // config path so Deno commands find .config.json from any working directory).
  deps.setEnv("NO_COLOR", "true");
  deps.setEnv("GIT_TERMINAL_PROMPT", "0");
  // Export the resolved work dir (Issue #4370) so every `workerCacheDir()`
  // consumer — the per-run MCP config, the caches — agrees with this run's
  // work dir instead of relying on the `$HOME/auto-issue-work` default.
  deps.setEnv("WORK_DIR", workDir);
  if (!env("CONFIG_PATH")) {
    deps.setEnv("CONFIG_PATH", `${repoDir}/.config.json`);
  }
  // Optional-feature settings from .config.json (imgbb key, FLEET health
  // repository/directory, GitHub status) become the environment variables
  // their consumers read — the step the bash conductor's `eval
  // "$(load-config)"` used to be. Environment wins; a host-only path is
  // not applied inside the container.
  await deps.applyOptionalFeatureEnv?.(
    env("CONFIG_PATH") ?? `${repoDir}/.config.json`,
  );

  try {
    // Step 3: Bootstrap prelude — PATH, run-id, logging, git reset, updates.
    // Fail-loud: a failed git reset must not run the worker on stale code.
    // Issue #3655: the software-update options and the whole-step opt-out must
    // be forwarded here. Omitting them meant the documented SKIP_CLAUDE_UPDATE
    // / SKIP_GH_UPDATE / SKIP_DENO_UPDATE / SKIP_SOFTWARE_UPDATE variables were
    // never consulted on this — the primary — path.
    const bootstrap = await deps.bootstrap({
      repoDir,
      logDir,
      home,
      currentPath: env("PATH") ?? "",
      fallbackPaths: env("VIBE_FALLBACK_PATHS"),
      // Resolved from the checkout's own origin/HEAD — no assumed name.
      pid,
      skipSoftwareUpdate: skipSoftwareUpdateFromEnv(env),
      softwareUpdate: softwareUpdateOptionsFromEnv(options.config, env),
    });
    if (!bootstrap.ok) {
      deps.logError(
        `[run-worker] bootstrap failed: ${bootstrap.error ?? "unknown error"}`,
      );
      return {
        outcome: "bootstrap-failed",
        exitCode: 1,
        reason: bootstrap.error ?? "bootstrap failed",
      };
    }

    // Step 4: Validate configuration — fail-loud on misconfiguration.
    try {
      deps.validateConfig(options.config);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.logError(`[run-worker] configuration invalid: ${reason}`);
      return { outcome: "config-invalid", exitCode: 1, reason };
    }

    // Where this run is executing (Issue #4146). Container is the default and
    // native is an explicit opt-in, so logging the resolved mode is what tells
    // a host that asked for native apart from one that launched contained
    // anyway.
    deps.log(`[run-worker] run mode: ${options.config.runMode}`);
    // ...and durably, for the green-gate evidence report (Issue #4189): the
    // stderr line above does not survive the run, `run_core.log` does.
    if (deps.recordRunMode) {
      await deps.recordRunMode({
        logDir,
        mode: options.config.runMode,
        host: resolveRunHostId(env),
        runId: bootstrap.env.VIBE_RUN_ID,
      });
    }

    // Which agent vendors this run carries credentials for (Issue #4108) —
    // logged before the preflight so a credential failure is read against the
    // set that was actually enabled.
    deps.log(
      `[run-worker] coding-agent providers: active=${options.config.agentProvider}, ` +
        `enabled=${options.config.enabledAgentProviders.join(", ")}`,
    );

    // Step 4.5: Credential preflight (Issue #4064). Unattended operation
    // forbids an interactive login mid-run, so absent or unusable credential
    // material must abort here — with a message the worker can escalate to
    // GitHub — rather than degrading into an auth error hours into the run.
    const credentialFailure = await deps.checkCredentials();
    if (credentialFailure) {
      deps.logError(`[run-worker] credential preflight failed:
${credentialFailure}`);
      return {
        outcome: "credentials-invalid",
        exitCode: 1,
        reason: credentialFailure,
      };
    }

    // Step 5: Resolve the authenticated GitHub user (required by the loop).
    const githubUser = await deps.resolveGithubUser();
    if (!githubUser) {
      deps.logError("[run-worker] could not resolve authenticated GitHub user");
      return {
        outcome: "github-user-failed",
        exitCode: 1,
        reason: "Could not resolve authenticated GitHub user",
      };
    }
    deps.log(`[run-worker] authenticated as ${githubUser}`);

    // Step 5.5: Identity guard — fail loud if the resolved login is not an
    // allowed service account (Issue #3528). Prevents a host whose `gh` auth
    // has drifted to a human personal token from operating with that human's
    // elevated permissions.
    const identityReason = deps.assertIdentity(githubUser, options.config);
    if (identityReason) {
      deps.logError(
        `[run-worker] identity guard rejected startup: ${identityReason}`,
      );
      return {
        outcome: "identity-mismatch",
        exitCode: 1,
        reason: identityReason,
      };
    }

    // Step 6: Publish gh token scopes (best-effort, security visibility).
    await deps.logGhScopes();

    // Step 7: One-time startup housekeeping (best-effort — never aborts).
    await deps.runHousekeeping(
      {
        workDir,
        logDir,
        tmpDir,
        defaultBranch: bootstrap.defaultBranch,
        githubUser,
      },
      options.config,
    );

    // Step 8: Run the main event loop.
    const loop = await deps.runMainLoop({
      repoDir,
      workDir,
      githubUser,
      config: options.config,
    });
    // Issue #342: an out-of-quota run ends on purpose. It says so twice — in
    // a marker under the host-visible log directory, and in an exit status no
    // crash produces — so the supervisor re-probes at its fixed cadence
    // instead of backing off, escalating and rebuilding a healthy container.
    if (loop.quotaPaused) {
      await deps.declareQuotaPause(logDir, {
        declaredAtMs: Date.now(),
        ...(loop.quotaResetEpochMs !== undefined
          ? { resetEpochMs: loop.quotaResetEpochMs }
          : {}),
        reason: loop.message,
      });
      return {
        outcome: "quota-paused",
        exitCode: QUOTA_PAUSE_EXIT_STATUS,
        reason: loop.message,
      };
    }

    return {
      outcome: loop.success ? "completed" : "failed",
      exitCode: loop.success ? 0 : 1,
      reason: loop.message,
    };
  } finally {
    // Exit cleanup — the bash `cleanup_on_exit` trap replacement. Removes the
    // PID file and tears down orphan-prone descendants (`claude`, `deno test`).
    // The wait scales with the configured slot count (Issue #4182).
    await deps.cleanup(
      pidFile,
      pid,
      Math.max(1, options.config.maxConcurrentIssues ?? 1),
    );
  }
}
