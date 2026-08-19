/**
 * Runner-deprecation finding filer (Issue #2256, extracted from
 * `best_practices_template.ts`).
 *
 * The github-actions-audit template (#4) and the best-practices template's
 * `github-actions` bucket both need to file synthetic `BP-RUNNER-…`
 * findings for the runner-deprecation warnings surfaced by
 * `runner_deprecation_scanner.ts`. The helpers were originally private to
 * `best_practices_template.ts`; this module is the shared source of truth
 * during the migration window. The audit template attaches the
 * `github-actions-audit` label (no `lang:` label), while the
 * best-practices `github-actions` bucket continues to attach
 * `best-practices` + `lang:github-actions` for back-compat.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import type {
  DeprecationFinding,
  GhCommandFn,
} from "./runner_deprecation_scanner.ts";
import { EOL_RUNTIMES } from "./github_actions_catalogue.ts";

// ---------------------------------------------------------------------------
// Severity classifier
// ---------------------------------------------------------------------------

/**
 * Classify a {@link DeprecationFinding} into a `severity:` label.
 *
 *   - `severity:high` — runtime removal already in effect or imminent.
 *     Node versions in {@link EOL_RUNTIMES} `eolVersions` are fully past
 *     end-of-life; versions in `eolSoonVersions` are scheduled for
 *     removal on GitHub-hosted runners within months (e.g. Node 20 on
 *     2026-06-02). Both map to high.
 *   - `severity:medium` — runtime deprecation announced but not yet
 *     enforced (e.g. a future major version warning).
 *   - `severity:low` — legacy command deprecations (`set-output`,
 *     `save-state`) that still function but should be migrated.
 *
 * Exported so tests can drive the classifier directly without going
 * through {@link fileRunnerDeprecationIssue}.
 */
export function classifyRunnerDeprecationSeverity(
  finding: DeprecationFinding,
): "high" | "medium" | "low" {
  const reason = finding.reason;
  if (reason === "set-output" || reason === "save-state") return "low";
  const nodeMatch = reason.match(/^node(\d+)$/);
  if (nodeMatch && nodeMatch[1]) {
    const version = nodeMatch[1];
    const nodeEntry = EOL_RUNTIMES.find((e) => e.runtime === "Node.js");
    if (nodeEntry) {
      if (nodeEntry.eolVersions.includes(version)) return "high";
      if (nodeEntry.eolSoonVersions.includes(version)) return "high";
    }
    return "medium";
  }
  return "medium";
}

// ---------------------------------------------------------------------------
// Body section builders
// ---------------------------------------------------------------------------

/**
 * Render a "Why this matters" paragraph for a runner-deprecation
 * finding, citing the Node.js EOL timeline from the catalogue when the
 * finding is Node-related.
 */
export function buildRunnerWhyItMatters(finding: DeprecationFinding): string {
  if (finding.reason === "set-output" || finding.reason === "save-state") {
    return (
      `The runner reported that the legacy \`${finding.reason}\` workflow ` +
      "command is deprecated. GitHub has announced its removal — actions " +
      "still emitting these commands will break once the deprecation is " +
      "enforced. Migrate to environment files (`$GITHUB_OUTPUT`, " +
      "`$GITHUB_STATE`) before the cut-off."
    );
  }
  const nodeMatch = finding.reason.match(/^node(\d+)$/);
  if (nodeMatch) {
    const nodeEntry = EOL_RUNTIMES.find((e) => e.runtime === "Node.js");
    if (nodeEntry) {
      return (
        `The runner reported a Node.js ${nodeMatch[1]} actions deprecation ` +
        `warning for \`${finding.action}@${finding.pinnedRef}\`. ` +
        nodeEntry.reasoning
      );
    }
  }
  return (
    `The runner reported a deprecation warning (\`${finding.reason}\`) for ` +
    `\`${finding.action}@${finding.pinnedRef}\`. Address it before the ` +
    "deprecation is enforced and the workflow breaks."
  );
}

/**
 * Render a "Suggested fix" paragraph for a runner-deprecation finding.
 * Prefers a concrete remediation step over generic guidance.
 */
export function buildRunnerSuggestedFix(finding: DeprecationFinding): string {
  if (finding.reason === "set-output") {
    return (
      "Bump the action to its current major (which has migrated to " +
      "`$GITHUB_OUTPUT`), or — if the action is no longer maintained — " +
      "replace the step with a direct shell write to `$GITHUB_OUTPUT`."
    );
  }
  if (finding.reason === "save-state") {
    return (
      "Bump the action to its current major (which has migrated to " +
      "`$GITHUB_STATE`), or — if the action is no longer maintained — " +
      "replace the step with a direct shell write to `$GITHUB_STATE`."
    );
  }
  if (/^node\d+$/.test(finding.reason)) {
    return (
      `Bump \`${finding.action}\` to its current major (the catalogue in ` +
      "the bucket guide records the latest), or migrate away from the " +
      "Node-based action if the upstream maintainer has not shipped a new " +
      "release on a supported Node runtime."
    );
  }
  return (
    `Bump \`${finding.action}\` to its current major or migrate away from ` +
    "the action if the upstream maintainer has not shipped a fix."
  );
}

// ---------------------------------------------------------------------------
// File-a-finding helper
// ---------------------------------------------------------------------------

/**
 * Options for {@link fileRunnerDeprecationIssue}. The caller picks the
 * primary scan label (e.g. `best-practices` or `github-actions-audit`)
 * and any extra labels (e.g. `lang:github-actions` for the legacy
 * best-practices bucket; the audit template passes none).
 */
export interface FileRunnerDeprecationIssueOptions {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Finding to file. */
  finding: DeprecationFinding;
  /** gh CLI runner. */
  ghCommandFn: GhCommandFn;
  /**
   * Primary scan label (e.g. `best-practices`, `github-actions-audit`).
   * Always attached.
   */
  scanLabel: string;
  /**
   * Extra labels (besides the scan label and the auto-computed
   * `severity:*`). The best-practices bucket passes `lang:github-actions`
   * here; the audit template passes `[]`.
   */
  extraLabels?: readonly string[];
}

/**
 * File a synthetic runner-deprecation issue and return its number plus
 * the stable finding id.
 *
 * The finding carries:
 *   - The `BP-RUNNER-…` stable id (embedded as the HTML marker).
 *   - The caller-supplied `scanLabel`, any `extraLabels`, and a severity
 *     label chosen by {@link classifyRunnerDeprecationSeverity}.
 *   - A body with "Why this matters" (citing the EOL timeline) and
 *     "Suggested fix" sections, plus the evidence captured by the
 *     scanner.
 *
 * Returns `null` on any gh failure — the caller logs it in the
 * summary and continues.
 */
export async function fileRunnerDeprecationIssue(
  opts: FileRunnerDeprecationIssueOptions,
): Promise<{ number: number; findingId: string } | null> {
  const { repo, finding, ghCommandFn, scanLabel } = opts;
  const extraLabels = opts.extraLabels ?? [];
  const severity = classifyRunnerDeprecationSeverity(finding);
  const emoji = severity === "high"
    ? "🔴"
    : severity === "medium"
    ? "🟠"
    : "🟡";
  const title =
    `${emoji} Runner deprecation: \`${finding.action}@${finding.pinnedRef}\` ` +
    `(\`${finding.reason}\`)`;
  const body = [
    `<!-- finding-id: ${finding.stableId} -->`,
    "",
    `**Bucket:** \`github-actions\``,
    `**Severity:** ${severity} (runner deprecation: ${finding.reason})`,
    `**Action:** \`${finding.action}@${finding.pinnedRef}\``,
    "",
    "## Why this matters",
    "",
    buildRunnerWhyItMatters(finding),
    "",
    "## Suggested fix",
    "",
    buildRunnerSuggestedFix(finding),
    "",
    "## Evidence",
    "",
    finding.evidence,
  ].join("\n");

  const args: string[] = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    scanLabel,
  ];
  for (const extra of extraLabels) {
    args.push("--label", extra);
  }
  args.push("--label", `severity:${severity}`);

  let raw: string;
  try {
    raw = await ghCommandFn(args);
  } catch {
    return null;
  }

  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId: finding.stableId };
}
