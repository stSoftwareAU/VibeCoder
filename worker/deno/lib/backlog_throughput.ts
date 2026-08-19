/**
 * Backlog & throughput observability (Issue #2405).
 *
 * Pure functions that turn a set of security / supply-chain finding
 * issues (open and recently-closed) into the metrics that answer the
 * single question "is the security backlog stable or growing?":
 *
 * - Open findings per repo (and total), by severity and age.
 * - Worker clear-rate: findings closed per day.
 * - Backlog trend: open-count now vs one window ago (rising / falling).
 * - Projected drain time at the current clear-rate.
 *
 * The maths lives here (no I/O) so it can be tested against fixture
 * issue sets. The `backlog-report` command supplies the live data from
 * `gh` issue queries.
 *
 * Uses Australian English spelling throughout.
 */

/** Finding severity, derived from the `severity:*` label. */
export type Severity = "high" | "medium" | "low" | "unknown";

/** Which scan family a finding belongs to. */
export type FindingCategory = "security" | "supply-chain";

/** Direction of the week-on-week backlog movement. */
export type TrendDirection = "rising" | "falling" | "flat";

/** Age buckets for open findings (days since creation). */
export interface AgeBuckets {
  /** Younger than 7 days. */
  fresh: number;
  /** Between 7 and 30 days. */
  recent: number;
  /** Older than 30 days. */
  stale: number;
}

/** A single finding issue, normalised from the `gh` JSON shape. */
export interface FindingIssue {
  repo: string;
  number: number;
  state: "open" | "closed";
  severity: Severity;
  category: FindingCategory;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 close timestamp, or null while open. */
  closedAt: string | null;
}

/** Outcome of classifying an issue's labels. */
export interface FindingClassification {
  isFinding: boolean;
  category: FindingCategory | null;
  severity: Severity;
}

/** Clear-rate over a rolling window. */
export interface ClearRate {
  closedInWindow: number;
  perDay: number;
}

/** Week-on-week backlog movement. */
export interface TrendResult {
  current: number;
  previous: number;
  delta: number;
  direction: TrendDirection;
}

/** Per-repo (or total) backlog rollup. */
export interface RepoBacklog {
  repo: string;
  openTotal: number;
  bySeverity: Record<Severity, number>;
  ageBuckets: AgeBuckets;
  clearRate: ClearRate;
  trend: TrendResult;
  /** Days to drain the backlog at the current rate, or null if not draining. */
  drainDays: number | null;
}

/** Full report payload. */
export interface BacklogSummary {
  generatedAt: string;
  windowDays: number;
  repos: RepoBacklog[];
  total: RepoBacklog;
}

const MS_PER_DAY = 86_400_000;
const SEVERITIES: Severity[] = ["high", "medium", "low", "unknown"];

/**
 * Classify an issue's labels as a security / supply-chain finding.
 *
 * A finding carries the `security` label or any `supply-chain*` label.
 * Supply-chain takes precedence when both families are present.
 */
export function classifyFindingLabels(labels: string[]): FindingClassification {
  const lower = labels.map((l) => l.trim().toLowerCase());

  const isSupplyChain = lower.some((l) => l.startsWith("supply-chain"));
  const isSecurity = lower.includes("security");

  let severity: Severity = "unknown";
  if (lower.includes("severity:high")) severity = "high";
  else if (lower.includes("severity:medium")) severity = "medium";
  else if (lower.includes("severity:low")) severity = "low";

  if (isSupplyChain) {
    return { isFinding: true, category: "supply-chain", severity };
  }
  if (isSecurity) {
    return { isFinding: true, category: "security", severity };
  }
  return { isFinding: false, category: null, severity };
}

/**
 * True when the issue was open at instant `tMs` (epoch milliseconds):
 * created at or before `tMs`, and either still open or closed after it.
 */
export function isOpenAt(issue: FindingIssue, tMs: number): boolean {
  const created = Date.parse(issue.createdAt);
  if (Number.isNaN(created) || created > tMs) return false;
  if (issue.closedAt === null) return true;
  const closed = Date.parse(issue.closedAt);
  if (Number.isNaN(closed)) return true;
  return closed > tMs;
}

/** Count findings open at instant `tMs`. */
export function openCountAt(issues: FindingIssue[], tMs: number): number {
  let count = 0;
  for (const issue of issues) {
    if (isOpenAt(issue, tMs)) count++;
  }
  return count;
}

/** Bucket currently-open findings by age in days. */
export function computeAgeBuckets(
  openIssues: FindingIssue[],
  nowMs: number,
): AgeBuckets {
  const buckets: AgeBuckets = { fresh: 0, recent: 0, stale: 0 };
  for (const issue of openIssues) {
    const created = Date.parse(issue.createdAt);
    if (Number.isNaN(created)) continue;
    const ageDays = (nowMs - created) / MS_PER_DAY;
    if (ageDays < 7) buckets.fresh++;
    else if (ageDays <= 30) buckets.recent++;
    else buckets.stale++;
  }
  return buckets;
}

/**
 * Clear-rate: findings closed within the trailing `windowDays`, and the
 * resulting per-day average.
 */
export function computeClearRate(
  issues: FindingIssue[],
  nowMs: number,
  windowDays: number,
): ClearRate {
  if (windowDays <= 0) return { closedInWindow: 0, perDay: 0 };
  const windowStart = nowMs - windowDays * MS_PER_DAY;
  let closedInWindow = 0;
  for (const issue of issues) {
    if (issue.closedAt === null) continue;
    const closed = Date.parse(issue.closedAt);
    if (Number.isNaN(closed)) continue;
    if (closed > windowStart && closed <= nowMs) closedInWindow++;
  }
  return { closedInWindow, perDay: closedInWindow / windowDays };
}

/**
 * Backlog trend: open-count now vs open-count `windowDays` ago. This is
 * the single number that answers "are we keeping up?".
 */
export function computeBacklogTrend(
  issues: FindingIssue[],
  nowMs: number,
  windowDays: number,
): TrendResult {
  const current = openCountAt(issues, nowMs);
  const previous = openCountAt(issues, nowMs - windowDays * MS_PER_DAY);
  const delta = current - previous;
  const direction: TrendDirection = delta > 0
    ? "rising"
    : delta < 0
    ? "falling"
    : "flat";
  return { current, previous, delta, direction };
}

/**
 * Projected drain time in days: backlog ÷ clear-rate. Returns null when
 * the backlog is empty (nothing to drain) or the clear-rate is zero (it
 * never drains at the current rate).
 */
export function projectDrainDays(
  backlog: number,
  perDay: number,
): number | null {
  if (backlog <= 0) return 0;
  if (perDay <= 0) return null;
  return backlog / perDay;
}

function emptySeverityTally(): Record<Severity, number> {
  return { high: 0, medium: 0, low: 0, unknown: 0 };
}

/** Roll a set of findings (already filtered to one repo, or all) into metrics. */
function rollup(
  repo: string,
  issues: FindingIssue[],
  nowMs: number,
  windowDays: number,
): RepoBacklog {
  const open = issues.filter((i) => isOpenAt(i, nowMs));
  const bySeverity = emptySeverityTally();
  for (const issue of open) bySeverity[issue.severity]++;

  const clearRate = computeClearRate(issues, nowMs, windowDays);
  const trend = computeBacklogTrend(issues, nowMs, windowDays);

  return {
    repo,
    openTotal: open.length,
    bySeverity,
    ageBuckets: computeAgeBuckets(open, nowMs),
    clearRate,
    trend,
    drainDays: projectDrainDays(open.length, clearRate.perDay),
  };
}

/**
 * Build the full backlog summary from a flat list of findings spanning
 * one or more repos.
 */
export function summariseBacklog(
  issues: FindingIssue[],
  options: { now?: Date; windowDays?: number } = {},
): BacklogSummary {
  const nowMs = (options.now ?? new Date()).getTime();
  const windowDays = options.windowDays ?? 7;

  const repoNames = [...new Set(issues.map((i) => i.repo))].sort();
  const repos = repoNames.map((repo) =>
    rollup(repo, issues.filter((i) => i.repo === repo), nowMs, windowDays)
  );
  const total = rollup("TOTAL", issues, nowMs, windowDays);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays,
    repos,
    total,
  };
}

function formatDrain(drainDays: number | null): string {
  if (drainDays === null) return "never (clear-rate is zero)";
  if (drainDays === 0) return "already clear";
  return `${drainDays.toFixed(1)} days`;
}

function formatTrend(trend: TrendResult): string {
  const sign = trend.delta > 0 ? "+" : "";
  return `${trend.direction} (${trend.previous} → ${trend.current}, ${sign}${trend.delta})`;
}

function formatRepoBlock(b: RepoBacklog): string {
  const sev = SEVERITIES.map((s) => `${s}=${b.bySeverity[s]}`).join(" ");
  const lines = [
    `${b.repo}: ${b.openTotal} open`,
    `  severity: ${sev}`,
    `  age: <7d=${b.ageBuckets.fresh} 7-30d=${b.ageBuckets.recent} >30d=${b.ageBuckets.stale}`,
    `  cleared: ${b.clearRate.closedInWindow} (${
      b.clearRate.perDay.toFixed(2)
    }/day)`,
    `  trend: ${formatTrend(b.trend)}`,
    `  drain: ${formatDrain(b.drainDays)}`,
  ];
  return lines.join("\n");
}

/** Render the summary as a human-readable report. */
export function formatBacklogReport(summary: BacklogSummary): string {
  const header =
    `Security backlog & throughput (window: ${summary.windowDays} days, ` +
    `generated ${summary.generatedAt})`;
  const blocks = summary.repos.map(formatRepoBlock);
  const totalBlock = formatRepoBlock(summary.total);

  const parts = [header, "", ...blocks];
  if (summary.repos.length !== 1) {
    parts.push("", totalBlock);
  }
  return parts.join("\n");
}
