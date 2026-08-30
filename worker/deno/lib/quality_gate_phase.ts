/**
 * Quality gate phase orchestration (Issue #1228).
 *
 * Migrates the business logic from work_on_issue_quality_gate() in
 * issue_worker.sh to Deno TypeScript. Handles:
 * - Docker image detection for the repository
 * - Missing tool detection (when no Docker image configured)
 * - Quality check execution (Docker-based or native with timeout)
 * - Docker infrastructure failure detection
 * - Missing command failure detection (not fixable by Claude)
 * - Quality failure output formatting for Claude retry
 * - Dev server port and subprocess cleanup
 *
 * The shell wrapper remains responsible for:
 * - Calling run_claude_with_retry (Claude CLI invocation)
 * - Git commit of remaining changes
 * - Calling handle_issue_failure for GitHub comments
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { RepoConfig } from "../types.ts";
import {
  asUntrustedUser,
  buildUntrustedCommandEnv,
  canRunAsUntrustedUser,
} from "./untrusted_command_env.ts";
import {
  detectMissingQualityTools,
  formatMissingToolsMessage,
  formatQualityFailureMessage,
} from "./quality_helpers.ts";
import {
  buildDockerRunArgs,
  isSafeDockerImageRef,
} from "./docker_image_ref.ts";
import { fenceQualityOutput } from "./untrusted_quality_output.ts";

/**
 * Whether this container can drop to the untrusted account, resolved once.
 *
 * A probe per quality run would spend two spawns on an answer that cannot
 * change within a container's life. Undefined until first asked.
 */
let untrustedUserAvailable: boolean | undefined;

/** Reset the cached probe. Tests only. */
export function _resetUntrustedUserProbe(): void {
  untrustedUserAvailable = undefined;
}

/**
 * The command to spawn, dropped to the untrusted account where possible.
 *
 * Falls back to running as the worker on an image that predates the `agent`
 * account, so a host mid-upgrade keeps working — degraded, not broken.
 */
async function untrustedSpawn(cmd: readonly string[]): Promise<string[]> {
  if (untrustedUserAvailable === undefined) {
    untrustedUserAvailable = await canRunAsUntrustedUser();
    if (!untrustedUserAvailable) {
      console.error(
        "[SECURITY] cannot run the repository's own commands as a separate " +
          "account — `sudo -n -u agent` is unavailable on this image, so " +
          "they run as the worker and can read its credential files " +
          "(Issue #571)",
      );
    }
  }
  return asUntrustedUser(cmd, { enabled: untrustedUserAvailable });
}

// =============================================================================
// Types
// =============================================================================

/** Result of a single quality gate run. */
export interface QualityGateRunResult {
  /**
   * What happened:
   * - "passed"                — quality checks passed
   * - "skipped"               — quality.sh not found, skip quality check
   * - "failed_missing_tools"  — missing tools, cannot run quality.sh
   * - "failed_fixable"        — quality failed, Claude should attempt a fix
   * - "failed_missing_command" — failed due to missing command, not fixable by Claude
   * - "failed_docker_infra"   — Docker infrastructure issue (Docker not installed, etc.)
   * - "failed"                — final failure (after retry or non-retryable)
   */
  action:
    | "passed"
    | "skipped"
    | "failed_missing_tools"
    | "failed_fixable"
    | "failed_missing_command"
    | "failed_docker_infra"
    | "failed";
  /** Raw quality check output (stdout+stderr). */
  qualityOutput: string;
  /** Truncated output for Claude retry prompt (last 100 lines). */
  retryPrompt?: string;
  /** Formatted failure message for GitHub comment. */
  failureMessage?: string;
  /** Docker image used (if any). */
  dockerImage?: string;
}

/** Dependencies that can be injected for testing. */
export interface QualityGateDeps {
  /** Get repo config value. */
  getRepoConfig: (
    repoConfigs: Record<string, RepoConfig> | undefined,
    repo: string,
    key: keyof RepoConfig,
  ) => string;
  /** Check if a file exists and is executable. */
  fileExists: (path: string) => Promise<boolean>;
  /** Detect missing quality tools from a script. */
  detectMissingTools: (
    qualityScript: string,
  ) => Promise<{ ok: true; value: string[] } | { ok: false; error: Error }>;
  /** Format missing tools message. */
  formatMissingToolsMsg: (tools: string[], script: string) => string;
  /** Run a command and capture output. Returns [exitCode, output]. */
  runCommand: (
    cmd: string[],
    options?: { stdin?: "null" | "inherit"; cwd?: string },
  ) => Promise<{ exitCode: number; output: string }>;
  /** Format quality failure message. */
  formatFailureMsg: (
    output: string,
    baselinePassed?: boolean,
    baselineOutput?: string,
  ) => string;
  /** Clean up dev server ports. */
  cleanupPorts: () => Promise<void>;
  /** Clean up orphaned subprocesses. */
  cleanupSubprocesses: () => Promise<void>;
  /** Get current user ID (for Docker --user flag). */
  getUserId: () => Promise<string>;
  /** Get current group ID (for Docker --user flag). */
  getGroupId: () => Promise<string>;
  /** Get current working directory. */
  getCwd: () => string;
  /** Find timeout command (gtimeout/timeout). */
  findTimeoutCmd: () => Promise<string | null>;
}

/** Parameters for running the quality gate phase. */
export interface QualityGateParams {
  repo: string;
  qualityScript?: string;
  repoConfigs?: Record<string, RepoConfig>;
  baselineQualityPassed?: boolean;
  baselineQualityOutput?: string;
  defaultTimeoutSeconds?: number;
}

// =============================================================================
// Default dependency implementations
// =============================================================================

/** Create default dependencies using real system calls. */
export function createDefaultDeps(): QualityGateDeps {
  return {
    getRepoConfig: (
      repoConfigs: Record<string, RepoConfig> | undefined,
      repo: string,
      key: keyof RepoConfig,
    ): string => {
      if (!repoConfigs) return "";
      const config = repoConfigs[repo];
      if (!config) return "";
      const value = config[key];
      if (value === undefined || value === null) return "";
      return String(value);
    },

    fileExists: async (path: string): Promise<boolean> => {
      try {
        const stat = await Deno.stat(path);
        return stat.isFile;
      } catch {
        return false;
      }
    },

    detectMissingTools: detectMissingQualityTools,
    formatMissingToolsMsg: formatMissingToolsMessage,
    formatFailureMsg: formatQualityFailureMessage,

    runCommand: async (
      cmd: string[],
      options?: { stdin?: "null" | "inherit"; cwd?: string },
    ): Promise<{ exitCode: number; output: string }> => {
      try {
        // Issues #571 and #572: this runs the REPOSITORY's own command — its
        // quality script, its tests, and every dependency install hook those
        // reach. Two things follow, and neither works without the other.
        //
        // The environment is BUILT, not inherited: an allowlist of what a
        // build needs, so no credential is in scope for a postinstall script
        // to echo. And the command runs as a DIFFERENT account where the
        // image provides one, because an environment allowlist cannot stop a
        // process reading a credential file its own uid owns.
        const spawnable = await untrustedSpawn(cmd);
        const proc = new Deno.Command(spawnable[0]!, {
          args: spawnable.slice(1),
          env: buildUntrustedCommandEnv(),
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
          stdin: options?.stdin === "inherit" ? "inherit" : "null",
          cwd: options?.cwd,
        });
        const result = await proc.output();
        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        return { exitCode: result.code, output: stdout + stderr };
      } catch (err) {
        return { exitCode: 1, output: String(err) };
      }
    },

    cleanupPorts: async (): Promise<void> => {
      const ports =
        (Deno.env.get("DEV_SERVER_PORTS") ?? "3000 3001 5173 8080 8081")
          .split(/\s+/);
      for (const port of ports) {
        try {
          const lsof = new Deno.Command("lsof", {
            args: ["-ti:" + port],
            stdout: "piped",
            stderr: "null",
          });
          const result = await lsof.output();
          if (result.success) {
            const pids = new TextDecoder().decode(result.stdout).trim();
            if (pids) {
              const kill = new Deno.Command("kill", {
                args: ["-9", ...pids.split("\n")],
                stdout: "null",
                stderr: "null",
              });
              await kill.output();
            }
          }
        } catch {
          // Port not in use or lsof not available
        }
      }
    },

    cleanupSubprocesses: async (): Promise<void> => {
      const patterns = [
        "react-scripts",
        "webpack-dev-server",
        "vite",
        "next-dev",
      ];
      for (const pattern of patterns) {
        try {
          const pgrep = new Deno.Command("pgrep", {
            args: ["-f", pattern],
            stdout: "piped",
            stderr: "null",
          });
          const result = await pgrep.output();
          if (result.success) {
            const pids = new TextDecoder().decode(result.stdout).trim();
            if (pids) {
              const kill = new Deno.Command("kill", {
                args: ["-9", ...pids.split("\n")],
                stdout: "null",
                stderr: "null",
              });
              await kill.output();
            }
          }
        } catch {
          // pgrep not available or no matching processes
        }
      }
    },

    getUserId: async (): Promise<string> => {
      try {
        const cmd = new Deno.Command("id", {
          args: ["-u"],
          stdout: "piped",
          stderr: "null",
        });
        const result = await cmd.output();
        return new TextDecoder().decode(result.stdout).trim();
      } catch {
        return "1000";
      }
    },

    getGroupId: async (): Promise<string> => {
      try {
        const cmd = new Deno.Command("id", {
          args: ["-g"],
          stdout: "piped",
          stderr: "null",
        });
        const result = await cmd.output();
        return new TextDecoder().decode(result.stdout).trim();
      } catch {
        return "1000";
      }
    },

    getCwd: (): string => Deno.cwd(),

    findTimeoutCmd: async (): Promise<string | null> => {
      const envCmd = Deno.env.get("TIMEOUT_CMD");
      if (envCmd) return envCmd;
      for (const t of ["gtimeout", "timeout"]) {
        try {
          const which = new Deno.Command("which", {
            args: [t],
            stdout: "null",
            stderr: "null",
          });
          const result = await which.output();
          if (result.success) return t;
        } catch {
          // Not found
        }
      }
      return null;
    },
  };
}

// =============================================================================
// Docker quality check execution
// =============================================================================

/**
 * Run quality checks inside a Docker container.
 *
 * Mounts the repo directory as /workspace and runs the quality command
 * with the same user/group as the host to avoid permission issues.
 */
export async function runDockerQualityCheck(
  dockerImage: string,
  qualityCommand: string,
  deps: QualityGateDeps,
): Promise<{ exitCode: number; output: string }> {
  // Verify Docker is available
  const dockerCheck = await deps.runCommand(["docker", "version"]);
  if (dockerCheck.exitCode !== 0) {
    return {
      exitCode: 1,
      output: "docker: Cannot connect to Docker daemon or Docker not installed",
    };
  }

  // Issue #3661 (SEC-76c9c3e5baf5): refuse a `-`-leading or otherwise
  // implausible image reference before it reaches docker's flag parser, and
  // fail loud rather than running the container with an unexpected option set.
  if (!isSafeDockerImageRef(dockerImage)) {
    return {
      exitCode: 1,
      output:
        `docker: refusing to run — configured docker_image is not a valid ` +
        `image reference: ${JSON.stringify(dockerImage)}`,
    };
  }

  const userId = await deps.getUserId();
  const groupId = await deps.getGroupId();
  const repoPath = deps.getCwd();

  return await deps.runCommand(buildDockerRunArgs({
    image: dockerImage,
    userId,
    groupId,
    repoPath,
    command: qualityCommand,
  }));
}

// =============================================================================
// Native quality check execution with timeout
// =============================================================================

/**
 * Run quality checks natively with timeout and cleanup.
 *
 * Cleans up dev server ports before running, uses timeout command
 * (gtimeout/timeout) if available, and cleans up subprocesses after.
 */
export async function runNativeQualityCheck(
  qualityCommand: string,
  timeoutSeconds: number,
  deps: QualityGateDeps,
): Promise<{ exitCode: number; output: string }> {
  // Clean up stale dev server ports before running
  await deps.cleanupPorts();

  const timeoutCmd = await deps.findTimeoutCmd();

  let cmd: string[];
  if (timeoutCmd) {
    cmd = [
      timeoutCmd,
      "--kill-after=10",
      String(timeoutSeconds),
      "bash",
      "-c",
      qualityCommand,
    ];
  } else {
    cmd = ["bash", "-c", qualityCommand];
  }

  const result = await deps.runCommand(cmd, { stdin: "null" });

  // Always clean up subprocesses after quality check
  await deps.cleanupSubprocesses();

  return result;
}

// =============================================================================
// Failure classification
// =============================================================================

/** Check if output indicates a Docker infrastructure issue. */
export function isDockerInfraFailure(output: string): boolean {
  return /docker:.*(not found|Cannot connect|permission denied)/i.test(output);
}

/** Check if output indicates a missing command issue. */
export function isMissingCommandFailure(output: string): boolean {
  return output.includes("command not found");
}

/**
 * Build the second-attempt remediation prompt from failing `quality.sh` output.
 *
 * Issue #3661 (SEC-d5b480003fce): the output is untrusted. `pr_ci_processor`
 * calls this on a checked-out PR branch, so a test name, an assertion message,
 * or a linter diagnostic on that branch is attacker-authored text landing in a
 * Claude prompt. Treat it like every other untrusted block in the codebase —
 * scrub delimiter-shaped patterns, wrap it in this run's randomised boundary
 * markers inside a sized code fence, and say plainly that the contents are
 * data, not instructions. The fencing itself lives in
 * `untrusted_quality_output.ts`, shared with the in-process quality-gate
 * remediation phase, which adds secret redaction to both (Issue #3706).
 *
 * @param qualityOutput - Raw stdout/stderr from the failing quality script.
 * @param maxLines - Keep only the last N lines (defaults to 100).
 * @param boundaryId - Optional fixed boundary id (tests only).
 * @returns The remediation prompt.
 */
export function buildRetryPrompt(
  qualityOutput: string,
  maxLines = 100,
  boundaryId?: string,
): string {
  const lines = qualityOutput.split("\n");
  const truncated = lines.length > maxLines
    ? lines.slice(-maxLines).join("\n")
    : qualityOutput;

  const { block } = fenceQualityOutput(truncated, boundaryId);

  return `The ./quality.sh script is failing. Its output is below.

${block}

Please fix all issues and ensure ./quality.sh passes. Do not comment out or remove existing tests.`;
}

// =============================================================================
// Main orchestrator
// =============================================================================

/**
 * Run one iteration of the quality gate phase.
 *
 * This performs a single quality check run and classifies the result.
 * The shell wrapper is responsible for the retry loop (calling Claude
 * and then re-invoking this function).
 */
export async function runQualityGateCheck(
  params: QualityGateParams,
  deps: QualityGateDeps = createDefaultDeps(),
): Promise<QualityGateRunResult> {
  const qualityScript = params.qualityScript ?? "./quality.sh";
  const defaultTimeout = params.defaultTimeoutSeconds ?? 600;

  // Step 1: Check if quality.sh exists
  const exists = await deps.fileExists(qualityScript);
  if (!exists) {
    return {
      action: "skipped",
      qualityOutput: "",
    };
  }

  // Step 2: Get Docker image configuration
  const dockerImage = deps.getRepoConfig(
    params.repoConfigs,
    params.repo,
    "dockerImage",
  );

  // Step 3: If no Docker image, detect missing tools early
  if (!dockerImage) {
    const toolResult = await deps.detectMissingTools(qualityScript);
    if (toolResult.ok && toolResult.value.length > 0) {
      const message = deps.formatMissingToolsMsg(
        toolResult.value,
        qualityScript,
      );
      return {
        action: "failed_missing_tools",
        qualityOutput: "",
        failureMessage: message,
      };
    }
  }

  // Step 4: Run quality checks
  const { exitCode, qualityOutput, dockerInfraFailure } =
    await executeQualityRun(
      params,
      deps,
      qualityScript,
      dockerImage,
      defaultTimeout,
    );

  if (dockerInfraFailure) {
    return {
      action: "failed_docker_infra",
      qualityOutput,
      dockerImage,
      failureMessage: deps.formatFailureMsg(
        qualityOutput,
        params.baselineQualityPassed,
        params.baselineQualityOutput,
      ),
    };
  }

  // Step 5: Classify first result
  if (exitCode === 0) {
    return {
      action: "passed",
      qualityOutput,
      dockerImage: dockerImage || undefined,
    };
  }

  // Missing commands are not shellcheck-fixable — classify immediately.
  if (isMissingCommandFailure(qualityOutput)) {
    return {
      action: "failed_missing_command",
      qualityOutput,
      dockerImage: dockerImage || undefined,
      failureMessage: deps.formatFailureMsg(
        qualityOutput,
        params.baselineQualityPassed,
        params.baselineQualityOutput,
      ),
    };
  }

  // Fixable failure — Claude can attempt a fix
  return {
    action: "failed_fixable",
    qualityOutput,
    retryPrompt: buildRetryPrompt(qualityOutput),
    dockerImage: dockerImage || undefined,
  };
}

/**
 * Execute a single quality-gate run (Docker or native). Returns the
 * exit code, combined output, and whether the output indicates a
 * Docker infrastructure failure (only meaningful when a Docker image
 * is configured).
 */
async function executeQualityRun(
  params: QualityGateParams,
  deps: QualityGateDeps,
  qualityScript: string,
  dockerImage: string,
  defaultTimeout: number,
): Promise<
  { exitCode: number; qualityOutput: string; dockerInfraFailure: boolean }
> {
  if (dockerImage) {
    const result = await runDockerQualityCheck(
      dockerImage,
      qualityScript,
      deps,
    );
    const infra = result.exitCode !== 0 && isDockerInfraFailure(result.output);
    return {
      exitCode: result.exitCode,
      qualityOutput: result.output,
      dockerInfraFailure: infra,
    };
  }

  const timeoutStr = deps.getRepoConfig(
    params.repoConfigs,
    params.repo,
    "qualityCheckTimeout",
  );
  const timeoutSeconds = timeoutStr && /^\d+$/.test(timeoutStr)
    ? parseInt(timeoutStr, 10)
    : defaultTimeout;

  const result = await runNativeQualityCheck(
    qualityScript,
    timeoutSeconds,
    deps,
  );
  return {
    exitCode: result.exitCode,
    qualityOutput: result.output,
    dockerInfraFailure: false,
  };
}

/**
 * Build the final failure message for the quality gate.
 *
 * Called after all retry attempts have been exhausted.
 */
export function buildFinalFailureMessage(
  qualityOutput: string,
  baselineQualityPassed?: boolean,
  baselineQualityOutput?: string,
  deps: QualityGateDeps = createDefaultDeps(),
): string {
  return deps.formatFailureMsg(
    qualityOutput,
    baselineQualityPassed,
    baselineQualityOutput,
  );
}
