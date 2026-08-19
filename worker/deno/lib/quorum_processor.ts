/**
 * The Quorum GitHub-facing processor (Issue #4112, parent #4102, milestone
 * #4060).
 *
 * A human applies the `quorum` label; this module claims the issue, runs the
 * plan-off in `quorum_orchestrator.ts`, posts the outcome as one comment, and
 * hands the issue back to the human. It is modelled on
 * `grill_me_processor.ts`: claim → heartbeat → work → post → release, with
 * every terminal failure posting a marker before it unassigns.
 *
 * ```mermaid
 * flowchart LR
 *     L["quorum label"] --> C["claim + heartbeat"]
 *     C --> Q["runQuorum()<br/>2 drafts + 1 judgement"]
 *     Q --> P["one comment:<br/>winner + attachments"]
 *     P --> H["remove quorum<br/>add needs-human"]
 * ```
 *
 * Three decisions carry the weight:
 *
 * - **The human picks what happens next.** Quorum removes `quorum` and adds
 *   `needs-human`; it never applies `planning` or `work-on`. Deciding *what
 *   the plan is* and deciding *to build it* are separate calls, and the second
 *   one is the human's — exactly as grill-me completion already works.
 * - **A degraded run publishes what it has.** An unjudged run posts the
 *   surviving plan(s) with the degradation named, and never promotes one of
 *   them to "winner". Inventing a winner would launder a failure into a
 *   decision (Issue #3234).
 * - **Plan text is untrusted output.** It is agent text derived from untrusted
 *   issue content, so before it reaches a comment it is secret-redacted, its
 *   `</details>` sequences are defanged so it cannot escape its collapsed
 *   section, and any worker-footer or Quorum-marker lookalike is demoted so it
 *   cannot forge the worker's own attribution.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  expectedNoPrOutcome,
  failedRunOutcome,
  outcomeForNonCodingResult,
  outcomeForThrown,
  type RunOutcome,
} from "./run_outcome.ts";
import type { GitHubComment, Logger, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import type { IssueContext } from "./issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { buildVerbosityBlock } from "./prompt_builder.ts";
import { prepareTrustAnnotatedCommentList } from "./comment_trust_filter.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { releaseAllWorkerClaims } from "./claim_release.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { WORKER_COMMENT_FOOTER_PREFIX } from "./grill_me_processor.ts";
import {
  type QuorumInvoker,
  type QuorumPlan,
  type QuorumRunResult,
  runQuorum,
} from "./quorum_orchestrator.ts";
import { reportQuorumDegradation } from "./quorum_run_stats.ts";

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** Marker heading a judged Quorum result comment. */
export const QUORUM_WINNER_MARKER = "## Quorum — Winning Plan";

/** Marker heading a degraded (unjudged) Quorum result comment. */
export const QUORUM_DEGRADED_MARKER = "## Quorum — Degraded Result";

/** Marker the processor posts when the run produced nothing publishable. */
export const QUORUM_FAILED_MARKER = "## Quorum Failed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies of {@link processQuorum} — mirrors the other processors. */
export interface QuorumProcessorDeps {
  /** GitHub client for API operations. */
  ghClient: GitHubClient;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
}

/** What one Quorum processing run did. */
export interface QuorumResult {
  /** True when the plan-off actually ran. */
  processed: boolean;
  /** True when the result comment was posted. */
  commentPosted: boolean;
  /** True when the `quorum` label was removed. */
  labelRemoved: boolean;
  /** True when `needs-human` was applied on this run. */
  needsHumanAdded: boolean;
  /** True when the worker released its self-assignment. */
  workerUnassigned: boolean;
  /** How the orchestrator ended, when it ran. */
  outcome?: QuorumRunResult["outcome"];
  /** The named degradation, when the run was not a clean three-agent quorum. */
  degradation?: string;
  /** Human-readable summary. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Comment construction (pure)
// ---------------------------------------------------------------------------

/**
 * Make one plan safe to embed in a worker comment.
 *
 * Three neutralisations, each closing a way the text could impersonate the
 * worker rather than be quoted by it:
 *
 * - `</details>` is escaped, so a plan cannot close its own collapsed section
 *   and have the rest of its text read as the worker's own prose.
 * - the `🤖 Processed by:` footer prefix is demoted, so a plan cannot forge
 *   the attribution line every worker comment carries — the line other worker
 *   code keys off to recognise a comment as worker-authored.
 * - the Quorum markers are demoted, so an echoed marker cannot make a later
 *   run mistake quoted text for its own prior output.
 *
 * Secrets are redacted last, over the whole string, so a secret split by one
 * of the substitutions is still caught.
 *
 * @param text - The agent's plan or reasoning text.
 * @returns The same text, inert inside a worker comment.
 */
export function sanitisePlanForComment(text: string): string {
  const defanged = text
    .replaceAll(/<\/details\s*>/gi, () => "&lt;/details&gt;")
    .replaceAll(WORKER_COMMENT_FOOTER_PREFIX, () => "🤖 (quoted) Processed by:")
    .replaceAll(
      QUORUM_WINNER_MARKER,
      () => "### (quoted) Quorum — Winning Plan",
    )
    .replaceAll(
      QUORUM_DEGRADED_MARKER,
      () => "### (quoted) Quorum — Degraded Result",
    );
  return redactSecrets(defanged);
}

/** Name one plan by its provider and anonymised position. */
function attribute(plan: QuorumPlan): string {
  return `\`${plan.providerId}\` (plan ${plan.position})`;
}

/** Wrap one attachment in a collapsed section. */
function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${
    sanitisePlanForComment(body)
  }\n\n</details>`;
}

/**
 * Build the body of the Quorum result comment.
 *
 * On a judged run the winning plan **is** the comment body, with the runner-up
 * and the judge's reasoning attached in collapsed sections and each plan
 * attributed to the agent that produced it. On a degraded run the heading says
 * so, the degradation is named, and every surviving plan is attached — none of
 * them presented as a winner.
 *
 * @param result - What the orchestrator produced.
 * @param githubUser - Worker login for the footer.
 * @returns The comment body, safe to post.
 */
export function buildQuorumComment(
  result: QuorumRunResult,
  githubUser: string,
): string {
  const footer = `\n\n---\n🤖 Processed by: ${githubUser}`;
  const sections: string[] = [];

  if (result.outcome === "judged" && result.winner && result.runnerUp) {
    sections.push(QUORUM_WINNER_MARKER);
    sections.push(
      `Winner: ${attribute(result.winner)}. Runner-up: ${
        attribute(result.runnerUp)
      }.`,
    );
    sections.push(sanitisePlanForComment(result.winner.text));
    sections.push(
      details(
        `Runner-up plan — ${result.runnerUp.providerId} (plan ${result.runnerUp.position})`,
        result.runnerUp.text,
      ),
    );
    sections.push(
      details("Judge's reasoning", result.reasoning ?? "(none supplied)"),
    );
    return sections.join("\n\n") + footer;
  }

  // Degraded: say what was lost, publish what survived, name no winner.
  sections.push(QUORUM_DEGRADED_MARKER);
  sections.push(
    `This run was not a clean three-agent quorum, so **no plan is presented ` +
      `as the winner**. Degradation: ${
        sanitisePlanForComment(result.degradation?.detail ?? "unknown")
      }`,
  );
  if (result.plans.length === 0) {
    sections.push("No plan survived the run — there is nothing to publish.");
  }
  for (const plan of result.plans) {
    sections.push(
      details(
        `Unjudged plan — ${plan.providerId} (plan ${plan.position})`,
        plan.text,
      ),
    );
  }
  return sections.join("\n\n") + footer;
}

// ---------------------------------------------------------------------------
// Prior-output detection
// ---------------------------------------------------------------------------

/**
 * Whether a Quorum result comment has already been posted on this issue.
 *
 * Keyed off the markers rather than the author so a sibling fleet identity's
 * result also counts (the Issue #2729 / #3768 lesson): re-running the plan-off
 * would bill three more top-tier agents to answer a question already answered
 * in the thread.
 *
 * @param comments - Issue comments.
 * @returns True when a judged or degraded result is already present.
 */
export function hasQuorumResultBeenPosted(
  comments: readonly GitHubComment[],
): boolean {
  return comments.some((comment) =>
    comment.body.includes(QUORUM_WINNER_MARKER) ||
    comment.body.includes(QUORUM_DEGRADED_MARKER)
  );
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Run one Quorum plan-off for an issue.
 *
 * @param ctx - Issue context.
 * @param processorDeps - Processor dependencies.
 * @returns The run outcome, or the terminal failure that stopped it.
 */
export async function processQuorum(
  ctx: IssueContext,
  processorDeps: QuorumProcessorDeps,
): Promise<Result<QuorumResult>> {
  const { repo, issueNumber, githubUser, config } = ctx;
  const { deps, ghClient, logger } = processorDeps;

  const workerId = `${githubUser}-${Date.now()}`;
  const claimResult = await deps.issues.claimIssue({
    repo,
    issueNumber,
    githubUser,
    workerId,
  });
  if (!claimResult.ok) {
    return {
      ok: false,
      error: new Error(`Failed to claim issue: ${claimResult.error.message}`),
    };
  }
  if (!claimResult.value.claimed) {
    return {
      ok: false,
      error: new Error(
        `Issue claimed by another worker: ${
          claimResult.value.winnerId ?? "unknown"
        }`,
      ),
    };
  }

  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber,
    workDir: config.workDir,
    recordFn: deps.crashHandling.recordHeartbeat,
    clearFn: deps.crashHandling.clearHeartbeat,
  });
  if (!heartbeatStart.ok) {
    try {
      await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    } catch (err) {
      logger.warn(
        "Failed to release claim after heartbeat start failure (non-fatal)",
        {
          repo,
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return {
      ok: false,
      error: new Error(
        `Failed to start heartbeat for ${repo}#${issueNumber}: ${heartbeatStart.error.message}`,
      ),
    };
  }
  const heartbeatHandle: HeartbeatHandle = heartbeatStart.value;

  // The run outcome rides the final heartbeat clear (Issue #4330) so the
  // release comment states a deliberate no-PR — never a ⚠️ failure — for
  // a round that worked, and a diagnosed failure for one that did not.
  const runStartedAtMs = Date.now();
  let runOutcome: RunOutcome | undefined;
  try {
    const result = await runQuorumForIssue(ctx, processorDeps);
    runOutcome = outcomeForNonCodingResult(
      "quorum",
      result,
      (Date.now() - runStartedAtMs) / 1000,
      "quorum plan-off round posted",
    );
    return result;
  } catch (err) {
    runOutcome = outcomeForThrown(
      "quorum",
      err,
      (Date.now() - runStartedAtMs) / 1000,
    );
    throw err;
  } finally {
    await stopHeartbeat(heartbeatHandle, runOutcome);
  }
}

/** Inner body — the heartbeat lifecycle is owned by the wrapper. */
async function runQuorumForIssue(
  ctx: IssueContext,
  processorDeps: QuorumProcessorDeps,
): Promise<Result<QuorumResult>> {
  const { repo, issueNumber, issueTitle, issueBody, githubUser, config } = ctx;
  const { ghClient, logger, deps } = processorDeps;

  let comments: GitHubComment[] = [];
  try {
    comments = await ghClient.getIssueComments(repo, issueNumber);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch comments for quorum", {
      repo,
      issueNumber,
      error: errorMsg,
    });
    return await postFailureAndUnassign(
      processorDeps,
      ctx,
      `Failed to fetch comments: ${errorMsg}`,
    );
  }

  // A result is already in the thread — this run is a no-op. Finish the
  // handback rather than billing three more agents for the same question.
  if (hasQuorumResultBeenPosted(comments)) {
    logger.info("Quorum result already posted — completing handback only", {
      repo,
      issueNumber,
    });
    const handback = await handBackToHuman(ctx, processorDeps, comments);
    return {
      ok: true,
      value: {
        processed: false,
        commentPosted: false,
        labelRemoved: handback.labelRemoved,
        needsHumanAdded: handback.needsHumanAdded,
        workerUnassigned: handback.workerUnassigned,
        summary: "Quorum result already posted — handback completed",
      },
    };
  }

  // Trust-annotate the thread before it reaches either prompt (Issue #3706):
  // the plan-off reads the same untrusted comment history every other
  // comment-fed prompt does, and through the same pipeline.
  const history = prepareTrustAnnotatedCommentList(
    comments.map((c) => ({ body: c.body, author: { login: c.author } })),
    {
      allowedAuthors: [...(config.allowedAuthors ?? []), githubUser],
      authorisedCommenters: config.authorisedCommenters ?? [],
      includeUntrustedComments: config.includeUntrustedComments ?? true,
    },
  );
  for (const auditMsg of history.securityAuditMessages) {
    logger.warn(auditMsg, { repo, issueNumber });
  }

  const runResult = await runQuorum({
    issue: {
      repo,
      issueNumber,
      issueTitle,
      issueBody,
      issueLabels: (ctx.issueLabels ?? []).join(", "),
      issueComments: history.formattedComments || "None.",
      commentBoundaryId: history.boundaryId,
      verbosityInstructions: buildVerbosityBlock(config.verbosity),
    },
    providers: {
      planners: [config.quorumPlanners[0]!, config.quorumPlanners[1]!],
      judge: config.quorumJudge,
    },
    invoke: buildQuorumInvoker(ctx, processorDeps),
    timeoutSeconds: config.quorumTimeout,
    killAfterSeconds: config.quorumKillAfter,
  });

  // `ok: false` means the run could not start — an unusable bound, an
  // unresolvable provider, a prompt that will not load. Those are the
  // worker's own faults, and they fail loudly (Issue #3234).
  if (!runResult.ok) {
    logger.warn("Quorum could not start", {
      repo,
      issueNumber,
      error: runResult.error.message,
    });
    return await postFailureAndUnassign(
      processorDeps,
      ctx,
      `Quorum could not start: ${runResult.error.message}`,
    );
  }

  const run = runResult.value;
  for (const timing of run.timings) {
    logger.info("Quorum agent finished", {
      repo,
      issueNumber,
      role: timing.role,
      position: timing.position,
      providerId: timing.providerId,
      status: timing.status,
      durationMs: Math.round(timing.durationMs),
    });
  }

  // Nothing survived: there is no plan to publish, so this is a failure with
  // the reason stated, not an empty "success" comment.
  if (run.plans.length === 0) {
    return await postFailureAndUnassign(
      processorDeps,
      ctx,
      run.degradation?.detail ?? "Both drafting agents failed.",
    );
  }

  const body = buildQuorumComment(run, githubUser);
  let commentPosted = false;
  try {
    await ghClient.postComment(repo, issueNumber, body);
    commentPosted = true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to post the Quorum result comment", {
      repo,
      issueNumber,
      error: errorMsg,
    });
    return await postFailureAndUnassign(
      processorDeps,
      ctx,
      `Failed to post the Quorum result: ${errorMsg}`,
    );
  }

  // Issue #4434: both Quorum phases are Fable-preferring (#4429), so a
  // Fable→Opus reroute must leave the same `degraded-model` label and stats
  // comment the six single-call phases post — once for the whole plan-off.
  // Non-fatal: a reporting failure never costs the human their result.
  try {
    await reportQuorumDegradation({
      repo,
      issueNumber,
      observations: run.modelObservations,
      ghClient,
      runGhCommand: deps.github.runGhCommand,
      logger,
    });
  } catch (err) {
    logger.warn("Quorum degraded-model detection failed (non-fatal)", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const handback = await handBackToHuman(ctx, processorDeps, comments);

  return {
    ok: true,
    value: {
      processed: true,
      commentPosted,
      labelRemoved: handback.labelRemoved,
      needsHumanAdded: handback.needsHumanAdded,
      workerUnassigned: handback.workerUnassigned,
      outcome: run.outcome,
      degradation: run.degradation?.detail,
      summary: run.outcome === "judged"
        ? `Posted the winning plan from ${run.winner?.providerId}, runner-up ${run.runnerUp?.providerId}`
        : `Posted a degraded result (${run.outcome}): ${
          run.degradation?.detail ?? "unknown degradation"
        }`,
    },
  };
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * Build the invoker the orchestrator drives each agent through.
 *
 * Every invocation routes through the same `runClaudeWithRetry` the rest of
 * the worker uses, naming its provider **per call** (Issue #4109) so the trio
 * can run concurrently in one process without touching module-level state.
 *
 * @param ctx - Issue context (supplies the bounds and working directory).
 * @param processorDeps - Processor dependencies.
 * @returns An invoker for {@link runQuorum}.
 */
function buildQuorumInvoker(
  ctx: IssueContext,
  processorDeps: QuorumProcessorDeps,
): QuorumInvoker {
  const { config } = ctx;
  const { deps, logger } = processorDeps;
  return async (invocation) => {
    const result = await deps.claude.runClaudeWithRetry(
      {
        prompt: invocation.prompt,
        timeoutSeconds: invocation.timeoutSeconds,
        killAfterSeconds: invocation.killAfterSeconds,
        noOutputTimeout: config.claudeNoOutputTimeout,
        phase: invocation.phase,
        agentProvider: invocation.agentProvider,
        cwd: config.workDir,
        logger,
      },
      { maxRetries: config.maxRateLimitRetries },
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        output: result.value.output,
        exitCode: result.value.exitCode,
        timedOut: result.value.timedOut,
        // The model observation the run made (Issue #4434) — without it a
        // Fable→Opus reroute is invisible to the processor.
        ...(result.value.runStats ? { runStats: result.value.runStats } : {}),
        ...(result.value.fallbackModel
          ? { fallbackModel: result.value.fallbackModel }
          : {}),
        ...(result.value.preflightDegraded
          ? {
            preflightDegraded: true,
            ...(result.value.preflightDegradedReason
              ? {
                preflightDegradedReason: result.value.preflightDegradedReason,
              }
              : {}),
          }
          : {}),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Handback and failure paths
// ---------------------------------------------------------------------------

/** What the handback did. */
interface HandbackOutcome {
  labelRemoved: boolean;
  needsHumanAdded: boolean;
  workerUnassigned: boolean;
}

/**
 * Hand the issue back to the human: remove `quorum`, add `needs-human`.
 *
 * Quorum deliberately applies **no** next-phase label. Choosing to plan, to
 * build, or to discard the winning plan is the human's call, and the posted
 * result comment is the explanation `needs-human` is paired with (Issue
 * #1471) — so the dedup markers point at it rather than posting a second one.
 *
 * @param ctx - Issue context.
 * @param processorDeps - Processor dependencies.
 * @param comments - Comments already fetched this run.
 * @returns What each step managed to do.
 */
async function handBackToHuman(
  ctx: IssueContext,
  processorDeps: QuorumProcessorDeps,
  comments: readonly GitHubComment[],
): Promise<HandbackOutcome> {
  const { repo, issueNumber, githubUser, config } = ctx;
  const { ghClient, logger, deps } = processorDeps;

  let labelRemoved = false;
  try {
    await ghClient.removeLabel(repo, issueNumber, config.quorumLabel);
    labelRemoved = true;
  } catch (err) {
    logger.warn("Failed to remove the quorum label", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let needsHumanAdded = false;
  const escalation = await escalateToHuman({
    ghClient,
    repo,
    target: { kind: "issue", number: issueNumber },
    needsHumanLabel: config.needsHumanLabel,
    reason:
      "The Quorum plan-off has finished and its result is posted above — no " +
      "next phase has been chosen.",
    nextStep:
      `Review the plan, then apply \`${config.planningLabel}\` to split it ` +
      `into sub-issues, apply \`work-on\` to build it directly, or close the ` +
      `issue. Remove \`${config.needsHumanLabel}\` once you have chosen.`,
    heading: "Quorum Complete",
    dedupKey: `quorum-complete-${issueNumber}`,
    additionalDedupMarkers: [QUORUM_WINNER_MARKER, QUORUM_DEGRADED_MARKER],
    prefetchedComments: [...comments],
    githubUser,
    logger,
    deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
  });
  if (escalation.ok && escalation.value.labelAdded) {
    needsHumanAdded = true;
  }

  const workerUnassigned = await releaseAllWorkerClaims(
    ghClient,
    repo,
    issueNumber,
    githubUser,
    logger,
    {
      outcome: expectedNoPrOutcome(
        "quorum",
        "quorum plan-off complete — result posted, awaiting a next-phase label",
      ),
    },
  );

  return { labelRemoved, needsHumanAdded, workerUnassigned };
}

/**
 * Terminal-failure exit: post the failure marker, then release the claim.
 *
 * Order matters — the marker goes up first so the failure is visible even if
 * the unassign then fails, mirroring `grill_me_processor.ts`. The reason is
 * redacted because callers pass raw external error text (Issue #3648).
 *
 * The `quorum` label is deliberately **left in place**: a failed run has not
 * answered the question the human asked, so the issue stays eligible for a
 * retry rather than silently dropping out of the phase.
 */
async function postFailureAndUnassign(
  processorDeps: QuorumProcessorDeps,
  ctx: IssueContext,
  reason: string,
): Promise<Result<QuorumResult>> {
  const { repo, issueNumber, githubUser } = ctx;
  const { ghClient, logger } = processorDeps;
  const body = `${QUORUM_FAILED_MARKER}\n\nThis Quorum run failed: ${
    redactSecrets(reason)
  }\n\n---\n🤖 Processed by: ${githubUser}`;
  try {
    await ghClient.postComment(repo, issueNumber, body);
  } catch {
    // Best effort — the Result below still reports the failure loudly.
  }
  await releaseAllWorkerClaims(
    ghClient,
    repo,
    issueNumber,
    githubUser,
    logger,
    {
      outcome: failedRunOutcome("quorum", reason, 0),
    },
  );
  return { ok: false, error: new Error(reason) };
}
