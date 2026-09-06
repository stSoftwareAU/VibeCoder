/**
 * Orchestrating command for the add-repo flow (Issue #2578).
 *
 * Drives the full lifecycle for a single `add-repo:`-titled issue and
 * signals the outcome by commenting on (and closing or escalating) that
 * issue. The orchestration order is:
 *
 *   1. {@link parseAddRepoTitle} (Issue #2575) — when the title carries no
 *      valid `owner/repo`, post an explanatory comment and close.
 *   2. {@link validateAddRepoTarget} (Issue #2576):
 *        - `not_found` / `no_access` → post a remediation comment AND apply
 *          `needs-human` via {@link escalateToHuman} (the only sanctioned
 *          path to that label). The repo is NOT added; stop.
 *        - `ok` → continue (visibility captured for the summary only; no
 *          public-vs-private gating — that is deferred to #2571).
 *   3. {@link addRepoToMonitoredList} (Issue #2575) — idempotent append.
 *   4. {@link syncLabelsForRepo} (Issue #2599) — sync the full canonical
 *      label set so issues can be scheduled on the new repo immediately.
 *      Non-fatal: a sync failure is reported but does not abort onboarding.
 *   5. {@link syncBranchProtectionForRepo} (Issue #2589) — configure the
 *      default-branch protection "wall" (Issue #2586) so the onboarded repo
 *      inherits the same pre-merge enforcement as existing repos. The
 *      visibility resolved in step 2 is passed through, so the
 *      visibility-aware required-check selection drops any unsatisfiable
 *      check. Non-fatal: a configuration failure is reported in the summary
 *      (never silently swallowed) but does not abort onboarding.
 *   6. {@link createAllIdleTaskWrappers} (Issue #2577) — seed all ten
 *      idle-task wrappers.
 *   7. Post a success comment (repo added/already present, detected
 *      visibility, label-sync summary, branch-protection summary, wrappers
 *      created/skipped) and close the issue as completed.
 *
 * Label sync runs here (Issue #2599) so a freshly onboarded repo carries the
 * full canonical GitHub label set immediately — the user can apply `work-on`,
 * `top-priority`, `grill-me`, etc. without waiting for a later setup/idle
 * sync. It reuses the canonical {@link syncLabelsForRepo} helper over
 * `LABEL_DEFINITIONS` (no second label list) and is idempotent, so a later
 * setup/idle sync over the same repo is a safe no-op. A label-sync failure
 * is reported in the summary, not swallowed, but is non-fatal: the worker
 * has write access so labels rarely need human action, and onboarding still
 * completes.
 *
 * The remaining setup syncs are deliberately NOT run here. The one-off
 * workflow sync, `.gitignore` sync, and collaborator precheck all run at
 * setup time (`setup.sh`); the steady-state idle tasks keep a newly added
 * repo in good standing. Re-running those syncs per add-repo issue would
 * spend API budget for no benefit, so this command relies on the idle
 * tasks instead.
 *
 * Label policy: this command never applies reserved/operational labels
 * directly. The only labels it touches are `idle-task` (indirectly, via
 * the wrapper helper) and `needs-human` (only through
 * {@link escalateToHuman}).
 *
 * Every external dependency (`gh` runners, filesystem, clock) is injected
 * so the whole flow is unit-testable with scripted responses and no real
 * network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type {
  Command,
  CommandResult,
  Logger,
  Result,
  WorkerConfig,
} from "../types.ts";
import {
  type AddRepoTargetStatus,
  addRepoToMonitoredList,
  parseAddRepoTitle,
  validateAddRepoTarget,
} from "../lib/add_repo.ts";
import type { RunCommand } from "../setup/collaborator_precheck.ts";
import {
  createAllIdleTaskWrappers,
  type CreateAllIdleTaskWrappersResult,
} from "../lib/create_all_idle_task_wrappers.ts";
import { runGhCommand as defaultGhCommand } from "../lib/github.ts";
import { spawnGh } from "../lib/gh_spawn.ts";
import {
  type LabelSyncResult,
  syncLabelsForRepo,
} from "../setup/label_sync.ts";
import {
  syncBranchProtectionForRepo,
  type SyncResult,
} from "../setup/branch_protection_sync.ts";
import type { RepoVisibility } from "../lib/repo_visibility.ts";
import type { RulesetSkipReason } from "../lib/default_branch_ruleset.ts";
import { escalateToHuman } from "../lib/needs_human_escalation.ts";
import { createGhEscalationClient } from "../lib/gh_escalation_client.ts";
import { ensureLabelExists } from "../lib/label_operations.ts";
import { createLogger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/** Outcome reported back via `CommandResult.data`. */
export interface ProcessAddRepoData {
  /** Discriminated outcome of the run. */
  outcome:
    | "unparseable"
    | "not_found"
    | "no_access"
    | "added"
    | "already_present"
    | "error";
  /** The parsed target repo, when the title parsed. */
  repo?: string;
  /** Detected visibility, when validation returned `ok`. */
  visibility?: string;
  /** Template names whose wrapper was newly filed. */
  created?: string[];
  /** Template names skipped because an open wrapper already existed. */
  skipped?: string[];
  /** Canonical label-sync summary (Issue #2599). */
  labels?: LabelSyncSummary;
  /** Branch-protection configuration summary (Issue #2589). */
  branchProtection?: BranchProtectionSummary;
}

/** Compact summary of the branch-protection configuration (Issue #2589). */
export interface BranchProtectionSummary {
  /** True when protection was read and (if needed) converged successfully. */
  ok: boolean;
  /** True when a `PUT` was issued to converge drift. */
  changed: boolean;
  /** Required-check contexts added to the default branch. */
  added: string[];
  /** Resolved default branch, when known. */
  branch?: string;
  /**
   * Why no ruleset was written, when none was — a direct-push or opted-out
   * branch never gets one (Issue #4356).
   */
  skipped?: RulesetSkipReason;
  /** Human-readable detail for the skip. */
  detail?: string;
  /** Populated on failure with a human-readable reason. */
  error?: string;
}

/** Compact summary of the canonical label sync for the run data/comment. */
export interface LabelSyncSummary {
  /** Labels newly created on the target repo. */
  created: number;
  /** Existing labels reconciled to the canonical colour/description. */
  updated: number;
  /** Labels that could not be created or updated. */
  failures: number;
  /** Set when the sync threw before producing a result. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (kept off the public CLI via `__testDeps`)
// ---------------------------------------------------------------------------

/** Arguments passed to the escalation seam. */
export interface EscalateArgs {
  repo: string;
  issueNumber: number;
  reason: string;
  nextStep: string;
}

/**
 * Injectable dependencies. Every functional dep resolves to its real
 * production implementation; tests override the seams they need to drive
 * a given outcome without touching the network or filesystem.
 */
export interface ProcessAddRepoDeps {
  /** String-returning `gh` runner (comment, close, worker-user lookup). */
  runGhCommand?: (args: string[]) => Promise<string>;
  /** `CommandOutput`-returning runner used by {@link validateAddRepoTarget}. */
  runCommand?: RunCommand;
  /** Filesystem read for {@link addRepoToMonitoredList}. */
  readTextFile?: (path: string) => Promise<string>;
  /** Filesystem write for {@link addRepoToMonitoredList}. */
  writeTextFile?: (path: string, data: string) => Promise<void>;
  /** Clock, threaded into wrapper seeding. */
  now?: () => Date;
  /** Config path override (defaults to `CONFIG_PATH` env or `.config.json`). */
  configPath?: string;
  /** Validate seam. Defaults to {@link validateAddRepoTarget}. */
  validateFn?: (
    repo: string,
  ) => Promise<Result<AddRepoTargetStatus, string>>;
  /** Append-to-monitored-list seam. Defaults to {@link addRepoToMonitoredList}. */
  addRepoFn?: (
    repo: string,
    configPath: string,
  ) => Promise<Result<{ added: boolean }>>;
  /** Wrapper-seeding seam. Defaults to {@link createAllIdleTaskWrappers}. */
  createWrappersFn?: (
    repo: string,
  ) => Promise<Result<CreateAllIdleTaskWrappersResult>>;
  /** Label-sync seam (Issue #2599). Defaults to {@link syncLabelsForRepo}. */
  syncLabelsFn?: (repo: string) => Promise<LabelSyncResult>;
  /**
   * Branch-protection seam (Issue #2589). Receives the target repo and the
   * visibility resolved during validation. Defaults to a wired
   * {@link syncBranchProtectionForRepo}.
   */
  configureBranchProtectionFn?: (
    repo: string,
    visibility: RepoVisibility,
  ) => Promise<SyncResult>;
  /** Escalation seam. Defaults to a wired {@link escalateToHuman}. */
  escalateFn?: (args: EscalateArgs) => Promise<void>;
  /** Worker-login lookup for the remediation command. */
  resolveWorkerUserFn?: () => Promise<string | undefined>;
  /** Logger. Defaults to {@link createLogger}. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Comment builders (exported for testing)
// ---------------------------------------------------------------------------

/** Comment posted when the issue title carries no valid `owner/repo`. */
export function buildUnparseableComment(title: string): string {
  return (
    "## Add-repo could not start\n\n" +
    "Could not parse an `owner/repo` from this title:\n\n" +
    `> ${title.trim()}\n\n` +
    "Re-open with a title of the form `add-repo: owner/repo` " +
    "(for example `add-repo: stSoftwareAU/private-repo-11`)."
  );
}

/** One-line, human-readable summary of the canonical label sync. */
export function buildLabelSyncLine(labels: LabelSyncSummary): string {
  if (labels.error !== undefined) {
    return `⚠️ Canonical label sync failed (${labels.error}) — schedule ` +
      "labels may be incomplete; a later setup/idle sync will reconcile.";
  }
  const counts = `created ${labels.created}, updated ${labels.updated}`;
  if (labels.failures > 0) {
    return `⚠️ Canonical labels synced with ${labels.failures} failure(s) ` +
      `(${counts}).`;
  }
  return `Canonical labels synced (${counts}) — issues can be scheduled now.`;
}

/** One-line, human-readable summary of the branch-enforcement step. */
export function buildBranchProtectionLine(bp: BranchProtectionSummary): string {
  if (!bp.ok) {
    const reason = bp.error ?? "unknown error";
    return `⚠️ Branch enforcement could not be configured (${reason}) — the ` +
      "default branch may be unprotected; a setup-time " +
      "`branch-protection-sync` will reconcile.";
  }
  const branchPart = bp.branch !== undefined ? ` on \`${bp.branch}\`` : "";
  if (bp.changed) {
    const addedPart = bp.added.length > 0
      ? ` (required checks: ${bp.added.join(", ")})`
      : "";
    return `Default-branch ruleset configured${branchPart}${addedPart}.`;
  }
  if (bp.skipped === "direct-push-branch" || bp.skipped === "opted-out") {
    const why = bp.skipped === "opted-out"
      ? "the repo opted out"
      : "the default branch takes direct pushes";
    const detailPart = bp.detail ? ` — ${bp.detail}` : "";
    return `Default-branch ruleset not applied${branchPart}: ${why}` +
      `${detailPart}. A required-status-checks ruleset would refuse every ` +
      "direct push (Issue #4356).";
  }
  return `Default-branch ruleset already in place${branchPart} (no change).`;
}

/** Success summary comment posted before closing the issue. */
export function buildSuccessComment(opts: {
  repo: string;
  added: boolean;
  visibility: string;
  created: readonly string[];
  skipped: readonly string[];
  labels: LabelSyncSummary;
  branchProtection: BranchProtectionSummary;
}): string {
  const {
    repo,
    added,
    visibility,
    created,
    skipped,
    labels,
    branchProtection,
  } = opts;
  const repoLine = added
    ? `\`${repo}\` was added to the monitored list.`
    : `\`${repo}\` was already present (no change).`;
  const createdLine = created.length > 0 ? created.join(", ") : "none";
  const skippedLine = skipped.length > 0 ? skipped.join(", ") : "none";
  return (
    "## Add-repo complete\n\n" +
    `- **Repository:** ${repoLine}\n` +
    `- **Detected visibility:** ${visibility}\n` +
    `- **Canonical labels:** ${buildLabelSyncLine(labels)}\n` +
    `- **Branch protection:** ${
      buildBranchProtectionLine(branchProtection)
    }\n` +
    `- **Idle-task wrappers created:** ${createdLine}\n` +
    `- **Idle-task wrappers skipped (already open):** ${skippedLine}\n\n` +
    "The ten idle-task scans (security, best-practices, test-audit, " +
    "github-actions-audit, supply-chain-readiness, orphan-deps, dead-code, " +
    "doc-coverage, format-drift, deprecated-api) will bring this repo up to " +
    "standard over the coming idle cycles."
  );
}

/** Reason + next-step text for an unreachable / inaccessible target. */
export function buildEscalationText(
  status: "not_found" | "no_access",
  repo: string,
  workerUser: string,
): { reason: string; nextStep: string } {
  const remediation =
    `gh api -X PUT repos/${repo}/collaborators/${workerUser} -f permission=triage`;
  const reason = status === "not_found"
    ? `The target repository \`${repo}\` could not be found, or the worker ` +
      `token cannot see it (404/403). It was NOT added to the monitored list.`
    : `The worker has read access to \`${repo}\` but cannot be assigned ` +
      `issues there (\`triage\` permission is false). It was NOT added to ` +
      `the monitored list.`;
  const nextStep =
    "Grant the worker triage (assignable) access as a repo admin, then " +
    "re-file the add-repo issue:\n\n" +
    "```bash\n" + remediation + "\n```";
  return { reason, nextStep };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const processAddRepoCommand: Command = {
  name: "process-add-repo",
  description:
    "Orchestrate the add-repo flow for one `add-repo:` issue: parse the " +
    "title, validate the target, append to the monitored list, seed the " +
    "ten idle-task wrappers, then comment and close (or escalate to a " +
    "human). Issue #2578.",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<ProcessAddRepoData>> {
    const repo = String(args["repo"] ?? "");
    const issueNumber = Number(args["issue-number"]);
    const title = String(args["title"] ?? "");

    const deps: ProcessAddRepoDeps =
      (args["__testDeps"] as ProcessAddRepoDeps | undefined) ?? {};
    const logger = deps.logger ?? createLogger();

    if (repo.length === 0) {
      return { success: false, message: "Missing required argument: --repo" };
    }
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      return {
        success: false,
        message: "Missing or invalid required argument: --issue-number",
      };
    }

    // Wire the low-level deps to their production defaults.
    const runGhCommand = deps.runGhCommand ?? defaultGhCommand;
    const runCommand: RunCommand = deps.runCommand ?? defaultRunCommand;
    const now = deps.now ?? (() => new Date());
    const configPath = deps.configPath ??
      Deno.env.get("CONFIG_PATH") ?? ".config.json";

    // High-level seams, each defaulting to a wired production implementation.
    const validateFn = deps.validateFn ??
      ((r: string) => validateAddRepoTarget(r, { runCommand }));
    const addRepoFn = deps.addRepoFn ??
      ((r: string, cp: string) =>
        addRepoToMonitoredList(r, cp, {
          readTextFile: deps.readTextFile ?? ((p) => Deno.readTextFile(p)),
          writeTextFile: deps.writeTextFile ??
            ((p, d) => Deno.writeTextFile(p, d)),
        }));
    const createWrappersFn = deps.createWrappersFn ??
      ((r: string) =>
        createAllIdleTaskWrappers(r, {
          ghCommandFn: runGhCommand,
          nowFn: now,
        }));
    // Label sync reuses the same inherited-env gh identity as the validate
    // path (defaultRunCommand); no ghConfigDir wiring is needed here.
    const syncLabelsFn = deps.syncLabelsFn ??
      ((r: string) => syncLabelsForRepo(r));
    // Branch-protection config reuses the same inherited-env gh identity as
    // the validate/label paths; the visibility resolved in step 2 is passed
    // through so no redundant visibility read is performed here.
    const configureBranchProtectionFn = deps.configureBranchProtectionFn ??
      ((r: string, vis: RepoVisibility) =>
        syncBranchProtectionForRepo(r, { visibility: vis }));
    const resolveWorkerUserFn = deps.resolveWorkerUserFn ??
      (() => resolveWorkerUser(runGhCommand));
    const escalateFn = deps.escalateFn ??
      ((escalation: EscalateArgs) =>
        defaultEscalate(escalation, {
          runGhCommand,
          needsHumanLabel: config.needsHumanLabel,
          logger,
        }));

    // -------------------------------------------------------------------
    // Step 1: parse the title.
    // -------------------------------------------------------------------
    const parsed = parseAddRepoTitle(title);
    if (parsed === null) {
      logger.info("process-add-repo: unparseable title", { repo, title });
      await closeWithComment(
        runGhCommand,
        repo,
        issueNumber,
        buildUnparseableComment(title),
        logger,
      );
      return {
        success: true,
        message: "process-add-repo: unparseable title — commented and closed",
        data: { outcome: "unparseable" },
      };
    }
    const targetRepo = parsed.repo;

    // -------------------------------------------------------------------
    // Step 2: validate the target.
    // -------------------------------------------------------------------
    const validation = await validateFn(targetRepo);
    if (!validation.ok) {
      // Transient validation failure (e.g. the visibility lookup itself
      // errored). Leave the issue open so the next loop iteration retries
      // rather than escalating or closing on a flake.
      logger.warn("process-add-repo: validation error", {
        repo: targetRepo,
        error: validation.error,
      });
      return {
        success: false,
        message: `process-add-repo: validation failed: ${validation.error}`,
        data: { outcome: "error", repo: targetRepo },
      };
    }

    const status = validation.value;
    if (status.kind === "not_found" || status.kind === "no_access") {
      const workerUser = (await resolveWorkerUserFn()) ?? "<worker-user>";
      const { reason, nextStep } = buildEscalationText(
        status.kind,
        targetRepo,
        workerUser,
      );
      logger.warn("process-add-repo: escalating inaccessible target", {
        repo: targetRepo,
        status: status.kind,
      });
      // escalateToHuman is the only sanctioned path to `needs-human`; it
      // posts the remediation comment and applies the label atomically.
      // The repo is NOT added and no wrappers are filed.
      await escalateFn({ repo, issueNumber, reason, nextStep });
      return {
        success: true,
        message:
          `process-add-repo: ${status.kind} — escalated to human, repo not added`,
        data: { outcome: status.kind, repo: targetRepo },
      };
    }

    // status.kind === "ok". Visibility is captured for the summary only —
    // no public-vs-private gating here (deferred to #2571).
    const visibility = status.visibility;

    // -------------------------------------------------------------------
    // Step 3: append to the monitored list (idempotent).
    // -------------------------------------------------------------------
    const addResult = await addRepoFn(targetRepo, configPath);
    if (!addResult.ok) {
      logger.warn("process-add-repo: failed to add repo", {
        repo: targetRepo,
        error: addResult.error.message,
      });
      return {
        success: false,
        message:
          `process-add-repo: failed to add ${targetRepo}: ${addResult.error.message}`,
        data: { outcome: "error", repo: targetRepo },
      };
    }
    const added = addResult.value.added;

    // -------------------------------------------------------------------
    // Step 4: sync the full canonical label set (Issue #2599).
    //
    // Runs before wrapper seeding so the canonical labels — including
    // `idle-task` — exist on the repo first. Non-fatal: a failure is
    // reported in the summary but does not abort onboarding (the worker
    // has write access, so labels rarely need human action). Idempotent,
    // so a later setup/idle sync over the same repo is a safe no-op.
    // -------------------------------------------------------------------
    const labels = await runLabelSync(syncLabelsFn, targetRepo, logger);

    // -------------------------------------------------------------------
    // Step 5: configure default-branch protection (Issue #2589).
    //
    // Applies the GitHub branch-protection "wall" (Issue #2586) to the
    // onboarded repo so it inherits the same pre-merge enforcement as
    // existing repos — immediately, rather than only on the next manual
    // `setup.sh`. The visibility resolved in step 2 is forwarded, so the
    // visibility-aware required-check selection never marks an
    // unsatisfiable check as required. Non-fatal: a failure is reported in
    // the summary (never silently swallowed) but does not abort onboarding;
    // the idempotent setup-time `branch-protection-sync` will reconcile.
    // -------------------------------------------------------------------
    const branchProtection = await runBranchProtection(
      configureBranchProtectionFn,
      targetRepo,
      visibility,
      logger,
    );

    // -------------------------------------------------------------------
    // Step 6: seed all ten idle-task wrappers (idempotent).
    // -------------------------------------------------------------------
    const wrapResult = await createWrappersFn(targetRepo);
    if (!wrapResult.ok) {
      logger.warn("process-add-repo: failed to seed wrappers", {
        repo: targetRepo,
        error: wrapResult.error.message,
      });
      return {
        success: false,
        message:
          `process-add-repo: failed to seed wrappers for ${targetRepo}: ${wrapResult.error.message}`,
        data: { outcome: "error", repo: targetRepo },
      };
    }
    const { created, skipped } = wrapResult.value;

    // -------------------------------------------------------------------
    // Step 7: success comment + close.
    // -------------------------------------------------------------------
    await closeWithComment(
      runGhCommand,
      repo,
      issueNumber,
      buildSuccessComment({
        repo: targetRepo,
        added,
        visibility,
        created,
        skipped,
        labels,
        branchProtection,
      }),
      logger,
    );

    return {
      success: true,
      message:
        `process-add-repo: ${
          added ? "added" : "already present"
        } ${targetRepo}; ` +
        `labels created=${labels.created} updated=${labels.updated} ` +
        `failures=${labels.failures}; ` +
        `branch-protection ${
          branchProtection.ok
            ? (branchProtection.changed ? "configured" : "already in place")
            : `failed (${branchProtection.error ?? "unknown"})`
        }; ` +
        `wrappers created=${created.length} skipped=${skipped.length}`,
      data: {
        outcome: added ? "added" : "already_present",
        repo: targetRepo,
        visibility,
        created,
        skipped,
        labels,
        branchProtection,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default `CommandOutput` runner backed by `Deno.Command`, mirroring the
 * collaborator-precheck runner. Used by {@link validateAddRepoTarget}.
 *
 * Issue #1218: a `gh` command is delegated to the shared chokepoint. The
 * add-repo route takes `owner/repo` from an issue **title**, so the `gh`
 * calls made on its behalf act against a requester-named repository; spawning
 * `gh` here directly put them outside `enforceGhWriteAllowlist`, outside
 * `redactGhBodyArgs` and — the loss that matters most — outside
 * `auditGhMutation`, so the mutation left no entry in the tamper-evident
 * journal `audit-chain-verify` reads. The build check could not see it
 * either: `GH_SPAWN_PATTERN` matches only a literal `Deno.Command("gh", …)`,
 * and this spawn names its binary through `cmd[0]`. Same treatment as the
 * sanctioned runner in `lib/purge_stale_workflow_issues.ts`.
 */
export const defaultRunCommand: RunCommand = async (cmd: string[]) => {
  if (cmd[0] === "gh") {
    const result = await spawnGh(cmd.slice(1));
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
};

/**
 * Run the canonical label sync for the target repo and reduce the result
 * to a compact summary. Non-fatal: a thrown error is caught, logged, and
 * recorded in the summary so onboarding still completes (Issue #2599).
 */
async function runLabelSync(
  syncLabelsFn: (repo: string) => Promise<LabelSyncResult>,
  targetRepo: string,
  logger: Logger,
): Promise<LabelSyncSummary> {
  try {
    const result = await syncLabelsFn(targetRepo);
    if (result.failures > 0) {
      logger.warn("process-add-repo: some canonical labels failed to sync", {
        repo: targetRepo,
        created: result.created,
        updated: result.updated,
        failures: result.failures,
      });
    }
    return {
      created: result.created,
      updated: result.updated,
      failures: result.failures,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("process-add-repo: canonical label sync threw (non-fatal)", {
      repo: targetRepo,
      error: message,
    });
    return { created: 0, updated: 0, failures: 0, error: message };
  }
}

/**
 * Configure default-branch protection for the onboarded repo and reduce the
 * result to a compact summary (Issue #2589). Non-fatal: the underlying
 * {@link syncBranchProtectionForRepo} already captures every failure in its
 * `SyncResult`, but an unexpected throw is also caught and recorded so
 * onboarding still completes. A failure is reported in the summary, never
 * silently swallowed.
 */
async function runBranchProtection(
  configureFn: (
    repo: string,
    visibility: RepoVisibility,
  ) => Promise<SyncResult>,
  targetRepo: string,
  visibility: RepoVisibility,
  logger: Logger,
): Promise<BranchProtectionSummary> {
  try {
    const result = await configureFn(targetRepo, visibility);
    if (!result.ok) {
      logger.warn("process-add-repo: branch-protection config failed", {
        repo: targetRepo,
        error: result.error,
      });
    }
    return {
      ok: result.ok,
      changed: result.changed,
      added: result.added,
      branch: result.branch,
      skipped: result.skipped,
      detail: result.detail,
      error: result.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      "process-add-repo: branch-protection config threw (non-fatal)",
      {
        repo: targetRepo,
        error: message,
      },
    );
    return { ok: false, changed: false, added: [], error: message };
  }
}

/** Resolve the authenticated worker login via `gh api user`. */
async function resolveWorkerUser(
  gh: (args: string[]) => Promise<string>,
): Promise<string | undefined> {
  try {
    const login = (await gh(["api", "user", "--jq", ".login"])).trim();
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}

/** Close the triggering issue as completed, attaching a summary comment. */
async function closeWithComment(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  issueNumber: number,
  comment: string,
  logger: Logger,
): Promise<void> {
  try {
    await gh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--reason",
      "completed",
      "--comment",
      comment,
    ]);
  } catch (err) {
    logger.warn("process-add-repo: failed to comment/close issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Default escalation: post the remediation comment and apply `needs-human`. */
async function defaultEscalate(
  args: EscalateArgs,
  ctx: {
    runGhCommand: (a: string[]) => Promise<string>;
    needsHumanLabel: string;
    logger: Logger;
  },
): Promise<void> {
  await escalateToHuman({
    ghClient: createGhEscalationClient(ctx.runGhCommand),
    repo: args.repo,
    target: { kind: "issue", number: args.issueNumber },
    needsHumanLabel: ctx.needsHumanLabel,
    heading: "Add-repo target needs human attention",
    reason: args.reason,
    nextStep: args.nextStep,
    ensureLabelColour: "d4c5f9",
    ensureLabelDescription: "Worker needs human action to add a repo",
    deps: {
      github: {
        ensureLabelExists: (r, l, c, d) =>
          ensureLabelExists(r, l, c, d, { ghCommandFn: ctx.runGhCommand }),
      },
    },
    logger: ctx.logger,
  });
}
