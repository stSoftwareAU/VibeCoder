/**
 * Per-repo idle-task scan freshness (Issue #3864).
 *
 * The steady-state idle-task filer is deliberately conservative: at most one
 * open `idle-task` wrapper exists across the entire monitored set (#2092), and
 * each idle tick picks a single template at random for a single repo. That is
 * right for background work, but it means a given (repo, template) pair can go
 * unscanned indefinitely with no signal anywhere — "zero open wrappers" is the
 * normal drained state, not an alarm. The missing information is **when each
 * (repo, template) pair last actually ran**.
 *
 * This module reconstructs that from **closed** wrapper issues:
 *
 *   - the wrapper's attribution footer (stamped by `appendIdleTaskAttribution`)
 *     names the template that filed it; the canonical wrapper titles are the
 *     fallback for pre-footer wrappers;
 *   - `closedAt` is the date the scan completed; and
 *   - the wrapper's closing comment — the template's own run summary — says
 *     whether the scan filed findings or was a no-op.
 *
 * It is **reporting only**: every `gh` call it makes is a read (`issue list`,
 * `issue view`). No issue is created, closed, commented on or edited.
 *
 * A repo whose history cannot be read degrades to `unknown` with a warning
 * rather than failing the whole report — the same fail-open shape as
 * `cross_repo_check_failed` in `idle_task_issue.ts` — while a malformed `gh`
 * payload throws so it is never silently reconciled as "no history".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand as defaultGhCommand } from "./github.ts";
import { parseAttributionFooter } from "./idle_task_attribution.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { listTemplates } from "./idle_task_template.ts";

// Import the bundled templates for their registration side-effect so the
// report enumerates the production set regardless of which call site reaches
// this module first (mirrors `create_all_idle_task_wrappers.ts`).
import "./idle_task_templates/security_scan_template.ts";
import "./idle_task_templates/best_practices_template.ts";
import "./idle_task_templates/test_audit_template.ts";
import "./idle_task_templates/github_actions_audit_template.ts";
import "./idle_task_templates/supply_chain_readiness_template.ts";
import "./idle_task_templates/orphan_deps_template.ts";
import "./idle_task_templates/dead_code_template.ts";
import "./idle_task_templates/doc_coverage_template.ts";
import "./idle_task_templates/format_drift_template.ts";
import "./idle_task_templates/deprecated_api_template.ts";
import "./idle_task_templates/bash_script_refs_template.ts";
import "./idle_task_templates/bash_syntax_audit_template.ts";
import "./idle_task_templates/documentation_audit_template.ts";
import "./idle_task_templates/alert_feed_template.ts";
import "./idle_task_templates/workflow_annotation_scan_template.ts";
import "./idle_task_templates/private_repo_reference_template.ts";
import "./idle_task_templates/duplicated_knowledge_template.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default staleness threshold, in days, before a pair is flagged. */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/** Bounded closed-wrapper history fetched per repo. */
const HISTORY_FETCH_LIMIT = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What a completed scan produced, as read from its closing comment. */
export type ScanOutcome = "findings" | "no-op" | "unknown";

/**
 * Freshness status of one (repo, template) pair.
 *
 * `never-run` (no completed scan on record) is deliberately distinct from
 * `stale` (ran, but longer ago than the threshold) and from `unknown` (the
 * repo's history could not be read at all).
 */
export type FreshnessStatus = "fresh" | "stale" | "never-run" | "unknown";

/** One closed idle-task wrapper, as read from `gh issue list`. */
export interface IdleTaskWrapperRecord {
  number: number;
  title: string;
  body: string;
  /** ISO-8601 close timestamp. */
  closedAt: string;
}

/** Freshness of a single (repo, template) pair. */
export interface IdleTaskFreshnessEntry {
  repo: string;
  template: string;
  /** ISO-8601 close timestamp of the most recent completed scan, else null. */
  lastRunAt: string | null;
  /** Whole days since `lastRunAt`, else null. */
  ageDays: number | null;
  /** Wrapper issue number the reading came from, else null. */
  issueNumber: number | null;
  /** Outcome of that scan, or null when there is nothing to classify. */
  outcome: ScanOutcome | null;
  status: FreshnessStatus;
  /**
   * Model tier the most recent completed scan ran on (Issue #4007), or null
   * when that wrapper carried no tier stamp. Pre-stamp wrappers stay `null` —
   * an unknown tier is never coerced to a concrete one, since that would
   * falsely satisfy a per-tier cadence floor.
   */
  lastRunModel: string | null;
  /**
   * Most recent completed-scan timestamp per stamped tier, e.g.
   * `{ "sonnet": "…", "fable": "…" }`. Empty when the pair's history holds no
   * stamped wrapper; unstamped wrappers appear under no key.
   */
  lastRunAtByModel: Record<string, string>;
}

/** Whole-fleet freshness report. */
export interface IdleTaskFreshnessReport {
  /** ISO-8601 timestamp the report was generated at. */
  generatedAt: string;
  /** Staleness threshold, in days, applied to every dated pair. */
  staleAfterDays: number;
  /** Repos covered, in the order supplied. */
  repos: string[];
  /** One entry per repo × registered template, sorted by staleness. */
  entries: IdleTaskFreshnessEntry[];
  /** Structured warnings for degraded readings. Empty when all reads were clean. */
  warnings: string[];
}

/** Options for {@link collectIdleTaskFreshness}. */
export interface CollectIdleTaskFreshnessOptions {
  /** Monitored repositories in `owner/repo` form. */
  repos: readonly string[];
  /** Template names to report. Defaults to every registered template. */
  templateNames?: readonly string[];
  /** Staleness threshold in days. Defaults to {@link DEFAULT_STALE_AFTER_DAYS}. */
  staleAfterDays?: number;
  /** Injectable `gh` runner backing the default fetchers. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Closed-wrapper history for one repo. Rejects when the history cannot be
   * read, which degrades that repo to `unknown`. Defaults to a `gh issue list`
   * read.
   */
  fetchHistoryFn?: (repo: string) => Promise<IdleTaskWrapperRecord[]>;
  /**
   * Closing-comment text for one wrapper, or null when the wrapper has no
   * comments. Defaults to a `gh issue view --json comments` read.
   */
  fetchCloseSummaryFn?: (
    repo: string,
    issueNumber: number,
  ) => Promise<string | null>;
  /** Injectable clock. Defaults to wall clock. */
  nowFn?: () => Date;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extract the template name from an idle-task issue body's attribution
 * footer, or null when the body carries no well-formed footer.
 *
 * Delegates to {@link parseAttributionFooter} so the footer format is defined
 * once, next to the builder — a change on either side is caught by the shared
 * round-trip test rather than silently dropping tier data here.
 */
export function parseAttributionTemplate(body: string): string | null {
  return parseAttributionFooter(body)?.template ?? null;
}

/**
 * Extract the model tier from an idle-task issue body's attribution footer,
 * or null when the wrapper predates the tier stamp (Issue #4007).
 */
export function parseAttributionModel(body: string): string | null {
  return parseAttributionFooter(body)?.model ?? null;
}

/**
 * Classify a wrapper's closing comment into a scan outcome.
 *
 * Every template renders its close comment through the shared convention:
 * `"no findings"` when the scan produced nothing, or
 * `"<scan> complete. Filed N issues: #A, #B, …"` when it filed. Anything else
 * — including a missing comment — is reported as `unknown` rather than being
 * guessed at as a clean run.
 */
export function classifyScanOutcome(summary: string | null): ScanOutcome {
  if (summary === null) return "unknown";
  if (/\bfiled\s+\d+\s+issues?\b/i.test(summary)) return "findings";
  if (/\bno findings\b/i.test(summary)) return "no-op";
  return "unknown";
}

/**
 * Parse a `gh issue list --json number,title,body,closedAt` payload into
 * wrapper records.
 *
 * Throws when the payload is not a JSON array — an unreadable history must
 * degrade to `unknown` at the repo level, never be reconciled as "this repo
 * has never been scanned". Individual rows missing a number or a `closedAt`
 * are skipped: they are open or malformed wrappers, not readable history.
 */
export function parseWrapperHistory(
  raw: string,
  repo: string,
): IdleTaskWrapperRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `idle-task freshness: unparseable issue history for ${repo}: ${message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `idle-task freshness: expected a JSON array of issues for ${repo}`,
    );
  }

  const records: IdleTaskWrapperRecord[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const number = typeof r["number"] === "number" ? r["number"] : null;
    const closedAt = typeof r["closedAt"] === "string" ? r["closedAt"] : "";
    if (number === null || closedAt.length === 0) continue;
    records.push({
      number,
      title: typeof r["title"] === "string" ? r["title"] : "",
      body: typeof r["body"] === "string" ? r["body"] : "",
      closedAt,
    });
  }
  return records;
}

/**
 * Resolve the template that filed a wrapper: the attribution footer first,
 * then the canonical wrapper title. Returns null when neither identifies a
 * template the report knows about.
 */
export function resolveWrapperTemplate(
  record: IdleTaskWrapperRecord,
  known: ReadonlySet<string>,
  titleToTemplate: ReadonlyMap<string, string>,
): string | null {
  const fromFooter = parseAttributionTemplate(record.body);
  if (fromFooter !== null && known.has(fromFooter)) return fromFooter;
  const fromTitle = titleToTemplate.get(record.title.trim());
  return fromTitle !== undefined ? fromTitle : null;
}

/**
 * Sort entries by staleness: never-run first (infinitely stale), then
 * unknown (staleness unmeasurable, so it needs an operator's eye next), then
 * dated entries oldest-first. Repo and template break ties so the ordering is
 * deterministic.
 */
export function sortByStaleness(
  entries: readonly IdleTaskFreshnessEntry[],
): IdleTaskFreshnessEntry[] {
  const rank = (e: IdleTaskFreshnessEntry): number =>
    e.status === "never-run" ? 0 : e.status === "unknown" ? 1 : 2;

  return [...entries].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    const ageDiff = (b.ageDays ?? 0) - (a.ageDays ?? 0);
    if (ageDiff !== 0) return ageDiff;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Default gh-backed fetchers (reads only)
// ---------------------------------------------------------------------------

/** List a repo's closed `idle-task` wrappers. Read-only. */
async function fetchHistoryViaGh(
  repo: string,
  gh: (args: string[]) => Promise<string>,
): Promise<IdleTaskWrapperRecord[]> {
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    IDLE_TASK_LABEL,
    "--state",
    "closed",
    "--json",
    "number,title,body,closedAt",
    "--limit",
    String(HISTORY_FETCH_LIMIT),
  ]);
  return parseWrapperHistory(raw, repo);
}

/**
 * Read a wrapper's closing comment — the template's run summary, posted by
 * `gh issue close --comment` in the idle-task route. Read-only.
 */
async function fetchCloseSummaryViaGh(
  repo: string,
  issueNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<string | null> {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  const comments = (parsed as Record<string, unknown>)["comments"];
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const last = comments[comments.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const body = (last as Record<string, unknown>)["body"];
  return typeof body === "string" ? body : null;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Build the freshness report for every repo × registered template pair.
 *
 * Performs reads only. A repo whose history cannot be read yields `unknown`
 * for all of its pairs plus one warning; a pair whose closing comment cannot
 * be read keeps its date and reports an `unknown` outcome plus one warning.
 */
export async function collectIdleTaskFreshness(
  opts: CollectIdleTaskFreshnessOptions,
): Promise<IdleTaskFreshnessReport> {
  const gh = opts.ghCommandFn ?? defaultGhCommand;
  const fetchHistory = opts.fetchHistoryFn ??
    ((repo: string) => fetchHistoryViaGh(repo, gh));
  const fetchCloseSummary = opts.fetchCloseSummaryFn ??
    ((repo: string, n: number) => fetchCloseSummaryViaGh(repo, n, gh));
  const now = (opts.nowFn ?? (() => new Date()))();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  const templates = listTemplates();
  const templateNames = opts.templateNames ?? templates.map((t) => t.name);
  const known = new Set(templateNames);

  const warnings: string[] = [];
  const entries: IdleTaskFreshnessEntry[] = [];

  for (const repo of opts.repos) {
    // Canonical title → template name, resolved per repo because a template
    // may embed the repo in its wrapper title.
    const titleToTemplate = new Map<string, string>();
    for (const template of templates) {
      if (!known.has(template.name)) continue;
      titleToTemplate.set(template.buildIssueTitle(repo).trim(), template.name);
    }

    let history: IdleTaskWrapperRecord[] | null;
    try {
      history = await fetchHistory(repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const line =
        `[idle-task-freshness] repo=${repo} action=warn reason=history_read_failed message=${message}`;
      warnings.push(line);
      warn(line);
      history = null;
    }

    if (history === null) {
      for (const template of templateNames) {
        entries.push({
          repo,
          template,
          lastRunAt: null,
          ageDays: null,
          issueNumber: null,
          outcome: null,
          status: "unknown",
          lastRunModel: null,
          lastRunAtByModel: {},
        });
      }
      continue;
    }

    // Most recent completed scan per template, plus per stamped model tier
    // (Issue #4007). Wrappers filed before the tier stamp existed contribute
    // to the overall reading only — they are deliberately absent from the
    // per-tier map so an unknown tier can never satisfy a cadence floor.
    const latest = new Map<string, IdleTaskWrapperRecord>();
    const latestByModel = new Map<string, Map<string, string>>();
    for (const record of history) {
      const template = resolveWrapperTemplate(record, known, titleToTemplate);
      if (template === null) continue;
      const closedMs = Date.parse(record.closedAt);
      if (Number.isNaN(closedMs)) continue;
      const current = latest.get(template);
      if (
        current === undefined ||
        Date.parse(current.closedAt) < closedMs
      ) {
        latest.set(template, record);
      }

      const model = parseAttributionModel(record.body);
      if (model === null) continue;
      let byModel = latestByModel.get(template);
      if (byModel === undefined) {
        byModel = new Map<string, string>();
        latestByModel.set(template, byModel);
      }
      const seen = byModel.get(model);
      if (seen === undefined || Date.parse(seen) < closedMs) {
        byModel.set(model, record.closedAt);
      }
    }

    for (const template of templateNames) {
      const record = latest.get(template);
      if (record === undefined) {
        entries.push({
          repo,
          template,
          lastRunAt: null,
          ageDays: null,
          issueNumber: null,
          outcome: null,
          status: "never-run",
          lastRunModel: null,
          lastRunAtByModel: {},
        });
        continue;
      }

      let summary: string | null = null;
      let outcome: ScanOutcome;
      try {
        summary = await fetchCloseSummary(repo, record.number);
        outcome = classifyScanOutcome(summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const line =
          `[idle-task-freshness] repo=${repo} issue=${record.number} action=warn ` +
          `reason=outcome_read_failed message=${message}`;
        warnings.push(line);
        warn(line);
        outcome = "unknown";
      }

      const ageDays = Math.floor(
        (now.getTime() - Date.parse(record.closedAt)) / MS_PER_DAY,
      );
      entries.push({
        repo,
        template,
        lastRunAt: record.closedAt,
        ageDays,
        issueNumber: record.number,
        outcome,
        status: ageDays >= staleAfterDays ? "stale" : "fresh",
        lastRunModel: parseAttributionModel(record.body),
        lastRunAtByModel: Object.fromEntries(
          latestByModel.get(template) ?? new Map<string, string>(),
        ),
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    staleAfterDays,
    repos: [...opts.repos],
    entries: sortByStaleness(entries),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const COLUMNS = [
  "REPO",
  "TEMPLATE",
  "LAST RUN",
  "MODEL",
  "AGE",
  "OUTCOME",
  "STATUS",
];

function entryRow(entry: IdleTaskFreshnessEntry): string[] {
  return [
    entry.repo,
    entry.template,
    entry.lastRunAt === null ? "-" : entry.lastRunAt.slice(0, 10),
    // Per-tier detail stays in the `--json` form; the table shows the tier of
    // the most recent scan, "-" when that wrapper predates the tier stamp.
    entry.lastRunModel ?? "-",
    entry.ageDays === null ? "-" : `${entry.ageDays}d`,
    entry.outcome ?? "-",
    entry.status,
  ];
}

/**
 * Render the report as an aligned, greppable table sorted by staleness. The
 * machine-readable form is the command's `--json` mode.
 */
export function formatFreshnessReport(report: IdleTaskFreshnessReport): string {
  const rows = report.entries.map(entryRow);
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  const counts: Record<FreshnessStatus, number> = {
    "never-run": 0,
    unknown: 0,
    stale: 0,
    fresh: 0,
  };
  for (const entry of report.entries) counts[entry.status]++;

  const out: string[] = [
    `Idle-task scan freshness — ${report.repos.length} repos × ` +
    `${report.entries.length / Math.max(report.repos.length, 1)} templates ` +
    `(${report.entries.length} pairs), stale after ${report.staleAfterDays} days`,
    "",
    line(COLUMNS),
    ...rows.map(line),
    "",
    `Summary: ${counts["never-run"]} never-run, ${counts.unknown} unknown, ` +
    `${counts.stale} stale, ${counts.fresh} fresh`,
  ];

  if (report.warnings.length > 0) {
    out.push("", "Warnings:", ...report.warnings.map((w) => `  ${w}`));
  }
  return out.join("\n");
}
