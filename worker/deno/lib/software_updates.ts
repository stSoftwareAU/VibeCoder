/**
 * Software update checking for Claude CLI, GH CLI, and Deno (Issue #294, #373, #906, #1496).
 *
 * Checks for software updates periodically (default: weekly). Uses a timestamp
 * file to track the last check time. Individual update commands retry on
 * transient failures with exponential backoff (Issue #1496). Permanent failures
 * (auth, missing binary, unsupported platform) are not retried. Final failures
 * are logged as warnings but do not propagate — the worker continues regardless.
 *
 * Every upgrade is additionally gated on a **release-age quarantine** (Issue
 * #3655): the candidate release must have been published at least
 * `VIBE_BUMP_QUARANTINE_HOURS` (default 24h) ago, matching the embargo this
 * repository already applies to every other external ecosystem. `gh` extensions
 * are enumerated and gated individually rather than upgraded wholesale, and the
 * Deno upgrade is pinned to the resolved version so the artefact installed is
 * the one that was age-checked. Each `gh` extension is likewise installed at
 * the exact ref its verdict dated (Issue #3952) — a release tag for a binary
 * extension, the default branch's HEAD sha for a script one. See
 * `tool_release_age.ts`.
 *
 * A caller may instead ask for one **exact version** through
 * `targetVersion` (Issue #623). That path installs the published artefact for
 * that version — the npm tarball for the Claude CLI, the `cli/cli` release
 * archive for `gh`, `deno upgrade <version>` for Deno — leaves a tool already
 * at that version alone, and throws when the version afterwards does not match.
 * The age gate stays exactly as it was for the unpinned "latest" path, which is
 * still what a caller gets when `targetVersion` is absent.
 *
 * `checkSoftwareUpdates` picks between the two from `update_mode` (Issue #625):
 * `dynamic` — the default — behaves exactly as it always has, while `frozen`
 * installs the exact `pinned_tool_versions` for all three tools on every
 * launch, ahead of the interval and floor gates.
 */

import type {
  Logger,
  PinnedToolVersions,
  Result,
  UpdateMode,
} from "../types.ts";
import {
  CLAUDE_CLI_NPM_PACKAGE,
  createReleaseAgeGate,
  DENO_RELEASE_REPO,
  GH_CLI_RELEASE_REPO,
  NPM_REGISTRY_BASE,
  parseGhExtensionList,
  type ReleaseAgeGate,
  type ReleaseAgeVerdict,
  type ReleaseChannel,
} from "./tool_release_age.ts";

/** Default update check interval: 7 days in seconds. */
export const DEFAULT_UPDATE_INTERVAL_SECONDS = 604800;

/** Default timeout for each update command in seconds. */
export const DEFAULT_UPDATE_TIMEOUT_SECONDS = 120;

/** Default maximum retry attempts for a single update command (Issue #1496). */
export const DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS = 3;

/**
 * Default exponential backoff delays in seconds between retries (Issue #1496).
 *
 * Entry `i` is the delay to wait AFTER attempt `i+1` failed (before attempt
 * `i+2`). The last entry is reused if there are more retries than entries.
 */
export const DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS: readonly number[] = [
  30,
  90,
  300,
];

/** Classification of an update command failure (Issue #1496). */
export type UpdateErrorClass = "transient" | "permanent";

/** Options for software update checking. */
export interface SoftwareUpdateOptions {
  /** Directory for the timestamp file (default: HOME). */
  timestampDir?: string;
  /** Update check interval in seconds (default: 604800 = 7 days). */
  intervalSeconds?: number;
  /** Skip Claude CLI update. */
  skipClaude?: boolean;
  /** Skip GH CLI update. */
  skipGh?: boolean;
  /** Skip Deno update. */
  skipDeno?: boolean;
  /** Timeout per update command in seconds (default: 120). */
  timeout?: number;
  /** Injectable time source for testing (returns Unix seconds). */
  now?: () => number;
  /** Retry configuration passed through to each tool update (Issue #1496). */
  retry?: UpdateRetryOptions;
  /**
   * Per-tool minimum version floors (Issue #2622). When the installed version
   * of a tool is below its floor, the update runs immediately, bypassing the
   * interval timestamp gate. Empty when the caller passes nothing; the worker
   * passes `OPERATIONAL_DEFAULTS.softwareMinVersions`, which is the map's
   * single source of truth (`{ claude: "2.1.260" }` today).
   */
  minVersions?: Record<string, string>;
  /**
   * Injectable installed-version reader for testing (Issue #2622). Given a
   * tool name it returns the raw `--version` output (e.g. "2.1.170 (Claude
   * Code)") or null when the version could not be read. Defaults to spawning
   * the tool's `--version` command.
   */
  readVersion?: (tool: string) => Promise<string | null>;
  /**
   * Release-age quarantine window in hours (Issue #3655). Defaults to 24 and
   * mirrors `VIBE_BUMP_QUARANTINE_HOURS`; a non-positive or unparseable value
   * falls back to the default rather than disabling the embargo.
   */
  quarantineHours?: number;
  /**
   * Injectable release-age gate (Issue #3655). Defaults to the real upstream
   * gate (`gh api` for GitHub releases, the npm registry for the Claude CLI).
   */
  ageGate?: ReleaseAgeGate;
  /** Injectable environment lookup (tests inject a fixed map). */
  env?: (name: string) => string | undefined;
  /**
   * How this host tracks releases (Issue #625, `.config.json` `update_mode`).
   * Absent or `"dynamic"` leaves every path exactly as it was; `"frozen"`
   * installs {@link pinnedToolVersions} instead of checking for updates.
   */
  updateMode?: UpdateMode;
  /**
   * Exact versions a `frozen` host installs (Issue #625, `.config.json`
   * `pinned_tool_versions`). Ignored in `dynamic` mode, so a host that flipped
   * back keeps its stale pins without acting on them.
   */
  pinnedToolVersions?: PinnedToolVersions;
}

/**
 * Result of executing an update command (possibly across multiple retries).
 * Issue #1496.
 */
export interface RunUpdateResult {
  /** Whether the update ultimately succeeded. */
  success: boolean;
  /** Number of attempts actually made. */
  attempts: number;
  /** Final exit code observed. */
  finalExitCode: number;
  /** Final combined stdout/stderr output observed. */
  finalOutput: string;
  /** Classification of the final failure (only set on failure). */
  classification?: UpdateErrorClass;
}

/** Retry configuration for a single update command (Issue #1496). */
export interface UpdateRetryOptions {
  /** Maximum number of attempts including the initial one (default: 3). */
  maxAttempts?: number;
  /** Exponential backoff delays between retries (default: [30, 90, 300]). */
  backoffSeconds?: readonly number[];
  /** Timeout per attempt in seconds (default: 120). */
  timeout?: number;
  /** Injectable sleep function (defaults to real setTimeout). */
  sleepFn?: (seconds: number) => Promise<void>;
  /**
   * Injectable command runner for tests. Defaults to `runWithTimeout`,
   * which spawns the real command.
   */
  runFn?: (
    cmd: string[],
    timeoutSeconds: number,
  ) => Promise<Result<{ exitCode: number; output: string }>>;
}

/**
 * Check if enough time has elapsed since the last update check.
 *
 * Reads the timestamp file to determine when the last update check occurred.
 * Returns true if the interval has elapsed, the file is missing, or contains
 * invalid content.
 */
export function shouldCheckForUpdates(
  timestampDir: string,
  intervalSeconds: number = DEFAULT_UPDATE_INTERVAL_SECONDS,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): boolean {
  const tsFile = `${timestampDir}/.last_software_update_check`;

  let content: string;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch {
    return true; // No file means never checked
  }

  if (!content || !/^\d+$/.test(content)) {
    return true; // Invalid content means we should check
  }

  const lastCheck = parseInt(content, 10);
  const now = nowFn();
  const elapsed = now - lastCheck;

  return elapsed >= intervalSeconds;
}

/**
 * Record the current time as the last update check timestamp.
 */
export function recordUpdateCheck(
  timestampDir: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<void> {
  const tsFile = `${timestampDir}/.last_software_update_check`;

  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Record the last successful update timestamp for a given tool (Issue #1496).
 *
 * Each tool (claude, gh, deno) gets its own small state file so self-heal
 * retries for one tool do not clobber the timestamp of another.
 */
export function recordSuccessfulUpdate(
  timestampDir: string,
  tool: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<void> {
  const tsFile = `${timestampDir}/.last_successful_update_${tool}`;
  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Read the last successful update timestamp for a given tool (Issue #1496).
 *
 * Returns null if the file is missing or contains invalid content.
 */
export function getLastSuccessfulUpdate(
  timestampDir: string,
  tool: string,
): number | null {
  const tsFile = `${timestampDir}/.last_successful_update_${tool}`;
  let content: string;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(content)) return null;
  return parseInt(content, 10);
}

/**
 * Classify an update command failure as transient or permanent (Issue #1496).
 *
 * Permanent failures (auth, missing binary, unsupported platform) should not
 * be retried — the same error will recur. Transient failures (network
 * timeouts, rate limits, 5xx) are retried with backoff.
 *
 * Defaults unknown failures to "transient" so flaky non-determinate errors
 * benefit from self-healing rather than skipping an entire update cycle.
 */
export function classifyUpdateError(
  exitCode: number,
  output: string,
): UpdateErrorClass {
  // Exit code 127 is the conventional "command not found" — permanent.
  if (exitCode === 127) return "permanent";

  const lower = output.toLowerCase();

  // Missing binary — permanent.
  if (
    lower.includes("command not found") ||
    lower.includes("no such file or directory") ||
    /: not found$/m.test(lower)
  ) {
    return "permanent";
  }

  // Authentication / authorisation — permanent.
  if (
    lower.includes("authentication") ||
    lower.includes("unauthorised") ||
    lower.includes("unauthorized") ||
    lower.includes("permission denied") ||
    lower.includes("not logged in") ||
    lower.includes("access denied") ||
    lower.includes("forbidden") ||
    lower.includes("invalid credentials") ||
    lower.includes("401 ") ||
    lower.includes("403 ")
  ) {
    return "permanent";
  }

  // Unsupported platform / architecture — permanent.
  if (
    lower.includes("unsupported platform") ||
    lower.includes("platform is not supported") ||
    lower.includes("architecture not supported") ||
    lower.includes("unsupported architecture") ||
    lower.includes("not supported on this")
  ) {
    return "permanent";
  }

  // Timeout exit codes used by runWithTimeout / GNU timeout — transient.
  if (exitCode === 124 || exitCode === 137) return "transient";

  // Network, timeout, rate limit, and 5xx failures — transient.
  if (
    /timed?\s*out/.test(lower) ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("connection refused") ||
    lower.includes("connection reset") ||
    lower.includes("could not resolve") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    /http 5\d{2}/.test(lower) ||
    lower.includes("tls handshake") ||
    lower.includes("ssl_error")
  ) {
    return "transient";
  }

  // Default: treat unknown failures as transient so we self-heal.
  return "transient";
}

/**
 * Run a command with a timeout and return the result.
 *
 * Uses the repo's canonical `AbortController` + `clearTimeout` timeout pattern
 * (as in `git_timeout.ts`) so the timeout timer is always cleared once the race
 * resolves — on the success path as well as the timeout path. Leaving a live
 * timer queued on the fast success path would keep the event loop non-idle and
 * delay process exit for up to `timeoutSeconds` (Issue #3167).
 *
 * Exported for direct unit testing; not part of the module's public API.
 */
export async function runWithTimeout(
  cmd: string[],
  timeoutSeconds: number,
): Promise<Result<{ exitCode: number; output: string }>> {
  const timeoutMs = timeoutSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const result = await command.output();

    // The abort signal terminates the child rather than throwing, so detect
    // the timeout by inspecting the controller after `output()` resolves.
    if (controller.signal.aborted) {
      return {
        ok: true,
        value: { exitCode: 124, output: `Timed out after ${timeoutSeconds}s` },
      };
    }

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    return {
      ok: true,
      value: { exitCode: result.code, output: `${stdout}\n${stderr}`.trim() },
    };
  } catch (err) {
    // Some runtimes surface the abort as an AbortError instead.
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        ok: true,
        value: { exitCode: 124, output: `Timed out after ${timeoutSeconds}s` },
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Default sleep helper: wait `seconds` real seconds. */
function defaultSleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Run an update command with retry and exponential backoff on transient
 * failures (Issue #1496).
 *
 * Classifies each failure using {@link classifyUpdateError}. Permanent
 * failures return immediately without retry. Transient failures are retried
 * up to `maxAttempts` times with delays taken from `backoffSeconds`. All
 * attempts ultimately failing returns `{ success: false }` — the caller is
 * expected to log a warning rather than throw.
 */
export async function runUpdateWithRetry(
  logger: Logger,
  toolName: string,
  cmd: string[],
  options: UpdateRetryOptions = {},
): Promise<RunUpdateResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS;
  const backoff = options.backoffSeconds ??
    DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS;
  const timeout = options.timeout ?? DEFAULT_UPDATE_TIMEOUT_SECONDS;
  const sleepFn = options.sleepFn ?? defaultSleepSeconds;
  const runFn = options.runFn ?? runWithTimeout;

  let lastExit = 0;
  let lastOutput = "";
  let lastClass: UpdateErrorClass | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const runResult = await runFn(cmd, timeout);

    if (runResult.ok) {
      lastExit = runResult.value.exitCode;
      lastOutput = runResult.value.output;
      if (lastExit === 0) {
        if (attempt > 1) {
          logger.info(
            `${toolName} update succeeded on attempt ${attempt}/${maxAttempts}`,
          );
        }
        return {
          success: true,
          attempts: attempt,
          finalExitCode: 0,
          finalOutput: lastOutput,
        };
      }
      lastClass = classifyUpdateError(lastExit, lastOutput);
    } else {
      // Spawn error — classify as transient so we retry.
      lastExit = -1;
      lastOutput = runResult.error.message;
      lastClass = "transient";
    }

    if (lastClass === "permanent") {
      logger.warn(
        `${toolName} update failed permanently (exit ${lastExit}) — not retrying: ${
          lastOutput || "no output"
        }`,
      );
      return {
        success: false,
        attempts: attempt,
        finalExitCode: lastExit,
        finalOutput: lastOutput,
        classification: "permanent",
      };
    }

    if (attempt < maxAttempts) {
      const delay = backoff[attempt - 1] ??
        backoff[backoff.length - 1] ?? 30;
      logger.info(
        `${toolName} update attempt ${attempt}/${maxAttempts} failed (transient, exit ${lastExit}) — retrying in ${delay}s`,
      );
      await sleepFn(delay);
    }
  }

  logger.warn(
    `${toolName} update failed after ${maxAttempts} attempt${
      maxAttempts === 1 ? "" : "s"
    } (exit ${lastExit}) — continuing anyway`,
  );
  if (lastOutput) logger.info(`${toolName} final output: ${lastOutput}`);
  return {
    success: false,
    attempts: maxAttempts,
    finalExitCode: lastExit,
    finalOutput: lastOutput,
    classification: lastClass,
  };
}

/** Shared per-tool update options. */
export interface ToolUpdateOptions {
  /** Skip the update entirely. */
  skip?: boolean;
  /**
   * Install this exact version instead of "whatever is latest" (Issue #623).
   *
   * When absent, every updater behaves exactly as it did before: the
   * release-age gate resolves the candidate and the tool's own upgrade command
   * runs. When present, the gate is bypassed — a pinned version is an explicit
   * choice, and the gate exists to control unpinned "latest" installs — the
   * exact version is installed, and a mismatch afterwards throws.
   */
  targetVersion?: string;
  /** Timeout per attempt in seconds (default: 120). */
  timeout?: number;
  /** Retry configuration (default: 3 attempts, [30, 90, 300] backoff). */
  retry?: UpdateRetryOptions;
  /** Directory for per-tool timestamp files (default: HOME). */
  timestampDir?: string;
  /** Injectable time source for the per-tool timestamp file. */
  now?: () => number;
  /** Release-age quarantine window in hours (default 24, Issue #3655). */
  quarantineHours?: number;
  /** Injectable release-age gate (defaults to the real upstream gate). */
  ageGate?: ReleaseAgeGate;
}

/**
 * Resolve the release-age gate for a tool update (Issue #3655).
 *
 * Tests inject a gate; production builds the real one from the same command
 * runner the update itself uses, so the gate is never accidentally bypassed.
 */
function resolveAgeGate(
  logger: Logger,
  opts: ToolUpdateOptions,
): ReleaseAgeGate {
  return opts.ageGate ?? createReleaseAgeGate({
    runFn: opts.retry?.runFn ?? runWithTimeout,
    quarantineHours: opts.quarantineHours,
    warn: (message) => logger.warn(message),
  });
}

/**
 * Log a quarantine verdict and report whether the upgrade may proceed
 * (Issue #3655).
 *
 * Fail-closed (Issue #3234): a release that is too new is deferred, and one
 * whose age cannot be verified is skipped with a warning. Neither outcome is
 * silent — an unverifiable upstream is a supply-chain signal, not a no-op.
 */
function passesQuarantine(
  logger: Logger,
  label: string,
  verdict: ReleaseAgeVerdict,
): boolean {
  if (verdict.eligible) {
    logger.info(`${label} release-age check passed: ${verdict.reason}`);
    return true;
  }
  if (verdict.indeterminate) {
    logger.warn(`${label} upgrade skipped: ${verdict.reason}`);
  } else {
    logger.info(`${label} upgrade deferred: ${verdict.reason}`);
  }
  return false;
}

/** Build the effective retry options for a tool update from its options. */
function buildRetryOptions(opts: ToolUpdateOptions): UpdateRetryOptions {
  return {
    maxAttempts: opts.retry?.maxAttempts,
    backoffSeconds: opts.retry?.backoffSeconds,
    timeout: opts.retry?.timeout ?? opts.timeout,
    sleepFn: opts.retry?.sleepFn,
    runFn: opts.retry?.runFn,
  };
}

/** Persist a successful update timestamp for a tool, if a directory is configured. */
function persistSuccess(
  logger: Logger,
  tool: string,
  opts: ToolUpdateOptions,
): void {
  if (!opts.timestampDir) return;
  const result = recordSuccessfulUpdate(opts.timestampDir, tool, opts.now);
  if (!result.ok) {
    logger.warn(
      `Failed to record successful update timestamp for ${tool}: ${result.error.message}`,
    );
  }
}

// ---------- Exact-version (pinned) installs (Issue #623) ----------

/** Tools that can be installed at an exact version (Issue #623). */
export type PinnedTool = "claude" | "gh" | "deno";

/** Human-readable label per tool, used in log lines and error messages. */
const TOOL_LABELS: Readonly<Record<PinnedTool, string>> = {
  claude: "Claude CLI",
  gh: "GH CLI",
  deno: "Deno",
};

/** Release channel each tool's "latest" version is published through. */
const TOOL_CHANNELS: Readonly<Record<PinnedTool, ReleaseChannel>> = {
  claude: { kind: "npm", pkg: CLAUDE_CLI_NPM_PACKAGE },
  gh: { kind: "github", repo: GH_CLI_RELEASE_REPO },
  deno: { kind: "github", repo: DENO_RELEASE_REPO },
};

/** Canonical order every tool sweep follows: claude → gh → deno. */
const UPDATE_TOOLS: readonly PinnedTool[] = ["claude", "gh", "deno"];

/**
 * Version shape accepted as a pinned install target (Issue #623).
 *
 * The value is interpolated into a download URL and a command line, so only a
 * plain semver (with an optional pre-release suffix) is accepted — anything
 * else is refused loudly rather than fetched.
 *
 * Exported because the release tool-version manifest (Issue #688) records
 * versions a frozen host installs through exactly this path, so it must accept
 * exactly what the pinned installer accepts rather than a second copy of the
 * rule that could drift.
 */
export const PINNED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The commands that install one pinned version, plus best-effort cleanup. */
interface PinnedInstallPlan {
  /** Commands run in order; the first failure aborts the install. */
  commands: string[][];
  /** Commands run afterwards regardless of outcome; failures are ignored. */
  cleanup: string[][];
}

/** Directory downloads are staged in. Falls back to `/tmp`. */
function stagingDir(): string {
  let dir: string | undefined;
  try {
    dir = Deno.env.get("TMPDIR") ?? Deno.env.get("TMP");
  } catch {
    dir = undefined;
  }
  return (dir ?? "/tmp").replace(/\/+$/, "") || "/tmp";
}

/**
 * The `gh` release archive for one version on one platform (Issue #623).
 *
 * Mirrors the naming `container/Containerfile` already relies on —
 * `gh_<version>_<os>_<arch>` — including `gh`'s own quirks: macOS archives are
 * zipped and spelled `macOS`, Linux archives are gzipped tarballs. Returns null
 * for a platform `cli/cli` publishes no such archive for, so the caller can
 * fail loud instead of fetching a URL that does not exist.
 */
export function ghReleaseArchive(
  version: string,
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): { dir: string; archive: string; url: string; zipped: boolean } | null {
  const goarch = arch === "x86_64"
    ? "amd64"
    : arch === "aarch64"
    ? "arm64"
    : null;
  const osName = os === "linux" ? "linux" : os === "darwin" ? "macOS" : null;
  if (!goarch || !osName) return null;
  const zipped = osName === "macOS";
  const dir = `gh_${version}_${osName}_${goarch}`;
  const archive = `${dir}.${zipped ? "zip" : "tar.gz"}`;
  return {
    dir,
    archive,
    zipped,
    url:
      `https://github.com/${GH_CLI_RELEASE_REPO}/releases/download/v${version}/${archive}`,
  };
}

/**
 * Resolve the path the installed `gh` binary occupies (Issue #623).
 *
 * A pinned `gh` install replaces the binary already on PATH, so the exact
 * version the caller asked for is the one that runs. Returns null when `gh`
 * cannot be located — the caller then fails loud rather than guessing a prefix.
 */
async function resolveGhBinaryPath(
  runFn: NonNullable<UpdateRetryOptions["runFn"]>,
): Promise<string | null> {
  const probe = await runFn(["which", "gh"], 5);
  if (!probe.ok || probe.value.exitCode !== 0) return null;
  return probe.value.output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("/")) ?? null;
}

/**
 * Build the command sequence that installs one exact version (Issue #623).
 *
 * Each tool follows the pattern the container image already uses for its
 * pinned tools: fetch the published artefact for that exact version, then
 * install from the local file — never a floating "latest".
 */
async function planPinnedInstall(
  tool: PinnedTool,
  version: string,
  runFn: NonNullable<UpdateRetryOptions["runFn"]>,
): Promise<Result<PinnedInstallPlan>> {
  const fail = (message: string): Result<PinnedInstallPlan> => ({
    ok: false,
    error: new Error(message),
  });

  if (tool === "deno") {
    // `deno upgrade` already takes a version argument.
    return {
      ok: true,
      value: { commands: [["deno", "upgrade", version]], cleanup: [] },
    };
  }

  const tmp = stagingDir();

  if (tool === "claude") {
    const tarball = `${tmp}/claude-code-${version}.tgz`;
    const url =
      `${NPM_REGISTRY_BASE}/${CLAUDE_CLI_NPM_PACKAGE}/-/claude-code-${version}.tgz`;
    return {
      ok: true,
      value: {
        commands: [
          ["curl", "-fsSL", "-o", tarball, url],
          ["npm", "install", "-g", "--ignore-scripts", tarball],
        ],
        cleanup: [["rm", "-f", tarball]],
      },
    };
  }

  const asset = ghReleaseArchive(version);
  if (!asset) {
    return fail(
      `no gh ${version} release archive is published for ${Deno.build.os}/${Deno.build.arch}`,
    );
  }
  const destination = await resolveGhBinaryPath(runFn);
  if (!destination) {
    return fail(
      "the installed gh binary could not be located, so the pinned binary has nowhere to go",
    );
  }
  const archive = `${tmp}/${asset.archive}`;
  const extracted = `${tmp}/${asset.dir}`;
  return {
    ok: true,
    value: {
      commands: [
        ["curl", "-fsSL", "-o", archive, asset.url],
        asset.zipped
          ? ["unzip", "-o", "-q", archive, "-d", tmp]
          : ["tar", "-xzf", archive, "-C", tmp],
        ["install", "-m", "0755", `${extracted}/bin/gh`, destination],
      ],
      cleanup: [["rm", "-rf", archive, extracted]],
    },
  };
}

/**
 * Whether version output reports exactly `version` (Issue #623).
 *
 * Returns null when either side has no parseable semver, so the caller can
 * distinguish "different version" from "could not tell".
 */
export function versionMatchesExactly(
  installedOutput: string,
  version: string,
): boolean | null {
  const installed = parseSemver(installedOutput);
  const wanted = parseSemver(version);
  if (!installed || !wanted) return null;
  return compareSemver(installed, wanted) === 0;
}

/**
 * Re-read a tool's version after a pinned install and fail loud on a mismatch
 * (Issue #623).
 *
 * Uses the same reader as the floor check (`VERSION_COMMANDS` via
 * {@link makeVersionReader}) rather than a second version reader. Unlike the
 * floor check — which warns and waits for the next interval — a pinned install
 * that did not land the requested version throws, naming the requested and the
 * actual version: silently leaving the host on an unpinned tool is exactly the
 * silent failure this path exists to prevent.
 */
async function verifyPinnedVersion(
  logger: Logger,
  tool: PinnedTool,
  version: string,
  readVersion: (tool: string) => Promise<string | null>,
): Promise<void> {
  const label = TOOL_LABELS[tool];
  const output = await readVersion(tool);
  if (output === null) {
    throw new Error(
      `${label} pinned install of ${version} cannot be verified: the installed version could not be read`,
    );
  }
  const matches = versionMatchesExactly(output, version);
  if (matches === null) {
    throw new Error(
      `${label} pinned install of ${version} cannot be verified: no version could be parsed from "${output.trim()}"`,
    );
  }
  if (!matches) {
    const installed = parseSemver(output)!;
    throw new Error(
      `${label} version mismatch after a pinned install: requested ${version}, installed ${
        installed.join(".")
      }`,
    );
  }
  logger.info(`${label} is now at the pinned version ${version}`);
}

/**
 * Install one tool at an exact version (Issue #623).
 *
 * A tool already reporting that version is left alone — a launch must not
 * reinstall on every run. Otherwise the artefact for exactly that version is
 * fetched and installed, and the result is verified: a failed install, an
 * unverifiable version, or a version that does not match throws with both the
 * requested and the actual version named.
 */
export async function installPinnedVersion(
  logger: Logger,
  tool: PinnedTool,
  version: string,
  options: ToolUpdateOptions = {},
): Promise<void> {
  const label = TOOL_LABELS[tool];
  if (!PINNED_VERSION_PATTERN.test(version)) {
    throw new Error(
      `${label} pinned install refused: "${version}" is not a valid version`,
    );
  }

  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const readVersion = makeVersionReader(runFn);

  const before = await readVersion(tool);
  if (before !== null && versionMatchesExactly(before, version) === true) {
    logger.info(
      `${label} is already at the pinned version ${version} — nothing to install`,
    );
    return;
  }

  const plan = await planPinnedInstall(tool, version, runFn);
  if (!plan.ok) {
    throw new Error(
      `${label} pinned install of ${version} failed — ${plan.error.message}`,
    );
  }

  logger.info(`Installing ${label} ${version} (pinned)...`);

  let failure: string | null = null;
  for (const cmd of plan.value.commands) {
    const result = await runUpdateWithRetry(
      logger,
      `${label} ${version}`,
      cmd,
      retryOpts,
    );
    if (!result.success) {
      failure = `\`${cmd[0]}\` failed (exit ${result.finalExitCode})${
        result.finalOutput ? `: ${result.finalOutput}` : ""
      }`;
      break;
    }
  }
  // Cleanup is best-effort: a leftover download must not mask the outcome.
  for (const cmd of plan.value.cleanup) await runFn(cmd, 30);

  if (failure) {
    throw new Error(
      `${label} pinned install of ${version} failed — ${failure}`,
    );
  }

  await verifyPinnedVersion(logger, tool, version, readVersion);
  persistSuccess(logger, tool, options);
}

/** What dynamic mode would install for one tool right now (Issue #623). */
export interface DynamicVersionCandidate {
  /** Tool the candidate applies to. */
  tool: PinnedTool;
  /** Version dynamic mode would install, or null when unresolved. */
  version: string | null;
  /** True when a version was resolved and it clears the quarantine window. */
  eligible: boolean;
  /** Human-readable explanation, suitable for a prompt or a log line. */
  reason: string;
}

/**
 * Report the version dynamic mode would install right now for one tool
 * (Issue #623).
 *
 * Resolved through the existing release-age gate, so the answer is the version
 * an unpinned update would actually adopt — not merely upstream's newest. A
 * version too new to clear the quarantine window, or one that cannot be
 * resolved at all, is reported as ineligible with the gate's own reason rather
 * than being reported as a usable default.
 */
export async function resolveDynamicVersion(
  logger: Logger,
  tool: PinnedTool,
  options: ToolUpdateOptions = {},
): Promise<DynamicVersionCandidate> {
  const verdict = await resolveAgeGate(logger, options).check(
    TOOL_CHANNELS[tool],
  );
  return verdictToCandidate(tool, verdict);
}

/**
 * Report what dynamic mode would install right now for every tool, in the
 * canonical claude → gh → deno order (Issue #623).
 */
export function resolveDynamicVersions(
  logger: Logger,
  options: ToolUpdateOptions = {},
): Promise<DynamicVersionCandidate[]> {
  return Promise.all(
    UPDATE_TOOLS.map((tool) => resolveDynamicVersion(logger, tool, options)),
  );
}

/** Fold a gate verdict into the candidate shape callers report. */
function verdictToCandidate(
  tool: PinnedTool,
  verdict: ReleaseAgeVerdict,
): DynamicVersionCandidate {
  return {
    tool,
    version: verdict.eligible ? verdict.version : null,
    eligible: verdict.eligible && verdict.version !== null,
    reason: verdict.eligible && !verdict.version
      ? `${
        TOOL_LABELS[tool]
      }: the release-age check passed but resolved no version to install.`
      : verdict.reason,
  };
}

/**
 * Report the newest release of one tool that has cleared the quarantine window
 * (Issue #726).
 *
 * {@link resolveDynamicVersion} answers "may upstream's newest be adopted?" —
 * the question an upgrade asks, and one whose answer is routinely "not yet":
 * the Claude CLI ships several times a day, so its newest release is almost
 * always inside the 24h window. A caller that has to *name* an installable
 * version — the release tool-version manifest — asks this instead, and gets
 * the newest release the embargo has already let through.
 *
 * The embargo is unchanged: a tool with nothing past the window is still
 * reported ineligible, with the gate's own reason.
 */
export async function resolveQuarantineClearedVersion(
  logger: Logger,
  tool: PinnedTool,
  options: ToolUpdateOptions = {},
): Promise<DynamicVersionCandidate> {
  const verdict = await resolveAgeGate(logger, options).checkNewestAged(
    TOOL_CHANNELS[tool],
  );
  return verdictToCandidate(tool, verdict);
}

/**
 * Report the newest quarantine-cleared release of every tool, in the canonical
 * claude → gh → deno order (Issue #726).
 */
export function resolveQuarantineClearedVersions(
  logger: Logger,
  options: ToolUpdateOptions = {},
): Promise<DynamicVersionCandidate[]> {
  return Promise.all(
    UPDATE_TOOLS.map((tool) =>
      resolveQuarantineClearedVersion(logger, tool, options)
    ),
  );
}

/**
 * Update Claude CLI to latest version with retry on transient failures (Issue #1496).
 *
 * Gated on the release age of `@anthropic-ai/claude-code` on npm (Issue #3655).
 * `claude update` exposes no version argument, so this unpinned upgrade cannot
 * name a version; the age gate is therefore the control that keeps a
 * just-published — possibly hijacked — release out of the fleet. A caller that
 * supplies `targetVersion` takes the pinned path instead (Issue #623), which
 * installs that exact release from its npm tarball.
 */
export async function updateClaudeCli(
  logger: Logger,
  options: ToolUpdateOptions = {},
): Promise<void> {
  if (options.skip) {
    logger.info("Claude CLI update skipped (skipClaude=true)");
    return;
  }

  // Pinned install (Issue #623): `claude update` takes no version argument, so
  // the exact release is installed from its npm tarball instead.
  if (options.targetVersion) {
    await installPinnedVersion(
      logger,
      "claude",
      options.targetVersion,
      options,
    );
    return;
  }

  logger.info("Checking for Claude CLI updates...");

  const verdict = await resolveAgeGate(logger, options).check({
    kind: "npm",
    pkg: CLAUDE_CLI_NPM_PACKAGE,
  });
  if (!passesQuarantine(logger, "Claude CLI", verdict)) return;

  const result = await runUpdateWithRetry(
    logger,
    "Claude CLI",
    ["claude", "update"],
    buildRetryOptions(options),
  );

  if (result.success) {
    logger.info("Claude CLI update completed successfully");
    if (result.finalOutput) logger.info(`Update output: ${result.finalOutput}`);
    persistSuccess(logger, "claude", options);
  }
}

/**
 * Upgrade installed `gh` extensions one at a time, each gated on its own
 * repository's release age (Issue #3655).
 *
 * `gh extension upgrade --all` upgraded an unbounded set of arbitrary
 * third-party repositories in a single unpinned step, so one compromised
 * extension reached every host. Extensions are now enumerated with
 * `gh extension list` and each is checked against the quarantine window
 * individually.
 *
 * **The install is pinned to the ref the gate dated (Issue #3952).** Bare
 * `gh extension upgrade <name>` installs the latest release for a binary
 * extension but pulls the default branch for a script extension, so a gate
 * that dated the latest release could pass a months-old tag while branch HEAD
 * — possibly ten minutes old — was what actually landed. Each upgrade now runs
 * `gh extension install <repo> --pin <ref> --force`, where `<ref>` is exactly
 * the tag or commit sha the verdict dated. An extension whose installable ref
 * cannot be dated is left alone and reported.
 *
 * @returns True when enumeration succeeded and no attempted upgrade failed.
 */
async function upgradeGhExtensions(
  logger: Logger,
  gate: ReleaseAgeGate,
  retryOpts: UpdateRetryOptions,
): Promise<boolean> {
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const listed = await runFn(["gh", "extension", "list"], 30);
  if (!listed.ok || listed.value.exitCode !== 0) {
    const detail = listed.ok
      ? `exit ${listed.value.exitCode}: ${listed.value.output || "no output"}`
      : listed.error.message;
    logger.warn(
      `Could not enumerate gh extensions (${detail}) — no extension is ` +
        `upgraded, because an unenumerated set cannot be age-checked`,
    );
    return false;
  }

  const extensions = parseGhExtensionList(listed.value.output);
  if (extensions.length === 0) {
    logger.info("No gh extensions installed — nothing to upgrade");
    return true;
  }

  let allOk = true;
  for (const ext of extensions) {
    const verdict = await gate.check({ kind: "gh-extension", repo: ext.repo });
    if (!passesQuarantine(logger, `gh extension ${ext.repo}`, verdict)) {
      continue;
    }
    // Fail loud (Issue #3234): an approved verdict with no ref cannot be
    // installed as dated, so it is reported rather than upgraded unpinned.
    if (!verdict.ref) {
      logger.warn(
        `gh extension ${ext.repo} upgrade skipped: the release-age check ` +
          `approved ${verdict.version ?? "an unnamed version"} but resolved ` +
          `no dated ref to pin the install to`,
      );
      allOk = false;
      continue;
    }
    const result = await runUpdateWithRetry(
      logger,
      `gh extension ${ext.name}`,
      ["gh", "extension", "install", ext.repo, "--pin", verdict.ref, "--force"],
      retryOpts,
    );
    if (!result.success) allOk = false;
    else if (result.finalOutput) {
      logger.info(`gh extension ${ext.name}: ${result.finalOutput}`);
    }
  }
  return allOk;
}

/**
 * Update GH CLI binary (via brew) and extensions with retry (Issue #1496).
 *
 * Both halves are release-age gated (Issue #3655): the binary upgrade against
 * the latest `cli/cli` release, and each extension against its own repository.
 * `brew upgrade gh` takes no version argument, so the gate approximates the
 * formula's age with the age of the upstream `gh` release the formula tracks —
 * a formula-only compromise that does not touch `cli/cli` is out of its reach
 * and remains covered by Homebrew's own signing. A caller that supplies
 * `targetVersion` takes the pinned path instead (Issue #623), installing that
 * exact `cli/cli` release archive over the `gh` binary already on PATH.
 */
export async function updateGhCli(
  logger: Logger,
  options: ToolUpdateOptions = {},
): Promise<void> {
  if (options.skip) {
    logger.info("GH CLI update skipped (skipGh=true)");
    return;
  }

  // Pinned install (Issue #623): `brew upgrade gh` takes no version argument,
  // so the exact release archive for this platform is installed instead. Only
  // the binary is pinned — extensions keep their own age-gated upgrade path.
  if (options.targetVersion) {
    await installPinnedVersion(logger, "gh", options.targetVersion, options);
    return;
  }

  logger.info("Checking for GH CLI updates...");

  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const gate = resolveAgeGate(logger, options);

  // Upgrade GH CLI binary via brew (if available). `which brew` is a short,
  // deterministic probe and does not need retry — classify its absence as
  // "brew not installed" and skip the binary upgrade.
  const brewProbe = await runFn(["which", "brew"], 5);
  if (brewProbe.ok && brewProbe.value.exitCode === 0) {
    const binaryVerdict = await gate.check({
      kind: "github",
      repo: GH_CLI_RELEASE_REPO,
    });
    if (passesQuarantine(logger, "GH CLI binary", binaryVerdict)) {
      logger.info("Upgrading GH CLI via brew...");
      const brewResult = await runUpdateWithRetry(
        logger,
        "brew upgrade gh",
        ["brew", "upgrade", "gh"],
        retryOpts,
      );
      if (brewResult.success && brewResult.finalOutput) {
        logger.info(`brew upgrade gh: ${brewResult.finalOutput}`);
      }
    }
  } else {
    logger.info("brew not available — skipping GH CLI binary upgrade");
  }

  // Upgrade GH CLI extensions individually, each behind the quarantine window.
  if (await upgradeGhExtensions(logger, gate, retryOpts)) {
    logger.info("GH CLI update completed successfully");
    persistSuccess(logger, "gh", options);
  }
}

/**
 * Update Deno runtime with retry (Issue #1496).
 *
 * The upgrade is **pinned** to the release the quarantine gate actually
 * approved (Issue #3655): `deno upgrade <version>` rather than a bare
 * `deno upgrade`, so a release published between the age check and the upgrade
 * cannot slip in unchecked. A caller that supplies `targetVersion` pins to that
 * version instead of the gate's verdict (Issue #623).
 */
export async function updateDeno(
  logger: Logger,
  options: ToolUpdateOptions = {},
): Promise<void> {
  if (options.skip) {
    logger.info("Deno update skipped (skipDeno=true)");
    return;
  }

  // Pinned install (Issue #623): `deno upgrade` already accepts a version, so
  // the requested one is used in place of the age-gate verdict. The absent-
  // binary probe below is deliberately not consulted — a pinned install that
  // cannot run must fail loud, not return quietly.
  if (options.targetVersion) {
    await installPinnedVersion(logger, "deno", options.targetVersion, options);
    return;
  }

  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;

  // Presence probe is a one-shot check — no retry.
  const denoCheck = await runFn(["which", "deno"], 5);
  if (!denoCheck.ok || denoCheck.value.exitCode !== 0) {
    logger.info("Deno not installed — skipping update");
    return;
  }

  logger.info("Checking for Deno updates...");

  const verdict = await resolveAgeGate(logger, options).check({
    kind: "github",
    repo: DENO_RELEASE_REPO,
  });
  if (!passesQuarantine(logger, "Deno", verdict)) return;
  if (!verdict.version) {
    logger.warn("Deno upgrade skipped: no resolved version to pin to");
    return;
  }

  const result = await runUpdateWithRetry(
    logger,
    "Deno",
    ["deno", "upgrade", verdict.version],
    retryOpts,
  );

  if (result.success) {
    logger.info("Deno update completed successfully");
    if (result.finalOutput) logger.info(`Update output: ${result.finalOutput}`);
    persistSuccess(logger, "deno", options);
  }
}

/** The updater for each tool, shared by the dynamic and frozen paths. */
const TOOL_UPDATERS: Readonly<
  Record<PinnedTool, (l: Logger, o: ToolUpdateOptions) => Promise<void>>
> = {
  claude: updateClaudeCli,
  gh: updateGhCli,
  deno: updateDeno,
};

/**
 * Install the exact versions a frozen host is held at (Issue #625).
 *
 * Every tool takes the pinned path added in #623, so a tool already at its
 * version is a no-op and a pinned install that does not land the requested
 * version throws with both versions named — a launch never quietly continues
 * on a different version than the one recorded in `.config.json`.
 *
 * **The release-age quarantine is deliberately not applied here.** That gate
 * exists to keep a just-published — possibly hijacked — release out of an
 * unattended "latest" pull; a frozen version is instead a human's deliberate
 * choice recorded in config, so there is no unattended selection to guard. The
 * pinned version is logged at install so the choice stays auditable.
 *
 * @throws When a tool has no pinned version, or its pinned install fails.
 */
async function installFrozenToolVersions(
  logger: Logger,
  pinned: PinnedToolVersions,
  toolOpts: ToolUpdateOptions,
  skips: Record<string, boolean>,
): Promise<void> {
  for (const tool of UPDATE_TOOLS) {
    const label = TOOL_LABELS[tool];
    const version = pinned[tool]?.trim();
    if (!version) {
      // Config load already refuses a half-pinned frozen host, so reaching
      // here means the options were assembled by hand. Continuing would leave
      // this tool floating on whatever the host happens to have.
      throw new Error(
        `update_mode is frozen but ${label} has no pinned version — set ` +
          `pinned_tool_versions.${tool} rather than leaving the tool to drift`,
      );
    }
    if (skips[tool]) {
      logger.warn(
        `${label} is pinned to ${version} (update_mode=frozen) but its ` +
          `update is suppressed (${
            SKIP_ENV_NAME[tool] ?? "skip flag"
          }) — the ` +
          `host may drift off its pin`,
      );
      continue;
    }
    logger.info(`${label} pinned to ${version} (update_mode=frozen)`);
    await TOOL_UPDATERS[tool](logger, { ...toolOpts, targetVersion: version });
  }
}

/** Version-reading commands per tool (Issue #2622). */
const VERSION_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude", "--version"],
  gh: ["gh", "--version"],
  deno: ["deno", "--version"],
};

/** Environment variable that suppresses each tool's update (Issue #2622). */
const SKIP_ENV_NAME: Readonly<Record<string, string>> = {
  claude: "SKIP_CLAUDE_UPDATE",
  gh: "SKIP_GH_UPDATE",
  deno: "SKIP_DENO_UPDATE",
};

/**
 * Parse the leading semver (MAJOR.MINOR.PATCH) from version output (Issue #2622).
 *
 * Accepts output such as "2.1.170 (Claude Code)", "gh version 2.40.0 (...)",
 * or "v1.2.3". Returns null when no semver-shaped token is present.
 */
export function parseSemver(text: string): [number, number, number] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two semver triples numerically per segment (Issue #2622).
 *
 * Returns a negative number when `a < b`, zero when equal, positive when
 * `a > b`. The comparison is numeric per segment, so 2.1.170 > 2.1.9 — a plain
 * string comparison would wrongly order these.
 */
export function compareSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Determine whether installed version output is below a required floor (Issue #2622).
 *
 * Returns:
 *  - `true`  — installed version is strictly below the floor.
 *  - `false` — installed version is at or above the floor.
 *  - `null`  — the installed output or floor could not be parsed (the caller
 *              should fall back to interval behaviour with a warning).
 */
export function isVersionBelowFloor(
  installedOutput: string,
  floor: string,
): boolean | null {
  const installed = parseSemver(installedOutput);
  const required = parseSemver(floor);
  if (!installed || !required) return null;
  return compareSemver(installed, required) < 0;
}

/**
 * Record the time of the most recent floor-triggered update attempt for a tool
 * (Issue #2622).
 *
 * Gates repeat floor updates so a tool that cannot reach its floor does not
 * retry-loop every iteration — the next floor attempt waits for the normal
 * interval to elapse.
 */
export function recordFloorUpdateAttempt(
  timestampDir: string,
  tool: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<void> {
  const tsFile = `${timestampDir}/.last_floor_update_attempt_${tool}`;
  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Whether a floor-triggered update may be attempted for a tool (Issue #2622).
 *
 * Returns true when no floor attempt has been recorded within `intervalSeconds`
 * (or the record is missing/invalid). This reuses the existing interval as a
 * backoff so an unreachable floor does not retry every iteration.
 */
export function shouldAttemptFloorUpdate(
  timestampDir: string,
  tool: string,
  intervalSeconds: number = DEFAULT_UPDATE_INTERVAL_SECONDS,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): boolean {
  const tsFile = `${timestampDir}/.last_floor_update_attempt_${tool}`;
  let content: string;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch {
    return true;
  }
  if (!/^\d+$/.test(content)) return true;
  const last = parseInt(content, 10);
  return nowFn() - last >= intervalSeconds;
}

/**
 * Build the default installed-version reader (Issue #2622).
 *
 * Spawns the tool's `--version` command and returns its combined output, or
 * null when the tool is unknown or the command fails.
 */
function makeVersionReader(
  runFn: (
    cmd: string[],
    timeoutSeconds: number,
  ) => Promise<Result<{ exitCode: number; output: string }>>,
): (tool: string) => Promise<string | null> {
  return async (tool: string) => {
    const cmd = VERSION_COMMANDS[tool];
    if (!cmd) return null;
    const result = await runFn([...cmd], 10);
    if (!result.ok || result.value.exitCode !== 0) return null;
    return result.value.output;
  };
}

/**
 * Re-read a tool's version after a floor-triggered update and warn if the
 * required floor is still unmet (Issue #2622).
 *
 * A still-below-floor result is a permanent-failure signal: it is logged once
 * (naming the tool, installed version, and required floor) and not retried
 * until the interval elapses — the caller has already recorded a floor attempt.
 */
async function verifyFloorAfterUpdate(
  logger: Logger,
  tool: string,
  floor: string,
  readVersion: (tool: string) => Promise<string | null>,
): Promise<void> {
  const output = await readVersion(tool);
  if (output === null) {
    logger.warn(
      `Could not re-read ${tool} version after a floor-triggered update (required floor ${floor})`,
    );
    return;
  }
  const below = isVersionBelowFloor(output, floor);
  if (below === null) {
    logger.warn(
      `Could not parse ${tool} version "${output.trim()}" after a floor-triggered update (required floor ${floor})`,
    );
    return;
  }
  if (below) {
    const installed = parseSemver(output);
    logger.warn(
      `${tool} is still below the required version floor ${floor} after updating (installed ${
        installed ? installed.join(".") : output.trim()
      }) — floor unmet; will not retry until the interval elapses`,
    );
  } else {
    logger.info(`${tool} now meets the required version floor ${floor}`);
  }
}

/**
 * Orchestrate the software update check (Issues #906, #1496, #2622, #625).
 *
 * Under `update_mode: "frozen"` (Issue #625) the three tools are installed at
 * their configured `pinned_tool_versions` and nothing below applies: no
 * interval, no floor, no release-age quarantine. Everything that follows
 * describes the `dynamic` default, which is unchanged.
 *
 * Runs an update for a tool when *either* the interval has elapsed *or* the
 * installed version is below a configured floor (`minVersions`). The interval
 * gate is the weekly cadence (timestamp file); the floor gate bypasses it so a
 * known-too-old tool (e.g. Claude CLI lacking `--model fable` support) updates
 * immediately rather than waiting up to a week.
 *
 * Floor handling:
 *  - Below floor + (interval elapsed OR no recent floor attempt) → force update.
 *  - After a floor-triggered update, the version is re-read; still-below-floor
 *    is logged as a permanent failure and not retried until the interval
 *    elapses (a floor-attempt timestamp provides the backoff).
 *  - Unparseable version output falls back to interval behaviour with a warning
 *    and never blocks the worker.
 *  - A skip flag (e.g. SKIP_CLAUDE_UPDATE) still wins, but logs that a version
 *    floor is unmet when it suppresses a floor-triggered update.
 *
 * The global weekly timestamp is only recorded when the interval actually
 * elapsed, so a floor-only trigger does not skip the next weekly gh/deno check.
 */
export async function checkSoftwareUpdates(
  logger: Logger,
  options: SoftwareUpdateOptions = {},
): Promise<void> {
  // Defence in depth for Issue #4062: the bootstrap gates its call on
  // skipSoftwareUpdateFromEnv, but other callers (run-core's periodic path)
  // reached this entry directly and ran the weekly check inside the
  // container. The image is the update mechanism, so the gate lives here,
  // covering every caller.
  if (skipSoftwareUpdateFromEnv(options.env)) {
    // Debug, not info (Issue #4212): in container mode this is a permanent
    // fact of the deployment, and stating it every cycle is pure log noise.
    logger.debug(
      "Software updates suppressed: inside the worker container the image " +
        "is the update mechanism (Issue #4062), or SKIP_SOFTWARE_UPDATE is " +
        "set",
    );
    return;
  }

  const timestampDir = options.timestampDir ??
    (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".");
  const intervalSeconds = options.intervalSeconds ??
    DEFAULT_UPDATE_INTERVAL_SECONDS;
  const timeout = options.timeout ?? DEFAULT_UPDATE_TIMEOUT_SECONDS;
  const nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
  const minVersions = options.minVersions ?? {};
  const readVersion = options.readVersion ??
    makeVersionReader(options.retry?.runFn ?? runWithTimeout);

  const toolOpts: ToolUpdateOptions = {
    timeout,
    retry: options.retry,
    timestampDir,
    now: nowFn,
    quarantineHours: options.quarantineHours,
    ageGate: options.ageGate,
  };
  const skips: Record<string, boolean> = {
    claude: options.skipClaude ?? false,
    gh: options.skipGh ?? false,
    deno: options.skipDeno ?? false,
  };

  // Frozen hosts install their pins on every launch (Issue #625). The interval
  // and floor gates below are dynamic-mode machinery: a pin is the operator's
  // recorded decision, and editing `pinned_tool_versions` by hand is the
  // supported way to move a frozen host, so the edit has to take effect on the
  // next launch rather than at the end of the weekly cadence. Each install is a
  // no-op once the tool reports its pinned version, so running every launch
  // costs one `--version` read per tool.
  if (options.updateMode === "frozen") {
    await installFrozenToolVersions(
      logger,
      options.pinnedToolVersions ?? {},
      toolOpts,
      skips,
    );
    return;
  }

  const intervalElapsed = shouldCheckForUpdates(
    timestampDir,
    intervalSeconds,
    nowFn,
  );

  // Evaluate version floors (Issue #2622). A tool below its floor is updated
  // immediately, bypassing the interval gate; unparseable versions fall back
  // to interval behaviour with a warning.
  const belowFloor = new Map<string, string>(); // tool -> floor
  const floorTriggered = new Set<string>();
  for (const [tool, floor] of Object.entries(minVersions)) {
    if (!floor) continue;
    const output = await readVersion(tool);
    if (output === null) {
      logger.warn(
        `Could not read ${tool} version for floor check (floor ${floor}) — using interval behaviour`,
      );
      continue;
    }
    const below = isVersionBelowFloor(output, floor);
    if (below === null) {
      logger.warn(
        `Could not parse ${tool} version from "${output.trim()}" for floor ${floor} — using interval behaviour`,
      );
      continue;
    }
    if (!below) continue;
    belowFloor.set(tool, floor);
    if (
      intervalElapsed ||
      shouldAttemptFloorUpdate(timestampDir, tool, intervalSeconds, nowFn)
    ) {
      floorTriggered.add(tool);
      logger.info(
        `${tool} installed version is below required floor ${floor} — forcing update`,
      );
    } else {
      logger.info(
        `${tool} is below floor ${floor} but a floor update was attempted recently — deferring until the interval elapses`,
      );
    }
  }

  if (!intervalElapsed && floorTriggered.size === 0) {
    logger.info("Software updates checked recently — skipping");
    return;
  }

  logger.info(
    intervalElapsed
      ? "Running weekly software update check..."
      : `Running floor-triggered software update (${
        [...floorTriggered].join(", ")
      })...`,
  );

  // Preserve the historical claude → gh → deno ordering.
  for (const tool of UPDATE_TOOLS) {
    if (!(intervalElapsed || floorTriggered.has(tool))) continue;
    const skip = skips[tool] ?? false;
    const floor = belowFloor.get(tool);
    if (skip && floor !== undefined) {
      logger.warn(
        `${tool} is below the required version floor ${floor} but the update is suppressed (${
          SKIP_ENV_NAME[tool] ?? "skip flag"
        })`,
      );
    }
    await TOOL_UPDATERS[tool](logger, { ...toolOpts, skip });
    if (floorTriggered.has(tool)) {
      // Record the attempt regardless of outcome so an unreachable floor does
      // not retry-loop every iteration.
      recordFloorUpdateAttempt(timestampDir, tool, nowFn);
      if (!skip && floor !== undefined) {
        await verifyFloorAfterUpdate(logger, tool, floor, readVersion);
      }
    }
  }

  // Only the full weekly cadence resets the global interval timestamp; a
  // floor-only trigger must not skip the next weekly gh/deno check.
  if (intervalElapsed) {
    recordUpdateCheck(timestampDir, nowFn);
  }

  logger.info(
    intervalElapsed
      ? "Weekly software update check complete"
      : "Floor-triggered software update complete",
  );
}

/** Config fields {@link softwareUpdateOptionsFromEnv} reads. */
export interface SoftwareUpdateConfig {
  /** Per-tool minimum version floors (Issue #2622). */
  softwareMinVersions?: Record<string, string>;
  /** Maximum retry attempts per update command. */
  updateRetryMaxAttempts?: number;
  /** Exponential backoff delays between retries. */
  updateRetryBackoffSeconds?: readonly number[];
  /**
   * How this host tracks releases (Issue #625, `.config.json` `update_mode`).
   * Absent reads as `dynamic`.
   */
  updateMode?: UpdateMode;
  /** Exact versions a frozen host installs (Issue #625). */
  pinnedToolVersions?: PinnedToolVersions;
}

/** Read an optional positive integer from the environment. */
function envInt(
  getEnv: (name: string) => string | undefined,
  name: string,
): number | undefined {
  const raw = getEnv(name);
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return undefined;
  return parseInt(raw, 10);
}

/**
 * Build the software-update options every production entry point uses
 * (Issue #3655).
 *
 * Three callers previously assembled this option set by hand — the run-core
 * production deps, the `run-bootstrap` command, and (not at all) the
 * `run-entrypoint` driver. The driver's omission meant the documented
 * `SKIP_CLAUDE_UPDATE` / `SKIP_GH_UPDATE` / `SKIP_DENO_UPDATE` opt-outs were
 * never consulted on the primary path: setting them did not stop the upgrade
 * the worker performed at startup. One shared builder keeps the three paths
 * from drifting apart again.
 */
export function softwareUpdateOptionsFromEnv(
  config: SoftwareUpdateConfig = {},
  getEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): SoftwareUpdateOptions {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? ".";
  return {
    timestampDir: getEnv("SOFTWARE_UPDATE_TIMESTAMP_DIR") ?? home,
    intervalSeconds: envInt(getEnv, "SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS"),
    timeout: envInt(getEnv, "CLAUDE_UPDATE_TIMEOUT"),
    minVersions: config.softwareMinVersions,
    skipClaude: getEnv("SKIP_CLAUDE_UPDATE") === "true",
    skipGh: getEnv("SKIP_GH_UPDATE") === "true",
    skipDeno: getEnv("SKIP_DENO_UPDATE") === "true",
    quarantineHours: envInt(getEnv, "VIBE_BUMP_QUARANTINE_HOURS"),
    // Issue #625: the mode and its pins reach every entry point through this
    // one builder, so a frozen host installs its pins on whichever path
    // launched it.
    updateMode: config.updateMode,
    pinnedToolVersions: config.pinnedToolVersions,
    retry: {
      maxAttempts: config.updateRetryMaxAttempts,
      backoffSeconds: config.updateRetryBackoffSeconds,
    },
  };
}

/**
 * Whether the whole software-update step is suppressed (Issue #3655).
 *
 * Always suppressed inside the worker container (the image stamps
 * VIBE_IMAGE_AGENT_PROVIDERS): the image is the update mechanism
 * (Issue #4062) — every tool version is pinned and checksum-verified at
 * build time, so a run-time self-update would install unpinned packages
 * into an ephemeral VM, repeat on every run, and sit outside the image's
 * supply-chain guarantees. Bumping the pin in container/tools.json and the
 * Containerfile changes the tag and rebuilds instead.
 */
export function skipSoftwareUpdateFromEnv(
  getEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  if (getEnv("SKIP_SOFTWARE_UPDATE") === "true") return true;
  return getEnv("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined;
}
