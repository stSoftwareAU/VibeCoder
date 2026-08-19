/**
 * audit-heartbeat-recoveries command (Issue #1885).
 *
 * One-shot audit: scans the past N days of GitHub comments across the
 * worker's monitored repos, finds every "Assigned-without-heartbeat
 * recovery (Issue #632)" comment, and classifies each into legitimate
 * vs false-positive recovery so we can quantify the problem and
 * validate later fixes.
 *
 * The classifier itself lives in `lib/heartbeat_recovery_classifier.ts`
 * — this command is the I/O wrapper.
 *
 * Usage:
 *   deno run mod.ts audit-heartbeat-recoveries
 *   deno run mod.ts audit-heartbeat-recoveries --days 30
 *   deno run mod.ts audit-heartbeat-recoveries --out docs/audits/foo.md
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import { getGithubUser } from "../lib/claude_runner.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  classifyEvent,
  isRecoveryComment,
  parseMarkerStateFromBody,
  type RecoveryCategory,
} from "../lib/heartbeat_recovery_classifier.ts";
import { HEARTBEAT_MARKER_PREFIX } from "../lib/heartbeat_storage.ts";

/** Default audit window in days. */
const DEFAULT_WINDOW_DAYS = 30;

/** Follow-up window after a recovery used to detect "completed" outcomes. */
const FOLLOW_UP_WINDOW_DAYS = 7;

/** A single classified recovery event. */
export interface RecoveryEvent {
  repo: string;
  issue: number;
  title: string;
  recoveryCommentId: number;
  recoveryAt: string;
  category: RecoveryCategory;
}

/** Aggregated audit report. */
export interface AuditReport {
  generatedAt: string;
  windowDays: number;
  workerUser: string;
  reposScanned: string[];
  totals: { events: number; issues: number };
  byCategory: Record<RecoveryCategory, number>;
  events: RecoveryEvent[];
}

interface IssueComment {
  id: number;
  user: { login: string } | null;
  created_at: string;
  body: string;
}

interface TimelineEvent {
  event: string;
  created_at?: string;
  source?: {
    issue?: {
      number?: number;
      state?: string;
      pull_request?: { merged_at?: string | null } | null;
    };
  };
}

/** Options accepted by `auditHeartbeatRecoveries`. */
export interface AuditOptions {
  repos: string[];
  workerUser: string;
  windowDays?: number;
  /** Override the current time — used by tests to make windows deterministic. */
  nowFn?: () => Date;
  /** Injectable gh runner for tests. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

async function ghJson<T>(
  args: string[],
  ghFn: (args: string[]) => Promise<string>,
): Promise<T> {
  const out = await ghFn(args);
  return JSON.parse(out || "null") as T;
}

/** Fetch all comments on an issue, paginating as needed. */
async function fetchIssueComments(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  let page = 1;
  while (page <= 20) {
    const batch = await ghJson<IssueComment[]>(
      [
        "api",
        "-X",
        "GET",
        `repos/${repo}/issues/${issueNumber}/comments`,
        "-F",
        "per_page=100",
        "-F",
        `page=${page}`,
      ],
      ghFn,
    );
    if (!batch || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return comments;
}

/** Fetch the timeline for an issue (used for cross-references to PRs). */
async function fetchIssueTimeline(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<TimelineEvent[]> {
  return await ghJson<TimelineEvent[]>(
    [
      "api",
      "-X",
      "GET",
      `repos/${repo}/issues/${issueNumber}/timeline`,
      "-H",
      "Accept: application/vnd.github.mockingbird-preview+json",
      "-F",
      "per_page=100",
    ],
    ghFn,
  );
}

/**
 * Search the past `windowDays` of comments in a single repo for any
 * Issue-#632 recovery marker. Returns the unique issue numbers that
 * contain at least one match.
 */
async function findRecoveryIssues(
  repo: string,
  sinceIso: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<number[]> {
  // Use the comment-search endpoint scoped to the repo. The marker text is
  // unique enough that a phrase search returns clean results.
  const q =
    `"Assigned-without-heartbeat recovery" repo:${repo} updated:>=${sinceIso}`;
  const result = await ghJson<{
    items?: Array<{ number: number }>;
  }>(
    [
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=${q}`,
      "-F",
      "per_page=100",
    ],
    ghFn,
  );
  const items = result?.items ?? [];
  const seen = new Set<number>();
  for (const it of items) {
    if (typeof it.number === "number") seen.add(it.number);
  }
  return [...seen];
}

/**
 * Decide the marker state for a single recovery moment.
 *
 * Inspects every VIBE_CODER_HEARTBEAT marker comment on the issue and
 * picks the most recent one that predates the recovery comment. If that
 * comment is `cleared` it returns `cleared`; if it is `live` and was
 * last edited at least `windowSeconds` before recovery it is treated
 * as `stale`; otherwise `live`.
 */
export function deriveMarkerState(
  comments: IssueComment[],
  recoveryAt: string,
  staleWindowSeconds: number,
): "absent" | "live" | "stale" | "cleared" {
  const recoveryT = Date.parse(recoveryAt);
  let bestT = -Infinity;
  let bestBody: string | null = null;
  for (const c of comments) {
    if (!c.body.includes(HEARTBEAT_MARKER_PREFIX)) continue;
    const t = Date.parse(c.created_at);
    if (!isFinite(t) || t > recoveryT) continue;
    if (t > bestT) {
      bestT = t;
      bestBody = c.body;
    }
  }
  if (bestBody === null) return "absent";
  const bodyState = parseMarkerStateFromBody(bestBody);
  if (bodyState === "absent") return "absent";
  if (bodyState === "cleared") return "cleared";
  // body says "live" — treat as stale if the marker has not been refreshed
  // for more than the stale window.
  if (recoveryT - bestT > staleWindowSeconds * 1000) return "stale";
  return "live";
}

/**
 * Determine whether the issue had an open linked PR at the moment the
 * recovery comment was posted, by walking timeline cross-references.
 */
export function hadOpenLinkedPRAtRecovery(
  timeline: TimelineEvent[],
  recoveryAt: string,
): boolean {
  const recoveryT = Date.parse(recoveryAt);
  for (const ev of timeline) {
    if (ev.event !== "cross-referenced") continue;
    const src = ev.source?.issue;
    if (!src?.pull_request) continue;
    const t = ev.created_at ? Date.parse(ev.created_at) : NaN;
    if (!isFinite(t) || t > recoveryT) continue;
    const merged = src.pull_request.merged_at;
    // Open at recovery means: cross-reference exists, not merged, and
    // either still open or closed after the recovery moment. We have no
    // direct "closed at" so we treat any non-merged PR linked before the
    // recovery as open at that moment.
    if (!merged || Date.parse(merged) > recoveryT) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether the issue was reclaimed and a PR merged within the
 * follow-up window after the recovery comment.
 */
export function completedWithinFollowUp(
  timeline: TimelineEvent[],
  recoveryAt: string,
  followUpDays: number,
): boolean {
  const recoveryT = Date.parse(recoveryAt);
  const cutoff = recoveryT + followUpDays * 24 * 3600 * 1000;
  for (const ev of timeline) {
    if (ev.event !== "cross-referenced") continue;
    const src = ev.source?.issue;
    if (!src?.pull_request) continue;
    const merged = src.pull_request.merged_at;
    if (!merged) continue;
    const mergedT = Date.parse(merged);
    if (isFinite(mergedT) && mergedT >= recoveryT && mergedT <= cutoff) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch the issue title via gh (used so the output contains a human
 * readable title even when search did not return one).
 */
async function fetchIssueTitle(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<string> {
  try {
    const data = await ghJson<{ title?: string }>(
      [
        "api",
        "-X",
        "GET",
        `repos/${repo}/issues/${issueNumber}`,
      ],
      ghFn,
    );
    return data?.title ?? "";
  } catch {
    return "";
  }
}

/**
 * Run the audit across the supplied repos.
 *
 * Returns a `Result` — the orchestrating command surfaces a clean error
 * message rather than throwing.
 */
export async function auditHeartbeatRecoveries(
  options: AuditOptions,
): Promise<Result<AuditReport>> {
  const ghFn = options.ghCommandFn ?? runGhCommand;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.nowFn ? options.nowFn() : new Date();
  const sinceIso = new Date(
    now.getTime() - windowDays * 24 * 3600 * 1000,
  ).toISOString().slice(0, 10);
  const sinceT = Date.parse(`${sinceIso}T00:00:00Z`);

  // 24h "marker is stale" window — a marker not refreshed in 24h is unlikely
  // to represent a live worker, regardless of the heartbeat timeout config.
  const staleWindowSeconds = 24 * 3600;

  const events: RecoveryEvent[] = [];
  const seenIssues = new Set<string>();

  for (const repo of options.repos) {
    let issueNumbers: number[];
    try {
      issueNumbers = await findRecoveryIssues(repo, sinceIso, ghFn);
    } catch (err) {
      return { ok: false, error: err as Error };
    }

    for (const issueNumber of issueNumbers) {
      let comments: IssueComment[];
      let timeline: TimelineEvent[];
      try {
        comments = await fetchIssueComments(repo, issueNumber, ghFn);
        timeline = await fetchIssueTimeline(repo, issueNumber, ghFn);
      } catch {
        continue;
      }

      // Title — best-effort.
      const title = await fetchIssueTitle(repo, issueNumber, ghFn);

      for (const comment of comments) {
        if (comment.user?.login !== options.workerUser) continue;
        if (!isRecoveryComment(comment.body)) continue;
        const t = Date.parse(comment.created_at);
        if (!isFinite(t) || t < sinceT) continue;

        const markerState = deriveMarkerState(
          comments,
          comment.created_at,
          staleWindowSeconds,
        );
        const openLinkedPR = hadOpenLinkedPRAtRecovery(
          timeline,
          comment.created_at,
        );
        const completed = completedWithinFollowUp(
          timeline,
          comment.created_at,
          FOLLOW_UP_WINDOW_DAYS,
        );

        const category = classifyEvent({
          markerState,
          openLinkedPRAtRecovery: openLinkedPR,
          completedWithinFollowUp: completed,
        });

        events.push({
          repo,
          issue: issueNumber,
          title,
          recoveryCommentId: comment.id,
          recoveryAt: comment.created_at,
          category,
        });
        seenIssues.add(`${repo}#${issueNumber}`);
      }
    }
  }

  const byCategory: Record<RecoveryCategory, number> = {
    "legitimate-crash": 0,
    "false-positive:cleared-marker": 0,
    "false-positive:open-pr": 0,
    "false-positive:other": 0,
  };
  for (const ev of events) byCategory[ev.category]++;

  return {
    ok: true,
    value: {
      generatedAt: now.toISOString(),
      windowDays,
      workerUser: options.workerUser,
      reposScanned: [...options.repos],
      totals: { events: events.length, issues: seenIssues.size },
      byCategory,
      events,
    },
  };
}

/**
 * Render the markdown report for `docs/audits/heartbeat-recovery-audit-*`.
 */
export function formatAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const dateOnly = report.generatedAt.slice(0, 10);
  lines.push(`# Heartbeat-recovery audit — ${dateOnly}`);
  lines.push("");
  lines.push(
    `Window: last ${report.windowDays} days  |  Worker user: \`${report.workerUser}\``,
  );
  lines.push(
    `Repos scanned: ${report.reposScanned.length}  |  Total events: ${report.totals.events}  |  Issues with events: ${report.totals.issues}`,
  );
  lines.push("");

  lines.push("## Breakdown by category");
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("| --- | ---: |");
  const ordered: RecoveryCategory[] = [
    "legitimate-crash",
    "false-positive:cleared-marker",
    "false-positive:open-pr",
    "false-positive:other",
  ];
  for (const cat of ordered) {
    lines.push(`| \`${cat}\` | ${report.byCategory[cat]} |`);
  }
  lines.push("");

  lines.push("## Representative issues");
  lines.push("");
  for (const cat of ordered) {
    const examples = report.events.filter((e) => e.category === cat).slice(
      0,
      5,
    );
    lines.push(`### \`${cat}\` (${report.byCategory[cat]})`);
    lines.push("");
    if (examples.length === 0) {
      lines.push("_No events in this category._");
      lines.push("");
      continue;
    }
    lines.push("| Repo | Issue | Recovery time |");
    lines.push("| --- | --- | --- |");
    for (const ev of examples) {
      const link =
        `[#${ev.issue}](https://github.com/${ev.repo}/issues/${ev.issue})`;
      lines.push(`| \`${ev.repo}\` | ${link} | ${ev.recoveryAt} |`);
    }
    lines.push("");
  }

  lines.push("## Conclusion");
  lines.push("");
  lines.push(buildConclusion(report));
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a one-paragraph conclusion describing the dominant failure mode.
 */
export function buildConclusion(report: AuditReport): string {
  const total = report.totals.events;
  if (total === 0) {
    return "No `Assigned-without-heartbeat recovery (Issue #632)` events were observed in the window. The recovery path appears to be quiescent.";
  }
  const ordered: RecoveryCategory[] = [
    "legitimate-crash",
    "false-positive:cleared-marker",
    "false-positive:open-pr",
    "false-positive:other",
  ];
  const ranked = ordered
    .map((c) => ({ cat: c, count: report.byCategory[c] }))
    .sort((a, b) => b.count - a.count);
  const top = ranked[0]!;
  const pct = Math.round((top.count / total) * 100);
  const falsePositives = total - report.byCategory["legitimate-crash"];
  const fpPct = Math.round((falsePositives / total) * 100);
  return (
    `Across ${total} recovery events, the dominant category is \`${top.cat}\` ` +
    `(${top.count}/${total}, ${pct}%). False positives in total account for ` +
    `${falsePositives}/${total} (${fpPct}%) of events. ` +
    "Use this baseline to prioritise fixes — the largest false-positive bucket is the most leveraged target."
  );
}

/** Parse a comma-separated or JSON `--repos` argument. */
function parseReposArg(
  args: Record<string, unknown>,
  config: WorkerConfig,
): string[] {
  const raw = args["repos"];
  if (Array.isArray(raw)) {
    return raw.map(String).map((r) => r.trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((r) => r.trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
    return raw.split(",").map((r) => r.trim()).filter(Boolean);
  }
  return config.repos ?? [];
}

/** Parse a numeric argument, falling back to a default. */
function parseNumberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = args[key];
  if (typeof raw === "number" && isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

/** The audit-heartbeat-recoveries command implementation. */
export const auditHeartbeatRecoveriesCommand: Command = {
  name: "audit-heartbeat-recoveries",
  description:
    "Audit `Assigned-without-heartbeat recovery (Issue #632)` events across configured repos (Issue #1885)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<AuditReport>> {
    const repos = parseReposArg(args, config);
    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to audit. Pass --repos org/repo1,org/repo2 or configure repos in .config.json.",
      };
    }
    const windowDays = parseNumberArg(args, "days", DEFAULT_WINDOW_DAYS);
    const workerUserArg = args["worker"];
    let workerUser: string;
    if (typeof workerUserArg === "string" && workerUserArg.length > 0) {
      workerUser = workerUserArg;
    } else {
      const userResult = await getGithubUser();
      if (!userResult.ok) {
        return {
          success: false,
          message:
            `Failed to detect worker user (pass --worker to override): ${userResult.error.message}`,
        };
      }
      workerUser = userResult.value;
    }

    const result = await auditHeartbeatRecoveries({
      repos,
      workerUser,
      windowDays,
    });
    if (!result.ok) {
      return {
        success: false,
        message: `Audit failed: ${result.error.message}`,
      };
    }

    const md = formatAuditMarkdown(result.value);
    const dateOnly = result.value.generatedAt.slice(0, 10);
    const outArg = args["out"];
    const outPath = typeof outArg === "string" && outArg.length > 0
      ? outArg
      : `docs/audits/heartbeat-recovery-audit-${dateOnly}.md`;

    try {
      await Deno.mkdir("docs/audits", { recursive: true });
      await Deno.writeTextFile(outPath, md);
    } catch (err) {
      return {
        success: false,
        message: `Failed to write report: ${(err as Error).message}`,
      };
    }

    return {
      success: true,
      message: `Wrote ${outPath} (${result.value.totals.events} events).`,
      data: result.value,
    };
  },
};
