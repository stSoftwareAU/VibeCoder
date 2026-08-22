/**
 * Deferral of a `work-on` issue that is blocked on another issue (Issue #222).
 *
 * The no-changes handler had two endings — close ("already complete") and
 * `needs-human` ("analysis-only"). Neither fits a run whose agent correctly
 * found the work blocked on unfinished dependency work: closing it discards a
 * live task, and `needs-human` strips the discovery label and parks it on a
 * human who can do nothing until the dependency lands.
 *
 * A deferral is the third ending:
 *   * the issue stays **open**, with its discovery label untouched — no
 *     `needs-human`, so `stripDiscoveryLabelsOnEscalation` never fires;
 *   * `Depends on owner/repo#N` is recorded in the body, the exact form
 *     `isDependencyBlocked` reads, so the next scan skips the issue until the
 *     dependency closes (a `blocked` label is the fallback when the body
 *     cannot be edited);
 *   * the claim is released with the outcome
 *     `deferred: depends on owner/repo#N`, which the release comment states.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type BlockedOutcome,
  buildDependencyLine,
  formatDependencyRef,
} from "./blocked_outcome.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import { expectedNoPrOutcome, type RunOutcome } from "./run_outcome.ts";
import { releaseClaim as defaultReleaseClaim } from "./claim_release.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

/** Label applied when the dependency line cannot be written to the body. */
export const BLOCKED_LABEL = "blocked";

/** Injectable dependencies for {@link deferBlockedIssue} (testing). */
export interface DeferBlockedIssueDeps {
  /** Override the claim-release helper. Defaults to {@link releaseClaim}. */
  releaseClaim?: typeof defaultReleaseClaim;
  /** Ensure the `blocked` label exists before it is applied. */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
}

/** Options accepted by {@link deferBlockedIssue}. */
export interface DeferBlockedIssueOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  /** The detected blocked outcome — its dependency drives everything. */
  blocked: BlockedOutcome;
  /** Redacted tail of the agent's output, embedded in the comment. */
  outputSnippet: string;
  logger: Logger;
  deps?: DeferBlockedIssueDeps;
}

/** How the deferral was recorded so the dependency gate can see it. */
export type DeferralRecord = "body" | "label" | "none";

/** What {@link deferBlockedIssue} did. */
export interface DeferBlockedIssueResult {
  /** Where the dependency was recorded. */
  recorded: DeferralRecord;
  /** `owner/repo#N` of the dependency deferred on. */
  ref: string;
  /** Outcome forwarded to the claim-release comment. */
  outcome: RunOutcome;
}

/** The release-comment summary — the wording the acceptance criteria name. */
export function buildDeferralSummary(ref: string): string {
  return `deferred: depends on ${ref}`;
}

/** The public comment explaining the deferral, quoting the agent's reason. */
export function buildDeferralComment(
  blocked: BlockedOutcome,
  ref: string,
  outputSnippet: string,
): string {
  return `## Deferred — blocked on ${ref}\n\n` +
    `No code changes: this run reported the work blocked on another issue, ` +
    `so the issue stays open and keeps its discovery label. ` +
    `\`Depends on ${ref}\` is recorded below, and the dependency gate skips ` +
    `this issue until ${ref} closes — no human action is needed.\n\n` +
    `**Reason given by the run:**\n\n` +
    `${blocked.reason.split("\n").map((l) => `> ${l}`).join("\n")}\n\n` +
    `<details>\n<summary>Full output</summary>\n\n` +
    `\`\`\`\n${outputSnippet}\n\`\`\`\n\n</details>`;
}

/** True when `body` already declares `dep` in a form the gate reads. */
function bodyDeclaresDependency(
  body: string,
  blocked: BlockedOutcome,
): boolean {
  const wanted = formatDependencyRef(blocked.dependency).toLowerCase();
  return extractDependencyReferencesDetailed(body).some((ref) =>
    `${ref.repo ?? ""}#${ref.number}`.toLowerCase() === wanted
  );
}

/**
 * Record the dependency in the issue body, so `isDependencyBlocked` sees it.
 *
 * @returns `true` when the body now declares the dependency.
 */
async function recordDependencyInBody(
  options: DeferBlockedIssueOptions,
  line: string,
): Promise<boolean> {
  const { ghClient, repo, issueNumber, blocked, logger } = options;
  const issue = await ghClient.getIssue(repo, issueNumber);
  const body = issue.body ?? "";
  if (bodyDeclaresDependency(body, blocked)) {
    logger.info("Issue body already declares the dependency", {
      repo,
      issueNumber,
    });
    return true;
  }
  const separator = body.trim().length > 0 ? "\n\n" : "";
  await ghClient.editIssue(repo, issueNumber, {
    body: `${body.trimEnd()}${separator}${line}\n`,
  });
  return true;
}

/**
 * Defer a blocked `work-on` issue instead of closing or escalating it.
 *
 * Every GitHub step is best-effort and non-fatal — a failure is logged and the
 * next step still runs — but the failure is never reported as success: the
 * returned `recorded` says exactly how the dependency was captured (`body`,
 * the `blocked` label fallback, or `none` when both failed), so the caller can
 * log a partial deferral rather than a clean one.
 */
export async function deferBlockedIssue(
  options: DeferBlockedIssueOptions,
): Promise<DeferBlockedIssueResult> {
  const {
    ghClient,
    repo,
    issueNumber,
    githubUser,
    blocked,
    outputSnippet,
    logger,
    deps,
  } = options;
  const releaseClaim = deps?.releaseClaim ?? defaultReleaseClaim;
  const ref = formatDependencyRef(blocked.dependency);
  const line = buildDependencyLine(blocked.dependency);

  try {
    await ghClient.postComment(
      repo,
      issueNumber,
      buildDeferralComment(blocked, ref, outputSnippet),
    );
  } catch (err) {
    logger.warn("Failed to post the deferral comment", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let recorded: DeferralRecord = "none";
  try {
    if (await recordDependencyInBody(options, line)) recorded = "body";
  } catch (err) {
    logger.warn("Failed to record the dependency in the issue body", {
      repo,
      issueNumber,
      dependency: ref,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (recorded === "none") {
    // Fallback: the `blocked` label at least keeps the deferral visible.
    try {
      await deps?.ensureLabelExists?.(
        repo,
        BLOCKED_LABEL,
        "d93f0b",
        "Blocked on another issue",
      );
      await ghClient.addLabel(repo, issueNumber, BLOCKED_LABEL);
      recorded = "label";
    } catch (err) {
      logger.warn("Failed to apply the blocked label", {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (recorded === "none") {
    logger.warn(
      "Deferred a blocked issue but recorded the dependency nowhere — the " +
        "next scan will re-pick it up",
      { repo, issueNumber, dependency: ref },
    );
  }

  const outcome = expectedNoPrOutcome(
    "handle_no_changes",
    buildDeferralSummary(ref),
  );
  await releaseClaim(ghClient, repo, issueNumber, githubUser, logger, {
    outcome,
  });

  return { recorded, ref, outcome };
}
