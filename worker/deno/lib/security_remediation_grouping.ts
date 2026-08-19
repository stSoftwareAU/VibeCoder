/**
 * Security remediation grouping (Issue #2402).
 *
 * Part of the throughput epic #2400. The worker serialises to one in-flight
 * PR per work stream, so a sustained stream of `security` findings clears
 * one PR at a time. This module defines the **safe grouping criteria** that
 * let a single remediation PR close several related findings at once —
 * raising throughput without relaxing the one-PR-per-stream invariant.
 *
 * Three grouping strategies are supported, each chosen because the findings
 * in a group can be remediated together in one branch with low blast radius:
 *
 * - `file`       — findings in the same source file (one edit pass).
 * - `class`      — findings sharing a vulnerability class (one fix pattern).
 * - `dependency` — findings against the same dependency (one bump).
 *
 * Every group is capped at `maxGroupSize` findings so a batch PR never grows
 * too large to review. Findings with no shared key for the chosen strategy
 * are emitted as singleton groups — they are never batched unsafely.
 *
 * Pure functions, no I/O. Australian English throughout.
 */

import { assertNever } from "./assert_never.ts";

/** Severity levels carried by `severity:*` labels on a finding issue. */
export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

/** Safe criteria for batching related security findings into one PR. */
export type GroupingStrategy = "file" | "class" | "dependency";

/** Default per-PR cap — keeps a batched remediation PR reviewable. */
export const DEFAULT_MAX_GROUP_SIZE = 5;

/** Raw fields of a filed `security` finding issue, as returned by `gh`. */
export interface RawFindingIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

/** A parsed security finding, normalised for grouping. */
export interface SecurityFinding {
  /** The GitHub issue number the finding was filed under. */
  issueNumber: number;
  /** Stable finding id from the `<!-- finding-id: SEC-… -->` body marker. */
  findingId?: string;
  /** Offending file path, parsed from the issue title. */
  file?: string;
  /** Human-readable vulnerability class, parsed from the issue title. */
  vulnClass?: string;
  /** Dependency name, parsed from a bump-style title when present. */
  dependency?: string;
  /** Severity, from the `severity:*` label. */
  severity: Severity;
}

/** Options controlling how findings are grouped. */
export interface GroupingOptions {
  strategy: GroupingStrategy;
  /** Maximum findings per group (PR-size cap). Must be ≥ 1. */
  maxGroupSize: number;
}

/** A batch of findings that can be remediated in a single PR. */
export interface SecurityFindingGroup {
  strategy: GroupingStrategy;
  /** The shared grouping key (file path, class, or dependency name). */
  key: string;
  findings: SecurityFinding[];
}

const FINDING_ID_RE = /<!--\s*finding-id:\s*(SEC-[0-9a-f]+)\s*-->/i;
const SEVERITY_RE = /^severity:(critical|high|medium|low)$/;
// Title convention: "<desc> in <file>[:line]". Capture the trailing path.
const FILE_IN_TITLE_RE = /\bin\s+`?([^\s`]+?)`?(?::\d+(?:-\d+)?)?\s*$/;
// Bump-style title: "Bump <dep> from x to y" / "Update <dep> to y".
const BUMP_RE = /\b(?:bump|update|upgrade)\s+`?([^\s`]+)`?\s+(?:from|to)\b/i;
// Leading severity emoji prefixing the title description.
const LEADING_EMOJI_RE = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u;

/**
 * Parse a filed `security` issue into a normalised {@link SecurityFinding}.
 *
 * Extraction is best-effort and tolerant: any field the issue does not
 * clearly express is left `undefined`, which makes the finding un-groupable
 * for strategies that depend on it (it falls back to a singleton group).
 */
export function parseSecurityFinding(issue: RawFindingIssue): SecurityFinding {
  const findingId = issue.body.match(FINDING_ID_RE)?.[1];

  let severity: Severity = "unknown";
  for (const label of issue.labels) {
    const m = label.match(SEVERITY_RE);
    if (m) {
      severity = m[1] as Severity;
      break;
    }
  }

  const title = issue.title.trim();
  const dependency = title.match(BUMP_RE)?.[1];

  // Only treat the title as carrying a file when it is not a bump-style
  // title (those have no source path, just a version range).
  let file: string | undefined;
  let vulnClass: string | undefined;
  if (!dependency) {
    const fileMatch = title.match(FILE_IN_TITLE_RE);
    if (fileMatch) {
      file = fileMatch[1];
      // The description is everything before " in <file>".
      const desc = title.slice(0, fileMatch.index).trim();
      vulnClass = stripLeadingEmoji(desc) || undefined;
    }
  }

  return {
    issueNumber: issue.number,
    findingId,
    file,
    vulnClass,
    dependency,
    severity,
  };
}

function stripLeadingEmoji(text: string): string {
  return text.replace(LEADING_EMOJI_RE, "").trim();
}

/**
 * Return the grouping key for a finding under the chosen strategy, or
 * `undefined` when the finding has no shared key (→ singleton group).
 *
 * Class keys are lower-cased so "SQL injection" and "sql injection" group
 * together; file and dependency keys are used verbatim.
 */
export function selectGroupingKey(
  finding: SecurityFinding,
  strategy: GroupingStrategy,
): string | undefined {
  switch (strategy) {
    case "file":
      return finding.file;
    case "class":
      return finding.vulnClass?.toLowerCase();
    case "dependency":
      return finding.dependency;
    default:
      // Exhaustiveness guard: adding a new GroupingStrategy without a case
      // here becomes a compile error rather than a silent `undefined` that
      // would collapse every finding into a singleton group (Issue #2794).
      return assertNever(strategy);
  }
}

/**
 * Group findings into batches that can each be remediated in one PR.
 *
 * Findings sharing a key are bucketed together, then each bucket is split
 * into chunks no larger than `maxGroupSize`. Findings with no key are
 * emitted as singleton groups. Output is deterministic: groups are sorted
 * by key, and findings within a group by issue number.
 *
 * @throws RangeError when `maxGroupSize` is not a positive integer.
 */
export function groupSecurityFindings(
  findings: SecurityFinding[],
  options: GroupingOptions,
): SecurityFindingGroup[] {
  const { strategy, maxGroupSize } = options;
  if (!Number.isInteger(maxGroupSize) || maxGroupSize < 1) {
    throw new RangeError(
      `maxGroupSize must be a positive integer, got ${maxGroupSize}`,
    );
  }

  // Bucket by key; un-keyed findings get a unique singleton key.
  const buckets = new Map<string, SecurityFinding[]>();
  for (const finding of findings) {
    const sharedKey = selectGroupingKey(finding, strategy);
    const key = sharedKey ?? `#${finding.issueNumber}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(finding);
    } else {
      buckets.set(key, [finding]);
    }
  }

  const groups: SecurityFindingGroup[] = [];
  // Sort bucket keys for deterministic output.
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    bucket.sort((a, b) => a.issueNumber - b.issueNumber);
    // Split into cap-sized chunks.
    for (let i = 0; i < bucket.length; i += maxGroupSize) {
      groups.push({
        strategy,
        key,
        findings: bucket.slice(i, i + maxGroupSize),
      });
    }
  }

  return groups;
}

/**
 * Build the GitHub auto-close block for a batched remediation PR — one
 * `Closes #N` line per finding so every closed finding is traceable.
 */
export function buildClosesReferences(group: SecurityFindingGroup): string {
  return group.findings
    .map((finding) => `Closes #${finding.issueNumber}`)
    .join("\n");
}

/**
 * Build a human-readable list of the findings in a group, preferring the
 * stable finding id and falling back to the issue number.
 */
export function buildFindingIdList(group: SecurityFindingGroup): string {
  return group.findings
    .map((finding) => finding.findingId ?? `#${finding.issueNumber}`)
    .join(", ");
}
