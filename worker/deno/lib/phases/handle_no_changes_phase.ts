/**
 * Phase 3b — Handle No Changes.
 *
 * Invoked when Claude produced no code changes. Closes the issue if
 * Claude indicated it is already complete, posts a partial answer if
 * useful text was produced (question disguised as issue), or reports
 * a detailed failure otherwise. Single responsibility: classify the
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
import { detectUsageLimit } from "../claude_executor.ts";
import { listTemplates } from "../idle_task_template.ts";
import { handOffAnalysisOnly } from "../analysis_only_handoff.ts";
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

  // Check if the issue was already complete (Issue #519)
  // Look for completion indicators in Claude's output
  const completionIndicators = [
    "already complete",
    "already implemented",
    "already fixed",
    "already resolved",
    "no changes needed",
    "no changes required",
    "implementation is already",
  ];

  const lowerOutput = claudeOutput.toLowerCase();
  const isAlreadyComplete = completionIndicators.some((indicator) =>
    lowerOutput.includes(indicator)
  );

  if (isAlreadyComplete) {
    logger.info("Issue appears to be already complete based on Claude output");

    // Post a comment, close the issue, and unassign (Issue #1364)
    try {
      const ghClient = deps.github.createClient(logger);
      const outputSnippet = publishableSnippet(claudeOutput);
      const closeComment =
        `## Already Complete\n\nThis issue appears to already be resolved.\n\n<details>\n<summary>Claude's analysis</summary>\n\n\`\`\`\n${outputSnippet}\n\`\`\`\n\n</details>`;
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

  // A subscription usage limit hit MID-RUN (Issue #4315) leaves the agent's
  // only output as the limit message and no changes — observed live as two
  // 40- and 21-minute runs blamed as "no useful output" minutes before the
  // health check named the weekly cap. Name it: the reason classifies as
  // rate_limit → infrastructure, so the issue is not blamed and the loop's
  // limit handling takes over.
  if (detectUsageLimit(claudeOutput)) {
    logger.warn("Claude hit the subscription usage limit mid-run (no changes)");
    return {
      status: "failure",
      reason: formatDetailedFailureMessage(
        "Claude usage limit reached mid-run (subscription window) — no changes",
        {
          elapsedSeconds,
          clarityStatus: state.clarityStatus,
          outputSize: claudeOutput.length,
          lastOutputSnippet: snippet || undefined,
        },
      ),
    };
  }

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
