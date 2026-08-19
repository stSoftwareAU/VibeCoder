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
 */
export async function stripDiscoveryLabelsOnEscalation(
  repo: string,
  issueNumber: number,
  config: EscalationConfig,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<void> {
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
    return;
  }

  if (!currentLabels.includes(config.needsHumanLabel)) {
    return;
  }

  const toRemove = new Set<string>([config.workOnLabel, ...config.issueLabels]);
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
    } catch {
      // Non-fatal — continue with remaining labels.
    }
  }
}
