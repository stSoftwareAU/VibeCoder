/**
 * Alerting when open PRs block all issues in a repository (Issue #745, #909).
 *
 * When all issues in a repository are blocked by open PRs for an extended
 * period (configurable via alertHours, default 24 hours), posts a warning
 * comment on the blocking PR(s).
 *
 * State is tracked in $workDir/.repo_blocked_state using pipe-delimited
 * format: repo|first_detected_timestamp|alerted|issue_count|prs_json
 *
 * The alert is posted once per blocking period. When the blocking is resolved
 * (via clearRepoBlocked), the state resets so a new alert can be posted
 * if blocking recurs.
 *
 * Migrated from worker/shared/repo_blocked_alert.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import { spawnGh } from "./gh_spawn.ts";

/** Configuration for repo blocked alerts. */
export interface RepoBlockedAlertConfig {
  /** Working directory for state file. */
  workDir: string;
  /** Hours before alert is posted (default: 24). */
  alertHours: number;
}

/** A single entry in the blocked state file. */
export interface BlockedEntry {
  repo: string;
  firstDetected: number;
  alerted: boolean;
  issueCount: number;
  prsJson: string;
}

/** Default alert threshold in hours. */
export const DEFAULT_REPO_BLOCKED_ALERT_HOURS = 24;

const STATE_FILENAME = ".repo_blocked_state";

function stateFilePath(workDir: string): string {
  return `${workDir}/${STATE_FILENAME}`;
}

/**
 * Parse the state file into entries.
 */
async function readStateEntries(workDir: string): Promise<BlockedEntry[]> {
  const path = stateFilePath(workDir);
  try {
    const content = await Deno.readTextFile(path);
    const entries: BlockedEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length < 5) continue;
      entries.push({
        repo: parts[0]!,
        firstDetected: parseInt(parts[1]!, 10),
        alerted: parts[2] === "true",
        issueCount: parseInt(parts[3]!, 10),
        prsJson: parts.slice(4).join("|"),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Write entries back to the state file atomically.
 */
async function writeStateEntries(
  workDir: string,
  entries: BlockedEntry[],
): Promise<Result<void>> {
  const lines = entries.map(
    (e) =>
      `${e.repo}|${e.firstDetected}|${e.alerted}|${e.issueCount}|${e.prsJson}`,
  );
  const result = await atomicWrite({
    targetFile: stateFilePath(workDir),
    content: lines.length > 0 ? lines.join("\n") + "\n" : "",
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(
      `Failed to write repo blocked state: ${result.error.message}`,
    ),
  };
}

/**
 * Extract and sort PR numbers from a JSON array of PRs.
 */
function extractPrNumbers(prsJson: string): string {
  try {
    const prs = JSON.parse(prsJson) as Array<{ number: number }>;
    return prs.map((p) => p.number).sort((a, b) => a - b).join(",");
  } catch {
    return "";
  }
}

/**
 * Record that all issues in a repo are blocked by PRs.
 *
 * Only creates a new entry if the repo is not already tracked (preserves
 * original detection timestamp). If the blocking PRs changed (Issue #936),
 * resets the entry with a fresh timestamp.
 */
export async function recordRepoBlocked(
  config: RepoBlockedAlertConfig,
  repo: string,
  blockedIssueCount: number,
  prsJson: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<void>> {
  const entries = await readStateEntries(config.workDir);
  const existingIdx = entries.findIndex((e) => e.repo === repo);

  if (existingIdx >= 0) {
    // Issue #936: Check if blocking PRs changed
    const stored = entries[existingIdx];
    if (stored !== undefined) {
      const storedNums = extractPrNumbers(stored.prsJson);
      const currentNums = extractPrNumbers(prsJson);

      if (storedNums === currentNums) {
        return { ok: true, value: undefined }; // Same PRs — preserve existing
      }

      // PRs changed — remove old entry, record fresh one below
      entries.splice(existingIdx, 1);
    }
  }

  entries.push({
    repo,
    firstDetected: nowFn(),
    alerted: false,
    issueCount: blockedIssueCount,
    prsJson,
  });

  return await writeStateEntries(config.workDir, entries);
}

/**
 * Clear blocking state for a repo.
 *
 * Called when a repo is no longer fully blocked by open PRs.
 */
export async function clearRepoBlocked(
  config: RepoBlockedAlertConfig,
  repo: string,
): Promise<Result<void>> {
  const entries = await readStateEntries(config.workDir);
  const filtered = entries.filter((e) => e.repo !== repo);
  if (filtered.length === entries.length) {
    return { ok: true, value: undefined }; // Not tracked
  }
  return await writeStateEntries(config.workDir, filtered);
}

/**
 * Run a gh command. Returns true on success.
 */
async function runGh(args: string[]): Promise<boolean> {
  try {
    const result = await spawnGh(args, { stdout: "null", stderr: "null" });
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Post warning comments on blocking PRs.
 */
async function postRepoBlockedAlerts(
  repo: string,
  blockedIssueCount: number,
  hoursBlocked: number,
  prsJson: string,
): Promise<void> {
  const commentBody = `## \u26a0\ufe0f Issues Blocked Alert

This PR is blocking **${blockedIssueCount} issue(s)** in \`${repo}\` from being processed.

**Duration**: Issues have been blocked for approximately **${hoursBlocked} hours**.

### Suggested Actions

1. **Merge this PR** if it is ready for review/merge
2. **Close this PR** if the changes are no longer needed
3. **Add the \`ignore-open-prs\` label** to specific issues that should be processed despite open PRs

_This is an automated alert from the VibeCoder worker (Issue #745). It is posted once per blocking period._`;

  try {
    const prs = JSON.parse(prsJson) as Array<{ number: number }>;
    for (const pr of prs) {
      await runGh([
        "pr",
        "comment",
        String(pr.number),
        "--repo",
        repo,
        "--body",
        commentBody,
      ]);
    }
  } catch {
    // Parse failure or gh failure — non-fatal
  }
}

/**
 * Check if alert threshold is reached and post alert if needed.
 *
 * Returns true if an alert was posted.
 */
export async function checkRepoBlockedAlert(
  config: RepoBlockedAlertConfig,
  repo: string,
  blockedIssueCount: number,
  prsJson: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<boolean>> {
  const entries = await readStateEntries(config.workDir);
  const entry = entries.find((e) => e.repo === repo);
  if (!entry) return { ok: true, value: false };

  // Already alerted for this blocking period
  if (entry.alerted) return { ok: true, value: false };

  // Check threshold
  const thresholdSeconds = config.alertHours * 3600;
  const elapsed = nowFn() - entry.firstDetected;
  if (elapsed < thresholdSeconds) return { ok: true, value: false };

  // Threshold exceeded — post alerts
  const hoursBlocked = Math.floor(elapsed / 3600);
  await postRepoBlockedAlerts(repo, blockedIssueCount, hoursBlocked, prsJson);

  // Mark as alerted
  entry.alerted = true;
  const writeResult = await writeStateEntries(config.workDir, entries);
  if (!writeResult.ok) return writeResult as Result<boolean>;

  return { ok: true, value: true };
}
