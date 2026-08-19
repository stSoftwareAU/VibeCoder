/**
 * Heartbeat-recovery audit (Issue #1885).
 *
 * Pure classification logic for one-shot diagnostic audits of the
 * `Assigned-without-heartbeat recovery (Issue #632)` recovery events
 * posted by `detectAssignedWithoutHeartbeat`. Used to quantify how
 * often the recovery is firing on issues that were not, in fact,
 * crashed (parent #1883).
 *
 * Single responsibility: given the observable state of an issue at the
 * moment a recovery comment was posted, return one of four categories.
 * Network/IO and report rendering live in the command module.
 *
 * Uses Australian English throughout (behaviour, colour, organisation,
 * favour).
 */

import { assertNever } from "./assert_never.ts";
import { parseHeartbeatMarker } from "./heartbeat_storage.ts";

/** Marker text the worker writes when posting an Issue #632 recovery. */
export const ASSIGNED_WITHOUT_HEARTBEAT_MARKER =
  "Assigned-without-heartbeat recovery (Issue #632)";

/**
 * Near-duplicate phrasings the worker has historically used. New
 * variants should be appended here so the audit picks up regressions
 * even if the canonical marker is reworded later.
 */
export const RECOVERY_NEEDLES: ReadonlyArray<string> = [
  ASSIGNED_WITHOUT_HEARTBEAT_MARKER,
  // Earlier wording — kept defensively in case any cached comment
  // bodies still use it.
  "Assigned without heartbeat recovery (Issue #632)",
];

/**
 * Classification of a single recovery event.
 *
 *  - `legitimate-crash` — there is no published heartbeat marker (or
 *    the marker is stale beyond the recovery threshold), no linked
 *    PR, and the issue was not subsequently re-claimed and merged.
 *  - `false-positive:cleared-marker` — a heartbeat marker existed and
 *    was already cleared (epoch=0 + `cleared:` suffix) at recovery
 *    time, meaning the worker deliberately released the claim and
 *    nothing was actually wrong.
 *  - `false-positive:open-pr` — at recovery time an open PR linked to
 *    the issue existed; the worker was waiting on review/merge, not
 *    crashed.
 *  - `false-positive:other` — any other shape suggesting the worker
 *    had not crashed (e.g. a live marker that the recovery code
 *    nevertheless fired on, or work that completed cleanly after the
 *    recovery).
 */
export type RecoveryCategory =
  | "legitimate-crash"
  | "false-positive:cleared-marker"
  | "false-positive:open-pr"
  | "false-positive:other";

/** Marker state observed at the moment of the recovery comment. */
export type MarkerStateAtRecovery =
  | "none" // no VIBE_CODER_HEARTBEAT comment found
  | "live" // latest marker epoch within timeout window
  | "stale" // markers present but all older than the timeout
  | "cleared" // latest marker epoch === 0 (clearHeartbeat called)
  | "malformed"; // marker present but no parseable epoch

/**
 * Inputs to the classifier — the observable state of an issue at the
 * moment a recovery comment was posted.
 */
export interface RecoveryAuditEvent {
  /**
   * Marker state derived from the issue's comments preceding the
   * recovery comment. See `deriveMarkerStateAtRecovery`.
   */
  markerStateAtRecovery: MarkerStateAtRecovery;
  /** True if at least one open PR linked to the issue at recovery time. */
  openPrLinkedAtRecovery: boolean;
  /** True if the worker was re-assigned after the recovery comment. */
  reclaimedAfterRecovery: boolean;
  /** True if a PR for this issue was eventually merged after recovery. */
  prMergedAfterRecovery: boolean;
}

/**
 * Classify a recovery event.
 *
 * The four categories are mutually exclusive — the order of checks
 * matches the priority described in the issue: an open PR or a cleared
 * marker take precedence over any other signal because either one
 * proves the recovery code was wrong to fire.
 */
export function classifyRecoveryEvent(
  ev: RecoveryAuditEvent,
): RecoveryCategory {
  if (ev.openPrLinkedAtRecovery) {
    return "false-positive:open-pr";
  }
  if (ev.markerStateAtRecovery === "cleared") {
    return "false-positive:cleared-marker";
  }
  // A live marker at recovery time means the recovery scan disagreed
  // with itself — definitely not a crash.
  if (ev.markerStateAtRecovery === "live") {
    return "false-positive:other";
  }
  // No PR, no live/cleared marker, and the worker never resumed work
  // and never produced a merged PR — the most genuine "crash" shape.
  if (
    !ev.reclaimedAfterRecovery &&
    !ev.prMergedAfterRecovery &&
    (ev.markerStateAtRecovery === "none" ||
      ev.markerStateAtRecovery === "stale" ||
      ev.markerStateAtRecovery === "malformed")
  ) {
    return "legitimate-crash";
  }
  // Fell through: e.g. stale marker but the issue completed cleanly
  // afterwards — suggests the worker had not actually crashed.
  return "false-positive:other";
}

/**
 * A single comment fetched from `repos/{owner}/{repo}/issues/{n}/comments`.
 * Only the fields the audit actually reads are required.
 */
export interface AuditComment {
  body: string;
  created_at: string;
}

/**
 * Inspect every comment posted before `recoveryIso` and derive the
 * marker state visible to a recovery scan running at that instant.
 *
 * `timeoutSeconds` matches the `assignedNoHeartbeatTimeout` used by
 * the production scan — markers older than this are treated as stale.
 */
export function deriveMarkerStateAtRecovery(
  comments: ReadonlyArray<AuditComment>,
  recoveryIso: string,
  timeoutSeconds: number,
): MarkerStateAtRecovery {
  const recoveryEpochMs = Date.parse(recoveryIso);
  if (!isFinite(recoveryEpochMs)) return "none";
  const recoveryEpoch = Math.floor(recoveryEpochMs / 1000);

  let latest: { machineId: string; epoch: number } | null = null;
  let latestBody: string | null = null;
  for (const c of comments) {
    const t = Date.parse(c.created_at);
    if (!isFinite(t) || t > recoveryEpochMs) continue;
    const m = parseHeartbeatMarker(c.body);
    if (m === null) continue;
    if (latest === null || m.epoch > latest.epoch) {
      latest = m;
      latestBody = c.body;
    }
  }

  if (latest === null) return "none";
  if (latest.epoch === 0) {
    // `clearHeartbeat` writes epoch=0 with a `cleared:` suffix. Treat
    // both shapes as cleared so a malformed clear still classifies as
    // a deliberate release rather than a crash.
    return "cleared";
  }
  // Defensive — `parseHeartbeatMarker` already rejects NaN epochs but
  // an additional sanity check keeps the classifier honest if the
  // upstream parser ever changes.
  if (!isFinite(latest.epoch)) return "malformed";
  if (recoveryEpoch - latest.epoch <= timeoutSeconds) return "live";
  // Touch latestBody so the linter sees the read; the value is
  // captured in case future heuristics need to inspect the cleared
  // suffix text.
  if (latestBody === null) return "stale";
  return "stale";
}

/**
 * Find every recovery comment in the comment list. Returns one entry
 * per matching comment so multiple recoveries on the same issue are
 * counted independently.
 */
export function findRecoveryComments(
  comments: ReadonlyArray<{ id: number; body: string; created_at: string }>,
): ReadonlyArray<{ id: number; created_at: string }> {
  const out: Array<{ id: number; created_at: string }> = [];
  for (const c of comments) {
    if (typeof c.body !== "string") continue;
    if (RECOVERY_NEEDLES.some((needle) => c.body.includes(needle))) {
      out.push({ id: c.id, created_at: c.created_at });
    }
  }
  return out;
}

/**
 * Aggregate counts produced by classifying a batch of events.
 */
export interface AuditTotals {
  total: number;
  legitimateCrash: number;
  falsePositiveClearedMarker: number;
  falsePositiveOpenPr: number;
  falsePositiveOther: number;
}

/** Compute aggregate counts from a list of categorised events. */
export function tallyCategories(
  categories: ReadonlyArray<RecoveryCategory>,
): AuditTotals {
  const totals: AuditTotals = {
    total: categories.length,
    legitimateCrash: 0,
    falsePositiveClearedMarker: 0,
    falsePositiveOpenPr: 0,
    falsePositiveOther: 0,
  };
  for (const c of categories) {
    switch (c) {
      case "legitimate-crash":
        totals.legitimateCrash++;
        break;
      case "false-positive:cleared-marker":
        totals.falsePositiveClearedMarker++;
        break;
      case "false-positive:open-pr":
        totals.falsePositiveOpenPr++;
        break;
      case "false-positive:other":
        totals.falsePositiveOther++;
        break;
      default:
        assertNever(c);
    }
  }
  return totals;
}

/**
 * Render the markdown report. Pure function so the command can write
 * it to disk and tests can assert on the content.
 */
export interface ReportInput {
  generatedAtIso: string;
  windowDays: number;
  reposScanned: number;
  totals: AuditTotals;
  examples: ReadonlyMap<
    RecoveryCategory,
    ReadonlyArray<{
      repo: string;
      issueNumber: number;
      recoveryIso: string;
    }>
  >;
}

const CATEGORY_HEADINGS: ReadonlyArray<[RecoveryCategory, string]> = [
  ["legitimate-crash", "Legitimate crash"],
  ["false-positive:cleared-marker", "False positive: cleared marker"],
  ["false-positive:open-pr", "False positive: open PR linked"],
  ["false-positive:other", "False positive: other"],
];

export function renderReport(input: ReportInput): string {
  const { generatedAtIso, windowDays, reposScanned, totals, examples } = input;
  const lines: string[] = [];
  lines.push("# Heartbeat Recovery Audit");
  lines.push("");
  lines.push(`- **Generated at:** ${generatedAtIso}`);
  lines.push(`- **Window:** last ${windowDays} days`);
  lines.push(`- **Repos scanned:** ${reposScanned}`);
  lines.push(`- **Total recovery events:** ${totals.total}`);
  lines.push("");
  lines.push("## Breakdown by category");
  lines.push("");
  lines.push("| Category | Count | Share |");
  lines.push("| --- | ---: | ---: |");
  for (const [cat, heading] of CATEGORY_HEADINGS) {
    const count = countFor(totals, cat);
    const share = totals.total === 0
      ? "n/a"
      : `${Math.round((count / totals.total) * 1000) / 10}%`;
    lines.push(`| ${heading} | ${count} | ${share} |`);
  }
  lines.push("");
  for (const [cat, heading] of CATEGORY_HEADINGS) {
    lines.push(`### ${heading}`);
    lines.push("");
    const list = examples.get(cat) ?? [];
    if (list.length === 0) {
      lines.push("_No events in this category._");
    } else {
      for (const ex of list) {
        const url = `https://github.com/${ex.repo}/issues/${ex.issueNumber}`;
        lines.push(
          `- [${ex.repo}#${ex.issueNumber}](${url}) — ${ex.recoveryIso}`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Conclusion");
  lines.push("");
  lines.push(buildConclusion(totals));
  lines.push("");
  return lines.join("\n");
}

function countFor(totals: AuditTotals, cat: RecoveryCategory): number {
  switch (cat) {
    case "legitimate-crash":
      return totals.legitimateCrash;
    case "false-positive:cleared-marker":
      return totals.falsePositiveClearedMarker;
    case "false-positive:open-pr":
      return totals.falsePositiveOpenPr;
    case "false-positive:other":
      return totals.falsePositiveOther;
    default:
      return assertNever(cat);
  }
}

function buildConclusion(totals: AuditTotals): string {
  if (totals.total === 0) {
    return "No `Assigned-without-heartbeat recovery (Issue #632)` events" +
      " were observed in the audit window. The recovery code did not" +
      " fire — either nothing crashed, or the marker text has changed.";
  }
  const falsePositives = totals.falsePositiveClearedMarker +
    totals.falsePositiveOpenPr + totals.falsePositiveOther;
  const falsePositiveShare = Math.round(
    (falsePositives / totals.total) * 1000,
  ) / 10;
  const dominant = pickDominant(totals);
  return `Of ${totals.total} recovery events, ${falsePositives} ` +
    `(${falsePositiveShare}%) classify as false positives. ` +
    `The dominant shape was **${dominant}**. ` +
    `This snapshot informs which fixes to prioritise under parent #1883.`;
}

function pickDominant(totals: AuditTotals): string {
  const ranked: Array<[string, number]> = [
    ["legitimate crashes", totals.legitimateCrash],
    ["cleared-marker false positives", totals.falsePositiveClearedMarker],
    ["open-PR false positives", totals.falsePositiveOpenPr],
    ["other false positives", totals.falsePositiveOther],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0]![0];
}
