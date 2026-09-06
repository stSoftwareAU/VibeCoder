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
 *   agent-providers    Print the configured coding-agent provider ids
 *   launchagent        Setup macOS LaunchAgent
 *   scheduled-task     Register the Windows Task Scheduler entry
 *   screenshot         Setup Playwright MCP for screenshots
 *   label-sync         Synchronise labels across repos (--dry-run plans only)
 *   label-colour-reconcile  Repaint drifted fleet label colours
 *   workflow-sync      Audit workflows and raise issues for missing protections
 *   best-practices-sync  Audit workflows for best-practice findings and file follow-ups
 *   best-practices-relabel  Backfill severity + category labels on existing best-practice issues
 *   gitignore-sync     Apply canonical .gitignore + .gitattributes safety blocks to monitored repos
 *   verify-monitored-collaborator  Precheck worker collaborator access on every repo
 *   branch-protection-sync  Apply the default-branch ruleset to every monitored repo
 *   repos              List monitored repositories; --add / --remove one (Issue #672)
 *   update-mode        Ask for the update mode, pinned ref and tool versions (Issue #626)
 *   hooks              Install pre-commit hook and git exclude patterns
 *   all                Run full setup (default)
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { installConsoleRedaction } from "../lib/console_redaction.ts";
import { terminalStyler } from "../lib/console_style.ts";
import { resolveHostConfigPath } from "../lib/host_config_path.ts";
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
import {
  isLaunchAgentInstalled,
  removeLaunchAgent,
  setupLaunchAgent,
} from "./launchagent.ts";
import {
  isScheduledTaskRegistered,
  removeScheduledTask,
  setupScheduledTask,
} from "./scheduled_task.ts";
import { setupPlaywrightMcp } from "./screenshot.ts";
import {
  type ConsentReader,
  isAffirmative,
  readConsentLine,
} from "./consent_prompt.ts";
import {
  addRepoToMonitoredList,
  listMonitoredRepos,
  removeRepoFromMonitoredList,
} from "../lib/add_repo.ts";
import { syncLabelsForAllRepos } from "./label_sync.ts";
import { reconcileLabelColoursForAllRepos } from "./label_colour_reconcile.ts";
import { syncWorkflowsForAllRepos } from "./workflow_sync.ts";
import { syncBestPracticesForAllRepos } from "./best_practices_sync.ts";
import { relabelBestPracticesForAllRepos } from "./best_practices_relabel.ts";
import { syncGitignoreForAllRepos } from "./gitignore_sync.ts";
import { verifyMonitoredCollaborators } from "./collaborator_precheck.ts";
import {
  assessDefaultBranchAutoMerge,
  checkMilestoneRuleset,
  createMilestoneRuleset,
  type GhJson,
  MILESTONE_RULESET_NAME,
  planMilestoneRuleset,
  readRulesetDetails,
  type RulesetDetail,
  rulesetReadFailedFinding,
} from "../lib/milestone_ruleset_check.ts";
import { syncBranchProtectionForAllRepos } from "./branch_protection_sync.ts";
import { explainRulesetFailure } from "../lib/ruleset_failure.ts";
import {
  backfillIdleTaskLabels,
  formatBackfillEvent,
  formatBackfillSummary,
} from "../lib/idle_task_backfill.ts";
import { resolveSetupAgentProviderIds } from "./agent_providers.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { loadExistingConfig } from "./config_setup.ts";
import { runUpdateModeSetup } from "./update_mode_setup.ts";
import { resolveRunMode, type RunMode } from "../lib/run_mode.ts";
import { readConfiguredRunMode } from "../commands/run_mode.ts";

// ── Colour helpers ──────────────────────────────────────────────────────

/** Glyphs and colour come from the one shared module (Issue #870). */
const out = terminalStyler();
const err = terminalStyler(Deno.stderr);

function printInfo(msg: string): void {
  console.log(out.info(msg));
}

function printSuccess(msg: string): void {
  console.log(out.success(msg));
}

function printWarning(msg: string): void {
  console.log(out.warning(msg));
}

/**
 * `gh` executor for the read-only milestone-ruleset check (Issue #586).
 *
 * Its own runner rather than the sync's: that one returns a structured
 * `CommandOutput`, while the ruleset reads want raw JSON on stdout and a
 * throw on failure, matching the `GhJson` seam.
 */
function createSetupGhJson(ghConfigDir?: string) {
  return async (args: string[], stdin?: string): Promise<string> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command("gh", {
      args,
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      ...(env ? { env } : {}),
    });
    if (stdin !== undefined) {
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
      const piped = await child.output();
      const decode = new TextDecoder();
      if (!piped.success) throw new Error(decode.decode(piped.stderr).trim());
      return decode.decode(piped.stdout);
    }
    const output = await command.output();
    const decoder = new TextDecoder();
    if (!output.success) {
      throw new Error(decoder.decode(output.stderr).trim());
    }
    return decoder.decode(output.stdout);
  };
}

/** The terminal edges of {@link askCreateMilestoneRuleset}, injectable. */
export interface ConsentPromptSeams {
  /** Where the answer is read. Defaults to `Deno.stdin`. */
  reader?: ConsentReader;
  /** Whether a terminal is attached. Defaults to `Deno.stdin.isTerminal()`. */
  isTerminal?: () => boolean;
  /** Where the question is written. Defaults to `Deno.stdout`. */
  write?: (chunk: Uint8Array) => Promise<number>;
}

/**
 * Ask whether to create the missing `milestone/**` ruleset (Issue #586).
 *
 * Setup asks its own questions — this is one of them. Without a terminal to
 * ask on there is no consent to infer, so the check warns and changes
 * nothing: a scripted run can never hang here, and never writes a ruleset
 * nobody agreed to.
 *
 * The answer is read one whole line at a time (Issue #1296). This question is
 * asked once per repository, so a fixed-size read left the tail of a long
 * answer in the buffer to approve the NEXT repository's ruleset — consent the
 * operator never gave to a question they never saw.
 */
export async function askCreateMilestoneRuleset(
  repo: string,
  seams: ConsentPromptSeams = {},
): Promise<boolean> {
  const isTerminal = seams.isTerminal ?? (() => Deno.stdin.isTerminal());
  if (!isTerminal()) return false;

  const write = seams.write ??
    ((chunk: Uint8Array) => Deno.stdout.write(chunk));
  await write(
    new TextEncoder().encode(
      out.question(
        `${repo}: no ruleset covers \`milestone/**\`, so GitHub cannot arm ` +
          `auto-merge on a milestone PR.`,
      ) + "\n" +
        out.plain("Create one mirroring the default-branch checks? [y/N] "),
    ),
  );
  return isAffirmative(await readConsentLine(seams.reader ?? Deno.stdin));
}

function printError(msg: string): void {
  console.error(err.error(msg));
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
 * @param autoInstall - Consent to the install in advance (`--auto-install`,
 *                      Issue #33)
 * @returns The report to carry forward
 */
export async function repairMacOsContainerRuntime(
  probe: AllPrerequisitesResult,
  probeOptions: PrerequisiteOptions,
  deps: ContainerRepairDeps = {},
  autoInstall = false,
): Promise<AllPrerequisitesResult> {
  const runtimeFailed = probe.results.some((r) =>
    r.tool === CONTAINER_RUNTIME_TOOL && !r.ok
  );
  if (!runtimeFailed) return probe;

  const repair = deps.repair ?? repairContainerRuntime;
  const recheckAll = deps.recheckAll ?? checkAllPrerequisites;

  const repaired = await repair(probe, { log: printInfo, autoInstall });
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
  agentProviders: readonly string[] = [CLAUDE_PROVIDER_ID],
): string[] {
  if (ok) {
    return [`All host prerequisites satisfied (run mode: ${runMode})`];
  }
  // The claude CLI is only demanded of a host that runs Claude (Issue #730),
  // so the report must not tell a Codex-only operator to install it.
  const claudeNeed = agentProviders.includes(CLAUDE_PROVIDER_ID)
    ? "the claude CLI (setup mints the worker's OAuth token with it) and "
    : "";
  const needs = `Container mode needs git, an authenticated gh, deno, ` +
    `${claudeNeed}a working container runtime on the host; the image ` +
    `provides jq and timeout. Configured coding-agent providers: ` +
    `${agentProviders.join(", ")}.`;
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
  autoInstall = false,
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

  // Which coding agents this host runs decides whose tooling is host-fatal
  // (Issue #730). Resolved from the same seam `setup.sh` uses, and a broken
  // or unusable selection stops the run rather than silently probing for the
  // default provider's CLI.
  let agentProviders: string[];
  try {
    agentProviders = await resolveSetupAgentProviderIds(configPath);
  } catch (error) {
    printError((error as Error).message);
    return false;
  }
  printInfo(`Configured coding-agent providers: ${agentProviders.join(", ")}`);

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
  } catch (error) {
    // A missing config is not an error — `loadExistingConfig` returns `{}` for
    // one. Anything that throws is a rejected config (e.g. an invalid repo
    // slug, Issue #1291) and must stop setup rather than silently probing with
    // the wrong `gh` identity.
    printError((error as Error).message);
    return false;
  }

  const probeOptions: PrerequisiteOptions = {
    skipPrereqCheck: skipPrereq,
    skipAuthCheck: skipAuth,
    ghConfigDir,
    repoRoot: scriptDir,
    runMode,
    agentProviders,
  };
  const probe = await repairMacOsContainerRuntime(
    await checkAllPrerequisites(probeOptions),
    probeOptions,
    {},
    autoInstall,
  );

  // Interactive hosts are offered the installs, one prompt per tool
  // (Issue #4135). With no TTY — or VIBE_NO_AUTO_INSTALL=true — the offer is
  // withheld and the report says so (Issue #33); --auto-install consents to
  // every offer in advance, so a scripted run can still install.
  const result = await offerMissingPrerequisites(probe, {
    probeOptions: { ...probeOptions, skipPrereqCheck: false },
    autoInstall,
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

  const [headline, ...detail] = prerequisiteSummaryLines(
    result.ok,
    runMode,
    agentProviders,
  );
  if (result.ok) printSuccess(headline!);
  else printError(headline!);
  for (const line of detail) printInfo(line);

  return result.ok;
}

/**
 * `agent-providers`: print the configured coding-agent provider ids, one per
 * line (Issue #730).
 *
 * `setup.sh` captures this to decide which credential flows to run, so stdout
 * carries the ids and nothing else — the same contract `run-mode` gives the
 * launchers. A selection that cannot be resolved exits non-zero with the
 * reason on stderr and an empty stdout, so the caller stops rather than
 * prompting for the wrong vendor's credential.
 *
 * @param configPath - Host path of the worker configuration file
 * @returns True when the selection resolved
 */
async function runAgentProviders(configPath: string): Promise<boolean> {
  let providers: string[];
  try {
    providers = await resolveSetupAgentProviderIds(configPath);
  } catch (error) {
    printError((error as Error).message);
    return false;
  }
  for (const id of providers) console.log(id);
  return true;
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

/**
 * `update-mode`: ask whether this host follows the tip or is frozen at a pin,
 * and record the answer in `.config.json` (Issue #626).
 *
 * `setup.sh` delegates the whole conversation here and keeps no mode logic of
 * its own, in the same shape as `run.sh` → `worker-checkout-update`.
 */
async function runUpdateMode(
  scriptDir: string,
  configPath: string,
): Promise<boolean> {
  const result = await runUpdateModeSetup({
    repoDir: scriptDir,
    configPath,
  });
  if (!result.ok) {
    printError(result.error.message);
    return false;
  }

  const { settings, changed, prompted } = result.value;
  const mode = settings.update_mode ?? "dynamic";
  if (!prompted) {
    // A non-interactive fresh config is pinned to the latest release when one
    // resolves (Issue #692), so the line has to name the ref it landed on.
    const at = mode === "frozen" && settings.pinned_ref
      ? ` at ${settings.pinned_ref}`
      : "";
    printInfo(
      changed
        ? `Update mode defaulted to ${mode}${at} (no terminal to ask at).`
        : `Update mode left at ${mode}${at} (no terminal to ask at).`,
    );
    return true;
  }

  if (mode === "frozen") {
    const versions = settings.pinned_tool_versions ?? {};
    printSuccess(
      `Update mode: frozen at ${settings.pinned_ref} — claude ` +
        `${versions.claude}, gh ${versions.gh}, deno ${versions.deno}.`,
    );
  } else {
    printSuccess(
      "Update mode: dynamic — this host follows the tip and the latest tools.",
    );
  }
  if (!changed) printInfo(`${configPath} already said this — left untouched.`);
  return true;
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

/**
 * `launchagent --status`: print `installed` or `not-installed`, nothing else,
 * so setup.sh can read the answer (Issue #26).
 */
async function runLaunchAgentStatus(): Promise<boolean> {
  const installed = await isLaunchAgentInstalled(
    Deno.env.get("VIBE_LAUNCHAGENT_DIR"),
  );
  console.log(installed ? "installed" : "not-installed");
  return true;
}

/** `launchagent --uninstall`: unload the agent and delete its plist. */
async function runLaunchAgentRemoval(): Promise<boolean> {
  printInfo("Removing the macOS LaunchAgent...");
  const result = await removeLaunchAgent({
    launchAgentDir: Deno.env.get("VIBE_LAUNCHAGENT_DIR"),
    skipLaunchctl: Deno.env.get("VIBE_SKIP_LAUNCHCTL") === "true",
  });
  if (result.ok) printSuccess(result.message);
  else printError(result.message);
  return result.ok;
}

/** `scheduled-task --status`: `registered` or `not-registered`, nothing else. */
async function runScheduledTaskStatus(): Promise<boolean> {
  console.log(
    (await isScheduledTaskRegistered()) ? "registered" : "not-registered",
  );
  return true;
}

/** `scheduled-task --uninstall`: unregister the task. */
async function runScheduledTaskRemoval(): Promise<boolean> {
  printInfo("Unregistering the Windows scheduled task...");
  const result = await removeScheduledTask({
    skipSchtasks: Deno.env.get("VIBE_SKIP_SCHTASKS") === "true",
  });
  if (result.ok) printSuccess(result.message);
  else printError(result.message);
  return result.ok;
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

async function runLabelSync(
  configPath: string,
  dryRun = false,
): Promise<boolean> {
  printInfo(
    dryRun
      ? "Planning label sync across monitored repositories (dry run — nothing is changed)..."
      : "Synchronising labels across monitored repositories...",
  );

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
    const results = await syncLabelsForAllRepos(repos, { ghConfigDir, dryRun });
    let anyFailure = false;
    for (const r of results) {
      if (r.ok) {
        printInfo(
          r.dryRun
            ? `Label sync plan for ${r.repo}: ${r.created} would be created, ${r.updated} would be updated (colour + description overwritten), ${r.deprecated_removed} deprecated would be deleted, ${r.skipped} skipped`
            : `Labels synced for ${r.repo}: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped`,
        );
      } else {
        printWarning(
          `Label sync for ${r.repo} had ${r.failures} failure(s)${
            r.error ? `: ${r.error}` : ""
          }`,
        );
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

/**
 * Repaint fleet-managed labels whose colour drifted from the canonical
 * table (Issue #368).
 *
 * Only labels the table names are touched, and none are created — a label
 * a human added to their own repo is left exactly as they set it.
 */
async function runLabelColourReconcile(
  configPath: string,
  dryRun: boolean,
): Promise<boolean> {
  printInfo(
    dryRun
      ? "Checking fleet label colours (dry run — nothing will be changed)..."
      : "Reconciling fleet label colours across monitored repositories...",
  );

  try {
    const config = await loadExistingConfig(configPath);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      printWarning("No repos configured — skipping label colour reconcile");
      return true;
    }

    const ghConfigDir = config.gh_config_dir
      ? config.gh_config_dir.replace(/^~/, Deno.env.get("HOME") ?? "~")
      : undefined;
    const results = await reconcileLabelColoursForAllRepos(repos, {
      ghConfigDir,
      dryRun,
    });

    let anyFailure = false;
    for (const r of results) {
      if (r.error) {
        printWarning(
          `Label colours for ${r.repo} could not be read: ${r.error}`,
        );
        anyFailure = true;
        continue;
      }
      for (const c of r.changes) {
        const suffix = c.applied
          ? ""
          : c.error
          ? ` — FAILED: ${c.error}`
          : " (dry run)";
        printInfo(`  ${r.repo}: ${c.label} ${c.from} → ${c.to}${suffix}`);
      }
      printInfo(
        `Label colours for ${r.repo}: ${r.inspected} fleet labels, ` +
          `${r.drifted} drifted, ${r.changed} repainted`,
      );
      if (!r.ok) anyFailure = true;
    }
    return !anyFailure;
  } catch (error) {
    printWarning(
      `Label colour reconcile failed: ${
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

/**
 * Which credentials a `gh` call runs under.
 *
 * The two are NOT interchangeable (Issue #595). `service-account` points gh at
 * the worker's own configuration, which holds `write`; `operator` uses the
 * ambient credentials of the human running setup, which is the only identity
 * that can hold the `admin` a ruleset write needs.
 */
export type SetupIdentity = "service-account" | "operator";

/** The severities {@link reportMilestoneRuleset} prints at. */
export type ReportSeverity = "info" | "success" | "warning" | "error";

/** The side-effecting edges of {@link reportMilestoneRuleset}, injectable. */
export interface MilestoneReportSeams {
  /** A `gh` runner for the given identity. */
  ghFor: (identity: SetupIdentity) => GhJson;
  /** Ask the operator whether to create the missing ruleset. */
  ask: (repo: string) => Promise<boolean>;
  /** Emit one line. */
  print: (severity: ReportSeverity, message: string) => void;
}

/** The production seams: real `gh`, a real prompt, real printing. */
function liveMilestoneSeams(ghConfigDir?: string): MilestoneReportSeams {
  return {
    ghFor: (identity) =>
      identity === "operator"
        ? createSetupGhJson()
        : createSetupGhJson(ghConfigDir),
    ask: askCreateMilestoneRuleset,
    print: (severity, message) => {
      if (severity === "error") printError(message);
      else if (severity === "warning") printWarning(message);
      else if (severity === "success") printSuccess(message);
      else printInfo(message);
    },
  };
}

/**
 * Report one repository's milestone-branch and auto-merge configuration, and
 * offer to create the `milestone/**` ruleset when — and only when — an answer
 * could change something (Issues #586, #553, #678).
 *
 * The rulesets are read by the caller, once, and passed in, so the offer, the
 * milestone findings and the default-branch auto-merge check all assess the
 * same state and cannot disagree about what is on the repository.
 *
 * The one call that does NOT reuse them is the create: it re-reads under the
 * `operator` identity because that is the only one holding `admin`, and it
 * must decide what to write from what THAT identity can see (Issue #595). The
 * re-read is deliberate, not a missed optimisation.
 *
 * @param result - The repo and its resolved default branch
 * @param login - The service account the worker runs as
 * @param rulesets - Every ruleset on the repository, already read
 * @param seams - The `gh`, prompt and print edges
 * @returns The number of `error`-severity findings printed
 */
export async function reportMilestoneRuleset(
  result: { repo: string; branch?: string },
  login: string,
  rulesets: readonly RulesetDetail[],
  seams: MilestoneReportSeams,
): Promise<number> {
  const { repo, branch } = result;
  const findings = await checkMilestoneRuleset(
    repo,
    login,
    seams.ghFor("service-account"),
    { rulesets },
  );

  // A question whose only possible outcome is a refusal must not be asked.
  // With no default-branch gate to mirror there is nothing to create, so
  // answering yes changed nothing and the same question came back on every
  // run — setup says why instead (Issue #678).
  const plan = planMilestoneRuleset(rulesets);
  let suppressMissingWarning = false;

  if (plan.kind === "not-creatable") {
    // Said once, as a single line. The standing `no-milestone-ruleset` warning
    // ends "add a ruleset with required status checks", which read as a
    // contradiction next to "there are no checks to mirror" — so the reason is
    // folded into that warning rather than printed beside it.
    suppressMissingWarning = true;
    seams.print(
      "warning",
      `${repo}: no ruleset covers \`milestone/**\`, so GitHub cannot arm ` +
        `auto-merge on a milestone PR (Issue #586). Setup is not offering to ` +
        `create one — ${plan.reason}. Require status checks on the default ` +
        `branch first, then re-run setup to mirror them onto ` +
        `\`milestone/**\`.`,
    );
  } else if (plan.kind === "creatable" && await seams.ask(repo)) {
    const created = await createMilestoneRuleset(repo, seams.ghFor("operator"));
    if (!created.ok) {
      seams.print(
        "warning",
        `${repo}: could not create the milestone ruleset: ` +
          `${created.error.message}`,
      );
    } else if (created.created) {
      seams.print(
        "success",
        `${repo}: created the "${MILESTONE_RULESET_NAME}" ruleset ` +
          `requiring ${created.contexts.length} check(s) on ` +
          `\`milestone/**\` — milestone PRs are auto-mergeable`,
      );
      return 0;
    } else {
      seams.print(
        "info",
        `${repo}: milestone ruleset not created — ${created.reason}`,
      );
    }
  }

  // Issue #553: the same question for the DEFAULT branch. Auto-merge being
  // "set at random" was deterministic all along — GitHub refuses to arm it on
  // a PR nothing blocks, so a branch requiring neither checks nor reviews can
  // never carry it. `ensureDefaultBranchRuleset` defers to a human-managed
  // ruleset and will not add checks to one that exists, so without this
  // nothing says so. A repo whose default branch could not be resolved is
  // already reported by the caller; there is nothing to assess against.
  const autoMergeFinding = branch
    ? assessDefaultBranchAutoMerge(rulesets, branch)
    : null;
  if (autoMergeFinding) {
    seams.print("warning", `${repo}: ${autoMergeFinding.message}`);
  }

  let errors = 0;
  for (const finding of findings) {
    if (suppressMissingWarning && finding.code === "no-milestone-ruleset") {
      continue;
    }
    const line = `${repo}: ${finding.message}`;
    if (finding.severity === "error") {
      seams.print("error", line);
      errors++;
    } else if (finding.severity === "warning") {
      seams.print("warning", line);
    }
    // `info` is the healthy case — reported only in the caller's summary.
  }
  return errors;
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
    let milestoneRulesetErrors = 0;
    for (const r of summary.results) {
      if (!r.ok) {
        // Why it failed decides what an operator does next: a private
        // repository on a free plan needs GitHub Pro, which no token scope
        // or organisation policy will fix (Issue #733). Every case stays
        // non-fatal — setup finishes and the remaining checks still run.
        printWarning(
          explainRulesetFailure({
            repo: r.repo,
            error: r.error ?? "unknown error",
            ...(r.visibility ? { visibility: r.visibility } : {}),
          }).message,
        );
        continue;
      }
      if (r.changed) {
        // Name the other rules carried through, so a run that touches an
        // admin-hardened ruleset shows what survived the PUT (Issue #1290).
        const keptRules = r.preservedRules?.length
          ? `, rules kept: ${r.preservedRules.join(", ")}`
          : "";
        printSuccess(
          `${r.repo} (${r.visibility}, ${r.branch}): ruleset updated (+${r.added.length} contexts, ${r.preserved.length} pre-existing kept${keptRules})`,
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
      // Issue #586: milestone branches are the operator's to configure — the
      // worker never writes their ruleset, because getting it wrong freezes
      // every milestone branch in the fleet. Setup reads it and says what is
      // wrong, so a misconfiguration is caught here rather than by a milestone
      // sync failing on the hour.
      const milestoneLogin = (config.service_accounts ?? [])[0];
      if (milestoneLogin) {
        // Read the rulesets ONCE, and treat a read that failed as a failure:
        // turning it into an empty list said "no ruleset covers
        // `milestone/**`", so setup offered to create a ruleset that was
        // already there and asked again on every run (Issue #678).
        const read = await readRulesetDetails(
          r.repo,
          createSetupGhJson(ghConfigDir),
        );
        if (!read.ok) {
          printWarning(
            `${r.repo}: ${rulesetReadFailedFinding(read.error).message}`,
          );
        } else {
          milestoneRulesetErrors += await reportMilestoneRuleset(
            r,
            milestoneLogin,
            read.rulesets,
            liveMilestoneSeams(ghConfigDir),
          );
        }
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
    if (milestoneRulesetErrors > 0) {
      printWarning(
        `${milestoneRulesetErrors} repo(s) gate \`milestone/**\` against the ` +
          `service account, which is the intended policy — but the milestone ` +
          `branch sync still pushes directly, so it fails there until the ` +
          `sync raises a pull request instead (Issue #589).`,
      );
    }
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

async function runAll(
  scriptDir: string,
  configPath: string,
  autoInstall = false,
): Promise<boolean> {
  // 1. Prerequisites
  const prereqOk = await runPrerequisites(scriptDir, configPath, autoInstall);
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

/**
 * Add, remove or list monitored repositories (Issue #672).
 *
 * The operator-facing half of a flow that was only ever automated for the
 * `add-repo:` issue path. Adding a repository by hand meant editing
 * `.config.json` — and removing one had no path at all — so the list drifted
 * and a mistyped slug was found by the next run rather than at the keyboard.
 *
 * `--add` validates the slug's shape before anything is written. It does NOT
 * probe GitHub: that needs credentials this command should not require to
 * tell you what is in a local file, and `process-add-repo` already does the
 * full validation for the issue-driven path.
 */
async function runRepos(
  configPath: string,
  addRepo: string,
  removeRepo: string,
): Promise<boolean> {
  if (addRepo) {
    const result = await addRepoToMonitoredList(addRepo, configPath);
    if (!result.ok) {
      printError(result.error.message);
      return false;
    }
    if (result.value.added) {
      printSuccess(`Added ${addRepo} to the monitored repositories.`);
      printInfo(
        "It is picked up on the next cycle. Seed its idle-task wrappers with: " +
          `deno run --allow-all worker/deno/mod.ts raise-all-idle-tasks --monitored-repos ${addRepo}`,
      );
    } else {
      printInfo(`${addRepo} is already monitored — nothing changed.`);
    }
    return true;
  }

  if (removeRepo) {
    const result = await removeRepoFromMonitoredList(removeRepo, configPath);
    if (!result.ok) {
      printError(result.error.message);
      return false;
    }
    if (result.value.removed) {
      printSuccess(`Removed ${removeRepo} from the monitored repositories.`);
      if (result.value.repoConfigRemoved) {
        printInfo(`Its repo_config entry was removed too.`);
      }
      printInfo(
        "Open PRs and branches in that repository are left alone — this only " +
          "stops the worker looking at it.",
      );
    } else {
      printInfo(`${removeRepo} was not in the list — nothing changed.`);
    }
    return true;
  }

  // Neither flag: list. Seeing the list is the step the old flow skipped.
  const listed = await listMonitoredRepos(configPath);
  if (!listed.ok) {
    printError(listed.error.message);
    return false;
  }
  if (listed.value.length === 0) {
    printInfo("No repositories are monitored yet.");
    return true;
  }
  printInfo(`${listed.value.length} monitored repositories:`);
  for (const repo of listed.value) console.log(`  ${repo}`);
  return true;
}

function usage(): void {
  console.log(
    `Usage: setup_cli.ts <subcommand> [--script-dir DIR] [--config-path PATH] [--dry-run] [--auto-install]

Subcommands:
  prerequisites   Check all prerequisites (--auto-install consents in advance
                  to every offered install — Issue #33)
  config          Write config from VIBE_* env vars
  agent-providers Print the configured coding-agent provider ids, one per line
                  (Issue #730 — setup.sh runs each one's credential flow)
  launchagent     Setup macOS LaunchAgent (--status / --uninstall to query or remove it)
  screenshot      Setup Playwright MCP for screenshots
  label-sync      Synchronise labels across repos (supports --dry-run, which
                  reports what would change without touching a label)
  label-colour-reconcile  Repaint drifted fleet label colours to the canonical
                  table (supports --dry-run)
  workflow-sync   Audit workflows and raise issues for missing protections
  best-practices-sync  Audit workflows for best-practice findings and file follow-ups
  best-practices-relabel  Backfill severity + category labels on existing best-practice issues (supports --dry-run)
  gitignore-sync  Apply canonical .gitignore + .gitattributes safety blocks to monitored repos
  verify-monitored-collaborator  Precheck worker collaborator access on every repo
  branch-protection-sync  Apply the default-branch ruleset to every monitored repo
  backfill-idle-task-labels  Apply idle-task label to existing security-scan wrappers
  repos           List monitored repositories (--add owner/repo, --remove owner/repo)
  update-mode     Ask for the update mode (dynamic/frozen) and, when frozen,
                  the pinned ref and the exact Claude CLI / gh / Deno versions
  hooks           Install pre-commit hook and git exclude patterns
  scheduled-task  Register the Windows Task Scheduler entry (--status / --uninstall to query or remove it)
  all             Run full setup (default)`,
  );
}

if (import.meta.main) {
  // Issue #1280 (SEC-1217-12): setup runs as its own process, so it installs
  // its own console patch — setup prints config paths, prerequisite install
  // output and `gh` error text straight to the terminal.
  installConsoleRedaction();

  const args = Deno.args;
  const subcommand = args[0] ?? "all";

  // Parse --script-dir, --config-path and --dry-run
  let scriptDir = Deno.cwd();
  let configPath = "";
  let dryRun = false;
  let powershell = "";
  let uninstall = false;
  let status = false;
  let autoInstall = false;
  let addRepo = "";
  let removeRepo = "";

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
    } else if (args[i] === "--uninstall") {
      uninstall = true;
    } else if (args[i] === "--status") {
      status = true;
    } else if (args[i] === "--auto-install") {
      autoInstall = true;
    } else if (args[i] === "--add" && args[i + 1]) {
      addRepo = args[++i]!;
    } else if (args[i] === "--remove" && args[i + 1]) {
      removeRepo = args[++i]!;
    }
  }

  if (!configPath) {
    // CONFIG_FILE, with CONFIG_PATH as its alias, resolved by the same rule
    // the launcher uses — setup must not write one file while `./run.sh`
    // stages another (Issue #750).
    configPath = resolveHostConfigPath({
      baseDir: scriptDir,
      env: (name) => Deno.env.get(name),
    });
  }

  let ok = true;

  switch (subcommand) {
    case "prerequisites":
      ok = await runPrerequisites(scriptDir, configPath, autoInstall);
      break;
    case "config":
      ok = await runConfig(configPath);
      break;
    case "agent-providers":
      ok = await runAgentProviders(configPath);
      break;
    case "launchagent":
      ok = status
        ? await runLaunchAgentStatus()
        : uninstall
        ? await runLaunchAgentRemoval()
        : await runLaunchAgentSetup(scriptDir);
      break;
    case "scheduled-task":
      ok = status
        ? await runScheduledTaskStatus()
        : uninstall
        ? await runScheduledTaskRemoval()
        : await runScheduledTaskSetup(scriptDir, powershell);
      break;
    case "screenshot":
      ok = await runScreenshotSetup(scriptDir);
      break;
    case "label-sync":
      ok = await runLabelSync(configPath, dryRun);
      break;
    case "label-colour-reconcile":
      ok = await runLabelColourReconcile(configPath, dryRun);
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
    case "repos":
      ok = await runRepos(configPath, addRepo, removeRepo);
      break;
    case "update-mode":
      ok = await runUpdateMode(scriptDir, configPath);
      break;
    case "hooks":
      ok = await runHooks(scriptDir);
      break;
    case "all":
      ok = await runAll(scriptDir, configPath, autoInstall);
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
