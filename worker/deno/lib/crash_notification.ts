/**
 * Crash notification for the Vibe Coder worker (Issue #634, #909).
 *
 * When the worker exits unexpectedly (non-zero exit code, signal-based
 * termination), this module posts a notification so operators are aware.
 *
 * Notification channels:
 *   1. GitHub issue comment — posted on the issue being worked on (if any)
 *   2. Webhook — optional HTTP POST to a configured URL
 *
 * Rate limiting prevents notification spam during crash loops.
 *
 * Migrated from worker/shared/crash_notification.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { spawnGh } from "./gh_spawn.ts";

/** Configuration for crash notifications. */
export interface CrashNotificationConfig {
  /** Display name for this worker. */
  workerName: string;
  /** Minimum seconds between crash notifications (default: 600). */
  cooldownSeconds: number;
  /** Maximum log tail size in bytes before truncation (default: 50000). */
  logTailMaxBytes: number;
  /** Directory for rate-limit state file (default: ~/.vibe-coder). */
  stateDir: string;
  /** Optional webhook URL for POST notifications. */
  webhookUrl?: string;
}

/** Leaf name of the crash-notification state directory on the work volume. */
export const CRASH_STATE_DIR_NAME = ".crash-state";

/**
 * Where the rate-limit state file belongs (Issue #515).
 *
 * Host-side that is `~/.vibe-coder`, beside the operator's other worker
 * state. **Inside the container it is not:** `/home/vibe/.vibe-coder` is the
 * root-owned parent the runtime creates for the read-only credential and
 * config mounts, on the image layer — every write there is refused today and
 * refused louder once the container root filesystem is mounted read-only
 * (Issue #509). In the container the state belongs on the `vibe-work` volume,
 * where it also survives the container restart the rate limit exists to
 * throttle.
 *
 * @param workDir - The resolved work directory (the volume mount inside the
 *   container). Required for the in-container branch.
 * @param env - Environment lookup, injectable for testing.
 * @returns The directory the rate-limit state file is written to.
 */
export function resolveCrashStateDir(
  workDir: string | undefined,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  const explicit = env("CRASH_NOTIFICATION_STATE_DIR")?.trim();
  if (explicit) return explicit;
  // VIBE_IMAGE_AGENT_PROVIDERS is stamped into the image, so it is the
  // container signal every other module uses (see optional_feature_env.ts).
  const inContainer = env("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined;
  const trimmedWorkDir = workDir?.trim();
  if (inContainer && trimmedWorkDir) {
    return `${trimmedWorkDir}/${CRASH_STATE_DIR_NAME}`;
  }
  return `${env("HOME") ?? "~"}/.vibe-coder`;
}

/** Crash notification parameters. */
export interface CrashNotificationParams {
  /** Exit code of the crashed process. */
  exitCode: number;
  /** Repository in "owner/repo" format (may be empty). */
  repo: string;
  /** Issue number being worked on (may be empty/0). */
  issueNumber: number;
  /** Worker log tail for inclusion in notification. */
  logTail: string;
  /** Claude output tail for inclusion in notification. */
  claudeOutput: string;
  /** Current work stage (e.g., "running_claude"). */
  workStage: string;
  /** Unix timestamp when work started on current issue. */
  workStartTime: number;
  /** Whether the shutdown was planned (e.g., duration expired). */
  plannedShutdown: boolean;
  /**
   * Optional HTML-comment marker that identifies this report (Issue #343).
   *
   * When set, the marker is carried in the comment body and a comment already
   * carrying it is **edited in place** instead of a second one being posted —
   * the same body-marker dedup the script-failure (#207) and idle-inversion
   * (#321) streaks use. An ongoing condition then updates one report rather
   * than filing another on every re-notification.
   */
  dedupMarker?: string;
}

/** Default crash notification configuration. */
export const CRASH_NOTIFICATION_DEFAULTS: Readonly<
  Omit<CrashNotificationConfig, "workerName" | "stateDir">
> = {
  cooldownSeconds: 600,
  logTailMaxBytes: 50000,
} as const;

/**
 * Format seconds to human-readable elapsed time (e.g., "12m 34s", "1h 2m 3s").
 */
export function formatElapsedTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  return `${minutes}m ${secs}s`;
}

/**
 * Determine if an exit code represents an unexpected crash.
 *
 * Exit code 0 is clean. If plannedShutdown is true, any exit is intentional.
 */
export function isCrashExit(
  exitCode: number,
  plannedShutdown: boolean,
): boolean {
  if (exitCode === 0) return false;
  if (plannedShutdown) return false;
  return true;
}

/**
 * Derive signal name from exit code.
 *
 * Signal-based exits are 128 + signal_number:
 *   130 = SIGINT, 137 = SIGKILL, 143 = SIGTERM
 */
export function signalNameFromExitCode(exitCode: number): string {
  if (exitCode <= 128) return "";

  const signalNum = exitCode - 128;
  const signalMap: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    14: "SIGALRM",
    15: "SIGTERM",
  };
  return signalMap[signalNum] ?? `signal ${signalNum}`;
}

/**
 * Truncate text if it exceeds maxBytes.
 */
function truncateIfNeeded(text: string, maxBytes: number): string {
  if (!text || text.length <= maxBytes) return text;
  return `${
    text.substring(0, maxBytes)
  }\n... (truncated \u2014 output exceeded ${maxBytes} bytes)`;
}

/**
 * Capture the tail of a file, with size limit.
 *
 * Returns empty string if file is missing, empty, or unreadable.
 */
export async function captureFileTail(
  filePath: string,
  lineCount: number,
  maxBytes: number,
): Promise<string> {
  if (!filePath) return "";
  try {
    const content = await Deno.readTextFile(filePath);
    if (!content) return "";
    const lines = content.split("\n");
    const tail = lines.slice(-lineCount).join("\n");
    // Redact before truncating so a secret straddling the cut cannot survive
    // as an unmatchable fragment (Issue #3707).
    return truncateIfNeeded(redactSecrets(tail), maxBytes);
  } catch (err) {
    console.warn(
      `[crash-notification] Failed to capture file tail from ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
}

/**
 * Extract key error lines from text for prominent display.
 *
 * Issue #733 — imported from failure_diagnosis module.
 */
function extractKeyErrorLines(text: string): string {
  if (!text) return "";
  const errorPattern =
    /(^|\s)(Error:|error:|fatal:|FAIL\s|FAILED|not ok \d)|\d+ tests? failed|error TS\d+/;
  const lines = text.split("\n");
  const matches: string[] = [];
  for (const line of lines) {
    if (matches.length >= 10) break;
    if (errorPattern.test(line)) {
      matches.push(line);
    }
  }
  return matches.join("\n");
}

/**
 * Build a human-readable crash notification message.
 *
 * Includes: worker ID, exit code (with signal name if applicable),
 * timestamp, last known activity, work stage, elapsed time, and optionally
 * the worker log tail with key error lines displayed prominently.
 *
 * The fully-assembled message is routed through `redactSecrets()` so any
 * token captured in the raw log/Claude tails is masked before the message is
 * posted to a (often public) GitHub issue comment (Issue #2486).
 */
export function buildCrashMessage(
  config: CrashNotificationConfig,
  params: CrashNotificationParams,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): string {
  const workerId = config.workerName || "unknown";
  const timestamp = new Date().toISOString().replace("T", " ").replace(
    /\.\d+Z$/,
    " UTC",
  );

  const signalInfo = signalNameFromExitCode(params.exitCode);
  const exitDisplay = signalInfo
    ? `${params.exitCode} (${signalInfo})`
    : String(params.exitCode);

  const activity = params.repo && params.issueNumber
    ? `Working on issue #${params.issueNumber} in ${params.repo}`
    : "No issue in progress";

  const stage = params.workStage || "unknown";

  let elapsedDisplay = "unknown";
  if (params.workStartTime > 0) {
    const elapsed = nowFn() - params.workStartTime;
    elapsedDisplay = formatElapsedTime(elapsed);
  }

  const lines: string[] = [
    // Marker first, so the dedup search matches on the body's own contents
    // (Issue #343) and a re-notification updates this report in place.
    ...(params.dedupMarker ? [params.dedupMarker, ""] : []),
    "## Worker Crash Notification",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| **Worker** | ${workerId} |`,
    `| **Exit code** | ${exitDisplay} |`,
    `| **Timestamp** | ${timestamp} |`,
    `| **Last activity** | ${activity} |`,
    `| **Stage** | ${stage} |`,
    `| **Elapsed** | ${elapsedDisplay} |`,
    "",
    "This is an automated notification from the Vibe Coder worker. The worker exited unexpectedly and may need operator attention.",
  ];

  // Append log tail section if available. Redaction runs BEFORE truncation
  // (Issue #3707): cutting first can split a secret — most damagingly a PEM
  // block, whose END marker falls past the cut — leaving a fragment that no
  // rule matches on the later pass.
  const logTail = truncateIfNeeded(
    redactSecrets(params.logTail),
    config.logTailMaxBytes,
  );
  if (logTail) {
    const keyErrors = extractKeyErrorLines(logTail);
    if (keyErrors) {
      const quotedErrors = keyErrors.split("\n").map((l) => `> ${l}`).join(
        "\n",
      );
      lines.push("", "### Key Errors", quotedErrors);
    }
    lines.push(
      "",
      "<details>",
      "<summary>Worker log tail (click to expand)</summary>",
      "",
      "```",
      logTail,
      "```",
      "</details>",
    );
  }

  // Append Claude output section if available
  const claudeOutput = truncateIfNeeded(
    redactSecrets(params.claudeOutput),
    config.logTailMaxBytes,
  );
  if (claudeOutput) {
    lines.push(
      "",
      "### Claude Output (last 100 lines)",
      "<details>",
      "<summary>Click to expand</summary>",
      "",
      "```",
      claudeOutput,
      "```",
      "</details>",
    );
  }

  // Redact known secret shapes before the message leaves this module. The
  // log/Claude tails are captured with a plain `tail` from the raw output
  // files, bypassing the redacting logger, so any token in that tail (e.g. a
  // tokenised git clone URL, GH_TOKEN, sk-ant-…) would otherwise be posted
  // verbatim to a public issue comment (Issue #2486).
  return redactSecrets(lines.join("\n"));
}

/**
 * Check if notifications should be rate-limited.
 *
 * Returns true if a notification was sent within the cooldown period.
 */
export async function shouldRateLimitNotification(
  config: CrashNotificationConfig,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const stateFile = `${config.stateDir}/last_crash_notification`;
  try {
    const content = await Deno.readTextFile(stateFile);
    const lastSent = parseInt(content.trim(), 10);
    if (isNaN(lastSent)) return false;
    const elapsed = nowFn() - lastSent;
    return elapsed < config.cooldownSeconds;
  } catch (err) {
    console.warn(
      `[crash-notification] Failed to read rate-limit state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false; // No state file — first notification
  }
}

/**
 * Record that a crash notification was sent (for rate limiting).
 */
export async function recordNotificationSent(
  config: CrashNotificationConfig,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<void>> {
  try {
    await Deno.mkdir(config.stateDir, { recursive: true });
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `mkdir for crash notification state failed: ${err}`,
    );
  }
  const stateFile = `${config.stateDir}/last_crash_notification`;
  try {
    await Deno.writeTextFile(stateFile, String(nowFn()));
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Failed to record notification: ${err}`),
    };
  }
}

/**
 * Runs a `gh` command with the given arguments. Injectable seam so the
 * delivery path can be exercised in tests without spawning a real process
 * (mirrors the `nowFn` injection convention used elsewhere in this module).
 */
export type GhCommentRunner = (args: string[]) => Promise<void>;

/** Default `gh` runner — spawns the real CLI with output suppressed. */
const defaultGhCommentRunner: GhCommentRunner = async (args) => {
  await spawnGh(args, { stdout: "null", stderr: "null" });
};

/**
 * Runs a read-only `gh` command and returns its stdout. Used only on the
 * dedup-marker path (Issue #343), where the existing report has to be found
 * before it can be updated.
 */
export type GhQueryRunner = (args: string[]) => Promise<string>;

/** Default query runner — spawns the real CLI and captures stdout. */
const defaultGhQueryRunner: GhQueryRunner = async (args) => {
  const result = await spawnGh(args, { stderr: "null" });
  if (!result.success) {
    // Fail loud: a lookup we could not perform must not read as "no report
    // exists" without the caller knowing it guessed.
    throw new Error(`gh ${args[0] ?? ""} exited ${result.code}`);
  }
  return result.stdout;
};

/**
 * Find the id of an existing comment carrying `marker`, or null when there is
 * none. Throws when the lookup itself failed.
 */
async function findMarkedComment(
  repo: string,
  issueNumber: number,
  marker: string,
  queryGh: GhQueryRunner,
): Promise<number | null> {
  const raw = await queryGh([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--paginate",
    "--jq",
    "[.[] | {id: .id, body: .body}]",
  ]);
  // `--paginate` concatenates one array per page; parse each in turn.
  const comments: { id: number; body?: string }[] = [];
  for (const chunk of (raw || "").split("\n")) {
    const text = chunk.trim();
    if (!text) continue;
    const parsed = JSON.parse(text) as { id: number; body?: string }[];
    if (Array.isArray(parsed)) comments.push(...parsed);
  }
  const match = comments
    .filter((c) => (c.body ?? "").includes(marker))
    .sort((a, b) => b.id - a.id)[0];
  return match ? match.id : null;
}

/**
 * Post a crash notification as a GitHub issue comment.
 *
 * When `params.dedupMarker` is set (Issue #343) an existing comment carrying
 * that marker is edited in place rather than a second one being posted, so an
 * ongoing condition updates one report instead of filing another every time
 * it is re-notified. A failed lookup falls back to posting a fresh comment:
 * a duplicate report is recoverable, a lost escalation is not.
 *
 * All errors are suppressed — notification must never block cleanup.
 *
 * `runGh` and `queryGh` are injectable for tests; production uses the real
 * `gh` runners.
 */
export async function notifyCrashViaIssueComment(
  config: CrashNotificationConfig,
  params: CrashNotificationParams,
  runGh: GhCommentRunner = defaultGhCommentRunner,
  queryGh: GhQueryRunner = defaultGhQueryRunner,
): Promise<Result<{ delivered: boolean }>> {
  if (!params.repo || !params.issueNumber) {
    // Nothing was posted, and the caller must be told so (Issue #556): a
    // host-level failure has no in-flight issue, and reporting that silence
    // as a delivered notification is how a ten-hour outage went unreported.
    return { ok: true, value: { delivered: false } };
  }

  const message = buildCrashMessage(config, params);

  try {
    if (params.dedupMarker) {
      let existing: number | null = null;
      try {
        existing = await findMarkedComment(
          params.repo,
          params.issueNumber,
          params.dedupMarker,
          queryGh,
        );
      } catch (err) {
        recordFaultEvent(
          "catch_block_warning",
          `crash notification dedup lookup failed, posting a new comment: ` +
            `${err}`,
        );
      }
      if (existing !== null) {
        await runGh([
          "api",
          "--method",
          "PATCH",
          `repos/${params.repo}/issues/comments/${existing}`,
          "-f",
          `body=${message}`,
        ]);
        return { ok: true, value: { delivered: true } };
      }
    }

    await runGh([
      "issue",
      "comment",
      String(params.issueNumber),
      "--repo",
      params.repo,
      "--body",
      message,
    ]);
    return { ok: true, value: { delivered: true } };
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `crash notification via issue comment failed: ${err}`,
    );
    return { ok: true, value: { delivered: false } };
  }
}

/**
 * Performs the webhook HTTP request. Injectable seam so the delivery path can
 * be exercised in tests without a real network call (mirrors the `nowFn`
 * injection convention used elsewhere in this module).
 */
export type WebhookFetch = typeof fetch;

/**
 * Send crash details to an optional webhook via HTTP POST.
 *
 * All errors are suppressed — notification must never block cleanup.
 *
 * `fetchFn` is injectable for tests; production uses the global `fetch`.
 */
export async function notifyCrashViaWebhook(
  config: CrashNotificationConfig,
  params: CrashNotificationParams,
  fetchFn: WebhookFetch = fetch,
): Promise<Result<{ delivered: boolean }>> {
  if (!config.webhookUrl) {
    return { ok: true, value: { delivered: false } };
  }

  const workerId = config.workerName || "unknown";
  const signalName = signalNameFromExitCode(params.exitCode);
  const activity = params.repo && params.issueNumber
    ? `issue #${params.issueNumber} in ${params.repo}`
    : "none";

  const payload = JSON.stringify({
    worker_id: workerId,
    exit_code: params.exitCode,
    signal: signalName,
    timestamp: new Date().toISOString(),
    last_activity: activity,
    repo: params.repo,
    issue: String(params.issueNumber || ""),
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    await fetchFn(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return { ok: true, value: { delivered: true } };
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `crash notification via webhook failed: ${err}`,
    );
    return { ok: true, value: { delivered: false } };
  }
}

/**
 * Orchestrator: send crash notifications if appropriate.
 *
 * This is the main entry point. It:
 *   1. Checks if the exit is a crash (non-zero, unplanned)
 *   2. Checks rate limiting to prevent spam
 *   3. Posts to GitHub issue comment (if an issue was in progress)
 *   4. Posts to webhook (if configured)
 *   5. Records the notification timestamp — only when something was delivered
 *
 * `notified` says what actually reached a human (Issue #556). Both channels
 * are optional: a crash with no in-flight issue on a host with no webhook has
 * nowhere to report, and answering `notified: true` there told the caller an
 * incident had been raised when none had. The caller then suppressed every
 * later failure of the streak as "already reported" — the shape of the
 * ten-hour GRQ-23 outage nobody was told about.
 */
export async function sendCrashNotification(
  config: CrashNotificationConfig,
  params: CrashNotificationParams,
): Promise<Result<{ notified: boolean; reason?: string }>> {
  // Only notify on unexpected exits
  if (!isCrashExit(params.exitCode, params.plannedShutdown)) {
    return { ok: true, value: { notified: false, reason: "clean_exit" } };
  }

  // Rate-limit to prevent spam during crash loops
  const rateLimited = await shouldRateLimitNotification(config);
  if (rateLimited) {
    return { ok: true, value: { notified: false, reason: "rate_limited" } };
  }

  // Post GitHub issue comment
  const comment = await notifyCrashViaIssueComment(config, params);

  // Post to webhook if configured
  const webhook = await notifyCrashViaWebhook(config, params);

  const delivered = (comment.ok && comment.value.delivered) ||
    (webhook.ok && webhook.value.delivered);
  if (!delivered) {
    // No cooldown either: nothing was said, so the next attempt must not be
    // rate-limited against a notification that never happened.
    return { ok: true, value: { notified: false, reason: "no_channel" } };
  }

  // Record that we sent a notification. A failure here means the next crash
  // in the loop is NOT rate-limited, so it is said out loud rather than
  // discarded (Issue #515).
  const recorded = await recordNotificationSent(config);
  if (!recorded.ok) {
    console.warn(
      `[crash-notification] Could not record the rate-limit state in ` +
        `${config.stateDir}: ${recorded.error.message} — the next crash ` +
        `notification will not be rate-limited`,
    );
  }

  return { ok: true, value: { notified: true } };
}
