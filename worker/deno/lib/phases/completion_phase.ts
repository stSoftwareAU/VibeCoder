/**
 * Phase 5 — Completion (Push & PR).
 *
 * Pushes the feature branch (with rejection recovery), builds the PR
 * body from `docs/pr-summary-*.md`, validates screenshot evidence for
 * UI changes, creates or recovers the PR, then runs post-PR finalisation
 * (issue linking, duplicate PR closure, milestone retargeting, auto-merge).
 * Single responsibility: turn the local commits into a completed PR.
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
import { LABEL_DEFAULTS } from "../config_defaults.ts";
import { buildWorkerFooter } from "../worker_identity.ts";
import { getRunId } from "../run_id.ts";
import { buildIdempotencyMarker, buildMilestonePrSection } from "../pr_body.ts";
import { resolveComparableBaseRef } from "../git_base_ref.ts";
import { loadPrSummary } from "../pr_summary_loader.ts";
import { getRepoConfig } from "../repo_config.ts";
import {
  findBranchEvidenceImages,
  formatBranchEvidenceSection,
  validateScreenshotEvidence,
} from "../screenshot_validation.ts";
import {
  convertEvidenceImagesToRawUrls,
  findScreenshotReferences,
} from "../pr_evidence.ts";
import { resolveImagePaths } from "../image_path_resolver.ts";
import {
  ensureIssueClosedIfPrMerged,
  unassignAfterPrCreated,
} from "../issue_lifecycle.ts";
import { shouldRetryInfrastructureFailure } from "../infra_retry.ts";
import { buildBumpRejectionComment } from "../bump_deps.ts";
import {
  formatBuildStamp,
  resolveWorkerBuildInfo,
} from "../worker_build_info.ts";
import { postIssueRunStatsComment } from "../issue_run_stats_comment.ts";
import {
  buildSecurityFixGateMessage,
  evaluateSecurityFixGate,
  hasSecurityLabel,
  referencesFindingId,
} from "../security_fix_gate.ts";
import { collectSecurityFixDiff } from "../security_fix_diff.ts";
import {
  clearSecurityFixGateBlock,
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../security_fix_gate_feedback.ts";

/**
 * Phase name the `work-on` coding run is routed under (`PHASE_MODEL_DEFAULTS`).
 * Drives both the stats heading and the expected-model routing chain.
 */
const WORK_ON_STATS_PHASE = "issue";

/**
 * Look up the state of an existing PR. Returns null when the state cannot be
 * determined (e.g. gh API error) — the caller should treat that as "unknown"
 * and preserve existing non-merged behaviour.
 */
async function lookupPrState(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
): Promise<string | null> {
  if (prNumber <= 0) return null;
  try {
    const output = await deps.github.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    const parsed = JSON.parse(output) as { state?: string };
    return parsed.state ?? null;
  } catch (err) {
    deps.logger.warn("Recovery: PR state lookup errored (non-fatal)", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Run a git command and return its stdout, throwing on any failure.
 *
 * `deps.git.runGitCommand` reports a non-zero exit as `ok: true` with the exit
 * code in the value, so a caller that only checks `ok` would read a failed
 * `git diff` as empty output — a fault masked as success (Issue #3234). This
 * adapter converts both failure shapes into a throw, which is the contract
 * `collectSecurityFixDiff` uses to fall back to its next ref.
 */
async function runGitOrThrow(
  args: string[],
  repoPath: string,
  deps: WorkerDeps,
): Promise<string> {
  const result = await deps.git.runGitCommand(args, { cwd: repoPath });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (exit ${result.value.code}): ${result.value.stderr.trim()}`,
    );
  }
  return result.value.stdout;
}

/**
 * Recover an existing PR by updating its body and labels, then finalise (Issue #1189).
 *
 * Issue #1559: When the recovered PR is already merged, skip the redundant
 * "PR created" link comment and call `ensureIssueClosedIfPrMerged` so the
 * worker does not loop re-picking up an issue whose work is already shipped.
 *
 * Exported for unit testing — the primary entry point remains
 * `workOnIssueCompletion`.
 */
export async function recoverAndFinaliseExistingPr(
  prUrl: string,
  ctx: IssueContext,
  state: PhaseState,
  prBody: string,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, githubUser, milestoneTitle, issueLabels } = ctx;
  const logger = deps.logger;
  const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumMatch ? parseInt(prNumMatch[1]!, 10) : 0;
  // The run outcome names this PR at claim release (Issue #4325).
  state.prUrl = prUrl;
  state.prNumber = prNumber;

  // Update existing PR body with latest content
  await deps.pr.recoverExistingPr(repo, issueNumber, prUrl, prBody);

  // Update labels on existing PR (Issue #1189)
  if (issueLabels.length > 0 && prNumber > 0) {
    const labelResult = await deps.pr.updatePrLabels(
      repo,
      prNumber,
      issueLabels,
    );
    if (!labelResult.ok) {
      logger.warn("Failed to update PR labels (non-fatal)", {
        error: labelResult.error.message,
      });
    }
  }

  // Issue #1559: Check PR state up front so we can suppress the redundant
  // "PR created" link comment when the PR is already merged.
  const prState = await lookupPrState(repo, prNumber, deps);
  const prAlreadyMerged = prState === "MERGED";

  // Post-recovery finalisation (best-effort)
  try {
    // Skip the link comment when the PR is already merged — the issue is
    // about to be closed, so a "PR created" comment is pure noise.
    if (!prAlreadyMerged) {
      await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);
    }
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl);

    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    if (prNumber > 0) {
      const isMilestonePr = Boolean(milestoneTitle && state.milestoneBranch);
      await deps.pr.finalisePr({
        repo,
        prNumber,
        skipAutoMerge: isMilestonePr,
      });
    }
  } catch (err) {
    logger.warn("Post-recovery finalisation error (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Issue #1559: After finalisation, close the issue if the recovered PR
  // was merged. Best-effort — a failure here must not regress existing
  // recovery behaviour.
  if (prNumber > 0) {
    try {
      const closeResult = await ensureIssueClosedIfPrMerged(
        repo,
        issueNumber,
        prNumber,
        githubUser,
        { ghCommandFn: deps.github.runGhCommand, logger },
      );
      if (!closeResult.ok) {
        logger.warn(
          "Recovery: ensureIssueClosedIfPrMerged errored (non-fatal)",
          {
            repo,
            issueNumber,
            prNumber,
            error: closeResult.error.message,
          },
        );
      }
    } catch (err) {
      logger.warn("Recovery: ensureIssueClosedIfPrMerged threw (non-fatal)", {
        repo,
        issueNumber,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: "continue" };
}

/**
 * Push commits, create a PR, and finalise the issue.
 *
 * Handles push with recovery, PR body construction, duplicate PR
 * detection, auto-merge, reviewer requests, and issue linking.
 *
 * Issue #1550: Wraps the phase body in a bounded in-process retry for
 * infrastructure-category failures (notably `push_failure`). A transient
 * git-push blip no longer applies `failed-once` on the first occurrence —
 * the phase sleeps briefly and re-runs once before surfacing the failure.
 */
export async function workOnIssueCompletion(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  let result = await completionBody(ctx, state, deps);

  if (result.status === "failure") {
    const shouldRetry = await shouldRetryInfrastructureFailure(
      "completion",
      result.reason,
      state,
      deps.logger,
      { backoffMs: ctx.config.infraRetryBackoffMs },
    );
    if (shouldRetry) result = await completionBody(ctx, state, deps);
  }

  // Issue #3756 — a `work-on` issue is auto-closed by its merged PR, with no
  // worker attached at that moment, so PR-raise is the last point the worker
  // can report what the run cost. Post the issue's single cost/model stats
  // comment here, once the PR exists. Non-fatal and deduplicated: it never
  // affects the phase result.
  if (result.status !== "failure") {
    await postWorkOnRunStats(ctx, state, deps);
  }

  return result;
}

/**
 * Post the `work-on` run's cost/model stats comment on the issue (Issue #3756).
 *
 * Reports only the invocations the execute phase recorded on this run — the
 * comment body states that limit explicitly. Skipped entirely when Claude never
 * ran (nothing to report) or when the issue already carries a stats comment.
 */
async function postWorkOnRunStats(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<void> {
  const claudeResults = state.claudeRunStats ?? [];
  if (claudeResults.length === 0) return;

  const client = deps.github.createClient(deps.logger);
  await postIssueRunStatsComment({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    phase: WORK_ON_STATS_PHASE,
    claudeResults,
    getIssueComments: (repo, issueNumber) =>
      client.getIssueComments(repo, issueNumber),
    postComment: (repo, issueNumber, body) =>
      client.postComment(repo, issueNumber, body),
    logger: deps.logger,
  });
}

/** Single-attempt completion-phase body — see `workOnIssueCompletion`. */
async function completionBody(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, issueTitle, githubUser, config, milestoneTitle } =
    ctx;
  const logger = deps.logger;

  // Reconcile HEAD to the worker branch before anything is pushed (Issue
  // #4286). The agent may have committed on a branch of its own; every
  // step below assumes HEAD IS state.branchName, and each silently agreed
  // with the others while all being wrong until `gh pr create` met an
  // empty branch ("No commits between …", private-repo-22#565, three
  // attempts). Fast-forward when safe; refuse loudly when diverged.
  const reconcile = await deps.git.reconcileHeadToBranch(state.branchName, {
    cwd: state.repoPath,
  });
  if (!reconcile.ok) {
    return {
      status: "failure",
      reason:
        `Cannot push branch \`${state.branchName}\`: ${reconcile.error.message}`,
    };
  }
  if (reconcile.value.action === "fast-forwarded") {
    logger.warn(
      `The agent committed on '${reconcile.value.fromRef}' rather than the ` +
        `worker branch — fast-forwarded '${state.branchName}' to that work ` +
        `before pushing (Issue #4286)`,
    );
  }

  // Push branch
  const pushResult = await deps.git.pushUnpushedCommits(state.branchName, {
    cwd: state.repoPath,
  });
  if (!pushResult.ok) {
    // Attempt push rejection recovery (Issue #423)
    logger.warn("Push failed, attempting recovery");
    const recoveryResult = await deps.git.recoverFromPushRejection(
      state.branchName,
      {
        cwd: state.repoPath,
      },
    );
    if (!recoveryResult.ok) {
      return {
        status: "failure",
        // Issue #1550: include "Git push failed" so detectFailureCategory
        // classifies this as `push_failure` (infrastructure) and the infra
        // retry wrapper fires.
        reason:
          `Git push failed and recovery unsuccessful: ${recoveryResult.error.message}`,
      };
    }

    // Retry push after recovery
    const retryPush = await deps.git.pushUnpushedCommits(state.branchName, {
      cwd: state.repoPath,
    });
    if (!retryPush.ok) {
      return {
        status: "failure",
        reason: `Git push failed after recovery: ${retryPush.error.message}`,
      };
    }
  }

  // Pre-flight: branch must have at least one commit ahead of the PR base
  // before we attempt `gh pr create`. Without this guard, an empty branch
  // (zero commits ahead) reaches `gh pr create` and surfaces as the opaque
  // "GraphQL: No commits between <base> and <branch>" error — diagnosed in
  // production as Issue #1463 (pushUnpushedCommits side, fixed in #1592)
  // and again on private-repo-22#42 from another path. Bail out here with a
  // clear, diagnostic failure so the worker reports an actionable cause
  // instead of a misleading PR-creation error.
  // The single resolved base for this PR — used for the ahead-count guard, the
  // milestone footer (Issue #3911), and `gh pr create --base` below, so all
  // three can never disagree.
  const baseBranch = state.milestoneBranch ?? state.defaultBranch;
  // Issue #68: the ahead-count runs against a LOCAL ref, but a milestone base
  // is present in this clone only as `origin/<base>` — the clone was set up on
  // the issue branch from the remote milestone, so the bare name is an unknown
  // revision and `rev-list` failed on every milestone PR, taking the "could
  // not run" path silently each time. Resolve it (local → origin/<base>, with a
  // fetch only when the remote-tracking ref is absent). `baseBranch` (the bare
  // name) stays correct for the milestone footer and `gh pr create --base`,
  // which GitHub resolves server-side.
  const comparableBase = await resolveComparableBaseRef(
    deps.git.runGitCommand,
    baseBranch,
    { cwd: state.repoPath },
  );
  if (!comparableBase.ok) {
    // The guard genuinely cannot run — a base that resolves to nothing local,
    // remote, or fetchable. Louder than the per-PR warning (Issue #68): this
    // line is the diagnostic of record for the empty-branch PR failure it
    // exists to pre-empt, so it must not be routine noise.
    logger.error(
      "Ahead-of-base guard could not run — base ref unresolvable; " +
        "proceeding to PR creation without it",
      { baseBranch, error: comparableBase.error.message },
    );
  } else {
    // Count against the ref that will actually be pushed and named to
    // `gh pr create --head` — the worker branch — not HEAD (Issue #4286);
    // after the reconciliation above they agree, and this keeps the guard
    // honest if they ever do not.
    const aheadCountResult = await deps.git.runGitCommand(
      ["rev-list", "--count", `${comparableBase.value}..${state.branchName}`],
      { cwd: state.repoPath },
    );
    if (!aheadCountResult.ok || aheadCountResult.value.code !== 0) {
      // A guard that cannot run must say so (Issue #4286): the old code
      // parsed "" to NaN and proceeded silently.
      logger.warn(
        "Ahead-of-base guard could not run — proceeding to PR creation without it",
        {
          error: aheadCountResult.ok
            ? aheadCountResult.value.stderr.trim() ||
              `exit ${aheadCountResult.value.code}`
            : aheadCountResult.error.message,
        },
      );
    }
    if (aheadCountResult.ok && aheadCountResult.value.code === 0) {
      const aheadCount = parseInt(aheadCountResult.value.stdout.trim(), 10);
      if (Number.isFinite(aheadCount) && aheadCount === 0) {
        const statusResult = await deps.git.runGitCommand(
          ["status", "--porcelain"],
          { cwd: state.repoPath },
        );
        const uncommittedHint = statusResult.ok &&
            statusResult.value.stdout.trim().length > 0
          ? " — uncommitted changes are present in the working tree, so Claude likely modified files but did not commit them"
          : "";
        return {
          status: "failure",
          reason:
            `Branch \`${state.branchName}\` has no commits ahead of \`${baseBranch}\` — cannot create PR${uncommittedHint}`,
        };
      }
    }
  }

  // Build PR body before idempotency checks so recovery can update it (Issue #1189)
  const prTitle = `${issueTitle} (Issue #${issueNumber})`;
  let prBody: string;

  // Changed files feed the screenshot gate below and the branch-evidence
  // section (Issue #4355), so they are resolved before the body is built.
  let changedFiles: string[] = [];
  const diffResult = await deps.git.runGitCommand(
    ["diff", "--name-only", `${state.defaultBranch}...HEAD`],
    { cwd: state.repoPath },
  );
  if (diffResult.ok) {
    changedFiles = diffResult.value.stdout.trim().split("\n").filter((f) =>
      f.length > 0
    );
  } else {
    logger.warn("Could not determine changed files for screenshot validation");
  }

  const summaryResult = await loadPrSummary(state.repoPath, issueNumber);
  if (summaryResult.ok && summaryResult.value.content) {
    logger.info("Loaded PR summary file", {
      source: summaryResult.value.source,
    });
    prBody = summaryResult.value.content + "\n\n";
  } else {
    if (!summaryResult.ok) {
      logger.warn("Error reading PR summary file", {
        error: summaryResult.error.message,
      });
    } else {
      logger.warn("No PR summary file found, using minimal body");
    }
    prBody = `## Summary\n\nCloses #${issueNumber}.\n\n`;
  }

  // Screenshots the agent committed to docs/evidence/ but did not reference
  // in the summary (a WIP-resumed run keeps the earlier summary — Issue
  // #4355) are referenced here, so the evidence renders in the PR and the
  // gate below sees it. The relative paths go through the same repair and
  // raw-URL conversion as authored references.
  const branchEvidence = findBranchEvidenceImages(changedFiles);
  if (
    branchEvidence.length > 0 && findScreenshotReferences(prBody).length === 0
  ) {
    logger.info("Referencing branch evidence images not named in the summary", {
      images: branchEvidence,
    });
    prBody += formatBranchEvidenceSection(branchEvidence);
  }

  if (milestoneTitle && state.milestoneBranch) {
    prBody += buildMilestonePrSection({
      milestoneTitle,
      milestoneBranch: state.milestoneBranch,
      baseBranch,
    });
  }

  // Worker footer for multi-worker visibility (Issue #1190)
  prBody += buildWorkerFooter({
    workerName: config.workerName,
    githubUser,
    runId: getRunId(),
  });
  prBody += buildIdempotencyMarker(issueNumber);
  prBody = deps.pr.ensurePrReferencesIssue(prBody, issueNumber);

  // Issue #2985: Make evidence image links render in the PR description.
  //
  // GitHub does not resolve relative image paths in PR bodies, so an
  // `![alt](docs/evidence/foo.png)` reference renders as a broken image even
  // though the same markdown renders in a committed file. First repair any
  // broken relative path to a real on-disk file (soft gate, Issue #2230), then
  // rewrite in-repo evidence images to commit-pinned raw URLs. Both steps are
  // best-effort — warnings are logged but never block PR creation.
  const imageResolution = await resolveImagePaths(prBody, state.repoPath);
  prBody = imageResolution.body;
  for (const rewrite of imageResolution.rewrites) {
    logger.info("Repaired evidence image path", {
      from: rewrite.from,
      to: rewrite.to,
    });
  }
  for (const warning of imageResolution.warnings) {
    logger.warn("Could not resolve evidence image path", {
      path: warning.path,
      reason: warning.reason,
    });
  }

  const headShaResult = await deps.git.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: state.repoPath },
  );
  const headSha = headShaResult.ok ? headShaResult.value.stdout.trim() : "";
  if (headSha) {
    const conversion = await convertEvidenceImagesToRawUrls(prBody, {
      repoPath: state.repoPath,
      githubRepo: repo,
      commitSha: headSha,
    });
    prBody = conversion.content;
    for (const converted of conversion.conversions) {
      logger.info("Converted evidence image to raw URL", {
        from: converted.from,
        to: converted.to,
      });
    }
  } else {
    logger.warn(
      "Could not resolve HEAD SHA — evidence images left as relative paths",
    );
  }

  // Issue #1185: Screenshot validation before PR creation
  const skipScreenshot =
    getRepoConfig(config.repoConfig, repo, "skipScreenshotCheck") === "true";

  const screenshotResult = validateScreenshotEvidence({
    prSummaryContent: prBody,
    issueLabels: ctx.issueLabels.join(","),
    changedFiles,
    repo,
    issueNumber,
    skipScreenshotCheck: skipScreenshot,
  });

  const needsScreenshotLabel = LABEL_DEFAULTS.needsScreenshotLabel;
  if (!screenshotResult.valid) {
    logger.info("Screenshot validation failed — UI change without evidence");

    await deps.github.ensureLabelExists(
      repo,
      needsScreenshotLabel,
      "d93f0b",
      "Previous attempt was blocked for missing screenshot evidence",
    );

    const client = deps.github.createClient(logger);
    await client.addLabel(repo, issueNumber, needsScreenshotLabel);
    await client.postComment(
      repo,
      issueNumber,
      screenshotResult.failureMessage!,
    );

    return {
      status: "failure",
      reason: "Screenshot evidence missing for UI-related change",
    };
  }

  // Remove needs-screenshot label if validation passed and label was present
  if (
    screenshotResult.isUiChange &&
    ctx.issueLabels.includes(needsScreenshotLabel)
  ) {
    try {
      const client = deps.github.createClient(logger);
      await client.removeLabel(repo, issueNumber, needsScreenshotLabel);
    } catch {
      logger.warn("Failed to remove needs-screenshot label (non-fatal)");
    }
  }

  // ---------------------------------------------------------------------
  // Security-fix patch-verification gate (Issue #3540, hardened by #3652,
  // wired into this live phase by #3939).
  //
  // A PR that closes a `security`-labelled finding (or references a
  // `SEC-<hex>` finding id) must demonstrate that the fault is genuinely
  // closed. The decisive evidence is machine-checkable against the branch
  // diff — a test file is changed, and the test identifier the summary names
  // really appears in that diff — with the prose linkage kept as a secondary
  // human-review aid. Fail loud rather than mask a fault as success (Issue
  // #3234). Per-repo only (Issue #3239); opt out with the
  // `skip_security_fix_check` repo config.
  // ---------------------------------------------------------------------
  const issueLabels = ctx.issueLabels.join(",");
  const skipSecurityFixCheck =
    getRepoConfig(config.repoConfig, repo, "skipSecurityFixCheck") === "true";

  if (!skipSecurityFixCheck) {
    // Only pay for a diff when the gate is actually active.
    const gateActive = hasSecurityLabel(issueLabels) ||
      referencesFindingId(prBody);
    const securityDiff = gateActive
      ? await collectSecurityFixDiff(
        (gitArgs) => runGitOrThrow(gitArgs, state.repoPath, deps),
        baseBranch,
      )
      : null;
    if (gateActive && !securityDiff) {
      logger.warn("Could not collect branch diff for security-fix gate", {
        base: baseBranch,
      });
    }

    const securityGate = evaluateSecurityFixGate({
      prSummaryContent: prBody,
      issueLabels,
      diff: securityDiff,
    });
    // The verdict is carried in worker run state so the next attempt reads it
    // from a trusted channel (Issue #4057). The gate's issue comment cannot
    // serve: it is authored by the service account, which the retry's comment
    // trust filter classifies UNTRUSTED, so ten runs on #4030 started blind.
    const gateStateDir = resolveSecurityGateStateDir(config.workDir);

    if (securityGate.isSecurityFix && !securityGate.ok) {
      logger.warn("Security-fix verification gate blocked PR creation", {
        missing: securityGate.missing,
      });
      try {
        const block = await recordSecurityFixGateBlock(
          gateStateDir,
          repo,
          issueNumber,
          securityGate.missing,
        );
        logger.info("Recorded security-fix gate verdict for the next attempt", {
          blockCount: block.blockCount,
        });
      } catch (err) {
        // Loud, but not fatal: the PR is blocked either way. A silent drop
        // here is what let the loop repeat, so it must reach the log.
        logger.warn(
          `Could not persist the security-fix gate verdict — the next attempt will start blind: ${
            (err as Error).message
          }`,
        );
      }
      const failureMessage = buildSecurityFixGateMessage(securityGate.missing);
      try {
        const client = deps.github.createClient(logger);
        await client.postComment(repo, issueNumber, failureMessage);
      } catch {
        logger.warn("Failed to post security-fix gate comment (non-fatal)");
      }
      return { status: "failure", reason: failureMessage };
    }

    // Gate satisfied (or inactive) — drop any stale verdict so a later run on
    // this issue is not told to fix something it has already fixed.
    await clearSecurityFixGateBlock(gateStateDir, repo, issueNumber);
  }

  // Issue #869: Pre-check for existing PR by issue number
  const existingPrByIssue = await deps.pr.findExistingPrForIssue(
    repo,
    issueNumber,
  );
  if (existingPrByIssue.ok) {
    const existingPrUrl = existingPrByIssue.value;
    logger.info(
      "IDEMPOTENT: PR already exists for issue number, skipping creation",
      { prUrl: existingPrUrl },
    );
    return await recoverAndFinaliseExistingPr(
      existingPrUrl,
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // Issue #623: Pre-check for existing PR by branch name
  let existingPrByBranch = await deps.pr.findExistingPrForBranch(
    repo,
    state.branchName,
  );

  // Issue #872: Defence-in-depth — re-check by issue number
  if (!existingPrByBranch.ok) {
    const recheck = await deps.pr.findExistingPrForIssue(repo, issueNumber);
    if (recheck.ok) {
      existingPrByBranch = recheck;
    }
  }

  if (existingPrByBranch.ok) {
    const existingPrUrl = existingPrByBranch.value;
    logger.info("IDEMPOTENT: PR already exists for branch, skipping creation", {
      prUrl: existingPrUrl,
    });
    return await recoverAndFinaliseExistingPr(
      existingPrUrl,
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // Create PR via gh CLI
  const createPrArgs = [
    "pr",
    "create",
    "--title",
    prTitle,
    "--body",
    prBody,
    "--base",
    baseBranch,
    "--head",
    state.branchName,
    "--repo",
    repo,
  ];

  // Add reviewers if configured
  if (config.prReviewers.length > 0) {
    for (const reviewer of config.prReviewers) {
      createPrArgs.push("--reviewer", reviewer);
    }
  }

  let prUrl: string;
  try {
    const output = await deps.github.runGhCommand(createPrArgs);
    prUrl = output.trim();
    // Issue #3138: stamp the worker build on the PR-open line so a duplicate
    // PR can be traced back to the exact build that raised it.
    logger.info("PR created", {
      prUrl,
      build: formatBuildStamp(resolveWorkerBuildInfo()),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Self-healing: detect existing PR after creation failure (Issue #386, #1189)
    const existingPrFromError = await deps.pr.findExistingPrForIssue(
      repo,
      issueNumber,
    );
    if (existingPrFromError.ok) {
      logger.info("Found existing PR after creation error, recovering", {
        prUrl: existingPrFromError.value,
      });
      return await recoverAndFinaliseExistingPr(
        existingPrFromError.value,
        ctx,
        state,
        prBody,
        deps,
      );
    } else {
      return { status: "failure", reason: `PR creation failed: ${errorMsg}` };
    }
  }

  // Extract PR number from URL for API calls
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]!, 10) : 0;
  // The run outcome names this PR at claim release (Issue #4325).
  state.prUrl = prUrl;
  state.prNumber = prNumber;

  // Post-PR finalisation
  try {
    // Link PR to issue
    await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);

    // Close duplicate PRs
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl);

    // Retarget to milestone if applicable
    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    // Skip auto-merge for milestone PRs — they are larger and need manual review (Issue #1125)
    if (prNumber > 0) {
      const isMilestonePr = Boolean(milestoneTitle && state.milestoneBranch);
      await deps.pr.finalisePr({
        repo,
        prNumber,
        skipAutoMerge: isMilestonePr,
      });
    }

    // Issue #1613: Surface a rejected dependency bump on the PR thread
    // so reviewers can see what was attempted and why it was dropped.
    if (prNumber > 0 && state.bumpInfo) {
      const comment = buildBumpRejectionComment(state.bumpInfo);
      if (comment.length > 0) {
        try {
          const client = deps.github.createClient(logger);
          await client.postComment(repo, prNumber, comment);
        } catch (err) {
          logger.warn("Bump rejection comment failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    // Post-PR finalisation is best-effort
    logger.warn("Post-PR finalisation error (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Unassign the worker from the source issue once the PR exists (Issue
  // #1453). Like the security gate above, this only ever ran in the module the
  // bash→Deno migration orphaned, so `unassign_on_pr_created` had no effect in
  // production (Issue #3939). Best-effort — never fails the phase.
  if (config.unassignOnPrCreated) {
    await unassignAfterPrCreated(repo, issueNumber, githubUser, {
      ghCommandFn: deps.github.runGhCommand,
      logger,
    });
  }

  return { status: "continue" };
}
