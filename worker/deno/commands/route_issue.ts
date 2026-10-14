/**
 * `route-issue` — file an issue in the repository that owns the work
 * (Issue #3691).
 *
 * Usage:
 *   deno run --allow-all mod.ts route-issue --repo owner/repo \
 *     --title "..." --body-file body.md [--label L[,L2]] [--dry-run]
 *   deno run --allow-all mod.ts route-issue --repo owner/repo \
 *     --title "..." --part '["owner/a=a.md","owner/b=b.md;depends-on=owner/a"]' \
 *     [--label L[,L2]] [--dry-run]
 *   deno run --allow-all mod.ts route-issue \
 *     --resolve-duplicate owner/repo#N --correct owner/repo#M [--dry-run]
 *
 * Classifies the draft deterministically, checks write permission on the owner
 * repository, reuses a matching open or recently closed issue or pull request,
 * and otherwise creates the issue there. The audit is printed to stdout as
 * JSON. `--dry-run` creates nothing. A permission refusal or any other error
 * fails the command with a clear message; nothing is swallowed.
 *
 * `--resolve-duplicate` closes a wrong-repository duplicate in favour of the
 * correct issue, after the same checks as the create path. A diagnostic is
 * never closed (#2592).
 *
 * Australian English spelling used throughout.
 */

import type { Command, CommandResult, Logger, WorkerConfig } from "../types.ts";
import {
  findUnknownOptions,
  validateRouteIssueArgs,
  validateRouteIssueResolveArgs,
} from "../lib/command_args.ts";
import { loadConfig } from "../lib/config.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  type IssueRoutingAudit,
  type IssueRoutingContext,
  type IssueRoutingDraft,
  type IssueRoutingPart,
  IssueRoutingPermissionError,
  resolveWrongRepoDuplicate,
  routeIssueCreation,
} from "../lib/issue_routing.ts";
import { buildIssueRoutingContext } from "../lib/issue_routing_context.ts";
import { defaultLogger } from "../lib/logger.ts";

/** Injection points; the tests pass these through `__testDeps`. */
export interface RouteIssueDeps {
  ghCommandFn?: (args: string[]) => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  loadConfig?: typeof loadConfig;
  log?: (line: string) => void;
  logger?: Logger;
  now?: () => number;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "repo",
  "title",
  "body-file",
  "label",
  "part",
  "dry-run",
  "resolve-duplicate",
  "correct",
  "__testDeps",
]);

/** Builds the routing context for a target repository. */
type RoutingFor = (
  targetRepo: string,
  dryRun: boolean,
) => Promise<IssueRoutingContext>;

/** The audit as printed: stable snake_case fields an operator can parse. */
export interface RouteIssueReport {
  classification: "wrong-repo" | "ambiguous" | "correct-repo";
  owner_repository: string;
  subject_repository: string;
  issue_kind: string;
  reason: string;
  action: string;
  issues: IssueRoutingAudit["issues"];
  labels_not_migrated: string[];
}

/** The outcome of `--resolve-duplicate` as printed. */
export interface RouteIssueResolveReport {
  wrong_issue: string;
  correct_issue: string;
  dry_run: boolean;
  closed_wrong: boolean;
  reason: string;
}

/** Project an audit onto the printed report. */
export function toRouteIssueReport(audit: IssueRoutingAudit): RouteIssueReport {
  return {
    classification: audit.ambiguous
      ? "ambiguous"
      : audit.wrong_repo
      ? "wrong-repo"
      : "correct-repo",
    owner_repository: audit.owner_repository,
    subject_repository: audit.subject_repository,
    issue_kind: audit.issue_kind,
    reason: audit.reason,
    action: audit.action,
    issues: audit.issues,
    labels_not_migrated: audit.labels_not_migrated,
  };
}

/**
 * `--resolve-duplicate`: close the wrong-repository issue in favour of the
 * correct one. A refused or unfinished resolve is reported as not successful;
 * `--dry-run` reports what would happen and succeeds.
 */
async function resolveDuplicate(
  args: Record<string, unknown>,
  deps: RouteIssueDeps,
  log: (line: string) => void,
  logger: Logger,
  routingFor: RoutingFor,
): Promise<CommandResult<RouteIssueResolveReport>> {
  const parsed = validateRouteIssueResolveArgs(args);
  if (!parsed.ok) {
    return { success: false, message: parsed.error.message };
  }
  const { wrong, correct, dryRun } = parsed.value;
  const wrongText = `${wrong.repo}#${wrong.number}`;
  const correctText = `${correct.repo}#${correct.number}`;

  try {
    const routing = await routingFor(wrong.repo, dryRun);
    const outcome = await resolveWrongRepoDuplicate({
      wrong,
      correct,
      ctx: routing,
      gh: deps.ghCommandFn ?? runGhCommand,
      logger,
    });
    const report: RouteIssueResolveReport = {
      wrong_issue: wrongText,
      correct_issue: correctText,
      dry_run: dryRun,
      closed_wrong: outcome.closedWrong,
      reason: outcome.reason,
    };
    log(JSON.stringify(report, null, 2));
    return {
      success: outcome.closedWrong || dryRun,
      message: outcome.reason,
      data: report,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: error instanceof IssueRoutingPermissionError
        ? `Permission refused, nothing closed: ${message}`
        : `route-issue failed: ${message}`,
    };
  }
}

export const routeIssueCommand: Command = {
  name: "route-issue",
  description:
    "Create (or reuse) an issue in the repository that owns the work; " +
    "--dry-run creates nothing",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<
    CommandResult<RouteIssueReport | RouteIssueResolveReport>
  > {
    const deps = (args["__testDeps"] as RouteIssueDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));
    const logger = deps.logger ?? defaultLogger;

    const unknown = findUnknownOptions(args, KNOWN_OPTIONS);
    if (unknown.length > 0) {
      return {
        success: false,
        message: `Unknown option(s) ${
          unknown.map((k) => `--${k}`).join(", ")
        } — refused rather than ignored, because a mistyped --dry-run would ` +
          `otherwise read as a live run`,
      };
    }

    // One context builder for both modes, so they cannot drift.
    const routingFor: RoutingFor = (targetRepo, dryRun) =>
      buildIssueRoutingContext({
        targetRepo,
        dryRun,
        deps: { config: { loadConfig: deps.loadConfig ?? loadConfig } },
        logger,
        nowMs: (deps.now ?? Date.now)(),
      });

    if (args["resolve-duplicate"] !== undefined) {
      return await resolveDuplicate(args, deps, log, logger, routingFor);
    }

    const parsed = validateRouteIssueArgs(args);
    if (!parsed.ok) {
      return { success: false, message: parsed.error.message };
    }
    const { repo, title, bodyFile, labels, parts, dryRun } = parsed.value;
    const readText = deps.readTextFile ?? Deno.readTextFile;

    let draft: IssueRoutingDraft;
    if (bodyFile !== null) {
      let body: string;
      try {
        body = await readText(bodyFile);
      } catch (error: unknown) {
        return {
          success: false,
          message: `Could not read --body-file ${bodyFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      draft = { title, body, labels };
    } else {
      // --part mode: each part carries its own body; the top-level body stays
      // empty so no part's text can divert the draft to a single issue.
      const routedParts: IssueRoutingPart[] = [];
      for (const part of parts) {
        let partBody: string;
        try {
          partBody = await readText(part.bodyFile);
        } catch (error: unknown) {
          return {
            success: false,
            message: `Could not read --part body file ${part.bodyFile}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        routedParts.push({
          repo: part.repo,
          title,
          body: partBody,
          dependsOnRepos: part.dependsOnRepos,
        });
      }
      draft = { title, body: "", labels, parts: routedParts };
    }

    try {
      const routing = await routingFor(repo, dryRun);
      const audit = await routeIssueCreation(
        draft,
        repo,
        routing,
        deps.ghCommandFn ?? runGhCommand,
        logger,
      );
      const report = toRouteIssueReport(audit);
      log(JSON.stringify(report, null, 2));
      return {
        success: true,
        message: `route-issue ${audit.action}: ${
          audit.issues.map((i) =>
            i.number === null ? i.repo : `${i.repo}#${i.number}`
          ).join(", ")
        }`,
        data: report,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: error instanceof IssueRoutingPermissionError
          ? `Permission refused, nothing created: ${message}`
          : `route-issue failed: ${message}`,
      };
    }
  },
};
