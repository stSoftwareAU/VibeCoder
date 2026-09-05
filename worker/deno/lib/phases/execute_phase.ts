/**
 * Phase 3 — Execute Claude.
 *
 * Builds the prompt with per-repo customisations, invokes Claude with
 * timeout/retry, records the prompts commit and session resume state,
 * then detects whether any code changes were actually produced. Single
 * responsibility: drive Claude and classify the outcome (continue /
 * early_exit:no_changes / failure).
 *
 * Extracted from worker/deno/lib/issue_worker.ts (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { getPromptsCommit } from "../prompt_manager.ts";
import { promptOverrideMappings } from "../custom_label_prompts_config.ts";
import { LABEL_DEFAULTS } from "../config_defaults.ts";
import { detectScreenshotRequired } from "../execute_claude_phase.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
} from "../repo_config.ts";
import { formatDetailedFailureMessage } from "../failure_message.ts";
import {
  createSessionResumeState,
  recordPhaseCompletion,
} from "../session_resume.ts";
import { ensureHistoryDepth } from "../git_history.ts";
import { resolveComparableBaseRef } from "../git_base_ref.ts";
import { saveResumeState } from "../resume_state_store.ts";
import { buildPriorProgressNote } from "../handover_prompt_note.ts";
import {
  buildInterruptedWipCommitMessage,
  startWipCheckpoints,
} from "../wip_checkpoint.ts";
import {
  type PreservedRunWip,
  preserveRunWip,
} from "./run_wip_preservation.ts";
import {
  classifyExistingPrForIssue,
  type ExistingPrDisposition,
  formatSupersededReason,
} from "../superseding_pr.ts";
import { claimStaleOutcome, supersededOutcome } from "../run_outcome.ts";
import {
  checkClaimFreshness,
  formatStaleClaimReason,
} from "../claim_freshness.ts";
import { buildProgressExtension } from "../progress_extension_runtime.ts";
import { describeRunHardCap, resolveRunHardCap } from "../run_hard_cap.ts";
import {
  hasRunwayForInfraRetry,
  MIN_INFRA_RETRY_RUNWAY_SECONDS,
  shouldRetryInfrastructureFailure,
} from "../infra_retry.ts";
import {
  buildScheduledReleaseReason,
  detectFailureCategory,
} from "../failure_diagnosis.ts";
import { describeMemoryPressure } from "../memory_pressure.ts";
import {
  checkContextBudget,
  formatBudgetBreakdown,
} from "../context_budget.ts";
import {
  buildContextBudgetEscalationReason,
  buildContextComponents,
  CONTEXT_BUDGET_NEXT_STEP,
} from "../context_budget_guard.ts";
import { escalateToHuman } from "../needs_human_escalation.ts";
import { reportRunDeadline } from "../slot_context.ts";

/**
 * True when the worker branch has at least one commit ahead of its base
 * (Issue #45). Used to detect a false-positive auth classification: a run that
 * produced commits is not a credential failure, so its outcome must not be
 * released as "no PR raised". Best-effort — any git error resolves to `false`
 * so the caller keeps its existing behaviour.
 */
async function branchHasCommitsAhead(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<boolean> {
  const base = await resolveComparableBaseRef(
    deps.git.runGitCommand,
    state.baseBranch,
    { cwd: state.repoPath },
  );
  if (!base.ok) return false;
  const log = await deps.git.runGitCommand(
    ["rev-list", "--count", `${base.value}..${state.branchName}`],
    { cwd: state.repoPath },
  );
  if (!log.ok || log.value.code !== 0) return false;
  return parseInt(log.value.stdout.trim(), 10) > 0;
}

/**
 * Existing PR for this issue, classified as absent / open / superseding
 * (Issue #218). Every interrupted-run branch asks this instead of "did
 * `findExistingPrForIssue` return anything" — a merged sibling PR is not a
 * reason to carry on as though this run had succeeded.
 */
function classifyExistingPr(
  ctx: IssueContext,
  deps: WorkerDeps,
): Promise<ExistingPrDisposition> {
  return classifyExistingPrForIssue(ctx.repo, ctx.issueNumber, {
    findExistingPrForIssue: deps.pr.findExistingPrForIssue,
    runGhCommand: deps.github.runGhCommand,
    warn: (m: string) => deps.logger.warn(m),
  });
}

/**
 * Stop the run because a merged/closed PR already resolved the issue
 * (Issue #218) — not a failure, so no failure label, no `unknown` class and
 * no auto-filed run-failure issue.
 */
function supersededResult(
  phase: string,
  disposition: Extract<ExistingPrDisposition, { kind: "superseded" }>,
  wip: PreservedRunWip,
  deps: WorkerDeps,
): PhaseResult {
  const reason = formatSupersededReason(disposition, wip.wipNote);
  deps.logger.warn(
    `Issue already resolved by ${
      disposition.prState === "MERGED" ? "merged" : "closed"
    } PR #${disposition.prNumber} — stopping this run rather ` +
      `than continuing against a branch that has nothing left to raise ` +
      `(Issue #218)`,
    {
      phase,
      prUrl: disposition.prUrl,
      ...(disposition.headRefName ? { prBranch: disposition.headRefName } : {}),
      ...(wip.wipNote ? { wip: wip.wipNote } : {}),
    },
  );
  return {
    status: "early_exit",
    reason,
    outcome: supersededOutcome({
      phase,
      prUrl: disposition.prUrl,
      prNumber: disposition.prNumber,
      prState: disposition.prState,
      ...(wip.wipNote ? { wipNote: wip.wipNote } : {}),
    }),
  };
}

/**
 * Build the prompt and execute Claude to implement the issue.
 *
 * Handles prompt building, Claude invocation with timeout, change
 * detection, and self-healing for timeouts/no-changes.
 *
 * Issue #1550: Wraps the phase body in a bounded in-process retry for
 * infrastructure-category failures (timeout/zero-output, rate limit,
 * internal error). On infra-category failure the phase sleeps briefly and
 * re-runs once before surfacing the failure, so transient environment
 * blips do not apply the `failed-once` label.
 */
export async function workOnIssueExecuteClaude(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const result = await executeClaudeBody(ctx, state, deps);
  if (result.status !== "failure") return result;

  // Issue #4374: a SIGKILL under memory pressure that is still high at the
  // kill is not retried — the retry re-runs the same workload into the same
  // memory (observed live: #4189 killed at 23 min, retried, killed again at
  // 90 s). Release now with the reading in the diagnostics instead of paying
  // a second billed start. An `ok`/`unknown` reading keeps the one bounded
  // #1550 retry: transient pressure often passes.
  const pressure = state.lastKillMemoryPressure;
  if (pressure?.level === "high") {
    deps.logger.warn(
      "Not retrying the killed run in-process: memory pressure was still " +
        "high at the kill, so a retry would meet the same wall (Issue #4374)",
      { phase: "execute", memoryPressure: describeMemoryPressure(pressure) },
    );
    return result;
  }

  // VibeCoder#174: a retry needs runway. Late in the cycle the retry gets
  // the 60 s execute floor, cannot possibly finish, and its verdict replaces
  // the first attempt's (which may have preserved WIP). Keep the first
  // attempt's outcome and let the next cycle resume the branch.
  if (!hasRunwayForInfraRetry(ctx.cycleDeadlineEpochMs)) {
    deps.logger.warn(
      "Not retrying the failed run in-process: fewer than " +
        `${MIN_INFRA_RETRY_RUNWAY_SECONDS}s of cycle runway remain, so a ` +
        "retry could not finish — the next cycle resumes the branch " +
        "(VibeCoder#174)",
      {
        phase: "execute",
        category: detectFailureCategory(result.reason),
        runwaySeconds: Math.max(
          0,
          Math.round(((ctx.cycleDeadlineEpochMs ?? 0) - Date.now()) / 1000),
        ),
      },
    );
    return result;
  }

  const shouldRetry = await shouldRetryInfrastructureFailure(
    "execute",
    result.reason,
    state,
    deps.logger,
    { backoffMs: ctx.config.infraRetryBackoffMs },
  );
  if (!shouldRetry) return result;

  return await executeClaudeBody(ctx, state, deps);
}

/** Single-attempt execute-phase body — see `workOnIssueExecuteClaude`. */
async function executeClaudeBody(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, issueTitle, issueBody, config } = ctx;
  const logger = deps.logger;
  state.executeStartTime = Date.now();
  state.lastKillMemoryPressure = undefined;
  // Cleared per attempt (Issue #768) for the same reason as the memory
  // reading above: a later attempt that also ends classed `timeout` must not
  // put an earlier run's grants and refusal on the release comment.
  state.extensionTelemetry = undefined;

  // The cheap half of the claim-freshness re-check (Issue #344). A cycle that
  // spent forty minutes rate-limited holds a claim that may already be
  // resolved; one `gh issue view` here is the difference between finding that
  // out now and finding it out after a full agent run. Only the decisive
  // signal is consulted before the agent runs — the issue is closed — so an
  // in-flight PR (#174, #218 territory) still reaches the paths that know how
  // to handle it.
  const freshness = await checkClaimFreshness({
    repo,
    issueNumber,
    runBranch: state.branchName,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: deps.pr.findExistingPrForIssue,
      runGhCommand: deps.github.runGhCommand,
      warn: (m: string) => logger.warn(m),
    },
  });
  if (freshness.kind === "stale") {
    logger.warn(
      `Claim on ${repo}#${issueNumber} went stale before the agent ran — ` +
        `stopping rather than spending a run on resolved work (Issue #344)`,
      { reason: freshness.reason, detail: freshness.detail },
    );
    return {
      status: "early_exit",
      reason: formatStaleClaimReason(freshness),
      outcome: claimStaleOutcome({
        phase: "execute",
        stale: freshness,
        branch: state.branchName,
      }),
    };
  }

  // Validate repo state before Claude invocation (Issue #621)
  const repoValidation = await deps.git.validateRepoState(
    state.branchName,
    state.baseBranch,
    false,
    { cwd: state.repoPath },
  );
  if (!repoValidation.ok) {
    return {
      status: "failure",
      reason: `Repository validation failed: ${repoValidation.error.message}`,
    };
  }

  // Build prompt with per-repo quality and custom instructions (Issue #1187).
  // The baseline gate has already run this cycle, so the agent is told what
  // the gate actually costs here rather than the fleet-wide assumption
  // (Issue #1138) — that figure is what it weighs the run budget against.
  const qualityInstructions = buildQualityInstructions(
    config.repoConfig,
    repo,
    state.baselineQualityDurationSeconds === undefined
      ? {}
      : { typicalGateSeconds: state.baselineQualityDurationSeconds },
  );
  const customInstructions = getCustomInstructions(config.repoConfig, repo);

  // Browser/network capability is granted on need, not by default
  // (Issue #192). This is the main-loop path that hands the agent a `cwd`,
  // so before the gate it wired the Playwright MCP server — outbound HTTP
  // through a full browser context — into every issue the fleet worked.
  // Now only an issue that must produce screenshot evidence gets it: the
  // `needs-screenshot` label, or a repo configured with
  // `requiresScreenshots`. A backend issue's agent has no browser tool for
  // a prompt injection to steer at an internal or attacker-controlled host.
  const screenshotRequired = detectScreenshotRequired(
    ctx.issueLabels.join(","),
    LABEL_DEFAULTS.needsScreenshotLabel,
    config.repoConfig,
    repo,
  );
  if (screenshotRequired) {
    logger.info(
      "Screenshot evidence required — wiring the Playwright MCP browser for " +
        "this run (Issue #192)",
    );
  }

  const promptResult = await deps.infrastructure.buildPrompt({
    repo,
    issueNumber: String(issueNumber),
    issueTitle,
    issueBody,
    issueLabels: ctx.issueLabels.join(","),
    qualityInstructions,
    customInstructions,
    milestoneBranch: state.milestoneBranch,
    // An operator's custom prompt replaces the built-in issue template for
    // this run (Issue #848). Passed through rather than resolved here, so the
    // dispatch handler stays the single place that decides a run is custom.
    customPromptPath: ctx.customPromptPath,
    customPromptLabel: ctx.customPromptLabel,
    // An operator's `work-on` mapping overrides the built-in issue template
    // for every implementation run (Issue #849); the per-run custom prompt
    // above still wins when this run was dispatched by a custom label.
    promptOverrides: promptOverrideMappings(config),
  });
  if (!promptResult.ok) {
    return {
      status: "failure",
      reason: `Failed to build prompt: ${promptResult.error.message}`,
    };
  }

  // Destructure PromptParts for prompt caching (Issue #1262)
  const { systemPrompt, prompt: basePrompt } = promptResult.value;

  // Prior progress exists (Issue #4170): setup resumed a checkpointed
  // branch, so tell the agent to review and continue instead of starting
  // again. Appended after the cached prefix so prompt caching is intact.
  //
  // When that branch carries the interrupted run's handover file (Issue #771),
  // its content is spliced in here — fenced and framed as prior-run status —
  // instead of the generic "review `git log`" paragraph alone. It rides the
  // user prompt, so the budget check below measures it like any other prompt
  // input. Independent of `enable_session_resume` and of the provider: the
  // committed file is the contract, a `--resume` transcript is the bonus.
  const userPrompt = state.resumedFromCheckpoint
    ? basePrompt + buildPriorProgressNote(issueNumber, state.handoverNote)
    : basePrompt;

  // --- Context budget hard ceiling (Issue #3713) ---
  // The budget check used to be observational only, so an issue whose prompt
  // kept growing was bounded by wall-clock alone. Stop here — before any
  // billed invocation — and hand the issue to a human when the assembled
  // prompt reaches the ceiling.
  const budgetResult = checkContextBudget(
    buildContextComponents({
      systemPrompt,
      userPrompt,
      issueBody,
      customInstructions,
    }),
    config.claudeModel || "opus",
    {
      warningThresholdPercent: config.contextBudgetWarningPercent,
      errorThresholdPercent: config.contextBudgetErrorPercent,
      blockThresholdPercent: config.contextBudgetBlockPercent,
    },
  );
  logger.info(formatBudgetBreakdown(budgetResult));
  if (!budgetResult.ok) {
    const reason = buildContextBudgetEscalationReason(budgetResult);
    logger.error("Context budget ceiling reached — stopping the phase", {
      repo,
      issueNumber,
      totalTokens: budgetResult.totalTokens,
      contextWindowSize: budgetResult.contextWindowSize,
      usagePercent: budgetResult.usagePercent,
    });
    await escalateToHuman({
      ghClient: deps.github.createClient(logger),
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel: config.needsHumanLabel,
      heading: "Context budget ceiling reached",
      reason,
      nextStep: CONTEXT_BUDGET_NEXT_STEP,
      dedupKey: `context-budget-${issueNumber}`,
      githubUser: ctx.githubUser,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });
    return { status: "early_exit", reason: "context_budget_exceeded" };
  }

  // Record the prompt revision for traceability (Issue #1190, #844).
  // Templates carry no version number since #844 — the checkout's commit is
  // what pins the text. A failure is surfaced, never logged as "unknown".
  const promptsCommit = await getPromptsCommit();
  if (promptsCommit.ok) {
    logger.info("Using prompts from commit", { commit: promptsCommit.value });
  } else {
    logger.warn("Could not resolve the prompts commit", {
      error: promptsCommit.error.message,
    });
  }

  // Initialise session resume state if enabled (Issue #1324)
  if (config.enableSessionResume && !state.sessionResumeState) {
    state.sessionResumeState = createSessionResumeState();
    logger.info("Session resume enabled", {
      sessionId: state.sessionResumeState.sessionId,
    });
  }

  // The whole configured budget, cycle deadline or not (Issue #420, parent
  // #397). Issue #4254 used to truncate a claim to the runway left in the
  // cycle, so a claim taken 16 minutes before the hour was killed mid-task
  // and could not extend even while demonstrably progressing (GRQ#4398). The
  // deadline now stops *new* claims only — `slotShouldStop` in the scan loop
  // — while the run itself is bounded by the supervisor hard cap.
  const executeTimeoutSeconds = config.claudeTimeout;

  // The supervisor's wall-clock cap, published by loop.sh (Issue #421).
  // Extensions may re-arm the deadline only up to this ceiling, which holds
  // back the kill grace and the WIP commit-and-push window so the worker
  // stops itself before `timeout` SIGTERMs the whole launcher. Absent env —
  // a CLI run, a host with the cap disabled — means no ceiling.
  const hardCap = resolveRunHardCap({
    killAfterSeconds: config.claudeKillAfter,
  });
  logger.info(`Run hard cap: ${describeRunHardCap(hardCap, Date.now())}`);

  // Re-armable deadline for issue work only (Issue #4296, part of #4290):
  // while the agent shows recent tool activity and progress — a working tree
  // that is advancing, or a descendant process doing work outside the
  // checkout (Issue #508) — the hard deadline moves instead of killing. With
  // truncation gone the operator's flag is the only gate (Issue #420);
  // `undefined` leaves the timeout exactly as it was, which is what every
  // other phase gets.
  const progressExtension = await buildProgressExtension(
    config,
    state.repoPath,
    (deadline) => {
      reportRunDeadline(deadline);
    },
    hardCap.capped ? hardCap.cap.ceilingMs : undefined,
    // What the baseline gate cost here this cycle (Issue #1138) — the budget
    // notice warns earlier on a repo whose gate is slow than on one whose
    // gate is quick.
    state.baselineQualityDurationSeconds,
  );

  // The run-start line an operator reads to know which budget applies. It
  // replaces the #4297 regime sentence, retired with the regime it named.
  logger.info(
    `Execute budget: ${executeTimeoutSeconds}s — the full configured ` +
      `claude_timeout, never truncated by the cycle deadline (Issue #420); ` +
      `progress extensions ${progressExtension ? "on" : "off"}.`,
  );

  // The deadline this run is working to, published to the slot's in-flight
  // hold (Issue #4297) so the shutdown drain accounts for the run — and, if
  // it is extended below, for the deadline it actually ends up with.
  reportRunDeadline({
    deadlineMs: Date.now() + executeTimeoutSeconds * 1000,
    extensionsGranted: 0,
  });

  if (progressExtension) {
    logger.info(
      `Progress-extension deadline enabled (Issue #4290): ` +
        `${executeTimeoutSeconds}s budget, extended by ` +
        `${progressExtension.policy.grantSeconds}s while tool activity is ` +
        `within ${progressExtension.policy.activityStallSeconds}s and the ` +
        `working tree advances` +
        (progressExtension.ceilingMs !== undefined
          ? `, bounded by the run hard cap (Issue #421).`
          : `, unbounded — this run has no supervisor cap (Issue #421).`),
    );
  }

  // Where the branch stood before the agent ran (Issue #148). A re-claim
  // resumes a branch that may already carry an earlier run's WIP commits;
  // the completion phase needs this SHA to tell "the resume advanced the
  // branch" from "nothing new happened, do not raise a half-done PR". Best
  // effort: an unreadable HEAD leaves it unset and the gate fails open.
  const headBeforeExecute = await deps.git.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: state.repoPath },
  );
  state.executeStartHeadSha =
    headBeforeExecute.ok && headBeforeExecute.value.code === 0 &&
      headBeforeExecute.value.stdout.trim().length > 0
      ? headBeforeExecute.value.stdout.trim()
      : undefined;

  // Periodic WIP checkpoints (Issue #4170): while the agent runs, commit
  // and push its progress to the claim-locked issue branch every ~10
  // minutes, and refresh the durable resume state so a killed session
  // resumes from the last checkpoint instead of restarting from zero.
  // Gated with session resume — together they form resume-on-reclaim.
  const saveCheckpointState = () =>
    saveResumeState(config.workDir, repo, issueNumber, {
      ...(state.sessionResumeState
        ? { sessionId: state.sessionResumeState.sessionId }
        : {}),
      phaseCount: state.sessionResumeState?.phaseCount ?? 0,
      branch: state.branchName,
    }).then(() => undefined);
  const checkpoints = config.enableSessionResume
    ? startWipCheckpoints({
      repoPath: state.repoPath,
      branchName: state.branchName,
      logger: {
        info: (m: string) => logger.info(m),
        warn: (m: string) => logger.warn(m),
      },
      onCheckpoint: saveCheckpointState,
    })
    : undefined;

  // Execute Claude with timeout and retry
  let claudeResult: Awaited<ReturnType<typeof deps.claude.runClaudeWithRetry>>;
  try {
    claudeResult = await deps.claude.runClaudeWithRetry(
      {
        prompt: userPrompt,
        systemPrompt,
        // Route the coding run through the documented `issue` phase (Issue
        // #2709) — the standalone command path already did; this main-loop
        // path never had it, so fleet runs bypassed the per-phase
        // model/effort chain and every telemetry line read
        // `phase=unknown` / `[agent-progress] agent:`. `repo` names the
        // repository in the credit log and cache-hit lines.
        phase: "issue",
        repo,
        timeoutSeconds: executeTimeoutSeconds,
        killAfterSeconds: config.claudeKillAfter,
        model: config.claudeModel || undefined,
        cwd: state.repoPath,
        // Opt-in browser (Issue #192) — see `screenshotRequired` above.
        mcpConfig: screenshotRequired,
        logger,
        sessionResumeState: state.sessionResumeState,
        // Transcript tee file name (Issue #4169): agent-<runid>-<issue>.jsonl.
        issueNumber,
        // Opt-in only (Issue #4296) — absent, the hard timeout is unchanged.
        ...(progressExtension ? { progressExtension } : {}),
      },
      {
        maxRetries: config.maxRateLimitRetries,
      },
    );
  } finally {
    if (checkpoints) {
      checkpoints.stop();
      // Phase-end checkpoint, before verification (Issue #4170): push
      // whatever the run produced — including a timed-out or killed run's
      // partial work — so nothing later in the pipeline can lose it.
      await checkpoints.runNow();
    }
  }
  if (!claudeResult.ok) {
    return {
      status: "failure",
      reason: `Claude execution failed: ${claudeResult.error.message}`,
    };
  }

  state.claudeOutput = claudeResult.value.output;

  // Issue #3756 — retain this invocation's model/token stats. A `work-on`
  // issue is auto-closed by its merged PR with no worker attached, so the
  // completion phase posts the issue's single cost/model comment at PR-raise
  // time using what is recorded here. Recording is cumulative: the #1550
  // infrastructure retry re-enters this body.
  recordClaudeRunStats(state, claudeResult.value);

  // Check for timeout (Issue #1188 — detailed failure messages)
  if (claudeResult.value.timedOut) {
    // A hard-cap release fires the same watchdog and exits with the same
    // status as a genuine timeout (Issue #424, parent #397). Only the runner
    // knows which happened, so read its flag rather than the exit status.
    const scheduled = claudeResult.value.scheduledRelease;
    if (scheduled) {
      logger.warn(
        "Claude released on schedule — the supervisor's run hard cap was " +
          "reached while the run was still progressing; preserving its work " +
          "for the next claim (Issue #424)",
        { exitCode: claudeResult.value.exitCode },
      );
    } else {
      logger.warn("Claude timed out", {
        exitCode: claudeResult.value.exitCode,
      });
    }

    // What the re-armable deadline did to this run (Issue #768), kept for the
    // claim-release comment: how many extensions were granted and why the
    // last check was refused.
    state.extensionTelemetry = claudeResult.value.extensions;

    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    const snippet = state.claudeOutput.slice(-500);
    // WIP preservation runs FIRST, unconditionally (Issues #47, #218).
    //
    // Issue #47: "without creating changes" was misleading — a timed-out run
    // usually left uncommitted work in the tree (on #5 the agent was running
    // `deno test` on its own changes at the 38-minute kill), and on #5 that
    // work was simply discarded. One commit on the claim-locked issue branch,
    // pushed through the guarded chokepoint, UNCONDITIONALLY — unlike the
    // periodic #4170 checkpoints this does not wait for
    // `enable_session_resume`; that flag remains the opt-in half that
    // auto-resumes from the branch on re-claim.
    //
    // Issue #218: this used to sit BELOW the "a PR already exists → continue"
    // self-heal, so any PR for the issue — including a sibling host's, and
    // including an already-merged one — skipped preservation entirely. On
    // VibeCoder#185 that discarded 51 minutes of uncommitted work. The
    // existing-PR lookup now happens after the work is safe.
    const wip = await preserveRunWip({
      state,
      deps,
      issueNumber: ctx.issueNumber,
      repo: ctx.repo,
      // Zero output means the agent produced nothing, so nothing in the tree
      // is its work — leave the tree alone, as before.
      inspectWorkingTree: state.claudeOutput.length > 0,
      buildMessage: (dirtyFiles) =>
        buildInterruptedWipCommitMessage({
          cause: scheduled ? "scheduled-release" : "timed-out",
          elapsedSeconds,
          dirtyFiles,
        }),
      // The portable half of the handover (Issue #769): a note committed
      // beside the code, readable on any host by any provider.
      handover: {
        cause: scheduled ? "scheduled-release" : "timed-out",
        elapsedSeconds,
      },
      // Refresh the durable resume state so resume-on-reclaim (#4170) finds
      // the checkpoint when session resume is enabled.
      onPreserved: () => saveCheckpointState(),
    });
    const { dirtyFiles, wipCommits, wipNote } = wip;

    // Self-healing: check if a PR was already created (Issue #386), now that
    // the work is safe. An OPEN PR means work is in flight and continuing is
    // right; a MERGED/CLOSED one means this run has nothing left to raise
    // (Issue #218).
    const disposition = await classifyExistingPr(ctx, deps);
    if (disposition.kind === "open") {
      logger.info("PR already exists despite timeout, treating as success", {
        prUrl: disposition.prUrl,
        ...(wipNote ? { wip: wipNote } : {}),
      });
      return { status: "continue" };
    }
    if (disposition.kind === "superseded") {
      return supersededResult("execute", disposition, wip, deps);
    }

    // Issue #1550: When Claude times out with an empty output, classify the
    // failure as zero_output (infrastructure) so the infra-retry wrapper
    // fires. Pure timeouts with partial output remain in the generic
    // `timeout` category and are not retried.
    //
    // Every issue-work timeout now means the same thing — the run burned its
    // whole configured budget — because the cycle deadline no longer
    // truncates a claim (Issue #420), so there is no shortened-budget note to
    // add.
    //
    // A scheduled release says so instead (Issue #424): the run did not run
    // out of time on this issue, the fleet stopped it, and the wording must
    // not send a human off to split the issue into sub-issues.
    //
    // Either way the note names the branch the push targeted (Issue #770).
    // A scheduled release folds it into its own reason; a timeout appends it,
    // as before. `foldedNote` is what the reason already carries, so the
    // branch is never stated twice.
    const foldedNote = scheduled && wip.preserved ? wipNote : undefined;
    const baseReason = (scheduled
      ? buildScheduledReleaseReason(scheduled, foldedNote)
      : state.claudeOutput.length === 0
      ? `Claude timed out with zero output and made no changes`
      : dirtyFiles > 0
      ? `Claude timed out with uncommitted changes (${dirtyFiles} file${
        dirtyFiles === 1 ? "" : "s"
      })`
      : wipCommits > 0
      ? `Claude timed out with its work preserved on the branch`
      : `Claude timed out without creating changes`) +
      (wipNote && wipNote !== foldedNote ? ` — ${wipNote}` : "");
    const reason = formatDetailedFailureMessage(baseReason, {
      elapsedSeconds,
      timedOut: true,
      outputSize: state.claudeOutput.length,
      timeoutSeconds: executeTimeoutSeconds,
      clarityStatus: state.clarityStatus,
      lastOutputSnippet: snippet || undefined,
      // The evidence must survive (Issue #4202): which watchdog fired, and
      // what the process really exited with. Issue #4254 adds how late the
      // watchdog fired and whether the post-kill wait had to be abandoned.
      timeoutReason: claudeResult.value.timeoutReason,
      rawExitCode: claudeResult.value.rawExitCode,
      watchdogLateSeconds: claudeResult.value.watchdogLateSeconds,
      killIncompleteSeconds: claudeResult.value.killIncompleteSeconds,
    });
    return { status: "failure", reason };
  }

  // A killed run (Issue #4202): SIGKILLed with no watchdog firing — the
  // usual culprit is the VM's out-of-memory killer. This used to be
  // remapped onto the timeout path, which asserted a false "timed out after
  // ${config.claudeTimeout}s" (observed live at 539 s of a 3600 s budget).
  // The SIGKILL wording classifies as `killed` — infrastructure — so the
  // bounded #1550 retry may run: transient memory pressure often passes.
  if (claudeResult.value.killed) {
    const memoryPressureAtKill = claudeResult.value.memoryPressureAtKill;
    state.lastKillMemoryPressure = memoryPressureAtKill;
    logger.warn("Claude was killed (SIGKILL, no watchdog)", {
      rawExitCode: claudeResult.value.rawExitCode,
      memoryPressure: memoryPressureAtKill
        ? describeMemoryPressure(memoryPressureAtKill)
        : "unprobed",
    });

    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    // Same ordering as the timeout path (Issue #218): the work is made safe
    // before anything can decide this run is finished with.
    const wip = await preserveRunWip({
      state,
      deps,
      issueNumber: ctx.issueNumber,
      repo: ctx.repo,
      inspectWorkingTree: state.claudeOutput.length > 0,
      buildMessage: (dirtyFiles) =>
        buildInterruptedWipCommitMessage({
          cause: "killed",
          elapsedSeconds,
          dirtyFiles,
        }),
      handover: { cause: "killed", elapsedSeconds },
      onPreserved: () => saveCheckpointState(),
    });

    // Self-healing: a kill late in the run may follow a pushed PR (#386);
    // a merged/closed one instead means the issue is already resolved (#218).
    const disposition = await classifyExistingPr(ctx, deps);
    if (disposition.kind === "open") {
      logger.info("PR already exists despite the kill, treating as success", {
        prUrl: disposition.prUrl,
        ...(wip.wipNote ? { wip: wip.wipNote } : {}),
      });
      return { status: "continue" };
    }
    if (disposition.kind === "superseded") {
      return supersededResult("execute", disposition, wip, deps);
    }

    // stderr is where a V8 heap abort or a CLI self-termination writes its
    // last words (Issue #4237) — surfaced beside the stdout tail so a killed
    // run carries every stream's evidence.
    const stderrTail = (claudeResult.value.stderr ?? "").trim().slice(-400);
    const snippet = [state.claudeOutput.slice(-500), stderrTail]
      .filter((part) => part.length > 0)
      .join("\n--- stderr ---\n");
    const reason = formatDetailedFailureMessage(
      "Claude was killed (exit 137, SIGKILL)" +
        (wip.wipNote ? ` — ${wip.wipNote}` : " without creating changes"),
      {
        elapsedSeconds,
        outputSize: state.claudeOutput.length,
        clarityStatus: state.clarityStatus,
        lastOutputSnippet: snippet || undefined,
        rawExitCode: claudeResult.value.rawExitCode ?? 137,
        memoryPressureAtKill,
        killDiagnostics: claudeResult.value.killDiagnostics,
      },
    );
    return { status: "failure", reason };
  }

  // The worker's own shutdown ended the agent run (Issue #4369): the cycle is
  // over. That is a scheduled release, not a failure of the issue (Issue
  // #424, parent #397) — preserve the work, name the handover, and let the
  // next claim resume the branch. Without this arm the result fell through to
  // change detection, which ran the quality gate and the completion phase
  // over a half-done tree exactly as the external-SIGTERM path did before
  // Issue #46 fixed it.
  if (claudeResult.value.terminated) {
    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    logger.warn(
      "Claude was stopped by the worker's own shutdown — releasing the claim " +
        "on schedule with the work preserved (Issue #424)",
      { rawExitCode: claudeResult.value.rawExitCode },
    );
    const wip = await preserveRunWip({
      state,
      deps,
      issueNumber: ctx.issueNumber,
      repo: ctx.repo,
      inspectWorkingTree: state.claudeOutput.length > 0,
      buildMessage: (dirtyFiles) =>
        buildInterruptedWipCommitMessage({
          cause: "scheduled-release",
          elapsedSeconds,
          dirtyFiles,
        }),
      handover: { cause: "scheduled-release", elapsedSeconds },
      onPreserved: () => saveCheckpointState(),
    });
    // Same ordering as every other stop path (#218): the work is safe before
    // anything decides this run is finished with.
    const disposition = await classifyExistingPr(ctx, deps);
    if (disposition.kind === "open") {
      logger.info(
        "PR already exists despite the shutdown, treating as success",
        {
          prUrl: disposition.prUrl,
          ...(wip.wipNote ? { wip: wip.wipNote } : {}),
        },
      );
      return { status: "continue" };
    }
    if (disposition.kind === "superseded") {
      return supersededResult("execute", disposition, wip, deps);
    }
    // The note names the branch the push targeted (Issue #770); folding it
    // into the scheduled-release reason states that exactly once.
    const foldedNote = wip.preserved ? wip.wipNote : undefined;
    const reason = formatDetailedFailureMessage(
      buildScheduledReleaseReason("cycle-ended", foldedNote) +
        (wip.wipNote && wip.wipNote !== foldedNote ? ` — ${wip.wipNote}` : ""),
      {
        elapsedSeconds,
        outputSize: state.claudeOutput.length,
        clarityStatus: state.clarityStatus,
        lastOutputSnippet: state.claudeOutput.slice(-500) || undefined,
        rawExitCode: claudeResult.value.rawExitCode ?? 143,
      },
    );
    return { status: "failure", reason };
  }

  // Issue #46: a SIGTERM the worker never requested — an external kill (a tool
  // the agent ran, the CLI, the container, a stray signal). The old code let
  // this `terminated` result fall through to change detection and `continue`,
  // so quality-gate and completion ran over a half-done tree and failed for
  // the wrong reason ("no commits ahead"). Fail the phase with the kill as the
  // reason (which classifies as `killed` -> infrastructure, so the bounded
  // retry applies), after the same pushed-PR self-heal the SIGKILL path uses.
  if (claudeResult.value.externalSigterm) {
    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    // Preserve before classifying, as on the timeout and kill paths (#218).
    const wip = await preserveRunWip({
      state,
      deps,
      issueNumber: ctx.issueNumber,
      repo: ctx.repo,
      inspectWorkingTree: state.claudeOutput.length > 0,
      buildMessage: (dirtyFiles) =>
        buildInterruptedWipCommitMessage({
          cause: "external-sigterm",
          elapsedSeconds,
          dirtyFiles,
        }),
      handover: { cause: "external-sigterm", elapsedSeconds },
      onPreserved: () => saveCheckpointState(),
    });
    const disposition = await classifyExistingPr(ctx, deps);
    if (disposition.kind === "open") {
      logger.info(
        "PR already exists despite the external SIGTERM, treating as success",
        {
          prUrl: disposition.prUrl,
          ...(wip.wipNote ? { wip: wip.wipNote } : {}),
        },
      );
      return { status: "continue" };
    }
    if (disposition.kind === "superseded") {
      return supersededResult("execute", disposition, wip, deps);
    }
    const stderrTail = (claudeResult.value.stderr ?? "").trim().slice(-400);
    const snippet = [state.claudeOutput.slice(-500), stderrTail]
      .filter((part) => part.length > 0)
      .join("\n--- stderr ---\n");
    logger.warn(
      "Claude killed by an external SIGTERM (not a worker-requested shutdown)",
      { rawExitCode: claudeResult.value.rawExitCode },
    );
    const reason = formatDetailedFailureMessage(
      "Claude was killed by an external SIGTERM (exit 143) — the worker did " +
        "not request this shutdown" + (wip.wipNote ? ` — ${wip.wipNote}` : ""),
      {
        elapsedSeconds,
        outputSize: state.claudeOutput.length,
        clarityStatus: state.clarityStatus,
        lastOutputSnippet: snippet || undefined,
        rawExitCode: claudeResult.value.rawExitCode ?? 143,
        killDiagnostics: claudeResult.value.killDiagnostics,
      },
    );
    return { status: "failure", reason };
  }

  // Check for auth errors (Issue #1188 — detailed failure messages).
  // Issue #45: an auth failure is the CLI's OWN signal — a non-zero exit whose
  // stderr or final error lines match — never the body of a successful
  // transcript. #36 (a redaction issue whose prose mentions "api key") exited
  // having raised a correct PR, yet the whole-transcript scan tripped and
  // recorded the success as an authentication failure. Read only the CLI's
  // error surface (stderr + the final output lines), and only for a non-zero
  // exit.
  const authSurface = [
    claudeResult.value.stderr ?? "",
    claudeResult.value.output.trim().split("\n").slice(-15).join("\n"),
  ].join("\n");
  if (
    claudeResult.value.exitCode !== 0 &&
    deps.claude.isClaudeAuthError(authSurface)
  ) {
    // Cross-check for evidence of success before blaming the credential: a run
    // that left commits ahead of base is a false positive on issue content,
    // not an auth failure — fall through so the good branch/PR is not
    // discarded and the claim is not released as "no PR raised" (Issue #45).
    if (await branchHasCommitsAhead(state, deps)) {
      logger.warn(
        "Auth-error pattern matched but the branch has commits ahead of " +
          "base — treating as a classifier false positive, not an " +
          "authentication failure",
        { branch: state.branchName },
      );
    } else {
      const elapsedSeconds = Math.round(
        (Date.now() - state.executeStartTime) / 1000,
      );
      // The evidence must survive (Issue #3234): during a live fleet auth
      // outage this branch discarded Claude's own words, leaving
      // "authentication error" indistinguishable from a usage-limit block.
      const authSnippet = authSurface.slice(-500).trim() ||
        "(no output captured)";
      const reason = formatDetailedFailureMessage(
        "Claude authentication error",
        {
          elapsedSeconds,
          clarityStatus: state.clarityStatus,
          lastOutputSnippet: authSnippet,
        },
      );
      return { status: "failure", reason };
    }
  }

  // Rate/usage-limit give-up (Issue #4315): the runner reports exit 2 when
  // it stopped retrying — including the terminal subscription usage-limit
  // branch. This used to fall through to "no changes" (a silent
  // early_exit with no infrastructure retry and no cooldown class). Name
  // it so `detectFailureCategory` classifies it as rate_limit →
  // infrastructure: the issue is not blamed, and the durable signal the
  // runner wrote pauses the loop.
  if (claudeResult.value.exitCode === 2) {
    const limit = claudeResult.value.usageLimit;
    const heading = limit
      ? "Claude usage limit reached (subscription window)"
      : "Claude rate limit — retries exhausted";
    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    const snippet = [
      claudeResult.value.output.slice(-300),
      (claudeResult.value.stderr ?? "").trim().slice(-300),
    ].filter((part) => part.length > 0).join("\n--- stderr ---\n");
    const reason = formatDetailedFailureMessage(heading, {
      elapsedSeconds,
      clarityStatus: state.clarityStatus,
      lastOutputSnippet: snippet || undefined,
    }) + (limit
      ? ` Agent work is paused for ${limit.waitSeconds}s${
        limit.resetEpochMs
          ? ` (until ${new Date(limit.resetEpochMs).toISOString()})`
          : ""
      }.`
      : "");
    logger.warn(heading, { exitCode: 2, waitSeconds: limit?.waitSeconds });
    return { status: "failure", reason };
  }

  // Record session phase completion for resume support (Issue #1324)
  if (state.sessionResumeState) {
    state.sessionResumeState = recordPhaseCompletion(state.sessionResumeState);
    // Persist across process death (Issue #4170) so a re-claim can prime
    // `--resume` from the durable transcript.
    await saveResumeState(config.workDir, repo, issueNumber, {
      sessionId: state.sessionResumeState.sessionId,
      phaseCount: state.sessionResumeState.phaseCount,
      branch: state.branchName,
    });
  }

  // Detect changes — check for uncommitted changes or new commits
  const diffResult = await deps.git.runGitCommand(
    ["diff", "--stat", "HEAD"],
    { cwd: state.repoPath },
  );

  // Issue #106: resolve the base to a ref this clone can actually compare
  // against. A milestone base is frequently present only as `origin/<base>`,
  // so a bare `<base>..HEAD` fails with exit 128 — and the old check inspected
  // only whether the command ran, never its exit code, so the failure read as
  // "no commits" and a run that had produced a merged PR was escalated as
  // analysis-only. Resolve loudly: on an unresolvable base, fall back to the
  // existing-PR backstop and otherwise surface the error, never "no changes".
  const baseRef = await resolveComparableBaseRef(
    deps.git.runGitCommand,
    state.baseBranch,
    { cwd: state.repoPath },
  );
  if (!baseRef.ok) {
    logger.warn("Could not resolve the base ref for change detection", {
      baseBranch: state.baseBranch,
      error: baseRef.error.message,
    });
    const existingPr = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (existingPr.ok && existingPr.value) {
      logger.info(
        "PR already exists — treating the base-ref resolution failure as non-fatal",
      );
      return { status: "continue" };
    }
    return {
      status: "failure",
      reason:
        `change detection could not resolve base ref '${state.baseBranch}': ${baseRef.error.message}`,
    };
  }

  // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
  await ensureHistoryDepth([baseRef.value, "HEAD"], { cwd: state.repoPath });
  const logResult = await deps.git.runGitCommand(
    ["log", `${baseRef.value}..HEAD`, "--oneline"],
    { cwd: state.repoPath },
  );

  const hasUncommitted = diffResult.ok &&
    diffResult.value.stdout.trim().length > 0;
  // Issue #106: a non-zero git exit is an ERROR, never "no commits". Only a
  // command that ran AND exited 0 with empty output means the branch is level
  // with its base.
  const logOk = logResult.ok && logResult.value.code === 0;
  const hasNewCommits = logOk && logResult.value.stdout.trim().length > 0;

  if (!hasUncommitted && !hasNewCommits) {
    if (!logOk) {
      logger.warn("git log <base>..HEAD failed during change detection", {
        baseRef: baseRef.value,
        code: logResult.ok ? logResult.value.code : undefined,
        stderr: logResult.ok ? logResult.value.stderr.trim() : undefined,
      });
    }

    // Self-healing: check for remote commits (Issue #585)
    // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
    await ensureHistoryDepth(
      [baseRef.value, `origin/${state.branchName}`],
      { cwd: state.repoPath },
    );
    const remoteDiff = await deps.git.runGitCommand(
      ["log", `${baseRef.value}..origin/${state.branchName}`, "--oneline"],
      { cwd: state.repoPath },
    );
    const hasRemoteCommits = remoteDiff.ok && remoteDiff.value.code === 0 &&
      remoteDiff.value.stdout.trim().length > 0;

    if (hasRemoteCommits) {
      logger.info("Found remote commits despite no local changes");
      return { status: "continue" };
    }

    // Self-healing: check if PR already exists (Issue #386)
    const existingPr = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (existingPr.ok && existingPr.value) {
      logger.info("PR already exists despite no local changes");
      return { status: "continue" };
    }

    // Issue #106: if the range comparison itself errored and nothing else
    // found work, the state is undetermined — surface it, never silently
    // conclude no_changes (which escalates to analysis-only).
    if (!logOk) {
      return {
        status: "failure",
        reason: `change detection failed: git log ${baseRef.value}..HEAD ` +
          (logResult.ok
            ? `exited ${logResult.value.code}: ${logResult.value.stderr.trim()}`
            : `could not run: ${logResult.error.message}`),
      };
    }

    return { status: "early_exit", reason: "no_changes" };
  }

  return { status: "continue" };
}
