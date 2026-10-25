/**
 * clear-worker-gate-labels command (Issue #4132).
 *
 * One-off sweep. It selects the latest failure record, and removes failure
 * labels only for a fleet-authored Automated Processing Failed record in
 * Issue #4132's four-category cleanup scope. Later records from other worker
 * paths retain their labels, even when an older gate failure qualified.
 *
 * Dry-run is the default, matching the other destructive command that
 * reports unless `--dry-run false` is passed (`pr-manager
 * close-duplicate-prs`). A live run is never implied by omitting the flag.
 *
 * Usage:
 *   deno run mod.ts clear-worker-gate-labels
 *   deno run mod.ts clear-worker-gate-labels --repos owner/repo
 *   deno run mod.ts clear-worker-gate-labels --dry-run false --repos owner/repo
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import { parseCategoryFromComment } from "./analyse_failed_once.ts";
import {
  getFailureCategoryDisplay,
  isWorkerGateLabelCleanupDisplay,
  WORKER_GATE_LABEL_CLEANUP_CATEGORIES,
} from "../lib/failure_diagnosis.ts";
import { resolveAlertDedupAuthors } from "../lib/alert_dedup_authors.ts";
import {
  isFleetAuthor,
  resolveFleetMaintenanceAuthorSet,
} from "../lib/fleet_authors.ts";
import {
  FAILURE_RECORD_HEADING_PATTERN,
  parseCommentRows,
  parseLabelledIssues,
} from "../lib/issue_sweep_parse.ts";
import { DEFAULT_LABEL_CONFIG } from "../lib/label_types.ts";
import {
  coerceBooleanFlag,
  coerceStringListFlag,
} from "../lib/command_args.ts";
import { processEnvLookup } from "../lib/env_lookup.ts";

/** Heading `label_failure.ts` writes on a failure record. */
const FAILURE_HEADING_RE = /^##\s+Automated Processing Failed\b/;
const FAILURE_RECORD_RE = new RegExp(FAILURE_RECORD_HEADING_PATTERN);

const FAILED_LABEL = DEFAULT_LABEL_CONFIG.failedLabel;
const FAILED_ONCE_LABEL = DEFAULT_LABEL_CONFIG.failedOnceLabel;

/** Displays shared by cleanup, reports and help. */
function workerGateDisplays(): string[] {
  return WORKER_GATE_LABEL_CLEANUP_CATEGORIES.map(getFailureCategoryDisplay);
}

/** Printed on every report so operators can inspect the exact cleanup scope. */
function predicateNote(): string {
  return "isWorkerGateLabelCleanupDisplay accepts exactly " +
    workerGateDisplays().join(", ") +
    ". criteria-unmet and every other category are left labelled.";
}

/** One issue the sweep considered. */
export interface WorkerGateLabelDecision {
  repo: string;
  issueNumber: number;
  /** Display category, or `none` when the issue has no failure comment. */
  category: string;
  action: "would-remove" | "removed" | "keep";
  reason: string;
  /** Failure labels present on the issue. */
  labels: string[];
}

/** What one invocation decided. */
export interface WorkerGateLabelReport {
  dryRun: boolean;
  decisions: WorkerGateLabelDecision[];
}

/** Options for {@link clearWorkerGateLabels}. */
export interface ClearWorkerGateLabelsOptions {
  repos: string[];
  /** When true, the report is the only effect. */
  dryRun: boolean;
  /** Fleet logins whose failure comments are trusted. */
  fleetAuthors: readonly string[];
  /** Max issues fetched per label. Defaults to 200. */
  limit?: number;
  /** Injectable gh runner. Production uses `runGhCommand`. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Sink for the author-check warnings. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/**
 * Read `--dry-run`. Absent means dry-run. A live run is `--dry-run false`.
 * A value that is not true or false is refused, so a typo cannot select
 * either default.
 */
export function dryRunFromArgs(value: unknown): Result<boolean> {
  return coerceBooleanFlag(value, "dry-run", true);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isFailureComment(body: string): boolean {
  return FAILURE_RECORD_RE.test(body.trimStart());
}

/**
 * Decide what to do with one issue from its comments, oldest first.
 *
 * The latest failure comment is the one that counts. An older gate comment
 * does not clear an issue whose newest failure record is something else, and
 * a newer comment that is not a failure record does not hide the record.
 */
function decideIssue(
  repo: string,
  issueNumber: number,
  labels: readonly string[],
  comments: ReadonlyArray<{ author?: string | null; body: string }>,
  fleet: string[],
): WorkerGateLabelDecision {
  const present = [...labels];
  const failures = comments.filter((comment) => isFailureComment(comment.body));
  const latest = failures[failures.length - 1];
  if (!latest) {
    return {
      repo,
      issueNumber,
      category: "none",
      action: "keep",
      reason: "no failure comment",
      labels: present,
    };
  }
  const category = parseCategoryFromComment(latest.body);
  if (!isFleetAuthor(latest.author, fleet)) {
    return {
      repo,
      issueNumber,
      category,
      action: "keep",
      reason: "latest failure comment is not fleet-authored",
      labels: present,
    };
  }
  if (!FAILURE_HEADING_RE.test(latest.body.trimStart())) {
    return {
      repo,
      issueNumber,
      category,
      action: "keep",
      reason: "latest failure record belongs to another worker path",
      labels: present,
    };
  }
  if (!isWorkerGateLabelCleanupDisplay(category)) {
    return {
      repo,
      issueNumber,
      category,
      action: "keep",
      reason: `category ${category} is not a worker-gate category`,
      labels: present,
    };
  }
  return {
    repo,
    issueNumber,
    category,
    action: "would-remove",
    reason: "fleet-authored failure comment names a worker-gate category",
    labels: present,
  };
}

/**
 * List open issues carrying one failure label. A failed `gh` call or an
 * unreadable payload is an error. An empty array is a real empty list.
 */
async function listLabelled(
  repo: string,
  label: string,
  limit: number,
  gh: (args: string[]) => Promise<string>,
): Promise<Result<Map<number, Set<string>>>> {
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
      "--limit",
      String(limit),
      "--json",
      "number,labels",
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `listing open '${label}' issues on ${repo}: ${asError(err).message}`,
      ),
    };
  }
  let parsed;
  try {
    parsed = parseLabelledIssues(raw);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `parsing the '${label}' issue list on ${repo}: ${asError(err).message}`,
      ),
    };
  }
  const found = new Map<number, Set<string>>();
  for (const issue of parsed) {
    const labels = new Set<string>();
    labels.add(label);
    for (const name of issue.labels) {
      if (name === FAILED_LABEL || name === FAILED_ONCE_LABEL) labels.add(name);
    }
    found.set(issue.number, labels);
  }
  return { ok: true, value: found };
}

/**
 * Survey the repos and, unless `dryRun`, remove `failed` / `failed-once`
 * from issues whose latest fleet-authored failure comment names a category
 * `isWorkerGateLabelCleanupDisplay` accepts.
 *
 * Every issue considered is returned. A failed list or a failed comment
 * read returns an error and removes nothing: the reads all happen before
 * any label edit.
 */
export async function clearWorkerGateLabels(
  options: ClearWorkerGateLabelsOptions,
): Promise<Result<WorkerGateLabelReport>> {
  if (options.repos.length === 0) {
    return {
      ok: false,
      error: new Error(
        "No repos to clear. Pass --repos owner/repo or configure repos.",
      ),
    };
  }
  const gh = options.ghCommandFn ?? runGhCommand;
  const log = options.log ?? ((message: string) => console.warn(message));
  const limit = options.limit ?? 200;
  const fleet = await resolveAlertDedupAuthors(
    { fleetAuthors: [...options.fleetAuthors] },
    log,
  );
  if (fleet.length === 0) {
    return {
      ok: false,
      error: new Error(
        "Fleet author set is unresolved, so no failure comment can be " +
          "trusted. No label was removed. Configure service_accounts, " +
          "fleet_pr_authors or GITHUB_USER.",
      ),
    };
  }

  const decisions: WorkerGateLabelDecision[] = [];
  for (const repo of options.repos) {
    const candidates = new Map<number, Set<string>>();
    for (const label of [FAILED_ONCE_LABEL, FAILED_LABEL]) {
      const listed = await listLabelled(repo, label, limit, gh);
      if (!listed.ok) return listed;
      for (const [number, labels] of listed.value) {
        const existing = candidates.get(number);
        if (existing) {
          for (const name of labels) existing.add(name);
        } else {
          candidates.set(number, new Set(labels));
        }
      }
    }

    const numbers = [...candidates.keys()].sort((a, b) => a - b);
    for (const issueNumber of numbers) {
      const labels = [...(candidates.get(issueNumber) ?? [])];
      let raw: string;
      try {
        raw = await gh([
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repo,
          "--json",
          "comments",
        ]);
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `reading comments on ${repo}#${issueNumber}: ${
              asError(err).message
            }`,
          ),
        };
      }
      let comments;
      try {
        comments = parseCommentRows(raw);
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `parsing comments on ${repo}#${issueNumber}: ${
              asError(err).message
            }`,
          ),
        };
      }
      decisions.push(
        decideIssue(repo, issueNumber, labels, comments, fleet),
      );
    }
  }

  if (!options.dryRun) {
    for (const decision of decisions) {
      if (decision.action !== "would-remove") continue;
      const args = [
        "issue",
        "edit",
        String(decision.issueNumber),
        "--repo",
        decision.repo,
      ];
      for (const label of decision.labels) {
        args.push("--remove-label", label);
      }
      try {
        await gh(args);
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `removing ${
              decision.labels.join(", ")
            } from ${decision.repo}#${decision.issueNumber}: ${
              asError(err).message
            }`,
          ),
        };
      }
      decision.action = "removed";
    }
  }

  return { ok: true, value: { dryRun: options.dryRun, decisions } };
}

/** Operator-facing log. Every considered issue is one row. */
export function formatWorkerGateLabelReport(
  report: WorkerGateLabelReport,
): string {
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? "# Clear worker-gate failure labels (dry-run)"
      : "# Clear worker-gate failure labels",
  );
  lines.push("");
  lines.push(predicateNote());
  lines.push("");
  if (report.dryRun) {
    lines.push("Dry-run: no label was removed.");
  } else {
    const removed = report.decisions.filter((decision) =>
      decision.action === "removed"
    ).length;
    lines.push(`Removed the failure label on ${removed} issue(s).`);
  }
  lines.push("");
  lines.push("| Repo | Issue | Category | Action | Reason |");
  lines.push("| --- | --- | --- | --- | --- |");
  if (report.decisions.length === 0) {
    lines.push(
      "| _none_ | — | — | — | no open failed or failed-once issue |",
    );
  } else {
    for (const decision of report.decisions) {
      lines.push(
        `| ${decision.repo} | #${decision.issueNumber} | ${decision.category} | ${decision.action} | ${decision.reason} |`,
      );
    }
  }
  return lines.join("\n");
}

const HELP =
  "Clear failed and failed-once labels left by a worker gate (Issue #4132). " +
  "Dry-run is the default and removes nothing. " +
  "Usage: deno run mod.ts clear-worker-gate-labels [--repos owner/repo] [--limit 200]. " +
  "A live run is explicit: deno run mod.ts clear-worker-gate-labels --dry-run false [--repos owner/repo]. " +
  "Repos default to the worker config. " +
  "The latest failure record must be Automated Processing Failed and " +
  "fleet-authored. isWorkerGateLabelCleanupDisplay accepts exactly " +
  workerGateDisplays().join(", ") +
  ". criteria-unmet and every other category are left labelled.";

/** The clear-worker-gate-labels command implementation. */
export const clearWorkerGateLabelsCommand: Command = {
  name: "clear-worker-gate-labels",
  description: HELP,
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorkerGateLabelReport>> {
    const dryRun = dryRunFromArgs(args["dry-run"]);
    if (!dryRun.ok) {
      return { success: false, message: dryRun.error.message };
    }
    const parsedRepos = coerceStringListFlag(args["repos"], "repos");
    if (!parsedRepos.ok) {
      return { success: false, message: parsedRepos.error.message };
    }
    const repos = parsedRepos.value.length > 0
      ? parsedRepos.value
      : (config.repos ?? []);
    if (repos.length === 0) {
      return {
        success: false,
        message:
          "No repos to clear. Pass --repos owner/repo or configure repos in .config.json.",
      };
    }
    const limitArg = args["limit"];
    let limit = 200;
    if (limitArg !== undefined && limitArg !== null) {
      const parsed = typeof limitArg === "number"
        ? limitArg
        : typeof limitArg === "string" && /^\d+$/.test(limitArg.trim())
        ? parseInt(limitArg, 10)
        : Number.NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          success: false,
          message:
            "Invalid --limit: expected a positive integer. A limit that " +
            "cannot be read is refused, not treated as the default.",
        };
      }
      limit = parsed;
    }

    const fleetAuthors = resolveFleetMaintenanceAuthorSet({
      githubUser: processEnvLookup("GITHUB_USER") ?? "",
      fleetPrAuthors: config.fleetPrAuthors ?? [],
      serviceAccounts: config.serviceAccounts ?? [],
    });
    const result = await clearWorkerGateLabels({
      repos,
      dryRun: dryRun.value,
      fleetAuthors,
      limit,
    });
    if (!result.ok) {
      return { success: false, message: result.error.message };
    }
    return {
      success: true,
      message: formatWorkerGateLabelReport(result.value),
      data: result.value,
    };
  },
};
