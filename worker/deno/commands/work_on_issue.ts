/**
 * Work-on-issue command — top-level orchestrator for issue processing.
 *
 * Issue #1231: Migrates the work_on_issue() main orchestrator from
 * issue_worker.sh to Deno. This command wraps the workOnIssue()
 * function from issue_worker.ts and exposes it for CLI invocation
 * via the Deno CLI (`deno run mod.ts <command>`).
 *
 * The command:
 * 1. Validates required arguments
 * 2. Fetches issue data from GitHub (body, labels, comments)
 * 3. Validates issue input for security (Issue #478)
 * 4. Builds an IssueContext
 * 5. Delegates to workOnIssue() for full phase sequencing
 * 6. Returns a structured result for shell consumption
 *
 * Arguments:
 *   --repo              Repository in "owner/repo" format
 *   --issue-number      Issue number
 *   --issue-title       Issue title
 *   --github-user       Worker's GitHub username
 *   --milestone-title   Milestone title (optional, empty if none)
 *
 * Output: JSON with the orchestration result:
 *   { success, phase, reason, timings }
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type IssueContext,
  workOnIssue,
  type WorkOnIssueResult,
} from "../lib/issue_worker.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueData } from "../lib/issue_data.ts";
import { fetchIssueData } from "../lib/issue_data.ts";
import { enforceIssueBodyLimit, validateIssueInput } from "../lib/security.ts";
import { prepareTrustAnnotatedComments } from "../lib/comment_trust_filter.ts";
import { capFormattedComments } from "../lib/comment_rate_limiter.ts";
import { annotateIssueContentWithTrust } from "../lib/issue_content_trust_filter.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueResult,
} from "../lib/idle_task_claim_handler.ts";
import { finaliseIdleTaskWrapper } from "../lib/idle_task_wrapper_closure.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  type PickupContentIntegrityInput,
  type PickupContentIntegrityOutcome,
  verifyPickupContentIntegrity,
} from "../lib/pickup_content_integrity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed and validated arguments for the work-on-issue command. */
export interface WorkOnIssueArgs {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  githubUser: string;
  milestoneTitle?: string;
}

/** Injectable dependencies for testing. */
export interface WorkOnIssueCommandDeps {
  fetchIssueData: (repo: string, issueNumber: number) => Promise<IssueData>;
  validateIssueInput: typeof validateIssueInput;
  createDeps: () => WorkerDeps;
  runOrchestrator: (
    ctx: IssueContext,
    deps: WorkerDeps,
  ) => Promise<WorkOnIssueResult>;
  /**
   * Idle-task routing helper (Issue #1965). Defaults to the production
   * `handleIdleTaskIssue`; injected in tests to assert routing without
   * driving a real template runner.
   */
  handleIdleTask?: (
    opts: {
      repo: string;
      issueNumber: number;
      issueTitle: string;
      issueLabels: string[];
      issueBody: string;
      workDir: string;
    },
    deps: { logger: WorkerDeps["logger"] },
  ) => Promise<HandleIdleTaskIssueResult>;
  /** Injectable gh runner used to close idle-task issues (Issue #1965). */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Pickup-time content-integrity re-verification (Issue #3647). Defaults to
   * the production `verifyPickupContentIntegrity`; injected in tests.
   */
  verifyContentIntegrity?: (
    input: PickupContentIntegrityInput,
  ) => Promise<PickupContentIntegrityOutcome>;
}

// ---------------------------------------------------------------------------
// Exported helpers (testable without subprocess invocation)
// ---------------------------------------------------------------------------

/**
 * Parse and validate raw command arguments.
 *
 * Returns a typed args object on success, or an error message string.
 */
export function parseWorkOnIssueArgs(
  args: Record<string, unknown>,
): WorkOnIssueArgs | string {
  const repo = String(args["repo"] ?? "");
  const issueNumber = Number(args["issue-number"] ?? 0);
  const issueTitle = String(args["issue-title"] ?? "");
  const githubUser = String(args["github-user"] ?? "");
  const milestoneTitle = String(args["milestone-title"] ?? "");

  if (!repo) return "Missing required argument: --repo";
  if (!issueNumber) return "Missing required argument: --issue-number";
  if (!issueTitle) return "Missing required argument: --issue-title";
  if (!githubUser) return "Missing required argument: --github-user";

  return {
    repo,
    issueNumber,
    issueTitle,
    githubUser,
    milestoneTitle: milestoneTitle || undefined,
  };
}

/**
 * Format structured issue comments into a single string for the context.
 *
 * Each comment is formatted as "author: body" separated by "---" dividers.
 *
 * Issue #3648: this is the no-trust-configuration path, so the per-author caps
 * in `comment_rate_limiter.ts` never run. Without a cap here an attacker on a
 * public repository could add arbitrarily many large comments and have every
 * byte concatenated into the prompt. `capFormattedComments` bounds the blob
 * unconditionally and announces anything it drops.
 */
export function formatIssueComments(
  comments: IssueData["comments"],
  maxTotalChars?: number,
): string {
  return capFormattedComments(
    comments
      .map((c) => `${c.author}: ${c.body}`)
      .join("\n---\n"),
    maxTotalChars,
  );
}

/**
 * Core orchestration logic — fetches issue data, builds context,
 * and delegates to the workOnIssue() orchestrator.
 *
 * Extracted so tests can inject mock dependencies without hitting
 * real GitHub APIs or spawning subprocesses.
 */
export async function runWorkOnIssueCommand(
  parsedArgs: WorkOnIssueArgs,
  config: WorkerConfig,
  commandDeps: WorkOnIssueCommandDeps,
): Promise<CommandResult<WorkOnIssueResult>> {
  const { repo, issueNumber, githubUser, milestoneTitle } = parsedArgs;

  // Fetch issue data from GitHub API (Issue #652: single consolidated call)
  const issueData = await commandDeps.fetchIssueData(repo, issueNumber);

  // Issue #3878: `--issue-title` carries the title captured at scan time and
  // was never re-read, so a title-only edit made after approval hashed as
  // unchanged and the unapproved text still reached the prompt. Verify — and
  // then use — the title this fetch observed. A fetch that failed yields an
  // empty title, which cannot match any snapshot, so the gate below blocks.
  const issueTitle = issueData.title;

  // Issue #3647: re-verify the content-approval snapshot against the bytes
  // just fetched. The scan-time check (Issue #1341) verified an earlier,
  // independent copy and discarded it, so without this the body sent to the
  // model was never covered by the approval snapshot.
  const verifyIntegrity = commandDeps.verifyContentIntegrity ??
    verifyPickupContentIntegrity;
  const integrity = await verifyIntegrity({
    repo,
    issueNumber,
    issueTitle,
    issueBody: issueData.body,
    issueLabels: issueData.labels,
    issueAuthor: issueData.author,
    config,
  });
  if (integrity.blocked) {
    const blockedResult: WorkOnIssueResult = {
      success: false,
      phase: "content_integrity",
      reason: integrity.reason,
      timings: {},
    };
    return {
      success: false,
      message: JSON.stringify(blockedResult),
      data: blockedResult,
    };
  }

  // Issue #1965: route idle-task issues to the template runner instead
  // of through the standard Claude-driven flow. The claim handler
  // returns `{ handled: false }` for issues that do not carry the
  // `idle-task` label so this branch only fires for framework-filed
  // work items. Errors (malformed body, unknown template, runTask
  // throw) are reported as handled with a descriptive summary so the
  // worker can close the issue and unblock the queue.
  const handleIdleTask = commandDeps.handleIdleTask ?? handleIdleTaskIssue;
  const ghCommandFn = commandDeps.ghCommandFn ?? runGhCommand;
  const idleDeps = commandDeps.createDeps();
  const idleResult = await handleIdleTask(
    {
      repo,
      issueNumber,
      issueTitle,
      issueLabels: issueData.labels,
      issueBody: issueData.body,
      workDir: config.workDir,
    },
    { logger: idleDeps.logger },
  );
  if (idleResult.handled) {
    const summary = idleResult.summary ?? "idle-task processed";
    // Issue #179: only a scan that actually ran closes its wrapper. A failed
    // run comments the failure and leaves the wrapper open for retry.
    await finaliseIdleTaskWrapper(
      { repo, issueNumber, ok: idleResult.ok ?? false, summary },
      { logger: idleDeps.logger, ghCommandFn },
    );
    const orchestratorResult: WorkOnIssueResult = {
      success: idleResult.ok ?? false,
      phase: "idle_task",
      reason: summary,
      timings: {},
    };
    return {
      success: orchestratorResult.success,
      message: JSON.stringify(orchestratorResult),
      data: orchestratorResult,
    };
  }

  // Security validation (Issue #478): length + suspicious-pattern check.
  //
  // Issue #3648: the result used to be discarded, and `validateIssueInput`
  // neither truncates nor throws — so `DEFAULT_MAX_BODY_LENGTH` enforced
  // nothing and an arbitrarily large body went straight into the prompt. Act
  // on the verdict: log it, then bound the body actually used downstream.
  const validation = commandDeps.validateIssueInput(issueTitle, issueData.body);
  const bodyLimit = enforceIssueBodyLimit(issueData.body);
  if (
    validation.titleSuspicious || validation.bodySuspicious ||
    bodyLimit.truncated
  ) {
    commandDeps.createDeps().logger.warn(
      `Issue input validation: titleSuspicious=${validation.titleSuspicious} ` +
        `bodySuspicious=${validation.bodySuspicious} ` +
        `titleLength=${validation.titleLength} ` +
        `bodyLength=${bodyLimit.originalLength}` +
        (bodyLimit.truncated
          ? ` — body truncated to ${bodyLimit.maxBodyLength} bytes`
          : ""),
      { repo, issueNumber },
    );
  }
  const issueBody = bodyLimit.body;

  // Trust-filter the issue body + title exactly as untrusted comments are
  // (Issue #3312). The body/title are the primary prompt-injection surface
  // (the GitLost body-borne attack) and were previously only `console.warn`-ed.
  //
  // Neutralisation (delimiter sanitising + nonce-boundary wrapping) is applied
  // downstream in buildIssuePrompt; here we classify the issue author's trust
  // and emit a structured security-audit event for suspicious patterns from an
  // untrusted author — not a bare console warning. Trusted authors take the
  // fast path (no audit event), matching the comment behaviour.
  const contentTrust = annotateIssueContentWithTrust(
    issueData.author ?? "",
    issueTitle,
    issueBody,
    {
      allowedAuthors: config.allowedAuthors ?? [],
      authorisedCommenters: config.authorisedCommenters ?? [],
    },
  );
  if (contentTrust.securityAuditMessages.length > 0) {
    const securityLogger = commandDeps.createDeps().logger;
    for (const auditMsg of contentTrust.securityAuditMessages) {
      securityLogger.warn(auditMsg, { repo, issueNumber });
    }
  }

  // Build comments string from structured comment data.
  // Issue #1340: Use trust-annotated comments when trust lists are configured,
  // otherwise fall back to the plain format for backward compatibility.
  const hasTrustConfig = (config.allowedAuthors?.length ?? 0) > 0 ||
    (config.authorisedCommenters?.length ?? 0) > 0;

  let issueComments: string;
  // Boundary id of the genuine per-comment trust headers, when the trust
  // formatter produced them (Issue #3638). Left undefined for the raw comment
  // format so no untrusted text gains an exemption from the full scrub.
  let commentBoundaryId: string | undefined;
  if (hasTrustConfig) {
    const rawJson = JSON.stringify({
      comments: issueData.comments.map((c) => ({
        body: c.body,
        author: { login: c.author },
      })),
    });
    const trustResult = prepareTrustAnnotatedComments(rawJson, {
      allowedAuthors: config.allowedAuthors ?? [],
      authorisedCommenters: config.authorisedCommenters ?? [],
      includeUntrustedComments: config.includeUntrustedComments ?? true,
    });
    issueComments = trustResult.formattedComments;
    commentBoundaryId = trustResult.boundaryId;

    // Log security audit events for suspicious untrusted comments
    const deps = commandDeps.createDeps();
    for (const auditMsg of trustResult.securityAuditMessages) {
      deps.logger.warn(auditMsg, { repo, issueNumber });
    }
  } else {
    issueComments = formatIssueComments(issueData.comments);
  }

  // Build the IssueContext
  const ctx: IssueContext = {
    repo,
    issueNumber,
    issueTitle,
    issueBody,
    issueLabels: issueData.labels,
    issueComments,
    commentBoundaryId,
    githubUser,
    milestoneTitle,
    milestoneNumber: issueData.milestoneNumber, // Issue #1322: session branching
    config,
  };

  // Create dependencies and run the orchestrator
  const deps = commandDeps.createDeps();
  const result = await commandDeps.runOrchestrator(ctx, deps);

  return {
    success: result.success,
    message: JSON.stringify(result),
    data: result,
  };
}

// ---------------------------------------------------------------------------
// Production dependency factory
// ---------------------------------------------------------------------------

function createProductionDeps(): WorkOnIssueCommandDeps {
  return {
    fetchIssueData,
    validateIssueInput,
    createDeps: createDefaultDeps,
    runOrchestrator: workOnIssue,
    handleIdleTask: handleIdleTaskIssue,
    ghCommandFn: runGhCommand,
    verifyContentIntegrity: verifyPickupContentIntegrity,
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export const workOnIssueCommand: Command = {
  name: "work-on-issue",
  description:
    "Top-level issue processing orchestrator — setup, clarity, execute, quality, completion (Issue #1231)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorkOnIssueResult>> {
    const parsed = parseWorkOnIssueArgs(args);
    if (typeof parsed === "string") {
      return { success: false, message: parsed };
    }

    return await runWorkOnIssueCommand(parsed, config, createProductionDeps());
  },
};
