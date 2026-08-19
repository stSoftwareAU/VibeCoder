/**
 * Phase 3 — Execute Claude.
 *
 * Builds the prompt with per-repo customisations, invokes Claude with
 * timeout/retry, records prompt versions and session resume state,
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
import { getLatestVersion } from "../prompt_manager.ts";
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
import {
  PRIOR_PROGRESS_PROMPT_NOTE,
  saveResumeState,
} from "../resume_state_store.ts";
import { startWipCheckpoints } from "../wip_checkpoint.ts";
import { buildProgressExtension } from "../progress_extension_runtime.ts";
import { shouldRetryInfrastructureFailure } from "../infra_retry.ts";
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
import {
  resolveExecuteTimeoutSeconds,
  resolveExtensionRegime,
} from "../execute_timeout.ts";
import { reportRunDeadline } from "../slot_context.ts";

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

  // Build prompt with per-repo quality and custom instructions (Issue #1187)
  const qualityInstructions = buildQualityInstructions(config.repoConfig, repo);
  const customInstructions = getCustomInstructions(config.repoConfig, repo);

  const promptResult = await deps.infrastructure.buildPrompt({
    repo,
    issueNumber: String(issueNumber),
    issueTitle,
    issueBody,
    issueLabels: ctx.issueLabels.join(","),
    qualityInstructions,
    customInstructions,
    milestoneBranch: state.milestoneBranch,
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
  const userPrompt = state.resumedFromCheckpoint
    ? basePrompt + PRIOR_PROGRESS_PROMPT_NOTE
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

  // Record prompt versions for traceability (Issue #1190)
  const issueVersion = await getLatestVersion("issue").then(
    (r) => r.ok ? r.value : "unknown",
  );
  const guidelinesVersion = await getLatestVersion("coding_guidelines").then(
    (r) => r.ok ? r.value : "unknown",
  );
  logger.info("Using prompt versions", {
    issue: issueVersion,
    coding_guidelines: guidelinesVersion,
  });

  // Initialise session resume state if enabled (Issue #1324)
  if (config.enableSessionResume && !state.sessionResumeState) {
    state.sessionResumeState = createSessionResumeState(repo, issueNumber);
    logger.info("Session resume enabled", {
      sessionId: state.sessionResumeState.sessionId,
    });
  }

  // Deadline-aware execute timeout (Issue #4254): a claim taken late in the
  // cycle must not run a full claudeTimeout past the planned shutdown — one
  // stuck run stretched a 3 h 46 m cycle to 11 h 30 m. Bound the timeout to
  // the time left until the cycle deadline (plus the kill grace) when a
  // deadline is known; the CLI single-issue path leaves it unset.
  const executeTimeout = resolveExecuteTimeoutSeconds(
    config.claudeTimeout,
    config.claudeKillAfter,
    ctx.cycleDeadlineEpochMs,
    Date.now(),
  );
  // Which regime this run is in (Issue #4297) — logged at run start either
  // way, so an operator reading the log knows whether progress extensions
  // were on the table at all, and (deadline-bound) that this claim was taken
  // late in the cycle. A deadline-bound run is never extended: the cycle
  // deadline is an external commitment and #4254 exists precisely because a
  // busy-looking run overran it.
  const regime = resolveExtensionRegime(executeTimeout, config.claudeTimeout);
  logger.info(
    `Execute timeout regime: ${regime.regime} — ${regime.reason}.`,
  );

  // The deadline this run is working to, published to the slot's in-flight
  // hold (Issue #4297) so the shutdown drain accounts for the run — and, if
  // it is extended below, for the deadline it actually ends up with.
  reportRunDeadline({
    deadlineMs: Date.now() + executeTimeout.timeoutSeconds * 1000,
    extensionsGranted: 0,
  });

  // Re-armable deadline for issue work only (Issue #4296, part of #4290):
  // while the agent shows both recent tool activity and a working tree that
  // is actually advancing, the hard deadline moves instead of killing. Off
  // unless the operator enabled it, and off outright for a deadline-bound
  // run; `undefined` leaves the timeout exactly as it was, which is what
  // every other phase gets.
  const progressExtension = regime.extensionsAllowed
    ? await buildProgressExtension(
      config,
      state.repoPath,
      (deadline) => {
        reportRunDeadline(deadline);
      },
    )
    : undefined;
  if (progressExtension) {
    logger.info(
      `Progress-extension deadline enabled (Issue #4290): ` +
        `${executeTimeout.timeoutSeconds}s budget, extended by ` +
        `${progressExtension.policy.grantSeconds}s while tool activity is ` +
        `within ${progressExtension.policy.activityStallSeconds}s and the ` +
        `working tree advances.`,
    );
  }

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
        timeoutSeconds: executeTimeout.timeoutSeconds,
        killAfterSeconds: config.claudeKillAfter,
        model: config.claudeModel || undefined,
        cwd: state.repoPath,
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
    logger.warn("Claude timed out", { exitCode: claudeResult.value.exitCode });

    // Self-healing: check if PR was already created (Issue #386)
    const existingPr = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (existingPr.ok && existingPr.value) {
      logger.info("PR already exists despite timeout, treating as success");
      return { status: "continue" };
    }

    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    const snippet = state.claudeOutput.slice(-500);
    // Issue #1550: When Claude times out with an empty output, classify the
    // failure as zero_output (infrastructure) so the infra-retry wrapper
    // fires. Pure timeouts with partial output remain in the generic
    // `timeout` category and are not retried.
    const baseReason = state.claudeOutput.length === 0
      ? "Claude timed out with zero output and made no changes"
      : "Claude timed out without creating changes";
    const reason = formatDetailedFailureMessage(baseReason, {
      elapsedSeconds,
      timedOut: true,
      outputSize: state.claudeOutput.length,
      timeoutSeconds: executeTimeout.timeoutSeconds,
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

    // Self-healing: a kill late in the run may follow a pushed PR (#386).
    const existingPr = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (existingPr.ok && existingPr.value) {
      logger.info("PR already exists despite the kill, treating as success");
      return { status: "continue" };
    }

    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    // stderr is where a V8 heap abort or a CLI self-termination writes its
    // last words (Issue #4237) — surfaced beside the stdout tail so a killed
    // run carries every stream's evidence.
    const stderrTail = (claudeResult.value.stderr ?? "").trim().slice(-400);
    const snippet = [state.claudeOutput.slice(-500), stderrTail]
      .filter((part) => part.length > 0)
      .join("\n--- stderr ---\n");
    const reason = formatDetailedFailureMessage(
      "Claude was killed (exit 137, SIGKILL) without creating changes",
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

  // Check for auth errors (Issue #1188 — detailed failure messages)
  if (deps.claude.isClaudeAuthError(claudeResult.value.output)) {
    const elapsedSeconds = Math.round(
      (Date.now() - state.executeStartTime) / 1000,
    );
    // The evidence must survive (Issue #3234): during a live fleet auth
    // outage this branch discarded Claude's own words, leaving
    // "authentication error" indistinguishable from a usage-limit block or
    // a classifier false positive on issue content that mentions tokens.
    const authSnippet = claudeResult.value.output.slice(-500).trim() ||
      "(no output captured)";
    const reason = formatDetailedFailureMessage("Claude authentication error", {
      elapsedSeconds,
      clarityStatus: state.clarityStatus,
      lastOutputSnippet: authSnippet,
    });
    return { status: "failure", reason };
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
  // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
  await ensureHistoryDepth([state.baseBranch, "HEAD"], { cwd: state.repoPath });
  const logResult = await deps.git.runGitCommand(
    ["log", `${state.baseBranch}..HEAD`, "--oneline"],
    { cwd: state.repoPath },
  );

  const hasUncommitted = diffResult.ok &&
    diffResult.value.stdout.trim().length > 0;
  const hasNewCommits = logResult.ok &&
    logResult.value.stdout.trim().length > 0;

  if (!hasUncommitted && !hasNewCommits) {
    // Self-healing: check for remote commits (Issue #585)
    // Ensure enough history for the commit-range log on a shallow clone (Issue #1502)
    await ensureHistoryDepth(
      [state.baseBranch, `origin/${state.branchName}`],
      { cwd: state.repoPath },
    );
    const remoteDiff = await deps.git.runGitCommand(
      ["log", `${state.baseBranch}..origin/${state.branchName}`, "--oneline"],
      { cwd: state.repoPath },
    );
    const hasRemoteCommits = remoteDiff.ok &&
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

    return { status: "early_exit", reason: "no_changes" };
  }

  return { status: "continue" };
}
