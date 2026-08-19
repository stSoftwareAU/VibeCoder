/**
 * Vibe Coder Worker - Deno-based issue processing module.
 *
 * This module provides the main entry point for the Deno worker,
 * which can be invoked from the shell script to perform specific
 * operations.
 *
 * ## Usage
 *
 * The worker can be invoked with different commands:
 *
 * ```bash
 * # Get version information
 * deno run --allow-env mod.ts version
 *
 * # Assess issue clarity
 * deno run --allow-env mod.ts assess-clarity --title "Fix bug" --body "Description"
 *
 * # List available commands
 * deno run --allow-env mod.ts help
 * ```
 *
 * ## Extending the Worker
 *
 * New commands can be added by:
 * 1. Creating a new file in the commands/ directory
 * 2. Implementing the Command interface
 * 3. Registering the command in this module
 *
 * See commands/version.ts for a simple example.
 */

import { loadConfig, validateConfig } from "./lib/config.ts";
import { applyServiceAccountEnv } from "./lib/service_account_env.ts";
import { createLogger } from "./lib/logger.ts";
import { installConsoleRedaction } from "./lib/console_redaction.ts";
import { type CommandRegistry, createCommandRegistry } from "./lib/commands.ts";
import { buildDefaultWorkerConfig } from "./lib/config_defaults.ts";
import { setSuppressionAuthorAllowlist } from "./lib/suppression_comments.ts";
import {
  setPhaseEffortConfigOverrides,
  setPhaseModelConfigOverrides,
} from "./lib/claude_executor.ts";
import type { CommandResult, Logger, WorkerConfig } from "./types.ts";

// Import built-in commands
import { versionCommand } from "./commands/version.ts";
import { assessClarityCommand } from "./commands/assess_clarity.ts";
import { suggestImprovementsCommand } from "./commands/suggest_improvements.ts";
import { checkParentDepsCommand } from "./commands/check_parent_dependencies.ts";
import { checkRepoAvailabilityCommand } from "./commands/check_repo_availability.ts";
import { mergeIfChecksPassedCommand } from "./commands/merge_if_checks_passed.ts";
import { workerIdentityCommand } from "./commands/worker_identity.ts";
import { terminalTitleCommand } from "./commands/terminal_title.ts";
import { diskSpaceCommand } from "./commands/disk_space.ts";
import { cleanDenoCacheCommand } from "./commands/clean_deno_cache.ts";
import { logRotationCommand } from "./commands/log_rotation.ts";
import { workerLogCleanupCommand } from "./commands/worker_log_cleanup.ts";
import { pathBootstrapCommand } from "./commands/path_bootstrap.ts";
import { runIdCommand } from "./commands/run_id.ts";
import { securityCommand } from "./commands/security.ts";
import { runSecurityScanCommand } from "./commands/run_security_scan.ts";
import { collectSecurityBatchCommand } from "./commands/collect_security_batch.ts";
import { maybeFileIdleTaskCommand } from "./commands/maybe_file_idle_task.ts";
import { processAddRepoCommand } from "./commands/process_add_repo.ts";
import { processSeedIdleTasksCommand } from "./commands/process_seed_idle_tasks.ts";
import { resolveCrossRepoDepCommand } from "./commands/resolve_cross_repo_dep.ts";
import { backfillIdleTaskLabelsCommand } from "./commands/backfill_idle_task_labels.ts";
import { createAllIdleTaskWrappersCommand } from "./commands/create_all_idle_task_wrappers.ts";
import { idleTaskFreshnessCommand } from "./commands/idle_task_freshness.ts";
import { raiseBoyScoutIdleTasksCommand } from "./commands/raise_boy_scout_idle_tasks.ts";
import { raiseAllIdleTasksCommand } from "./commands/raise_all_idle_tasks.ts";
import { raiseSingleIdleTaskCommand } from "./commands/raise_single_idle_task.ts";
import { bulkTriageSecurityCommand } from "./commands/bulk_triage_security.ts";
import { pidGuardCommand } from "./commands/pid_guard.ts";
import { loadConfigCommand } from "./commands/load_config.ts";
import { ghAuthCommand } from "./commands/gh_auth.ts";
import { ghWrapperCommand } from "./commands/gh_wrapper.ts";
import { githubStatusCommand } from "./commands/github_status.ts";
import { featureAvailabilityCommand } from "./commands/feature_availability.ts";
import { circuitBreakerCommand } from "./commands/circuit_breaker.ts";
import { failureTrackerCommand } from "./commands/failure_tracker.ts";
import { cooldownStateCommand } from "./commands/cooldown_state.ts";
import { failureDiagnosisCommand } from "./commands/failure_diagnosis.ts";
import { repoFailureTrackerCommand } from "./commands/repo_failure_tracker.ts";
import { crashCleanupCommand } from "./commands/crash_cleanup.ts";
import { crashNotificationCommand } from "./commands/crash_notification.ts";
import { stuckIssueDetectorCommand } from "./commands/stuck_issue_detector.ts";
import { repoBlockedAlertCommand } from "./commands/repo_blocked_alert.ts";
import { claimIssueCommand } from "./commands/claim_issue.ts";
import { labelManagerCommand } from "./commands/label_manager.ts";
import { findIssuesCommand } from "./commands/find_issues.ts";
import { findIssuesByLabelCommand } from "./commands/find_issues_by_label.ts";
import { fetchIssueDataCommand } from "./commands/fetch_issue_data.ts";
import { fetchJenkinsLogCommand } from "./commands/fetch_jenkins_log.ts";
import { checkJenkinsAccessCommand } from "./commands/check_jenkins_access.ts";
import { healthCheckCacheCommand } from "./commands/health_check_cache.ts";
import { shuffleReposCommand } from "./commands/shuffle_repos.ts";
import { softwareUpdatesCommand } from "./commands/software_updates.ts";
import { atomicWriteCommand } from "./commands/atomic_write.ts";
import { cleanupStaleTempFilesCommand } from "./commands/cleanup_stale_temp_files.ts";
import { staleWorkDirCommand } from "./commands/stale_workdir.ts";
import { sessionSweepCommand } from "./commands/session_sweep.ts";
import { seatbeltProfileCommand } from "./commands/seatbelt_profile.ts";
import { denoCacheGuardCommand } from "./commands/deno_cache_guard.ts";
import { benchmarkCommand } from "./commands/benchmark.ts";
import { worktreeCleanupCommand } from "./commands/worktree_cleanup.ts";
import { claudeTailCleanupCommand } from "./commands/claude_tail_cleanup.ts";
import { gitOperationsCommand } from "./commands/git_operations.ts";
import { branchCleanupCommand } from "./commands/branch_cleanup.ts";
import { claudeAuthCommand } from "./commands/claude_auth.ts";
import { claudeRunnerCommand } from "./commands/claude_runner.ts";
import { answerSanitiserCommand } from "./commands/answer_sanitiser.ts";
import { partialAnswerCommand } from "./commands/partial_answer.ts";
import { promptBuilderCommand } from "./commands/prompt_builder.ts";
import { promptManagerCommand } from "./commands/prompt_manager.ts";
import { commentFilterCommand } from "./commands/comment_filter.ts";
import { questionClarificationCommand } from "./commands/question_clarification.ts";
import { mermaidValidatorCommand } from "./commands/mermaid_validator.ts";
import { prManagerCommand } from "./commands/pr_manager.ts";
import { qualityHelpersCommand } from "./commands/quality_helpers.ts";
import { runEntrypointCommand } from "./commands/run_entrypoint.ts";
import { runBootstrapCommand } from "./commands/run_bootstrap.ts";
import { runHousekeepingCommand } from "./commands/run_housekeeping.ts";
import { repoConfigCommand } from "./commands/repo_config.ts";
import { githubAppAuthCommand } from "./commands/github_app_auth.ts";
import { refinementProcessorCommand } from "./commands/refinement_processor.ts";
import { grillMeProcessorCommand } from "./commands/grill_me_processor.ts";
import { revisionProcessorCommand } from "./commands/revision_processor.ts";
import { planningProcessorCommand } from "./commands/planning_processor.ts";
import { questionProcessorCommand } from "./commands/question_processor.ts";
import { prFeedbackProcessorCommand } from "./commands/pr_feedback_processor.ts";
import { prSpellingProcessorCommand } from "./commands/pr_spelling_processor.ts";
import { prCiProcessorCommand } from "./commands/pr_ci_processor.ts";
import { prMaintenanceCommand } from "./commands/pr_maintenance.ts";
import { runCoreCommand } from "./commands/run_core.ts";
import { creditSummaryCommand } from "./commands/credit_summary.ts";
import { backlogReportCommand } from "./commands/backlog_report.ts";
import { greenGateReportCommand } from "./commands/green_gate_report.ts";
import { stripContainerfileCommand } from "./commands/strip_containerfile.ts";
import { repoSettingsHardenCommand } from "./commands/repo_settings_harden.ts";
import { auditLogTailCommand } from "./commands/audit_log_tail.ts";
import { auditChainVerifyCommand } from "./commands/audit_chain_verify.ts";
import { milestoneCompletionCommand } from "./commands/milestone_completion.ts";
import { milestoneHealthCommand } from "./commands/milestone_health.ts";
import { milestoneBranchSyncCommand } from "./commands/milestone_branch_sync.ts";
import { diagnoseCommand } from "./commands/diagnose.ts";
import { diagnoseIssueCommand } from "./commands/diagnose_issue.ts";
import { diagnoseRepoCommand } from "./commands/diagnose_repo.ts";
import { fleetHealthCommand } from "./commands/fleet_health.ts";
import { clarityPhaseCommand } from "./commands/clarity_phase.ts";
import { qualityGatePhaseCommand } from "./commands/quality_gate_phase.ts";
import { executeClaudePhaseCommand } from "./commands/execute_claude_phase.ts";
import { workOnIssueCommand } from "./commands/work_on_issue.ts";
import { staleWorkflowDetectorCommand } from "./commands/stale_workflow_detector.ts";
import { batchApiCommand } from "./commands/batch_api.ts";
import { selfHealSummaryCommand } from "./commands/self_heal_summary.ts";
import { analyseFailedOnceCommand } from "./commands/analyse_failed_once.ts";
import { auditHeartbeatRecoveriesCommand } from "./commands/audit_heartbeat_recoveries.ts";
import { checkPagesLiquidCommand } from "./commands/check_pages_liquid.ts";
import { checkMermaidCommand } from "./commands/check_mermaid.ts";
import { checkMarkdownlintCommand } from "./commands/check_markdownlint.ts";
import { notifyAuditFailureCommand } from "./commands/notify_audit_failure.ts";
import { purgeStaleWorkflowIssuesCommand } from "./commands/purge_stale_workflow_issues.ts";
import { sweepHeartbeatCommentsCommand } from "./commands/sweep_heartbeat_comments.ts";
import { containerImageHashCommand } from "./commands/container_image_hash.ts";
import { containerRuntimeDetectCommand } from "./commands/container_runtime_detect.ts";
import { containerLaunchPlanCommand } from "./commands/container_launch_plan.ts";
import { containerRestartBackoffCommand } from "./commands/container_restart_backoff.ts";
import { containerReapCommand } from "./commands/container_reap.ts";
import { containerImagePruneCommand } from "./commands/container_image_prune.ts";
import { runModeCommand } from "./commands/run_mode.ts";
import { auditDefaultBranchRulesetsCommand } from "./commands/audit_default_branch_rulesets.ts";
import { secretsHistoryScanCommand } from "./commands/secrets_history_scan.ts";
import { securityTabletopCommand } from "./commands/security_tabletop.ts";
import { publishDecisionCheckCommand } from "./commands/publish_decision_check.ts";
import { supplyChainGateCommand } from "./commands/supply_chain_gate.ts";
import { securityTreeSweepCommand } from "./commands/security_tree_sweep.ts";
import { exportBrandingCommand } from "./commands/export_branding.ts";
import { exportScrubGateCommand } from "./commands/export_scrub_gate.ts";
import { exportRedactCommand } from "./commands/export_redact.ts";
import { exportLinksCommand } from "./commands/export_links.ts";

// Re-export types and utilities for external use
export * from "./types.ts";
export { loadConfig, validateConfig } from "./lib/config.ts";
export {
  isRepoAllowed,
  validateConfigFull,
  validateGitUrl,
  validateLabelFormat,
  validateRepoFormat,
  validateUsernameFormat,
} from "./lib/config_validator.ts";
export { createLogger, type LoggerOptions } from "./lib/logger.ts";
export { type CommandRegistry, createCommandRegistry } from "./lib/commands.ts";
export { createGitHubClient } from "./lib/github.ts";
export {
  buildQualityInstructions,
  buildReviewerFlags,
  buildReviewerFlagsForRepo,
  getCustomInstructions,
  getRepoConfig,
  runPreSetupCommand,
} from "./lib/repo_config.ts";
export {
  calculateJitter,
  clearDefaultBranchMemoryCache,
  getRepoDefaultBranch,
  invalidateDefaultBranch,
  sleepWithJitter,
} from "./lib/shell_helpers.ts";
export {
  DEFAULT_BRANCH_CACHE_TTL_MS,
  defaultBranchCachePath,
  getCachedDefaultBranch,
  invalidateCachedDefaultBranch,
  loadDefaultBranchCache,
  saveDefaultBranchCache,
  setCachedDefaultBranch,
} from "./lib/default_branch_cache.ts";

/**
 * Create and initialise the command registry with built-in commands.
 *
 * @returns Initialised command registry
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = createCommandRegistry();

  // Register built-in commands
  registry.register(versionCommand);
  registry.register(assessClarityCommand);
  registry.register(suggestImprovementsCommand);
  registry.register(checkParentDepsCommand);
  registry.register(checkRepoAvailabilityCommand);
  registry.register(mergeIfChecksPassedCommand);
  registry.register(workerIdentityCommand);
  registry.register(runIdCommand);
  registry.register(terminalTitleCommand);
  registry.register(diskSpaceCommand);
  registry.register(cleanDenoCacheCommand);
  registry.register(logRotationCommand);
  registry.register(workerLogCleanupCommand);
  registry.register(pathBootstrapCommand);
  registry.register(securityCommand);
  registry.register(runSecurityScanCommand);
  registry.register(collectSecurityBatchCommand);
  registry.register(maybeFileIdleTaskCommand);
  registry.register(processAddRepoCommand);
  registry.register(processSeedIdleTasksCommand);
  registry.register(resolveCrossRepoDepCommand);
  registry.register(backfillIdleTaskLabelsCommand);
  registry.register(createAllIdleTaskWrappersCommand);
  registry.register(idleTaskFreshnessCommand);
  registry.register(raiseBoyScoutIdleTasksCommand);
  registry.register(raiseAllIdleTasksCommand);
  registry.register(raiseSingleIdleTaskCommand);
  registry.register(bulkTriageSecurityCommand);
  registry.register(pidGuardCommand);
  registry.register(loadConfigCommand);
  registry.register(ghAuthCommand);
  registry.register(ghWrapperCommand);
  registry.register(githubStatusCommand);
  registry.register(featureAvailabilityCommand);
  registry.register(circuitBreakerCommand);
  registry.register(failureTrackerCommand);
  registry.register(cooldownStateCommand);
  registry.register(failureDiagnosisCommand);
  registry.register(repoFailureTrackerCommand);
  registry.register(crashCleanupCommand);
  registry.register(crashNotificationCommand);
  registry.register(stuckIssueDetectorCommand);
  registry.register(repoBlockedAlertCommand);
  registry.register(claimIssueCommand);
  registry.register(labelManagerCommand);
  registry.register(findIssuesCommand);
  registry.register(findIssuesByLabelCommand);
  registry.register(fetchIssueDataCommand);
  registry.register(fetchJenkinsLogCommand);
  registry.register(checkJenkinsAccessCommand);
  registry.register(healthCheckCacheCommand);
  registry.register(shuffleReposCommand);
  registry.register(softwareUpdatesCommand);
  registry.register(atomicWriteCommand);
  registry.register(cleanupStaleTempFilesCommand);
  registry.register(staleWorkDirCommand);
  registry.register(sessionSweepCommand);
  registry.register(seatbeltProfileCommand);
  registry.register(denoCacheGuardCommand);
  registry.register(benchmarkCommand);
  registry.register(worktreeCleanupCommand);
  registry.register(claudeTailCleanupCommand);
  registry.register(gitOperationsCommand);
  registry.register(branchCleanupCommand);
  registry.register(claudeAuthCommand);
  registry.register(claudeRunnerCommand);
  registry.register(answerSanitiserCommand);
  registry.register(partialAnswerCommand);
  registry.register(promptBuilderCommand);
  registry.register(promptManagerCommand);
  registry.register(commentFilterCommand);
  registry.register(questionClarificationCommand);
  registry.register(mermaidValidatorCommand);
  registry.register(prManagerCommand);
  registry.register(qualityHelpersCommand);
  registry.register(runEntrypointCommand);
  registry.register(runBootstrapCommand);
  registry.register(runHousekeepingCommand);
  registry.register(repoConfigCommand);
  registry.register(githubAppAuthCommand);
  registry.register(refinementProcessorCommand);
  registry.register(grillMeProcessorCommand);
  registry.register(revisionProcessorCommand);
  registry.register(planningProcessorCommand);
  registry.register(questionProcessorCommand);
  registry.register(prFeedbackProcessorCommand);
  registry.register(prSpellingProcessorCommand);
  registry.register(prCiProcessorCommand);
  registry.register(prMaintenanceCommand);
  registry.register(runCoreCommand);
  registry.register(creditSummaryCommand);
  registry.register(backlogReportCommand);
  registry.register(greenGateReportCommand);
  registry.register(stripContainerfileCommand);
  registry.register(repoSettingsHardenCommand);
  registry.register(auditLogTailCommand);
  registry.register(auditChainVerifyCommand);
  registry.register(milestoneCompletionCommand);
  registry.register(milestoneHealthCommand);
  registry.register(milestoneBranchSyncCommand);
  registry.register(diagnoseCommand);
  registry.register(diagnoseIssueCommand);
  registry.register(diagnoseRepoCommand);
  registry.register(fleetHealthCommand);
  registry.register(clarityPhaseCommand);
  registry.register(qualityGatePhaseCommand);
  registry.register(executeClaudePhaseCommand);
  registry.register(workOnIssueCommand);
  registry.register(staleWorkflowDetectorCommand);
  registry.register(batchApiCommand);
  registry.register(selfHealSummaryCommand);
  registry.register(analyseFailedOnceCommand);
  registry.register(auditHeartbeatRecoveriesCommand);
  registry.register(checkPagesLiquidCommand);
  registry.register(checkMermaidCommand);
  registry.register(notifyAuditFailureCommand);
  registry.register(checkMarkdownlintCommand);
  registry.register(purgeStaleWorkflowIssuesCommand);
  registry.register(sweepHeartbeatCommentsCommand);
  registry.register(containerImageHashCommand);
  registry.register(containerRuntimeDetectCommand);
  registry.register(containerLaunchPlanCommand);
  registry.register(containerRestartBackoffCommand);
  registry.register(containerReapCommand);
  registry.register(containerImagePruneCommand);
  registry.register(runModeCommand);
  registry.register(auditDefaultBranchRulesetsCommand);
  registry.register(secretsHistoryScanCommand);
  registry.register(securityTabletopCommand);
  registry.register(publishDecisionCheckCommand);
  registry.register(supplyChainGateCommand);
  registry.register(securityTreeSweepCommand);
  registry.register(exportBrandingCommand);
  registry.register(exportScrubGateCommand);
  registry.register(exportRedactCommand);
  registry.register(exportLinksCommand);

  return registry;
}

/**
 * Parse command-line arguments into a structured format.
 *
 * @param args - Raw command-line arguments
 * @returns Parsed command name and arguments
 */
export function parseArgs(
  args: string[],
): { command: string; args: Record<string, unknown> } {
  if (args.length === 0) {
    return { command: "help", args: {} };
  }

  const command = args[0]!;
  const parsedArgs: Record<string, unknown> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      // Check if next arg is a value or another flag
      // Use explicit undefined check — empty string "" is a valid value
      if (nextArg !== undefined && !nextArg.startsWith("--")) {
        // Try to parse as JSON for complex values
        try {
          parsedArgs[key] = JSON.parse(nextArg);
        } catch {
          parsedArgs[key] = nextArg;
        }
        i++; // Skip the value
      } else {
        // Flag without value = true
        parsedArgs[key] = true;
      }
    }
  }

  return { command, args: parsedArgs };
}

/**
 * Display help information about available commands.
 *
 * @param registry - Command registry
 * @param logger - Logger instance
 */
function showHelp(registry: CommandRegistry, logger: Logger): void {
  logger.info("Vibe Coder Worker - Available Commands:\n");

  const commands = registry.listWithDescriptions();

  if (commands.length === 0) {
    logger.info("  No commands registered.");
    return;
  }

  for (const { name, description } of commands) {
    logger.info(`  ${name.padEnd(20)} ${description}`);
  }

  logger.info(
    "\nUsage: deno run --allow-env --allow-run --allow-read mod.ts <command> [options]",
  );
  logger.info("\nExamples:");
  logger.info("  deno run mod.ts version");
  logger.info(
    '  deno run mod.ts assess-clarity --title "Fix bug" --body "Description"',
  );
}

/**
 * Main entry point for the Deno worker.
 *
 * @param args - Command-line arguments (defaults to Deno.args)
 */
export async function main(args: string[] = Deno.args): Promise<void> {
  // Issue #3661 (SEC-f684a9d954ff): make secret masking structural. The logger
  // redacts its own sink, but ~97 direct console.* calls in worker/deno/lib/
  // write to the same stderr (captured to worker-*.log) — several of them
  // interpolating raw subprocess error text. Patch the console once, here, so
  // every worker command inherits the guarantee.
  installConsoleRedaction();

  const logger = createLogger({
    debug: Deno.env.get("DEBUG") === "true",
  });

  const registry = createDefaultRegistry();
  const { command, args: parsedArgs } = parseArgs(args);

  // Handle help command specially
  if (command === "help" || command === "--help" || command === "-h") {
    showHelp(registry, logger);
    return;
  }

  // Load configuration
  const configPath = Deno.env.get("CONFIG_PATH") ?? ".config.json";
  let config: WorkerConfig;

  try {
    config = await loadConfig(configPath);
    // Apply the service-account auth env (GH_CONFIG_DIR / GIT_SSH_COMMAND)
    // before any command issues a gh/git call — the pure-Deno driver has no
    // bash `eval "$(load-config)"` step to do it (Issue #3530).
    applyServiceAccountEnv(config);
    // Apply phase model config overrides (Issue #1265)
    setPhaseModelConfigOverrides(config.phaseModelOverrides);
    // Apply phase effort config overrides (Issue #1403)
    setPhaseEffortConfigOverrides(config.phaseEffortOverrides);
    // Wire the suppression author allowlist from the trusted-author list —
    // unconfigured, the suppression gate fails closed (Issue #3941).
    setSuppressionAuthorAllowlist(config.allowedAuthors ?? []);
    // Only validate config for commands that need it
    const configOptionalCommands = [
      "version",
      "help",
      "suggest-improvements",
      "check-repo-availability",
      "maybe-file-idle-task",
      "create-all-idle-task-wrappers",
      "bulk-triage-security",
      "merge-if-checks-passed",
      "worker-identity",
      "terminal-title",
      "disk-space",
      "clean-deno-cache",
      "log-rotation",
      "worker-log-cleanup",
      "path-bootstrap",
      "pid-guard",
      "load-config",
      "gh-auth",
      "gh-wrapper",
      "github-status",
      "feature-availability",
      "circuit-breaker",
      "failure-tracker",
      "cooldown-state",
      "failure-diagnosis",
      "repo-failure-tracker",
      "crash-cleanup",
      "crash-notification",
      "stuck-issue-detector",
      "repo-blocked-alert",
      "claim-issue",
      "label-manager",
      "find-issues",
      "find-issues-by-label",
      "fetch-issue-data",
      "health-check-cache",
      "shuffle-repos",
      "software-updates",
      "atomic-write",
      "cleanup-stale-temp-files",
      "worktree-cleanup",
      "claude-tail-cleanup",
      "git-operations",
      "branch-cleanup",
      "claude-auth",
      "claude-runner",
      "answer-sanitiser",
      "partial-answer",
      "prompt-builder",
      "prompt-manager",
      "comment-filter",
      "question-clarification",
      "mermaid-validator",
      "pr-manager",
      "quality-helpers",
      "run-entrypoint",
      "run-bootstrap",
      "revision-processor",
      "run-core",
      "fleet-health",
      "milestone-health",
      "sync-milestone-branches",
      "analyse-failed-once",
      "check-pages-liquid",
      "check-mermaid",
      "check-markdownlint",
      "notify-audit-failure",
      "diagnose",
      "backlog-report",
      "green-gate-report",
      "strip-containerfile",
      "repo-settings-harden",
      // Launchers call these before any config exists (Issues #4062, #4065).
      "container-image-hash",
      "container-launch-plan",
      // The host supervisor calls this between launcher runs (Issue #4072).
      "container-restart-backoff",
      // The launchers call this to reap a wedged container (Issue #4173).
      "container-reap",
      // The launchers call this to prune superseded image tags (Issue #4162).
      "container-image-prune",
      // The launchers ask this which mode to run in (Issue #4146).
      "run-mode",
      "seatbelt-profile",
      // Read-only sweep; runs against --org/--repos with no config (Issue #4356).
      "audit-default-branch-rulesets",
      // Full-history secrets sweep; runs in CI with no config (Issue #4190).
      "secrets-history-scan",
      // Hostile-fixture tabletop; runs on a schedule with no config (#4194).
      "security-tabletop",
      // Dossier checker; a pure file check with no config (Issue #4200).
      "publish-decision-check",
      // Supply-chain gate; runs in CI over the tree with no config (#4192).
      "supply-chain-gate",
      // Whole-tree security sweep; runs in CI with no config (Issue #4193).
      "security-tree-sweep",
      // Export pipeline stages; run over a staging tree with no config
      // (Issues #4196, #4197).
      "export-branding",
      "export-redact",
      "export-links",
      "export-scrub-gate",
    ];
    if (!configOptionalCommands.includes(command)) {
      validateConfig(config);
    }
  } catch (error) {
    // For simple commands, use minimal config (Issue #140: defaultBranch removed)
    const configOptionalCommands = [
      "version",
      "suggest-improvements",
      "check-repo-availability",
      "maybe-file-idle-task",
      "create-all-idle-task-wrappers",
      "bulk-triage-security",
      "merge-if-checks-passed",
      "worker-identity",
      "terminal-title",
      "disk-space",
      "clean-deno-cache",
      "log-rotation",
      "worker-log-cleanup",
      "path-bootstrap",
      "load-config",
      "gh-auth",
      "gh-wrapper",
      "github-status",
      "feature-availability",
      "circuit-breaker",
      "failure-tracker",
      "cooldown-state",
      "claim-issue",
      "label-manager",
      "find-issues",
      "find-issues-by-label",
      "fetch-issue-data",
      "health-check-cache",
      "shuffle-repos",
      "software-updates",
      "atomic-write",
      "cleanup-stale-temp-files",
      "worktree-cleanup",
      "claude-tail-cleanup",
      "git-operations",
      "branch-cleanup",
      "claude-auth",
      "claude-runner",
      "answer-sanitiser",
      "partial-answer",
      "prompt-builder",
      "prompt-manager",
      "comment-filter",
      "question-clarification",
      "mermaid-validator",
      "pr-manager",
      "quality-helpers",
      "run-entrypoint",
      "run-bootstrap",
      "revision-processor",
      "run-core",
      "fleet-health",
      "milestone-health",
      "sync-milestone-branches",
      "analyse-failed-once",
      "check-pages-liquid",
      "check-mermaid",
      "check-markdownlint",
      "notify-audit-failure",
      "diagnose",
      "backlog-report",
      "green-gate-report",
      "strip-containerfile",
      "repo-settings-harden",
      // Launchers call these before any config exists (Issues #4062, #4065).
      "container-image-hash",
      "container-launch-plan",
      // The host supervisor calls this between launcher runs (Issue #4072).
      "container-restart-backoff",
      // The launchers call this to reap a wedged container (Issue #4173).
      "container-reap",
      // The launchers call this to prune superseded image tags (Issue #4162).
      "container-image-prune",
      // The launchers ask this which mode to run in (Issue #4146).
      "run-mode",
      "seatbelt-profile",
      // Read-only sweep; runs against --org/--repos with no config (Issue #4356).
      "audit-default-branch-rulesets",
      // Hostile-fixture tabletop; runs on a schedule with no config (#4194).
      "security-tabletop",
      // Dossier checker; a pure file check with no config (Issue #4200).
      "publish-decision-check",
      // Supply-chain gate; runs in CI over the tree with no config (#4192).
      "supply-chain-gate",
      // Whole-tree security sweep; runs in CI with no config (Issue #4193).
      "security-tree-sweep",
      // Export pipeline stages; run over a staging tree with no config
      // (Issues #4196, #4197).
      "export-branding",
      "export-redact",
      "export-links",
      "export-scrub-gate",
    ];
    if (configOptionalCommands.includes(command)) {
      config = buildDefaultWorkerConfig();
    } else {
      logger.error(`Configuration error: ${(error as Error).message}`);
      Deno.exit(1);
    }
  }

  // Execute the command
  if (!registry.has(command)) {
    logger.error(`Unknown command: ${command}`);
    logger.info('Run with "help" to see available commands.');
    Deno.exit(1);
  }

  // Issue #223: registry.execute() returns Result instead of throwing
  const result = await registry.execute(command, parsedArgs, config);
  if (!result.ok) {
    logger.error(`Command failed: ${result.error.message}`);
    Deno.exit(1);
  }

  outputResult(result.value, logger);
}

/**
 * Output command result to stdout.
 *
 * @param result - Command execution result
 * @param logger - Logger instance
 */
function outputResult(result: CommandResult, _logger: Logger): void {
  // For simple results, just output the message
  console.log(result.message);

  // If there's additional data, output as JSON for machine parsing
  if (result.data && Deno.env.get("OUTPUT_JSON") === "true") {
    console.log(JSON.stringify(result.data, null, 2));
  }

  if (!result.success) {
    Deno.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  await main();
}
