/**
 * Phase 3b — Handle No Changes.
 *
 * Invoked when Claude produced no code changes. Closes the issue when the run
 * verified it was already resolved and cited the evidence (Issue #241), posts
 * a partial answer if useful text was produced (question disguised as issue),
 * or reports a detailed failure otherwise. Single responsibility: classify the
 * "no changes" outcome and communicate it back to GitHub.
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
import { formatDetailedFailureMessage } from "../failure_message.ts";
import { detectRunInterrupted, detectUsageLimit } from "../claude_executor.ts";
import { listTemplates } from "../idle_task_template.ts";
import { handOffAnalysisOnly } from "../analysis_only_handoff.ts";
import {
  detectBlockedOutcome,
  formatDependencyRef,
} from "../blocked_outcome.ts";
import { deferBlockedIssue, hasPriorDeferral } from "../blocked_deferral.ts";
import {
  detectAlreadyResolved,
  formatAlreadyResolvedEvidence,
} from "../already_resolved_outcome.ts";
import { redactSecrets } from "../secret_redaction.ts";
import { postIssueRunStatsComment } from "../issue_run_stats_comment.ts";

/**
 * Phase name the `work-on` coding run is routed under (`PHASE_MODEL_DEFAULTS`).
 * Drives both the stats heading and the expected-model routing chain.
 */
const WORK_ON_STATS_PHASE = "issue";

/**
 * Take the publishable tail of Claude's stdout for a public issue comment.
 *
 * Issue #3636: both no-changes branches embed this tail verbatim in a
 * world-readable comment. The child process inherits `GH_TOKEN` and its
 * Anthropic credentials, and a prompt-injected run can put them in its final
 * summary — which is exactly the text this tail captures. Route it through
 * the `redactSecrets()` chokepoint first, mirroring `label_failure.ts`.
 *
 * Redaction runs *before* the slice: slicing first can cut a credential
 * across the 3000-character boundary, leaving a fragment no rule matches.
 */
function publishableSnippet(claudeOutput: string): string {
  return redactSecrets(claudeOutput).slice(-3000);
}

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
  const { repo, issueNumber, githubUser, config } = ctx;
  const logger = deps.logger;
  const claudeOutput = state.claudeOutput;

  // Issue #222 — a run that reported itself blocked on another issue is a
  // DEFERRAL, and it is checked first: its output routinely contains phrases
  // the completion indicators below match ("no changes needed until #560
  // lands"), and closing a live task is the one outcome that cannot be undone
  // by the next scan. The issue stays open with its discovery label, records
  // `Depends on owner/repo#N`, and the dependency gate skips it until the
  // dependency closes.
  const blocked = detectBlockedOutcome(claudeOutput, { repo, issueNumber });
  // Loop guard: a deferral holds only while the dependency gate skips the
  // issue. Back here on the *same* dependency means it did not hold, and
  // deferring again would spin a fresh agent run on every scan — so the repeat
  // falls through to the analysis-only hand-off and a human sees it.
  const repeatDeferral = blocked !== undefined &&
    hasPriorDeferral(
      ctx.issueComments,
      formatDependencyRef(blocked.dependency),
    );
  if (blocked && repeatDeferral) {
    logger.warn(
      "Blocked on a dependency already deferred once — handing off to a " +
        "human instead of deferring again",
      {
        repo,
        issueNumber,
        dependency: formatDependencyRef(blocked.dependency),
      },
    );
  }
  if (blocked && !repeatDeferral) {
    const ghClient = deps.github.createClient(logger);
    const result = await deferBlockedIssue({
      ghClient,
      repo,
      issueNumber,
      githubUser,
      blocked,
      outputSnippet: publishableSnippet(claudeOutput),
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
    });
    logger.info("Blocked on a dependency — deferred instead of closing", {
      repo,
      issueNumber,
      dependency: result.ref,
      recorded: result.recorded,
    });
    return {
      status: "early_exit",
      reason: `deferred: depends on ${result.ref}`,
      expectedSkip: true,
      outcome: result.outcome,
    };
  }

  // Check whether the run verified the issue was already resolved (Issue #519,
  // tightened by Issue #241). Detection is the explicit
  // `vibe-already-resolved` marker first, then a broadened keyword claim — and
  // either way the close needs cited evidence (a commit and/or PR, plus how the
  // fix was verified on the marker path). An unevidenced claim falls through to
  // the analysis-only hand-off below, so an issue is never closed by inference.
  //
  // Issue #222: blocked-shaped output never reads as "already resolved", even
  // on the repeat-deferral path above — "no changes needed until #560 lands"
  // is a block, and closing the issue is what that change exists to prevent.
  const alreadyResolved = blocked
    ? ({ status: "none" } as const)
    : detectAlreadyResolved(claudeOutput, { repo, issueNumber });

  if (alreadyResolved.status === "unverified") {
    logger.info(
      "Run reported the issue already fixed but cited no evidence — " +
        "handing off instead of closing (Issue #241)",
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
    try {
      const ghClient = deps.github.createClient(logger);
      const outputSnippet = publishableSnippet(claudeOutput);
      const closeComment =
        `## Already Complete\n\nThis issue was verified as already resolved on the default branch, so it is closed with the evidence below rather than handed to a human (Issue #241).\n\n${
          formatAlreadyResolvedEvidence(evidence)
        }\n\n<details>\n<summary>Claude's analysis</summary>\n\n\`\`\`\n${outputSnippet}\n\`\`\`\n\n</details>`;
      await ghClient.closeIssue(repo, issueNumber, closeComment);
      // Issue #3756 — the worker closed the issue itself, so this is its
      // wrap-up point: post the run's single cost/model stats comment.
      await postIssueRunStatsComment({
        repo,
        issueNumber,
        phase: WORK_ON_STATS_PHASE,
        claudeResults: state.claudeRunStats ?? [],
        getIssueComments: (r, i) => ghClient.getIssueComments(r, i),
        postComment: (r, i, b) => ghClient.postComment(r, i, b),
        logger,
      });
      // Unassign
      await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    } catch (err) {
      logger.warn("Failed to close already-complete issue", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { status: "early_exit", reason: "already_complete" };
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
  if (detectUsageLimit(claudeOutput)) {
    logger.warn("Claude hit the subscription usage limit mid-run (no changes)");
    return {
      status: "failure",
      reason: formatDetailedFailureMessage(
        "Claude usage limit reached mid-run (subscription window) — no changes",
        {
          elapsedSeconds: truncationElapsed,
          clarityStatus: state.clarityStatus,
          outputSize: claudeOutput.length,
          lastOutputSnippet: claudeOutput.slice(-500) || undefined,
        },
      ),
    };
  }
  if (detectRunInterrupted(claudeOutput)) {
    logger.warn(
      "Claude run interrupted before completing (no changes) — retrying, not analysis-only",
    );
    return {
      status: "failure",
      reason: formatDetailedFailureMessage(
        "Run interrupted before completing — the agent was still working (no changes yet)",
        {
          elapsedSeconds: truncationElapsed,
          clarityStatus: state.clarityStatus,
          outputSize: claudeOutput.length,
          lastOutputSnippet: claudeOutput.slice(-500) || undefined,
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
        status: "early_exit",
        reason: "structured_output_wrapper_skipped",
      };
    }

    logger.info(
      "Claude produced text output but no code changes, posting partial answer",
    );

    // Issue #2849: a no-code-change run on a `work-on` issue is the
    // post-run "analysis-only / no-PR" signal. `work-on` treats a raised
    // PR as its completion signal, so without an explicit hand-off the
    // issue is re-picked-up and re-run indefinitely (the #2834 loop). We
    // post the partial answer (Claude's analysis — the deliverable for an
    // analysis-only issue) AND hand the issue off to `needs-human` so it
    // stops looping. The hand-off applies `needs-human` + a paired
    // explanation comment (Issue #1471) and releases the worker's claim;
    // it is NOT a `failed` outcome — the task did its job. The existing
    // `failed-once` → `failed` ladder remains the fallback loop guard for
    // the no-useful-output path below.
    const ghClient = deps.github.createClient(logger);
    try {
      const outputSnippet = publishableSnippet(claudeOutput);
      const questionLabel = config.questionLabel;
      const labelHint = questionLabel
        ? `\n\nIf you would like a full answer rather than code changes, a trusted reviewer can add the \`${questionLabel}\` label to this issue. The worker does not add this label itself — operational labels added by the worker are stripped by the security layer (Issue #1475).`
        : "";
      const comment =
        `## Partial Answer\n\nI was unable to make code changes for this issue, but here is what I found:\n\n<details>\n<summary>Claude's output</summary>\n\n\`\`\`\n${outputSnippet}\n\`\`\`\n\n</details>\n\nThis issue looks analysis-only (no PR to raise), so I am handing it back to a human rather than re-running it.${labelHint}`;
      await ghClient.postComment(repo, issueNumber, comment);
      // Note: do NOT add the question label here. Operational labels added by
      // the worker's service account are rejected by the trusted-label
      // security layer and produce confusing [UNTRUSTED_LABEL_CHANGE] log
      // lines (Issue #1475). A trusted human can add the label themselves.
    } catch (err) {
      logger.warn("Failed to post partial answer", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Clean hand-off: apply `needs-human` + paired comment and release the
    // claim. Best-effort and non-fatal (Issue #2849).
    await handOffAnalysisOnly({
      ghClient,
      repo,
      issueNumber,
      needsHumanLabel: config.needsHumanLabel,
      githubUser,
      trigger: "no_changes",
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
    });

    return { status: "early_exit", reason: "analysis_only_handed_off" };
  }

  const elapsedSeconds = state.executeStartTime > 0
    ? Math.round((Date.now() - state.executeStartTime) / 1000)
    : 0;
  const snippet = claudeOutput.slice(-500);

  // (The subscription usage-limit and interrupted-run cases — Issue #4315 /
  // Issue #108 — are handled earlier, before the analysis-only branch, so a
  // truncated run is never misclassified as analysis-only. See above.)

  // No useful output — treat as failure (Issue #1188 — detailed failure messages)
  logger.warn("Claude produced no changes and no useful output");
  const reason = formatDetailedFailureMessage(
    "No code changes and no useful output from Claude",
    {
      elapsedSeconds,
      clarityStatus: state.clarityStatus,
      outputSize: claudeOutput.length,
      lastOutputSnippet: snippet || undefined,
    },
  );
  return { status: "failure", reason };
}
