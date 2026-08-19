/**
 * Bulk triage of supply-chain / security findings (Issue #2403).
 *
 * The security-scan and supply-chain-* idle-task templates file findings
 * as ordinary GitHub issues carrying only their finding label (e.g.
 * `security`, `supply-chain-readiness`, `supply-chain:quarantine-missing`).
 * The worker is not authorised to apply pickup labels — `label_security.ts`
 * strips a worker-applied `work-on` — so under sustained supply-chain
 * inflow, a human must hand-toggle `work-on` per issue. That manual step is
 * the triage bottleneck.
 *
 * This module provides a pure-logic batch processor that walks a set of
 * monitored repos, finds open finding-labelled issues, applies severity
 * and minimum-age filters, and (unless `dryRun` is set) applies a pickup
 * label in bulk. A human runs the wrapping command with their own gh
 * credentials so the trusted-author allowlist check passes and the
 * label is honoured.
 *
 * The function is dependency-injected for testing: a stub `ghCommandFn`
 * supplies issue rows, and a stub `addLabelFn` records would-be label
 * writes without touching the network.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { addLabelToIssue } from "./label_operations.ts";
import { assertNever } from "./assert_never.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The three severity labels recognised by the finding-emitting templates. */
export const SEVERITY_LABELS: readonly string[] = [
  "severity:high",
  "severity:medium",
  "severity:low",
] as const;

/**
 * Default findings labels — the labels under which the security-scan and
 * supply-chain templates file their findings. Callers may override.
 */
export const DEFAULT_FINDINGS_LABELS: readonly string[] = [
  "security",
  "supply-chain-readiness",
  "supply-chain:quarantine-missing",
  "supply-chain:quarantine-misconfigured",
] as const;

/** Default pickup label applied when the human runs the triage command. */
export const DEFAULT_APPLY_LABEL = "work-on";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal issue shape returned by `gh issue list --json ...`. */
export interface TriageableIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}

/** Structured event emitted while the triage walks each repo. */
export type BulkTriageEvent =
  | {
    kind: "labelled";
    repo: string;
    number: number;
    appliedLabel: string;
    matchedLabel: string;
    severity?: string;
  }
  | {
    kind: "would_label";
    repo: string;
    number: number;
    appliedLabel: string;
    matchedLabel: string;
    severity?: string;
  }
  | {
    kind: "skipped_already_labelled";
    repo: string;
    number: number;
    appliedLabel: string;
  }
  | {
    kind: "skipped_severity";
    repo: string;
    number: number;
    severities: readonly string[];
  }
  | {
    kind: "skipped_age";
    repo: string;
    number: number;
    ageDays: number;
    minAgeDays: number;
  }
  | { kind: "skipped_cap"; repo: string; number: number; max: number }
  | { kind: "error"; repo: string; message: string };

/** Aggregate outcome of a triage run. */
export interface BulkTriageSummary {
  labelled: number;
  wouldLabel: number;
  alreadyLabelled: number;
  skippedSeverity: number;
  skippedAge: number;
  skippedCap: number;
  errors: number;
  dryRun: boolean;
}

/** Options accepted by {@link runBulkTriage}. */
export interface BulkTriageOptions {
  /** Monitored repo slugs (`owner/name`). */
  repos: readonly string[];
  /** Pickup label to apply (default: {@link DEFAULT_APPLY_LABEL}). */
  applyLabel?: string;
  /**
   * Finding-label selectors — issue must carry at least one. Defaults
   * to {@link DEFAULT_FINDINGS_LABELS}.
   */
  findingsLabels?: readonly string[];
  /**
   * Severity filter — issue must carry one of these severity labels.
   * Empty array (default) means no severity filter — every severity
   * is accepted, including findings with no severity label.
   */
  severities?: readonly string[];
  /** Minimum age in days for the issue (createdAt). Default: 0. */
  minAgeDays?: number;
  /** Maximum number of label writes per run. Default: 50. */
  max?: number;
  /** Dry-run: do not apply labels, only log `would_label` events. */
  dryRun?: boolean;
  /** Optional clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable gh runner. Defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injectable label-add function. Defaults to {@link addLabelToIssue}. */
  addLabelFn?: (
    repo: string,
    issueNumber: number,
    label: string,
    deps: { ghCommandFn?: (args: string[]) => Promise<string> },
  ) => Promise<Result<void>>;
  /** Per-event sink. Defaults to a no-op. */
  log?: (event: BulkTriageEvent) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return the first severity label carried by `labels`, or undefined if
 * none is present. Higher severity (`high`) wins over lower (`low`).
 */
export function classifySeverity(
  labels: readonly string[],
): string | undefined {
  for (const s of SEVERITY_LABELS) {
    if (labels.includes(s)) return s;
  }
  return undefined;
}

/**
 * Return the age of an ISO 8601 `createdAt` timestamp in whole days,
 * clamped to 0. Malformed timestamps produce 0 so a corrupt row never
 * masquerades as ancient.
 */
export function ageInDays(createdAt: string, now: Date): number {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const ms = now.getTime() - t;
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Walk every repo in `opts.repos`, find open issues carrying any of the
 * configured findings labels, apply severity + age filters, and (unless
 * `dryRun`) apply the pickup label to each surviving issue up to `max`.
 *
 * Per-repo gh failures are captured in `summary.errors` and never abort
 * the rest of the walk.
 */
export async function runBulkTriage(
  opts: BulkTriageOptions,
): Promise<BulkTriageSummary> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const log = opts.log ?? (() => {});
  const addLabelFn = opts.addLabelFn ?? addLabelToIssue;
  const applyLabel = opts.applyLabel ?? DEFAULT_APPLY_LABEL;
  const findingsLabels = opts.findingsLabels ?? DEFAULT_FINDINGS_LABELS;
  const severities = opts.severities ?? [];
  const minAgeDays = opts.minAgeDays ?? 0;
  const max = opts.max ?? 50;
  const dryRun = opts.dryRun ?? false;
  const nowFn = opts.now ?? (() => new Date());

  const summary: BulkTriageSummary = {
    labelled: 0,
    wouldLabel: 0,
    alreadyLabelled: 0,
    skippedSeverity: 0,
    skippedAge: 0,
    skippedCap: 0,
    errors: 0,
    dryRun,
  };

  // Live counter — `labelled` and `wouldLabel` both consume capacity so
  // a dry-run still surfaces the cap.
  let written = 0;

  for (const repo of opts.repos) {
    // Dedup across the per-label queries: one issue may carry multiple
    // findings labels at once and gh returns it once per query.
    const seen = new Map<number, { issue: TriageableIssue; matched: string }>();

    let repoFailed = false;
    for (const label of findingsLabels) {
      if (repoFailed) break;

      let raw: string;
      try {
        raw = await gh([
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          label,
          "--json",
          "number,title,url,labels,createdAt",
          "--limit",
          "100",
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors++;
        log({ kind: "error", repo, message });
        repoFailed = true;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error
          ? `malformed gh JSON: ${err.message}`
          : `malformed gh JSON: ${String(err)}`;
        summary.errors++;
        log({ kind: "error", repo, message });
        repoFailed = true;
        continue;
      }
      if (!Array.isArray(parsed)) continue;

      for (const row of parsed) {
        const issue = normaliseIssueRow(row);
        if (!issue) continue;
        if (!seen.has(issue.number)) {
          seen.set(issue.number, { issue, matched: label });
        }
      }
    }

    // Process each unique issue oldest-first so the human's mental
    // model — "drain the oldest first" — matches the order the worker
    // observes once the pickup label lands.
    const ordered = Array.from(seen.values()).sort((a, b) =>
      a.issue.createdAt.localeCompare(b.issue.createdAt)
    );

    for (const { issue, matched } of ordered) {
      // Skip if the pickup label is already present.
      if (issue.labels.includes(applyLabel)) {
        summary.alreadyLabelled++;
        log({
          kind: "skipped_already_labelled",
          repo,
          number: issue.number,
          appliedLabel: applyLabel,
        });
        continue;
      }

      // Severity filter.
      const severity = classifySeverity(issue.labels);
      if (severities.length > 0) {
        if (severity === undefined || !severities.includes(severity)) {
          summary.skippedSeverity++;
          log({
            kind: "skipped_severity",
            repo,
            number: issue.number,
            severities,
          });
          continue;
        }
      }

      // Age filter.
      if (minAgeDays > 0) {
        const age = ageInDays(issue.createdAt, nowFn());
        if (age < minAgeDays) {
          summary.skippedAge++;
          log({
            kind: "skipped_age",
            repo,
            number: issue.number,
            ageDays: age,
            minAgeDays,
          });
          continue;
        }
      }

      // Cap.
      if (written >= max) {
        summary.skippedCap++;
        log({ kind: "skipped_cap", repo, number: issue.number, max });
        continue;
      }

      if (dryRun) {
        summary.wouldLabel++;
        written++;
        log({
          kind: "would_label",
          repo,
          number: issue.number,
          appliedLabel: applyLabel,
          matchedLabel: matched,
          severity,
        });
        continue;
      }

      const res = await addLabelFn(repo, issue.number, applyLabel, {
        ghCommandFn: gh,
      });
      if (res.ok) {
        summary.labelled++;
        written++;
        log({
          kind: "labelled",
          repo,
          number: issue.number,
          appliedLabel: applyLabel,
          matchedLabel: matched,
          severity,
        });
      } else {
        summary.errors++;
        log({ kind: "error", repo, message: res.error.message });
      }
    }
  }

  return summary;
}

/**
 * Parse a single row from `gh issue list --json number,title,url,labels,createdAt`.
 * Returns undefined if the row is malformed.
 */
function normaliseIssueRow(row: unknown): TriageableIssue | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const obj = row as Record<string, unknown>;
  const number = obj.number;
  const title = obj.title;
  const url = obj.url;
  const createdAt = obj.createdAt;
  const rawLabels = obj.labels;

  if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  if (typeof title !== "string") return undefined;
  if (typeof url !== "string") return undefined;
  if (typeof createdAt !== "string") return undefined;
  if (!Array.isArray(rawLabels)) return undefined;

  const labels: string[] = [];
  for (const l of rawLabels) {
    if (l !== null && typeof l === "object") {
      const name = (l as { name?: unknown }).name;
      if (typeof name === "string") labels.push(name);
    } else if (typeof l === "string") {
      labels.push(l);
    }
  }

  return { number, title, url, createdAt, labels };
}

// ---------------------------------------------------------------------------
// Structured log helpers
// ---------------------------------------------------------------------------

/** Render a single triage event as a canonical `[bulk-triage] ...` log line. */
export function formatBulkTriageEvent(event: BulkTriageEvent): string {
  switch (event.kind) {
    case "labelled": {
      const sev = event.severity ? ` severity=${event.severity}` : "";
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=labelled label=${event.appliedLabel} ` +
        `matched=${event.matchedLabel}${sev}`;
    }
    case "would_label": {
      const sev = event.severity ? ` severity=${event.severity}` : "";
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=would_label label=${event.appliedLabel} ` +
        `matched=${event.matchedLabel}${sev}`;
    }
    case "skipped_already_labelled":
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=skipped reason=already_labelled label=${event.appliedLabel}`;
    case "skipped_severity":
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=skipped reason=severity allowed=${event.severities.join("|")}`;
    case "skipped_age":
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=skipped reason=age age_days=${event.ageDays} ` +
        `min_age_days=${event.minAgeDays}`;
    case "skipped_cap":
      return `[bulk-triage] repo=${event.repo} issue=${event.number} ` +
        `action=skipped reason=cap max=${event.max}`;
    case "error":
      return `[bulk-triage] repo=${event.repo} action=error reason=${event.message}`;
    default:
      return assertNever(event);
  }
}

/** Render the summary line emitted at the end of the triage. */
export function formatBulkTriageSummary(summary: BulkTriageSummary): string {
  const mode = summary.dryRun ? "dry_run" : "applied";
  return `[bulk-triage] action=summary mode=${mode} ` +
    `labelled=${summary.labelled} ` +
    `would_label=${summary.wouldLabel} ` +
    `already=${summary.alreadyLabelled} ` +
    `skipped_severity=${summary.skippedSeverity} ` +
    `skipped_age=${summary.skippedAge} ` +
    `skipped_cap=${summary.skippedCap} ` +
    `errors=${summary.errors}`;
}
