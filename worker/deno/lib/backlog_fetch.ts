/**
 * Live data gathering for the backlog-report command (Issue #2405).
 *
 * Queries `gh` for the security / supply-chain finding issues (open and
 * recently-closed) across the configured repos and normalises them into
 * the {@link FindingIssue} shape the pure maths in
 * `backlog_throughput.ts` consumes.
 *
 * The gh runner is injectable so the JSON-parsing path can be tested
 * without a live GitHub. Transient gh failures for one label query are
 * warned and skipped — a single flaky query never aborts the report.
 *
 * Uses Australian English spelling throughout.
 */

import { runGhCommand } from "./github.ts";
import {
  classifyFindingLabels,
  type FindingIssue,
} from "./backlog_throughput.ts";

/**
 * Finding labels we query per repo. Each is an exact `gh --label` match;
 * results are merged and de-duplicated by issue number, then classified
 * by {@link classifyFindingLabels}.
 */
export const FINDING_LABELS: readonly string[] = [
  "security",
  "supply-chain-readiness",
  "supply-chain:quarantine-missing",
  "supply-chain:quarantine-misconfigured",
];

/** Bounded query size per label per repo. */
const QUERY_LIMIT = 500;

export interface FetchFindingsOptions {
  /** Repositories in `owner/repo` form. */
  repos: string[];
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Warning sink for transient gh failures. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Parse one `gh issue list --json number,labels,createdAt,closedAt,state`
 * payload into normalised findings for `repo`. Non-finding rows and
 * malformed entries are skipped.
 */
export function parseFindingsJson(raw: string, repo: string): FindingIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const findings: FindingIssue[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;

    const number = typeof r.number === "number" ? r.number : NaN;
    const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
    if (Number.isNaN(number) || createdAt === "") continue;

    const labels = extractLabelNames(r.labels);
    const classification = classifyFindingLabels(labels);
    if (!classification.isFinding || classification.category === null) continue;

    const state = r.state === "CLOSED" || r.state === "closed"
      ? "closed"
      : "open";
    const closedRaw = r.closedAt;
    const closedAt = typeof closedRaw === "string" && closedRaw !== ""
      ? closedRaw
      : null;

    findings.push({
      repo,
      number,
      state,
      severity: classification.severity,
      category: classification.category,
      createdAt,
      closedAt,
    });
  }
  return findings;
}

/** Pull label names out of the `gh` labels array (objects with `name`). */
function extractLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object") {
      const name = (entry as Record<string, unknown>).name;
      if (typeof name === "string") names.push(name);
    } else if (typeof entry === "string") {
      names.push(entry);
    }
  }
  return names;
}

/**
 * Fetch and normalise all finding issues across the configured repos.
 * Issues are de-duplicated per repo by number (a finding carrying more
 * than one queried label appears in several label queries).
 */
export async function fetchFindings(
  opts: FetchFindingsOptions,
): Promise<FindingIssue[]> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const all: FindingIssue[] = [];
  for (const repo of opts.repos) {
    const seen = new Set<number>();
    for (const label of FINDING_LABELS) {
      let raw: string;
      try {
        raw = await gh([
          "issue",
          "list",
          "--repo",
          repo,
          "--label",
          label,
          "--state",
          "all",
          "--json",
          "number,labels,createdAt,closedAt,state",
          "--limit",
          String(QUERY_LIMIT),
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warn(
          `[backlog-report] repo=${repo} label=${label} action=warn reason=query_failed message=${message}`,
        );
        continue;
      }
      for (const finding of parseFindingsJson(raw, repo)) {
        if (seen.has(finding.number)) continue;
        seen.add(finding.number);
        all.push(finding);
      }
    }
  }
  return all;
}
