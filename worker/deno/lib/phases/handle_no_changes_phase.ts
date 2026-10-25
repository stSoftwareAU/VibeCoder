/**
 * Phase 3b — Handle No Changes.
 *
 * Invoked when Claude produced no code changes. Closes the issue when the run
 * verified it was already resolved and cited the evidence (Issue #241), closes
 * an issue its author declared analysis-only with the analysis as its
 * deliverable (Issue #4298), and otherwise retries the approved issue with the
 * run's output carried forward (Issue #4227). Output that names files to
 * change is a failed implementation, not analysis, so it is retried (Issue
 * #2687). Nothing here hands an approved issue to a human. Single
 * responsibility: classify the "no changes" outcome and communicate it back
 * to GitHub.
 *
 * Extracted from worker/deno/lib/issue_worker.ts (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { resolveFleetMaintenanceAuthorSet } from "../fleet_authors.ts";
import {
  type FailureDiagnosticContext,
  formatDetailedFailureMessage,
} from "../failure_message.ts";
import { detectRunInterrupted, detectUsageLimit } from "../claude_executor.ts";
import { listTemplates } from "../idle_task_template.ts";
import { retryUnfinishedIssue } from "../unfinished_issue_retry.ts";
import { hasAnalysisOnlyMarker } from "../analysis_only.ts";
import { detectDescribedCodeChange } from "../described_code_change.ts";
import {
  detectAlreadyResolved,
  formatAlreadyResolvedEvidence,
} from "../already_resolved_outcome.ts";
import {
  gateAlreadyResolvedClose,
  gatePlanningHandoff,
} from "../image_conclusion_gate.ts";
import { hasPlanningRequestMarker } from "../planning_handoff.ts";
import { redactSecrets } from "../secret_redaction.ts";
import { redactedTail } from "../redacted_text.ts";
import {
  handOffDeclaredOutcome,
  publishableSnippet,
} from "./declared_handoff.ts";
import {
  IMPLEMENTATION_RUN_STATS_PHASE,
  measureIssuePhaseRun,
  postIssueRunStatsComment,
} from "../issue_run_stats_comment.ts";
import { recordIssuePhaseRun } from "../fleet_telemetry.ts";
import {
  reportIssueSubAgentDegradation,
} from "../issue_sub_agent_degradation.ts";
import { resolveIssueSubAgentTier } from "../issue_sub_agent_tier.ts";

/**
 * Phase name the `work-on` coding run is routed under (`PHASE_MODEL_DEFAULTS`).
 * Drives both the stats heading and the expected-model routing chain.
 *
 * Shared with the renderer (Issue #2346): the split figures render only for
 * this phase, so a local copy drifting from it would silently empty the pilot
 * metric.
 */
const WORK_ON_STATS_PHASE = IMPLEMENTATION_RUN_STATS_PHASE;

/**
 * Return true when `ctx` looks like a wrapper filed by a template that
 * declares `requiresStructuredOutput` (Issue #2098). A template matches
 * when either:
 *   1. The issue title equals `template.buildIssueTitle(repo)`, OR
 *   2. `template.matchesIdleTaskBody?.(body) === true`.
 *
 * Used as defence-in-depth: when the standard pipeline reaches the
 * no-changes phase for a structured-output wrapper (e.g. a security
 * scan that slipped past `idle_task_guard`), we must not post a
 * narrative "Partial Answer" — the wrapper's outcome is filed issues.
 */
function matchesStructuredOutputTemplate(ctx: IssueContext): boolean {
  for (const tpl of listTemplates()) {
    if (!tpl.requiresStructuredOutput) continue;
    if (ctx.issueTitle === tpl.buildIssueTitle(ctx.repo)) return true;
    if (tpl.matchesIdleTaskBody?.(ctx.issueBody) === true) return true;
  }
  return false;
}

/**
 * Retry a run that described a code change but made none (Issue #2687).
 *
 * Posts a nudge the retry prompt carries, then returns a `failure` whose
 * wording `detectFailureCategory` reads as `no_changes`, so the issue walks the
 * normal failed-once → failed ladder. The nudge is best-effort: a GitHub error
 * is logged, never allowed to turn the retry into a hand-off.
 */
async function retryDescribedCodeChange(
  deps: WorkerDeps,
  ctx: IssueContext,
  files: string[],
  diagnostics: FailureDiagnosticContext,
): Promise<PhaseResult> {
  const logger = deps.logger;
  logger.warn(
    "Run described a code change but made none — retrying, not analysis-only",
    { files },
  );
  const fileList = files.map((f) => `\`${f}\``).join(", ");
  try {
    await deps.github.createClient(logger).postComment(
      ctx.repo,
      ctx.issueNumber,
      `## Retry: make the code change\n\nThe last run described a change to ${fileList} but committed nothing, so this is a failed implementation, not an analysis-only answer. The next attempt must edit and commit the files rather than describe the change.`,
    );
  } catch (err) {
    logger.warn("Failed to post the retry nudge", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    category: "no_changes",
    status: "failure",
    reason: formatDetailedFailureMessage(
      `Described a code change (${
        files.join(", ")
      }) but finished without making any changes — retrying so the next run makes the edit`,
      diagnostics,
    ),
  };
}

/**
 * Close an issue the worker has finished without a PR (Issues #1364, #4298).
 *
 * Shared by the two no-PR deliverables: an issue verified as already resolved,
 * and an issue its author declared analysis-only, whose posted analysis is the
 * deliverable. Closes with `comment`, posts the run's single stats comment,
 * records the run's figures and unassigns. Best-effort: a GitHub error is
 * logged, never allowed to turn a finished issue into a failure.
 */
async function closeAsCompleted(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  comment: string,
): Promise<void> {
  const { repo, issueNumber, githubUser } = ctx;
  const logger = deps.logger;
  try {
    const ghClient = deps.github.createClient(logger);
    await ghClient.closeIssue(repo, issueNumber, comment);
    // Issue #3405: label a haiku-tier run served a stale Haiku, and name
    // both models in the comment below.
    const subAgentDegradation = await reportIssueSubAgentDegradation({
      repo,
      issueNumber,
      tier: resolveIssueSubAgentTier(
        { issueSubAgentTier: ctx.config.issueSubAgentTier },
        ctx.config.repoConfig?.[repo],
        (m) => logger.warn(m),
      ),
      claudeResults: state.claudeRunStats ?? [],
      ghCommandFn: deps.github.runGhCommand,
      logger,
    });
    // Issue #3756 — the worker closed the issue itself, so this is its
    // wrap-up point: post the run's single cost/model stats comment.
    const posted = await postIssueRunStatsComment({
      repo,
      issueNumber,
      phase: WORK_ON_STATS_PHASE,
      claudeResults: state.claudeRunStats ?? [],
      getIssueComments: (r, i) => ghClient.getIssueComments(r, i),
      postComment: (r, i, b) => ghClient.postComment(r, i, b),
      logger,
      // What Graft did for this run (Issue #2105) — absent when the run
      // never reached the collection.
      ...(state.graftContext ? { graft: state.graftContext } : {}),
      // Fleet-authored comments only (Issue #1249, finding 12).
      authorOptions: {
        fleetAuthors: resolveFleetMaintenanceAuthorSet({
          githubUser,
          fleetPrAuthors: ctx.config.fleetPrAuthors ?? [],
          serviceAccounts: ctx.config.serviceAccounts ?? [],
        }),
      },
      // This run's CodeGraph figures (Issue #2161) — reported here too, so
      // a no-PR wrap-up is not a hole in the trial's data.
      ...(state.codegraphContext ? { codegraph: state.codegraphContext } : {}),
      // …and its RTK status, `off` included (Issue #2385).
      ...(state.rtkOutput ? { rtk: state.rtkOutput } : {}),
      ...(subAgentDegradation ? { subAgentDegradation } : {}),
      // A safety refusal this run recorded and recovered from (Issue #3406).
      ...(state.agentRefusal ? { agentRefusal: state.agentRefusal } : {}),
    });
    // Issue #2347: this path wraps up an `issue`-phase run too, so it records
    // the same figures its comment renders. The run passed no quality gate —
    // it raised no PR — so it counts towards the runs and not the passes.
    if (posted.reason !== "already_posted") {
      // Issue #3403: the tier this run resolved rides the same figures the
      // comment above renders.
      const subAgentTier = resolveIssueSubAgentTier(
        ctx.config,
        ctx.config.repoConfig?.[repo],
        (message) => logger.warn(message),
      );
      const figures = measureIssuePhaseRun({
        phase: WORK_ON_STATS_PHASE,
        claudeResults: state.claudeRunStats ?? [],
        subAgentTier,
      });
      if (figures) recordIssuePhaseRun(figures);
    }
    await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
  } catch (err) {
    logger.warn("Failed to close the finished issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The end of a no-change run that is not a deferral (Issues #4227, #4298).
 *
 * An issue its author declared analysis-only (`<!-- analysis-only -->`) is
 * finished: its analysis is posted and the issue closed as completed — never
 * handed to a human (Issue #4298). Any other approved issue is not finished,
 * so it is retried with the run's output carried to the next attempt.
 *
 * `closeWithheld` is the image gate's verdict (Issue #1385): when an untrusted
 * image sat in front of an agent that then reported the issue already fixed,
 * nothing the agent said may close the issue, so the run is retried.
 */
async function finishOrRetry(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  why: string,
  closeWithheld: boolean,
): Promise<PhaseResult> {
  if (hasAnalysisOnlyMarker(ctx.issueBody) && !closeWithheld) {
    deps.logger.info(
      "Analysis-only issue produced its analysis — closing it as completed (Issue #4298)",
      { repo: ctx.repo, issueNumber: ctx.issueNumber },
    );
    const comment =
      `## Analysis\n\nThis issue is analysis-only, so the analysis below is its deliverable and the issue is closed as completed (Issue #4298).\n\n<details>\n<summary>Claude's analysis</summary>\n\n\`\`\`\n${
        publishableSnippet(state.claudeOutput)
      }\n\`\`\`\n\n</details>`;
    await closeAsCompleted(ctx, state, deps, comment);
    return {
      category: "unknown",
      status: "early_exit",
      reason: "analysis_only_completed",
    };
  }
  return await retryUnfinishedIssue({
    ghClient: deps.github.createClient(deps.logger),
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    why,
    agentOutput: state.claudeOutput,
    diagnostics: {
      elapsedSeconds: state.executeStartTime > 0
        ? Math.round((Date.now() - state.executeStartTime) / 1000)
        : 0,
      clarityStatus: state.clarityStatus,
      outputSize: state.claudeOutput.length,
      lastOutputSnippet: redactedTail(state.claudeOutput, 500) || undefined,
    },
    logger: deps.logger,
  });
}

/**
 * Handle the case where Claude made no code changes.
 *
 * Detects whether the issue was already complete, posts partial
 * answers if text output was produced, and handles question-disguised
 * issues.
 */
export async function workOnIssueHandleNoChanges(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, githubUser } = ctx;
  const logger = deps.logger;
  const claudeOutput = state.claudeOutput;

  // Issue #3088: the blocked-deferral, time-deferral and planning hand-off
  // detection/apply logic is shared with the declared-handoff phase (which
  // catches the same signals on a run that also committed code), so it lives
  // in `handOffDeclaredOutcome`. A result there is returned unchanged; `blocked`
  // is still needed below for the "never treated as already resolved"
  // exclusion.
  const declaredOutcome = await handOffDeclaredOutcome(ctx, state, deps);
  if (declaredOutcome.result) return declaredOutcome.result;
  const { blocked, selfFiledDependency } = declaredOutcome;

  // Check whether the run verified the issue was already resolved (Issue #519,
  // tightened by Issue #241). Detection is the explicit
  // `vibe-already-resolved` marker first, then a broadened keyword claim — and
  // either way the close needs cited evidence (a commit and/or PR, plus how the
  // fix was verified on the marker path). An unevidenced claim falls through to
  // the retry below, so an issue is never closed by inference.
  //
  // Issue #222: blocked-shaped output never reads as "already resolved", even
  // on the repeat-deferral path above — "no changes needed until #560 lands"
  // is a block, and closing the issue is what that change exists to prevent.
  //
  // Issue #1385: the close is also withheld when an untrusted author's body
  // put an image in front of the agent. Every part of the evidence — the
  // claim, the commit, the PR, the verification note — is text the agent
  // emitted, and an image can tell it to report the issue as already fixed
  // *and* to stay quiet about where that came from, which the agent's own
  // suspicious-image self-check cannot be relied on to catch. The image
  // reference cannot be suppressed the same way: the worker parsed it before
  // the agent saw anything. So the run falls through to the retry — the issue
  // stays open, even when it is marked analysis-only (Issue #4298).
  const imageGate = gateAlreadyResolvedClose(ctx.untrustedImages);
  const alreadyResolvedRaw = blocked
    ? ({ status: "none" } as const)
    : detectAlreadyResolved(claudeOutput, { repo, issueNumber });
  const alreadyResolvedWithheld = imageGate.withheld &&
    alreadyResolvedRaw.status === "resolved";
  // Issue #4298: a withheld planning hand-off withholds the analysis-only
  // close too — both retire the issue on the agent's word alone.
  const closeWithheld = alreadyResolvedWithheld ||
    (gatePlanningHandoff(ctx.untrustedImages).withheld &&
      hasPlanningRequestMarker(claudeOutput));
  if (alreadyResolvedWithheld) {
    logger.warn(imageGate.auditMessage ?? "", {
      repo,
      issueNumber,
      untrustedImages: imageGate.imageCount,
    });
  }
  const alreadyResolved = alreadyResolvedWithheld
    ? ({ status: "none" } as const)
    : alreadyResolvedRaw;

  if (alreadyResolved.status === "unverified") {
    logger.info(
      "Run reported the issue already fixed but cited no evidence — " +
        "retrying instead of closing (Issue #241)",
      { repo, issueNumber, reason: alreadyResolved.reason },
    );
  }

  if (alreadyResolved.status === "resolved") {
    const { evidence, source } = alreadyResolved.outcome;
    logger.info(
      "Issue verified as already resolved — closing with the cited evidence",
      {
        repo,
        issueNumber,
        source,
        commit: evidence.commit ?? "",
        pr: evidence.pr ?? "",
      },
    );

    // Post a comment, close the issue, and unassign (Issue #1364)
    const closeComment =
      `## Already Complete\n\nThis issue was verified as already resolved on the default branch, so it is closed with the evidence below rather than handed to a human (Issue #241).\n\n${
        formatAlreadyResolvedEvidence(evidence)
      }\n\n<details>\n<summary>Claude's analysis</summary>\n\n\`\`\`\n${
        publishableSnippet(claudeOutput)
      }\n\`\`\`\n\n</details>`;
    await closeAsCompleted(ctx, state, deps, closeComment);

    return {
      category: "unknown",
      status: "early_exit",
      reason: "already_complete",
    };
  }

  // Issue #108: a no-changes run that was CUT OFF before finishing — blocked on
  // a slow first quality-gate pass, out of turn budget — is NOT analysis-only.
  // Its output is a "still working / I'll pick up" status line, not a
  // deliverable. Detect that (and a usage limit, which previously slipped past
  // to the analysis-only branch below whenever it left >100 chars) BEFORE the
  // analysis-only hand-off, and return a retryable infrastructure failure so
  // the loop re-runs the issue instead of escalating it to `needs-human` — a
  // dead end the worker cannot reverse. The message wording is what
  // `detectFailureCategory` keys on: "usage limit" → rate_limit, "interrupted
  // before completing" → interrupted; both are infrastructure, so the issue is
  // retried, not blamed.
  const truncationElapsed = state.executeStartTime > 0
    ? Math.round((Date.now() - state.executeStartTime) / 1000)
    : 0;
  // Issue #3146: a dependency this fleet filed during the run hands off on
  // this run, before the usage-limit and interrupted-run checks. Both return
  // a retryable failure, and a retry starts a new run, so the follow-up's
  // createdAt is then before runStartTime and the next run defers onto it.
  // detectRunInterrupted is a wording guess ("not finished"), which ordinary
  // blocked text matches. A finished Depends on line naming a self-filed
  // issue is the stronger signal, so it also wins over a usage-limit retry.
  if (selfFiledDependency) {
    logger.info(
      "No-changes run depends on a self-filed dependency — not deferring " +
        "onto it (Issue #3146); retrying the approved issue (Issue #4227)",
      { repo, issueNumber },
    );
    return await finishOrRetry(
      ctx,
      state,
      deps,
      "it named a dependency it filed itself instead of doing the work",
      closeWithheld,
    );
  }
  if (detectUsageLimit(claudeOutput)) {
    logger.warn("Claude hit the subscription usage limit mid-run (no changes)");
    return {
      category: "rate_limit",
      status: "failure",
      reason: formatDetailedFailureMessage(
        "Claude usage limit reached mid-run (subscription window) — no changes",
        {
          elapsedSeconds: truncationElapsed,
          clarityStatus: state.clarityStatus,
          outputSize: claudeOutput.length,
          lastOutputSnippet: redactedTail(claudeOutput, 500) || undefined,
        },
      ),
    };
  }
  if (detectRunInterrupted(claudeOutput)) {
    logger.warn(
      "Claude run interrupted before completing (no changes) — retrying, not analysis-only",
    );
    return {
      category: "interrupted",
      status: "failure",
      reason: formatDetailedFailureMessage(
        "Run interrupted before completing — the agent was still working (no changes yet)",
        {
          elapsedSeconds: truncationElapsed,
          clarityStatus: state.clarityStatus,
          outputSize: claudeOutput.length,
          lastOutputSnippet: redactedTail(claudeOutput, 500) || undefined,
        },
      ),
    };
  }

  // Check for partial text output (question disguised as issue)
  if (claudeOutput.trim().length > 100) {
    // Defence-in-depth (Issue #2098): if this issue matches a
    // structured-output idle-task wrapper, do NOT post a narrative
    // "Partial Answer". The wrapper's outcome is filed issues, not
    // text — so a partial textual answer is meaningless to the user.
    if (matchesStructuredOutputTemplate(ctx)) {
      logger.info("skipping Partial Answer — structured-output wrapper", {
        repo,
        issueNumber,
      });
      try {
        const ghClient = deps.github.createClient(logger);
        await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
      } catch (err) {
        logger.warn("Failed to unassign structured-output wrapper", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        category: "unknown",
        status: "early_exit",
        reason: "structured_output_wrapper_skipped",
      };
    }

    // Issue #2687: output that names files to change is a failed
    // implementation, not analysis (GRQ#4871). Retry it through the normal
    // failed-once → failed ladder with a nudge the next run's prompt carries,
    // instead of escalating it as analysis-only. An explicit analysis-only
    // marker in the body still wins.
    if (!hasAnalysisOnlyMarker(ctx.issueBody)) {
      const described = detectDescribedCodeChange(redactSecrets(claudeOutput));
      if (described.described) {
        return await retryDescribedCodeChange(
          deps,
          ctx,
          described.files,
          {
            elapsedSeconds: truncationElapsed,
            clarityStatus: state.clarityStatus,
            outputSize: claudeOutput.length,
            lastOutputSnippet: redactedTail(claudeOutput, 500) || undefined,
          },
        );
      }
    }

    // Issue #4227: an approved issue is completed, never handed back. A
    // no-change run is a failure to retry on the `failed-once` ladder, whose
    // escalating cooldown is the loop guard (#2834, #4158). An issue its
    // author declared analysis-only is closed with its analysis (#4298).
    return await finishOrRetry(
      ctx,
      state,
      deps,
      "it made no code change",
      closeWithheld,
    );
  }

  const elapsedSeconds = state.executeStartTime > 0
    ? Math.round((Date.now() - state.executeStartTime) / 1000)
    : 0;
  const snippet = redactedTail(claudeOutput, 500);

  // (The subscription usage-limit and interrupted-run cases — Issue #4315 /
  // Issue #108 — are handled earlier, before the analysis-only branch, so a
  // truncated run is never misclassified as analysis-only. See above.)

  // No useful output — treat as failure (Issue #1188 — detailed failure
  // messages). Issue #1949: an unevidenced "already applied" claim that was
  // too short for the analysis-only hand-off used to land here as a bare
  // "no useful output" failure, with no label and nothing said about the
  // claim — so the issue was re-claimable on the very next cycle. Name the
  // claim in the reason: the failure ladder publishes this message, so the
  // `failed-once` comment now states what the agent said and why it was not
  // taken at face value.
  const headline = alreadyResolved.status === "unverified"
    ? `Reported the issue already fixed but cited no evidence — ${alreadyResolved.reason}; no code changes and no useful output`
    : "No code changes and no useful output from Claude";
  logger.warn("Claude produced no changes and no useful output");
  const reason = formatDetailedFailureMessage(
    headline,
    {
      elapsedSeconds,
      clarityStatus: state.clarityStatus,
      outputSize: claudeOutput.length,
      lastOutputSnippet: snippet || undefined,
    },
  );
  return {
    category: "unknown",
    status: "failure",
    reason,
  };
}
