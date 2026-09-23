/**
 * diagnose-repo command (Issue #1118).
 *
 * Analyses a repository and reports why issues are blocked from being
 * selected by the worker. Delegates to the diagnose_repo library for
 * all business logic (label formatting, blocking reasons, per-issue
 * diagnosis, summary generation).
 *
 * Usage:
 *   deno_run_command diagnose-repo --repo stSoftwareAU/private-repo-24 --github-user worker-bot
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  diagnoseRepoIssue,
  type DiagnosticSummary,
  formatIssueDiagnostic,
  generateSummary,
  type IssueDiagnostic,
  type LabelConfig,
} from "../lib/diagnose_repo.ts";
import type { FleetConfigValidation } from "../lib/fleet_config_validation.ts";
import {
  fetchAllIssues,
  fetchIssuesByLabel,
  fetchOpenPRsForFleet,
} from "../lib/issue_query.ts";
import {
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "../lib/fleet_authors.ts";
import {
  formatFleetConfigValidation,
  validateFleetConfig,
} from "../lib/fleet_config_validation.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import { COOLDOWN_DEFAULTS, isIssueInCooldown } from "../lib/cooldown_state.ts";
import type { CooldownConfig } from "../lib/cooldown_state.ts";
import { normaliseIssueState } from "../lib/issue_dependencies.ts";
import type { IssueFetcher } from "../lib/issue_dependencies.ts";
import type { DependencyBlocker } from "../lib/issue_finder_common.ts";
import {
  createOpenMilestoneLookup,
  describeDependencyBlockers,
  isDependencyBlocked,
} from "../lib/issue_finder_common.ts";
import { runGhCommand } from "../lib/github.ts";

/**
 * Full repository diagnostic report data.
 */
export interface RepoDiagnosticReport {
  repo: string;
  githubUser: string;
  prCount: number;
  issues: IssueDiagnostic[];
  summary: DiagnosticSummary;
  /** Fleet author set the open-PR guard queries (Issue #3138). */
  fleetAuthors: string[];
  /** Fleet-configuration validation result (Issue #3138). */
  fleetValidation: FleetConfigValidation;
}

/**
 * Create an IssueFetcher from a gh command function.
 */
function createIssueFetcher(
  ghCommandFn: (args: string[]) => Promise<string>,
): IssueFetcher {
  return {
    async getIssueState(repo: string, issueNumber: number) {
      const output = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        // Issue #2533: `milestone` rides this existing per-dependency call so
        // the cross-milestone hold (Issue #2173) can name the open milestone
        // holding a closed dependency, at no extra `gh` call.
        "number,state,title,milestone",
      ]);
      const parsed = JSON.parse(output) as {
        number: number;
        state: string;
        title: string;
        milestone?: { title?: string } | null;
      };
      return {
        number: parsed.number,
        // Issue #3218: a merged PR reports `MERGED` — resolve it to CLOSED.
        state: normaliseIssueState(parsed.state),
        title: parsed.title,
        milestone: parsed.milestone?.title ?? null,
      };
    },
    async getSubIssues(repo: string, issueNumber: number) {
      try {
        const output = await ghCommandFn([
          "api",
          `repos/${repo}/issues/${issueNumber}`,
        ]);
        const parsed = JSON.parse(output) as { body?: string };
        if (!parsed.body) return [];
        const { extractSubIssueReferences } = await import(
          "../lib/issue_dependencies.ts"
        );
        return extractSubIssueReferences(parsed.body, repo);
      } catch {
        return [];
      }
    },
    async getIssueBody(repo: string, issueNumber: number) {
      const output = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "body",
      ]);
      const parsed = JSON.parse(output) as { body?: string };
      return parsed.body ?? "";
    },
  };
}

export const diagnoseRepoCommand: Command = {
  name: "diagnose-repo",
  description:
    "Analyse a repository and report why issues are blocked from worker pickup",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RepoDiagnosticReport>> {
    const repo = args["repo"] as string | undefined;
    if (!repo) {
      return {
        success: false,
        message:
          "Required argument 'repo' is missing (e.g., --repo owner/repo)",
      };
    }

    // Validate repository format
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
      return {
        success: false,
        message: "Invalid repository format. Expected 'owner/repo'.",
      };
    }

    const githubUser = (args["github-user"] as string | undefined) ??
      Deno.env.get("GITHUB_USER") ??
      "";

    if (!githubUser) {
      return {
        success: false,
        message:
          "Required argument 'github-user' is missing and GITHUB_USER env var is not set",
      };
    }

    const ghFn = runGhCommand;

    // Build label config from worker config
    const labelConfig: LabelConfig = {
      failedLabel: config.failedLabel,
      failedOnceLabel: config.failedOnceLabel,
      // Issue #2031: needs-clarification retired; needs-human is the handoff signal.
      needsHumanLabel: config.needsHumanLabel,
      refineIssueLabel: config.refineIssueLabel,
      planningLabel: config.planningLabel,
      questionLabel: config.questionLabel,
    };

    // Issue #3138: validate fleet configuration and fetch open PRs across the
    // whole fleet (host login + allowed_authors + fleet_pr_authors), matching
    // the open-PR guard's real inputs so the diagnostic reflects what the
    // guard actually sees — a per-user-only fetch here hid the #3095 blind
    // spot from operators running diagnose-repo.
    const fleetValidation = validateFleetConfig({
      githubUser,
      allowedAuthors: config.allowedAuthors,
      fleetPrAuthors: config.fleetPrAuthors ?? [],
      serviceAccounts: config.serviceAccounts ?? [],
    });
    const fleetAuthors = resolveFleetAuthors(
      githubUser,
      config.allowedAuthors,
      config.fleetPrAuthors ?? [],
      // Issue #209: a sibling listed only under `service_accounts` must
      // still have its open PRs fetched here, or diagnose-repo reports a
      // blind spot as healthy.
      config.serviceAccounts ?? [],
    );
    const prs = await fetchOpenPRsForFleet(repo, fleetAuthors, undefined, ghFn);

    // Fetch all issues for milestone occupancy checks
    const allIssues = await fetchAllIssues(repo, undefined, 100, ghFn);

    // Collect relevant labels to search for
    // Issue #2031: needs-clarification retired — needs-human is the handoff label.
    const searchLabels = new Set<string>([
      ...config.issueLabels,
      config.workOnLabel,
      config.failedLabel,
      config.failedOnceLabel,
      config.needsHumanLabel,
      config.planningLabel,
      config.questionLabel,
    ]);

    // Fetch issues for each label and deduplicate
    const seenIssues = new Set<number>();
    const diagnostics: IssueDiagnostic[] = [];

    let eligibleCount = 0;
    let prBlockedCount = 0;
    let labelBlockedCount = 0;
    let dependencyBlockedCount = 0;
    let otherBlockedCount = 0;

    // Create fetcher for dependency checks
    const fetcher = createIssueFetcher(ghFn);

    // Issue #2533: one memoised open-milestone lookup for the whole repo, so
    // the cross-milestone hold costs a single milestone listing rather than one
    // per candidate.
    const milestoneScope = createOpenMilestoneLookup(repo, undefined, ghFn);

    for (const label of searchLabels) {
      let issues: FilterableIssue[];
      try {
        issues = await fetchIssuesByLabel(repo, label, undefined, 50, ghFn);
      } catch {
        continue;
      }

      for (const issue of issues) {
        if (seenIssues.has(issue.number)) continue;
        seenIssues.add(issue.number);

        // Check cooldown
        let isInCooldown = false;
        const cdConfig: CooldownConfig = {
          workDir: config.workDir,
          issueRetryCooldown: COOLDOWN_DEFAULTS.issueRetryCooldown,
        };
        try {
          isInCooldown = await isIssueInCooldown(
            cdConfig,
            repo,
            issue.number,
          );
        } catch {
          // Cooldown check failed — assume not in cooldown
        }

        // Check dependencies.
        // Issue #2533: run the scan's own `isDependencyBlocked` gate with this
        // candidate's milestone scope rather than a hand-rolled open-state
        // loop. The loop only asked "is the dependency OPEN?", so a dependency
        // closed inside another still-open milestone — held by the
        // cross-milestone hold (Issue #2173) — was reported here as no
        // dependency at all, contradicting the scan that skipped the issue.
        let unmetDependencies: string | undefined;
        let openSubIssues: string | undefined;
        try {
          // Supplying `blockers` makes the return value exactly
          // `blockers.length > 0`, so the collected list is the verdict.
          const blockers: DependencyBlocker[] = [];
          await isDependencyBlocked(
            repo,
            issue.number,
            fetcher,
            undefined,
            {
              candidateMilestone: issue.milestone,
              isMilestoneOpen: milestoneScope,
            },
            blockers,
          );
          const children = blockers.filter((b) => b.kind === "child");
          if (children.length > 0) {
            openSubIssues = children.map((b) => `#${b.number}`).join(", ");
          }
          const forward = blockers.filter((b) => b.kind === "depends-on");
          if (forward.length > 0) {
            unmetDependencies = describeDependencyBlockers(repo, forward);
          }
        } catch {
          // Dependency check failed — skip
        }

        const diag = diagnoseRepoIssue({
          issue,
          prs,
          allIssues,
          labelConfig,
          workerUser: githubUser,
          // Issue #1064: the fleet-operated accounts, never the
          // `allowed_authors` permission list.
          pushCapableAuthors: resolveFleetMaintenanceAuthorSet({
            githubUser,
            fleetPrAuthors: config.fleetPrAuthors ?? [],
          }),
          isInCooldown,
          unmetDependencies,
          openSubIssues,
          // Issue #2533: the operator's own tier label names, so a
          // stream-sharing tier is not reported as blocked by occupancy.
          streamSharingTiers: {
            issueLabels: config.issueLabels,
            workOnLabel: config.workOnLabel,
          },
        });

        diagnostics.push(diag);

        // Categorise for summary
        if (!diag.isBlocked) {
          eligibleCount++;
        } else if (
          diag.reasons.some((r) => r.includes("Blocked by open PR"))
        ) {
          prBlockedCount++;
        } else if (diag.reasons.some((r) => r.includes("Blocking label"))) {
          labelBlockedCount++;
        } else if (
          diag.reasons.some(
            (r) =>
              r.toLowerCase().includes("depend") ||
              r.toLowerCase().includes("sub-issue"),
          )
        ) {
          dependencyBlockedCount++;
        } else {
          otherBlockedCount++;
        }
      }
    }

    const summary = generateSummary({
      totalIssues: diagnostics.length,
      eligibleCount,
      prBlockedCount,
      labelBlockedCount,
      dependencyBlockedCount,
      otherBlockedCount,
    });

    // Build formatted output
    const outputLines: string[] = [];
    outputLines.push(`# Repository Diagnostic Report: ${repo}`);
    outputLines.push("");
    outputLines.push(`Worker user: ${githubUser}`);
    outputLines.push("");

    // Fleet configuration section (Issue #3138)
    outputLines.push("## Fleet Configuration");
    outputLines.push("");
    outputLines.push(
      `Fleet authors queried by the open-PR guard: ${
        fleetAuthors.join(", ") || "(none)"
      }`,
    );
    for (const line of formatFleetConfigValidation(fleetValidation)) {
      outputLines.push(line);
    }
    outputLines.push("");

    // Open PRs section
    outputLines.push("## Open PRs by Fleet");
    outputLines.push("");
    if (prs.length === 0) {
      outputLines.push(`No open PRs across the fleet in ${repo}.`);
    } else {
      outputLines.push(`Open PRs across the fleet (${prs.length}):`);
      outputLines.push("");
      for (const pr of prs) {
        outputLines.push(
          `  - PR #${pr.number}: ${pr.title} (base: ${
            pr.baseRefName || "unknown"
          })`,
        );
      }
    }
    outputLines.push("");

    // Per-issue diagnostics
    outputLines.push("## Per-Issue Diagnostics");
    outputLines.push("");

    if (diagnostics.length === 0) {
      outputLines.push("No issues found with relevant labels.");
      outputLines.push("");
    } else {
      for (const diag of diagnostics) {
        outputLines.push(formatIssueDiagnostic(diag));
      }
    }

    // Summary
    outputLines.push(summary.formatted);

    const report: RepoDiagnosticReport = {
      repo,
      githubUser,
      prCount: prs.length,
      issues: diagnostics,
      summary,
      fleetAuthors,
      fleetValidation,
    };

    return {
      success: true,
      message: outputLines.join("\n"),
      data: report,
    };
  },
};
