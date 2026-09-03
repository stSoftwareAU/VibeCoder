/**
 * Escalation cleanup (Issue #1487).
 *
 * When the worker has escalated an issue by adding `needs-human`, the
 * discovery labels (`workOnLabel` and each `issueLabels` entry) must be
 * stripped so the issue is no longer surfaced by `fetchIssuesByLabel`.
 *
 * This is defence in depth against the label_security behaviour that strips
 * operational labels added by untrusted authors: because the worker's own
 * account is not in `allowedAuthors`, the worker-added `needs-human` label
 * is removed from the in-memory label list before `filterAndSort` can see
 * it — so the issue gets re-picked. Removing the discovery labels means the
 * issue never reaches the filter stage at all.
 */

import { runGhCommand } from "./github.ts";

/**
 * Minimal slice of WorkerConfig required for escalation cleanup.
 * Kept narrow so callers can pass an inline object in tests without
 * constructing a full WorkerConfig.
 */
export interface EscalationConfig {
  needsHumanLabel: string;
  workOnLabel: string;
  issueLabels: string[];
}

/**
 * If `needsHumanLabel` is present on the issue, remove the worker's
 * discovery labels (`workOnLabel` and each `issueLabels` entry) so the
 * issue is no longer surfaced by label-based discovery.
 *
 * Best-effort: any gh failure is swallowed — the escalation has already
 * happened, and a crash here would mask the escalation outcome in logs.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param config - Label configuration (see EscalationConfig)
 * @param ghCommandFn - Optional gh command function for testing
 * @returns The discovery labels actually removed, so the caller can say what
 *   must be restored (Issue #854).
 */
export async function stripDiscoveryLabelsOnEscalation(
  repo: string,
  issueNumber: number,
  config: EscalationConfig,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<string[]> {
  let currentLabels: string[];
  try {
    const output = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels",
    ]);
    const parsed = JSON.parse(output) as { labels?: Array<{ name: string }> };
    currentLabels = (parsed.labels ?? []).map((l) => l.name);
  } catch {
    return [];
  }

  if (!currentLabels.includes(config.needsHumanLabel)) {
    return [];
  }

  const toRemove = new Set<string>([config.workOnLabel, ...config.issueLabels]);
  const removed: string[] = [];
  for (const label of currentLabels) {
    if (!toRemove.has(label)) continue;
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-label",
        label,
      ]);
      removed.push(label);
    } catch {
      // Non-fatal — continue with remaining labels.
    }
  }

  // Issue #854: recovery needs BOTH labels restored, and until now nothing
  // said so. The escalation comment tells the reader to clear the block; the
  // discovery label is stripped silently afterwards, so an operator who does
  // exactly what they were told leaves the issue invisible rather than
  // claimable — no longer parked, simply never picked up again.
  //
  // Posted only when labels were actually removed. A second escalation finds
  // them already gone and removes nothing, so this does not repeat.
  if (removed.length > 0) {
    const list = removed.map((l) => `\`${l}\``).join(", ");
    const body = `## Discovery labels removed\n\n` +
      `**Why:** \`${config.needsHumanLabel}\` is on this issue, so the ` +
      `worker removed ${list} to stop label-based discovery re-surfacing it ` +
      `(Issue #1487).\n\n` +
      `**To resume:** remove \`${config.needsHumanLabel}\` **and** re-add ` +
      `${list}. Clearing \`${config.needsHumanLabel}\` alone leaves this ` +
      `issue with no discovery label, so nothing will claim it.`;
    try {
      await ghCommandFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        body,
      ]);
    } catch {
      // Best-effort: the labels are already correct, and a failed comment
      // must not mask the escalation outcome.
    }
  }

  return removed;
}
