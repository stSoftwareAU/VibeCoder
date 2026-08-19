#!/usr/bin/env -S deno run --allow-all

/**
 * CLI entry point for VibeCoder setup.
 *
 * Replaces the orchestration previously done by setup.sh shell modules.
 * Each subcommand corresponds to a former shell script in setup/.
 *
 * Usage:
 *   deno run --allow-all worker/deno/setup/setup_cli.ts <subcommand> [options]
 *
 * Subcommands:
 *   prerequisites      Check all prerequisites
 *   config             Write config from VIBE_* env vars
 *   launchagent        Setup macOS LaunchAgent
 *   scheduled-task     Register the Windows Task Scheduler entry
 *   screenshot         Setup Playwright MCP for screenshots
 *   label-sync         Synchronise labels across repos
 *   workflow-sync      Audit workflows and raise issues for missing protections
 *   best-practices-sync  Audit workflows for best-practice findings and file follow-ups
 *   best-practices-relabel  Backfill severity + category labels on existing best-practice issues
 *   gitignore-sync     Apply canonical .gitignore + .gitattributes safety blocks to monitored repos
 *   verify-monitored-collaborator  Precheck worker collaborator access on every repo
 *   branch-protection-sync  Apply the default-branch ruleset to every monitored repo
 *   hooks              Install pre-commit hook and git exclude patterns
 *   all                Run full setup (default)
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import {
  type AllPrerequisitesResult,
  checkAllPrerequisites,
  type PrerequisiteOptions,
} from "./prerequisites.ts";
import { offerMissingPrerequisites } from "./prerequisite_installer.ts";
import {
  CONTAINER_RUNTIME_TOOL,
  repairContainerRuntime,
} from "./container_runtime_install.ts";
import {
  installPreCommitHook,
  removePrePushHook,
  runConfigSetup,
  updateGitInfoExclude,
} from "./config_writer.ts";
import { setupLaunchAgent } from "./launchagent.ts";
import { setupScheduledTask } from "./scheduled_task.ts";
import { setupPlaywrightMcp } from "./screenshot.ts";
import { syncLabelsForAllRepos } from "./label_sync.ts";
import { syncWorkflowsForAllRepos } from "./workflow_sync.ts";
import { syncBestPracticesForAllRepos } from "./best_practices_sync.ts";
import { relabelBestPracticesForAllRepos } from "./best_practices_relabel.ts";
import { syncGitignoreForAllRepos } from "./gitignore_sync.ts";
import { verifyMonitoredCollaborators } from "./collaborator_precheck.ts";
import { syncBranchProtectionForAllRepos } from "./branch_protection_sync.ts";
import {
  backfillIdleTaskLabels,
  formatBackfillEvent,
  formatBackfillSummary,
} from "../lib/idle_task_backfill.ts";
import { loadExistingConfig } from "./config_setup.ts";
import { resolveRunMode, type RunMode } from "../lib/run_mode.ts";
import { readConfiguredRunMode } from "../commands/run_mode.ts";

// ── Colour helpers ──────────────────────────────────────────────────────

const isTty = Deno.stdout.isTerminal();
const RED = isTty ? "\x1b[0;31m" : "";
const GREEN = isTty ? "\x1b[0;32m" : "";
const YELLOW = isTty ? "\x1b[1;33m" : "";
const BLUE = isTty ? "\x1b[0;34m" : "";
const NC = isTty ? "\x1b[0m" : "";

function printInfo(msg: string): void {
  console.log(`${BLUE}ℹ${NC}  ${msg}`);
}

function printSuccess(msg: string): void {
  console.log(`${GREEN}✓${NC}  ${msg}`);
}

function printWarning(msg: string): void {
  console.log(`${YELLOW}⚠${NC}  ${msg}`);
}

function printError(msg: string): void {
  console.error(`${RED}✗${NC}  ${msg}`);
}

// ── Subcommand handlers ─────────────────────────────────────────────────

/** Injection points for {@link repairMacOsContainerRuntime} (testing). */
export interface ContainerRepairDeps {
  /** The repair flow. Defaults to the real macOS one. */
  repair?: typeof repairContainerRuntime;
  /** Full re-probe run after a successful repair. */
  recheckAll?: typeof checkAllPrerequisites;
}

/**
 * Offer the macOS container-runtime install before the per-tool offers run
 * (Issue #4136).
 *
 * A report whose runtime already passes — and every non-macOS host, where the
 * runtime is offered inside the driver instead (Issue #4137) — comes back
 * untouched. When the runtime *was* repaired the whole probe is re-run rather than
 * patched: the worker-image check never ran while no runtime answered, so
 * patching would leave a half-checked report (Issue #3234).
 *
 * @param probe - The report `checkAllPrerequisites` just produced
 * @param probeOptions - The options that produced it, reused for the re-run
 * @param deps - Repair and re-probe overrides (testing)
 * @returns The report to carry forward
 */
export async function repairMacOsContainerRuntime(
  probe: AllPrerequisitesResult,
  probeOptions: PrerequisiteOptions,
  deps: ContainerRepairDeps = {},
): Promise<AllPrerequisitesResult> {
  const runtimeFailed = probe.results.some((r) =>
    r.tool === CONTAINER_RUNTIME_TOOL && !r.ok
  );
  if (!runtimeFailed) return probe;

  const repair = deps.repair ?? repairContainerRuntime;
  const recheckAll = deps.recheckAll ?? checkAllPrerequisites;

  const repaired = await repair(probe, { log: printInfo });
  const runtimeOk = repaired.results.some((r) =>
    r.tool === CONTAINER_RUNTIME_TOOL && r.ok
  );
  return runtimeOk ? await recheckAll(probeOptions) : repaired;
}

/**
 * The closing lines of the prerequisite report (Issue #4149).
 *
 * Every line names the run mode the probe classified for — container, the
 * only one (Issue #4) — so the report is explicit about what it demanded.
 *
 * @param ok - Whether the probe passed
 * @param runMode - The mode the probe ran for
 * @returns The headline first, then any follow-up detail lines
 */
export function prerequisiteSummaryLines(
  ok: boolean,
  runMode: RunMode,
): string[] {
  if (ok) {
    return [`All host prerequisites satisfied (run mode: ${runMode})`];
  }
  const needs =
    "Container mode needs git, an authenticated gh, deno, the claude CLI " +
    "(setup mints the worker's OAuth token with it) and a working " +
    "container runtime on the host; the image provides jq and timeout.";
  return [
    `Some host prerequisites are missing or not configured ` +
    `(run mode: ${runMode}).`,
    needs,
    "VIBE_SKIP_PREREQ_CHECK=true skips the whole probe (CI only — it hides " +
    "real gaps).",
  ];
}

async function runPrerequisites(
  scriptDir: string,
  configPath: string,
): Promise<boolean> {
  const skipPrereq = Deno.env.get("VIBE_SKIP_PREREQ_CHECK") === "true";
  const skipAuth = Deno.env.get("VIBE_SKIP_AUTH_CHECK") === "true";

  // The mode decides which tools are host-fatal (Issue #4149). A configured
  // value that is not a mode throws rather than falling back to the default —
  // a host must never be probed for a mode it did not ask for (Issue #3234).
  let runMode: RunMode;
  try {
    runMode = resolveRunMode({
      configured: await readConfiguredRunMode(configPath),
    });
  } catch (error) {
    printError((error as Error).message);
    return false;
  }

  // Load gh_config_dir from existing config so the auth check uses the right identity
  let ghConfigDir: string | undefined;
  try {
    const config = await loadExistingConfig(configPath);
    if (config.gh_config_dir) {
      ghConfigDir = config.gh_config_dir.replace(
        /^~/,
        Deno.env.get("HOME") ?? "~",
      );
    }
  } catch {
    // Config may not exist yet on first setup — that's fine
  }

  const probeOptions: PrerequisiteOptions = {
    skipPrereqCheck: skipPrereq,
    skipAuthCheck: skipAuth,
    ghConfigDir,
    repoRoot: scriptDir,
    runMode,
  };
  const probe = await repairMacOsContainerRuntime(
    await checkAllPrerequisites(probeOptions),
    probeOptions,
  );

  // Interactive hosts are offered the installs, one prompt per tool
  // (Issue #4135). With no TTY — or VIBE_NO_AUTO_INSTALL=true — the offer is
  // suppressed and the report below is byte-for-byte today's.
  const result = await offerMissingPrerequisites(probe, {
    probeOptions: { ...probeOptions, skipPrereqCheck: false },
    reporter: {
      info: printInfo,
      success: printSuccess,
      error: printError,
    },
  });

  for (const r of result.results) {
    if (r.ok) {
      printSuccess(r.message);
    } else if (r.informational) {
      // A tool this run mode does not need on the host — never fatal.
      printInfo(r.message);
      if (r.hint) printInfo(r.hint);
    } else {
      printError(r.message);
      if (r.hint) printInfo(r.hint);
    }
  }

  const [headline, ...detail] = prerequisiteSummaryLines(result.ok, runMode);
  if (result.ok) printSuccess(headline!);
  else printError(headline!);
  for (const line of detail) printInfo(line);

  return result.ok;
}

async function runConfig(configPath: string): Promise<boolean> {
  const result = await runConfigSetup(configPath);
  if (result.ok) {
    printSuccess(result.message);
  } else {
    printError(result.message);
  }
  // Issue #4033: a prune must never be silent.
  for (const warning of result.warnings ?? []) {
    printWarning(warning);
  }
  return result.ok;
}

async function runHooks(scriptDir: string): Promise<boolean> {
  const hookResult = await installPreCommitHook(scriptDir);
  if (hookResult.ok) printSuccess(hookResult.message);
  else printError(hookResult.message);

  const pushResult = await removePrePushHook(scriptDir);
  if (pushResult.ok) printInfo(pushResult.message);

  const excludeResult = await updateGitInfoExclude(scriptDir);
  if (excludeResult.ok) printSuccess(excludeResult.message);

  return hookResult.ok;
}

async function runLaunchAgentSetup(scriptDir: string): Promise<boolean> {
  const config = {
    scriptDir,
    logsDir: Deno.env.get("VIBE_LOGS_DIR"),
    launchAgentDir: Deno.env.get("VIBE_LAUNCHAGENT_DIR"),
    ghToken: Deno.env.get("VIBE_LAUNCHAGENT_GH_TOKEN"),
    anthropicApiKey: Deno.env.get("VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY"),
    fallbackPaths: Deno.env.get("VIBE_LAUNCHAGENT_FALLBACK_PATHS"),
    skipLaunchctl: Deno.env.get("VIBE_SKIP_LAUNCHCTL") === "true",
  };

  printInfo("Setting up macOS LaunchAgent...");
  const result = await setupLaunchAgent(config);
  if (result.ok) {
    printSuccess(result.message);
  } else {
    printError(result.message);
  }
  return result.ok;
}

/**
 * Register the Windows scheduled task — the LaunchAgent's twin (Issue #4185).
 *
 * `--powershell` lets setup.ps1 name the PowerShell host it is itself running
 * under, so the task runs the same one rather than a guess.
 */
async function runScheduledTaskSetup(
  scriptDir: string,
  powershell: string,
): Promise<boolean> {
  printInfo("Registering the Windows scheduled task...");
  const result = await setupScheduledTask({
    scriptDir,
    ...(powershell ? { powershell } : {}),
    ...(Deno.env.get("VIBE_TASK_USER")
      ? { userId: Deno.env.get("VIBE_TASK_USER")! }
      : {}),
    ...(Deno.env.get("VIBE_TASK_XML_PATH")
      ? { taskXmlPath: Deno.env.get("VIBE_TASK_XML_PATH")! }
      : {}),
    skipSchtasks: Deno.env.get("VIBE_SKIP_SCHTASKS") === "true",
  });
  if (result.ok) {
    printSuccess(result.message);
  } else {
    printError(result.message);
  }
  return result.ok;
}

async function runScreenshotSetup(scriptDir: string): Promise<boolean> {
  printInfo("Setting up Playwright MCP for screenshot support...");
  const config = {
    scriptDir,
    mcpConfigDir: Deno.env.get("VIBE_MCP_CONFIG_DIR"),
    screenshotDir: Deno.env.get("VIBE_SCREENSHOT_DIR"),
    skipInstall: Deno.env.get("VIBE_SKIP_SCREENSHOT_INSTALL") === "true",
  };

  const result = await setupPlaywrightMcp(config);
  if (result.ok) {
    printSuccess(result.message);
  } else {
    printWarning(result.message);
  }
  return result.ok;
}

async function runLabelSync(configPath: string): Promise<boolean> {
  printInfo("Synchronising labels across monitored repositories...");

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping label sync");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;
    const results = await syncLabelsForAllRepos(repos, { ghConfigDir });
    let anyFailure = false;
    for (const r of results) {
      if (r.ok) {
        printInfo(
          `Labels synced for ${r.repo}: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped`,
        );
      } else {
        printWarning(`Label sync for ${r.repo} had ${r.failures} failure(s)`);
        anyFailure = true;
      }
    }
    return !anyFailure;
  } catch (error) {
    printWarning(
      `Label sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runWorkflowSync(configPath: string): Promise<boolean> {
  printInfo("Synchronising workflows across monitored repositories...");

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping workflow sync");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;
    // Pass `workDir` so the auditor reads workflow files from the local
    // clone where one exists (Issue #1811). Falls back to `gh api` for
    // repos that have not been cloned yet.
    const workDir = Deno.env.get("WORK_DIR") ??
      `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;
    const results = await syncWorkflowsForAllRepos(repos, {
      ghConfigDir,
      workDir,
    });
    let anyFailure = false;
    for (const r of results) {
      if (r.ok) {
        printInfo(
          `Workflow sync for ${r.repo}: ${r.present} present, ${r.issuesRaised} issues raised, ${r.issuesSkipped} skipped; ${r.partial} partial (${r.partialIssuesRaised} partial issues raised, ${r.partialIssuesSkipped} skipped)`,
        );
      } else {
        printWarning(
          `Workflow sync for ${r.repo} failed: ${r.error ?? "unknown error"}`,
        );
        anyFailure = true;
      }
    }
    return !anyFailure;
  } catch (error) {
    printWarning(
      `Workflow sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runBestPracticesSync(configPath: string): Promise<boolean> {
  printInfo("Auditing workflows for best-practice findings...");

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping best-practices sync");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;
    const workDir = Deno.env.get("WORK_DIR") ??
      `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;

    const results = await syncBestPracticesForAllRepos({
      repos,
      workDir,
      ghConfigDir,
    });

    let anyFailure = false;
    let totalCreated = 0;
    let totalUpdated = 0;
    for (const r of results) {
      if (r.ok) {
        if (r.issueCreated) totalCreated++;
        if (r.issueUpdated) totalUpdated++;
        printInfo(
          `Best-practices sync for ${r.repo}: ${r.findings} finding(s), ${
            r.issueCreated
              ? "issue filed"
              : r.issueUpdated
              ? "existing issue updated"
              : "no action"
          }`,
        );
      } else {
        printWarning(
          `Best-practices sync for ${r.repo} failed: ${
            r.error ?? "unknown error"
          }`,
        );
        anyFailure = true;
      }
    }
    printInfo(
      `Best-practices sync summary: ${totalCreated} issue(s) filed, ${totalUpdated} updated (of ${results.length} repo(s))`,
    );
    return !anyFailure;
  } catch (error) {
    printWarning(
      `Best-practices sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runBestPracticesRelabel(
  configPath: string,
  dryRun: boolean,
): Promise<boolean> {
  printInfo(
    `Backfilling severity + category labels on existing best-practice issues${
      dryRun ? " (dry-run)" : ""
    }...`,
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping best-practices relabel");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;

    const results = await relabelBestPracticesForAllRepos({
      repos,
      ghConfigDir,
      dryRun,
    });

    let anyFailure = false;
    let totalRelabelled = 0;
    let totalSkipped = 0;
    for (const r of results) {
      if (r.ok) {
        totalRelabelled += r.relabelled;
        totalSkipped += r.skipped;
        printInfo(
          `Best-practices relabel for ${r.repo}: ${r.scanned} issue(s) scanned, ${r.relabelled} relabelled, ${r.skipped} already labelled`,
        );
      } else {
        printWarning(
          `Best-practices relabel for ${r.repo} failed: ${
            r.error ?? "unknown error"
          }`,
        );
        anyFailure = true;
      }
    }
    printInfo(
      `Best-practices relabel summary: ${totalRelabelled} relabelled, ${totalSkipped} already labelled (of ${results.length} repo(s))`,
    );
    return !anyFailure;
  } catch (error) {
    printWarning(
      `Best-practices relabel failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runGitignoreSync(configPath: string): Promise<boolean> {
  printInfo(
    "Applying canonical .gitignore and .gitattributes safety blocks to monitored repositories...",
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping gitignore sync");
      return true;
    }

    const workDir = Deno.env.get("WORK_DIR") ??
      `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;

    const summary = await syncGitignoreForAllRepos(repos, workDir);
    for (const r of summary.results) {
      // Both enforcers may have produced an error; surface them
      // independently so the operator can see which file failed.
      if (r.error || r.gitattributesError) {
        const parts: string[] = [];
        if (r.error) parts.push(`gitignore: ${r.error}`);
        if (r.gitattributesError) {
          parts.push(`gitattributes: ${r.gitattributesError}`);
        }
        printWarning(
          `gitignore sync for ${r.repo} failed: ${parts.join("; ")}`,
        );
        continue;
      }
      if (r.skippedReason) {
        printInfo(`${r.repo}: skipped (${r.skippedReason})`);
        continue;
      }
      // Compose a per-repo line. Only mention `.gitattributes` when
      // something changed there to keep the no-op output quiet, but
      // always mention `.gitignore` so the operator sees the per-repo
      // status at a glance.
      const gitignorePart = r.added.length === 0
        ? `gitignore already protected (${r.existed.length} patterns)`
        : `gitignore ${r.added.length} added (${r.existed.length} existed)`;
      const gitattributesPart = r.gitattributesAdded.length === 0
        ? ""
        : `; gitattributes ${r.gitattributesAdded.length} added (${r.gitattributesExisted.length} existed)`;
      printSuccess(`${r.repo}: ${gitignorePart}${gitattributesPart}`);
    }
    printInfo(
      `gitignore + gitattributes sync: ${summary.applied} applied, ${summary.skipped} skipped, ${summary.failed} failed (of ${summary.total})`,
    );
    return summary.failed === 0;
  } catch (error) {
    printWarning(
      `Gitignore sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runVerifyCollaborator(configPath: string): Promise<boolean> {
  printInfo(
    "Verifying worker is a collaborator on every monitored repository...",
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping collaborator precheck");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;

    // Issue #4030: report an inactive worker identity guard here too, so an
    // empty `service_accounts` is a filed issue rather than one log line.
    const result = await verifyMonitoredCollaborators({
      repos,
      ghConfigDir,
      serviceAccounts: config.service_accounts ?? [],
    });

    if (result.identityGuardInactive) {
      printWarning(
        "[SECURITY] service_accounts is empty — the worker identity guard " +
          "cannot enforce on this host. Re-run setup with VIBE_SERVICE_ACCOUNTS.",
      );
    }

    if (result.error) {
      // A network/auth failure is non-fatal — setup must still complete.
      printWarning(`Collaborator precheck could not complete: ${result.error}`);
      return true;
    }

    if (result.misses.length === 0 && !result.identityGuardInactive) {
      printSuccess(
        `Collaborator precheck passed: ${result.workerUser} can be assigned issues on all ${repos.length} repo(s)`,
      );
      return true;
    }

    for (const miss of result.misses) {
      printWarning(`${miss.repo}: ${miss.status}`);
    }
    if (result.issueFiled) {
      printWarning(
        `Filed a setup-precheck issue against stSoftwareAU/VibeCoder for ${result.misses.length} repo(s)`,
      );
    } else if (result.issueUpdated) {
      printWarning(
        `Updated the existing setup-precheck issue for ${result.misses.length} repo(s)`,
      );
    }
    // Misconfigured repos and an inactive identity guard are reported via the
    // filed issue — non-fatal so the rest of setup completes. Signal failure
    // so setup.sh prints its warning line.
    return false;
  } catch (error) {
    printWarning(
      `Collaborator precheck failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

async function runBranchProtectionSync(configPath: string): Promise<boolean> {
  printInfo(
    "Applying default-branch rulesets to monitored repositories...",
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping ruleset sync");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;

    const summary = await syncBranchProtectionForAllRepos({
      repos,
      ghConfigDir,
    });
    for (const r of summary.results) {
      if (!r.ok) {
        printWarning(
          `Ruleset sync for ${r.repo} failed: ${r.error ?? "unknown error"}`,
        );
        continue;
      }
      if (r.changed) {
        printSuccess(
          `${r.repo} (${r.visibility}, ${r.branch}): ruleset updated (+${r.added.length} contexts, ${r.preserved.length} pre-existing kept)`,
        );
      } else if (r.skipped === "no-reported-checks") {
        printInfo(
          `${r.repo} (${r.visibility}, ${r.branch}): no reported check matches the catalogue — nothing required`,
        );
      } else if (
        r.skipped === "direct-push-branch" || r.skipped === "opted-out"
      ) {
        // A required-status-checks ruleset would refuse every direct push
        // (Issue #4356); the worker's own stale ruleset is removed instead.
        const why = r.skipped === "opted-out"
          ? "opted out of the default-branch ruleset"
          : "default branch takes direct pushes";
        const detail = r.detail ? ` (${r.detail})` : "";
        const removal = r.deleted
          ? ` — deleted the stale "Vibe Coder default branch" ruleset`
          : "";
        printInfo(
          `${r.repo} (${r.visibility}, ${r.branch}): ${why}${detail} — no ruleset required${removal}`,
        );
      } else {
        printInfo(
          `${r.repo} (${r.visibility}, ${r.branch}): already covered by a ruleset (no change)`,
        );
      }
      // Classic protection is never written or deleted by the worker; a
      // leftover rule is surfaced so an operator can clear it (Issue #4163).
      if (r.legacyClassicProtection) {
        printWarning(
          `${r.repo}: legacy classic branch protection is still present on ${r.branch} — ` +
            `it can demand status contexts nothing reports. Remove it with: ` +
            `gh api -X DELETE repos/${r.repo}/branches/${r.branch}/protection`,
        );
      }
    }
    printInfo(
      `Ruleset sync: ${summary.configured} configured (${summary.changed} changed), ${summary.failed} failed (of ${summary.total})`,
    );
    // Per-repo failures are non-fatal but signalled so setup.sh prints its
    // warning line.
    return summary.failed === 0;
  } catch (error) {
    printWarning(
      `Ruleset sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runBackfillIdleTaskLabels(configPath: string): Promise<boolean> {
  printInfo(
    "Back-filling `idle-task` label on existing security-scan wrappers...",
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping idle-task back-fill");
      return true;
    }

    const summary = await backfillIdleTaskLabels({
      repos,
      log: (event) => console.log(formatBackfillEvent(event)),
    });
    console.log(formatBackfillSummary(summary));

    for (const err of summary.errors) {
      printWarning(`idle-task back-fill ${err.repo}: ${err.message}`);
    }
    printInfo(
      `idle-task back-fill: ${summary.labelled.length} labelled, ${summary.alreadyLabelled} already labelled, ${summary.deliberatelyUnlabelled.length} deliberately unlabelled, ${summary.errors.length} errors`,
    );
    // Per-repo failures are non-fatal — return true unless every repo failed.
    return summary.errors.length < repos.length;
  } catch (error) {
    printWarning(
      `idle-task back-fill failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function runAll(scriptDir: string, configPath: string): Promise<boolean> {
  // 1. Prerequisites
  const prereqOk = await runPrerequisites(scriptDir, configPath);
  if (!prereqOk) return false;

  // 2. Config
  await runConfig(configPath);

  // 3. Label sync (non-fatal)
  await runLabelSync(configPath);

  // 4. Workflow sync (non-fatal)
  await runWorkflowSync(configPath);

  // 5. Best-practices sync (non-fatal — Issue #2102)
  await runBestPracticesSync(configPath);

  // 6. Gitignore + gitattributes sync (non-fatal — Issues #1774, #2340)
  await runGitignoreSync(configPath);

  // 6b. Collaborator precheck (non-fatal — Issue #2326). Runs once at setup
  //     time only; never in the per-iteration loop (rate-limit budget).
  await runVerifyCollaborator(configPath);

  // 6c. Default-branch ruleset sync (non-fatal — Issue #2588). Runs after the
  //     collaborator precheck (which validates access). Setup-time only;
  //     never in the per-iteration loop (rate-limit budget).
  await runBranchProtectionSync(configPath);

  // 7. Back-fill the `idle-task` label on existing security-scan wrappers
  //    (non-fatal — Issue #2131).
  await runBackfillIdleTaskLabels(configPath);

  // 8. Hooks
  await runHooks(scriptDir);

  // 7. LaunchAgent (if requested)
  if (Deno.env.get("VIBE_SETUP_LAUNCHAGENT") === "true") {
    await runLaunchAgentSetup(scriptDir);
  }

  // 8. Screenshot support (if requested)
  if (Deno.env.get("VIBE_SETUP_SCREENSHOT_SUPPORT") === "true") {
    await runScreenshotSetup(scriptDir);
  }

  return true;
}

// ── Main ────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(
    `Usage: setup_cli.ts <subcommand> [--script-dir DIR] [--config-path PATH] [--dry-run]

Subcommands:
  prerequisites   Check all prerequisites
  config          Write config from VIBE_* env vars
  launchagent     Setup macOS LaunchAgent
  screenshot      Setup Playwright MCP for screenshots
  label-sync      Synchronise labels across repos
  workflow-sync   Audit workflows and raise issues for missing protections
  best-practices-sync  Audit workflows for best-practice findings and file follow-ups
  best-practices-relabel  Backfill severity + category labels on existing best-practice issues (supports --dry-run)
  gitignore-sync  Apply canonical .gitignore + .gitattributes safety blocks to monitored repos
  verify-monitored-collaborator  Precheck worker collaborator access on every repo
  branch-protection-sync  Apply the default-branch ruleset to every monitored repo
  backfill-idle-task-labels  Apply idle-task label to existing security-scan wrappers
  hooks           Install pre-commit hook and git exclude patterns
  scheduled-task  Register the Windows Task Scheduler entry
  all             Run full setup (default)`,
  );
}

if (import.meta.main) {
  const args = Deno.args;
  const subcommand = args[0] ?? "all";

  // Parse --script-dir, --config-path and --dry-run
  let scriptDir = Deno.cwd();
  let configPath = "";
  let dryRun = false;
  let powershell = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--script-dir" && args[i + 1]) {
      scriptDir = args[i + 1]!;
      i++;
    } else if (args[i] === "--config-path" && args[i + 1]) {
      configPath = args[i + 1]!;
      i++;
    } else if (args[i] === "--powershell" && args[i + 1]) {
      powershell = args[i + 1]!;
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!configPath) {
    configPath = Deno.env.get("CONFIG_FILE") ?? `${scriptDir}/.config.json`;
  }

  let ok = true;

  switch (subcommand) {
    case "prerequisites":
      ok = await runPrerequisites(scriptDir, configPath);
      break;
    case "config":
      ok = await runConfig(configPath);
      break;
    case "launchagent":
      ok = await runLaunchAgentSetup(scriptDir);
      break;
    case "scheduled-task":
      ok = await runScheduledTaskSetup(scriptDir, powershell);
      break;
    case "screenshot":
      ok = await runScreenshotSetup(scriptDir);
      break;
    case "label-sync":
      ok = await runLabelSync(configPath);
      break;
    case "workflow-sync":
      ok = await runWorkflowSync(configPath);
      break;
    case "best-practices-sync":
      ok = await runBestPracticesSync(configPath);
      break;
    case "best-practices-relabel":
      ok = await runBestPracticesRelabel(configPath, dryRun);
      break;
    case "gitignore-sync":
      ok = await runGitignoreSync(configPath);
      break;
    case "verify-monitored-collaborator":
      ok = await runVerifyCollaborator(configPath);
      break;
    case "branch-protection-sync":
      ok = await runBranchProtectionSync(configPath);
      break;
    case "backfill-idle-task-labels":
      ok = await runBackfillIdleTaskLabels(configPath);
      break;
    case "hooks":
      ok = await runHooks(scriptDir);
      break;
    case "all":
      ok = await runAll(scriptDir, configPath);
      break;
    case "--help":
    case "-h":
      usage();
      break;
    default:
      printError(`Unknown subcommand: ${subcommand}`);
      usage();
      ok = false;
  }

  if (!ok) Deno.exit(1);
}
