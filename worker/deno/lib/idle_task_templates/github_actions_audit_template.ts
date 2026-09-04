/**
 * GitHub Actions audit idle-task template (Issue #2256, parent #2243,
 * template #4).
 *
 * Runs the `prompts/github_actions_audit/prompt.md` audit against the target
 * repository's GitHub Actions material, pre-files an actionlint-in-CI
 * finding (when actionlint is not invoked from CI), pre-files runner
 * deprecation findings surfaced by `runner_deprecation_scanner.ts`,
 * then invokes Claude with the remaining work and files each surviving
 * finding as its own `github-actions-audit`-labelled issue.
 *
 * Modelled on `best_practices_template.ts` (inherits the pre-filers) and
 * `test_audit_template.ts` (single bucket, weekly cadence, label-ensure
 * up front).
 *
 *   - **Outcome-only Claude contract.** The orchestrating prompt
 *     instructs Claude to file findings directly via `gh issue create`.
 *     `runTask` verifies the outcome by diffing the repo's open
 *     `github-actions-audit` issues before and after the scan — no JSON
 *     parsing.
 *   - **Label-ensure first.** The `github-actions-audit` label is not
 *     seeded anywhere else, so `runTask` ensures it exists before any
 *     filing. The `severity:*` labels already exist in monitored repos
 *     (the security-scan and best-practices templates seeded them).
 *   - **Actionlint-in-CI pre-check.** When actionlint is not invoked
 *     in CI, file a `BP-LINTER-github-actions` `severity:high` finding
 *     (back-compat with findings filed by the daily best-practices
 *     `github-actions` bucket).
 *   - **Runner-deprecation pre-filer.** Each surviving deprecation
 *     finding becomes its own `github-actions-audit` issue. Helpers
 *     live in `lib/runner_deprecation_filer.ts` — shared with the
 *     best-practices `github-actions` bucket.
 *   - **Native SHA-pin pre-filer (Issue #2501).** Each unpinned
 *     third-party `uses:` becomes its own `severity:high` issue via
 *     `action_pin_scanner.ts`.
 *   - **Native permissions pre-filer (Issue #2502).** Each workflow/job
 *     with no `permissions:` block (inherits the broad default) or a
 *     `permissions: write-all` grant becomes its own `severity:medium`
 *     issue via `workflow_permissions_scanner.ts` — the decidable core
 *     of v7 prompt check #2.
 *   - **Native script-injection pre-filer (Issue #2503).** Each `run:`
 *     step interpolating an attacker-controllable `${{ github.* }}` field
 *     directly into the shell becomes its own `severity:high` issue via
 *     `run_injection_scanner.ts` — the decidable core of v7 prompt check
 *     #22.
 *   - **Native workflow-trigger pre-filer (Issue #2587).** Each
 *     test/lint/scan workflow that still triggers on push to the default
 *     branch becomes its own `severity:low` issue via
 *     `workflow_trigger_scanner.ts` (classified by #2585). The YAML fix
 *     (drop `push:` to default) rides a normal worker PR through the
 *     pre-merge gate — the scan itself raises no PR.
 *   - **Native checkout-persist-credentials pre-filer (Issue #2845).**
 *     Each `actions/checkout` step lacking `persist-credentials: false`
 *     in a job that gives no static signal of needing the persisted
 *     token becomes its own `severity:medium` issue via
 *     `checkout_persist_credentials_scanner.ts` — the deterministic
 *     native counterpart to the long-documented but never-implemented
 *     v3-slot check #23 (gap from #2834).
 *   - **Native broad-artefact-upload pre-filer (Issue #2846).** Each
 *     `actions/upload-artifact` step whose `with.path` is the whole
 *     workspace (`.`, `./`, `${{ github.workspace }}`, `*`, `**`) becomes
 *     its own issue via `artifact_upload_scanner.ts` — `severity:low`
 *     baseline, `severity:medium` when the job has secrets or runs under a
 *     privileged trigger. The decidable core of v9 prompt check #30 (gap
 *     from #2834).
 *   - **Native milestone-branch-filter pre-filer (Issue #3360).** Each CI
 *     quality workflow (test/lint/scan) whose `pull_request` branch filter
 *     misses milestone feature branches (`milestone/<slug>`, Issue #1300)
 *     becomes its own `severity:medium` issue via
 *     `milestone_branch_filter_scanner.ts`, so milestone sub-issue PRs are
 *     never merged past the gate unchecked. Per Issue #3239 isolation the
 *     YAML fix rides a normal per-repo worker PR — no cross-repo gate.
 *   - **Native gitleaks-drift pre-filer (Issue #598, part of #566).** The
 *     `gitleaks` spec detects presence by pattern, so a stale per-repo copy
 *     passes the audit for merely mentioning gitleaks. Each drifted copy —
 *     milestone-blind branch filter, stale `gitleaks-action` pin, no
 *     licence-less CLI fallback, or no `pull_request` trigger at all —
 *     becomes its own `severity:medium` issue via
 *     `gitleaks_drift_scanner.ts`. It runs straight after the
 *     milestone-branch-filter pre-filer so the branch gap is never filed
 *     twice.
 *   - **Observed gitleaks coverage (Issue #601, part of #566).** Presence
 *     is not execution: a committed workflow never runs when Actions are
 *     disabled, the workflow is disabled in the UI, its branch filter
 *     misses the PRs' base, or its YAML does not parse. The repo's recent
 *     closed PRs are sampled and their check runs read via
 *     `gitleaks_pr_coverage_scanner.ts`; when no gitleaks check reported
 *     on any of them a single `severity:medium`
 *     `BP-GITLEAKS-NOT-OBSERVED` issue is filed, naming the sampled PRs. A
 *     partial or failed sample is logged and stated in the evidence,
 *     never reported as clean.
 *   - **Native unpinned-CI-install pre-filer (Issue #3668, split out of
 *     #3642).** Each `run:`-level package install with no exact version
 *     pin (`npm install -g <pkg>`, `npx --yes <pkg>`, `gem install
 *     <pkg>`) becomes its own `severity:medium` issue via
 *     `ci_install_pin_scanner.ts`, consolidated one per package
 *     coordinate. `action_pin_scanner.ts` only inspects `uses:`, so these
 *     installs previously sat outside every native pre-filer — and
 *     outside the repo's dependency quarantine, which only covers
 *     manifests.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once
 *     per week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the only
 * thing callers need to do.
 *
 * Australian English used throughout (behaviour, organisation,
 * authorised).
 */

import {
  type IdleTaskBodyOptions,
  idleTaskPromptsDir,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import {
  diffNewlyFiled,
  fileFindingOnce,
  listAllOpenIssueTitles,
  listKnownOpenFindingIds,
  listOpenIssueNumbersByLabel,
  type OpenIssueTitle,
  parseGhJsonArray,
  renderOpenIssueTitles,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import {
  checkLinterInCI as defaultCheckLinterInCI,
  type LinterCheckResult,
} from "../linter_in_ci_check.ts";
import {
  type DeprecationFinding,
  type GhCommandFn,
  scanRecentRunsForDeprecations as defaultScanRunnerDeprecations,
} from "../runner_deprecation_scanner.ts";
import { fileRunnerDeprecationIssue as sharedFileRunnerDeprecationIssue } from "../runner_deprecation_filer.ts";
import {
  type ActionPinFinding,
  extractUsesValue,
  scanActionPins,
} from "../action_pin_scanner.ts";
import {
  buildAllowedActionPatterns,
  resolveTransitiveActionCoordinates,
} from "../repo_settings_harden.ts";
import {
  scanWorkflowPermissions,
  type WorkflowPermissionsFinding,
} from "../workflow_permissions_scanner.ts";
import {
  type RunInjectionFinding,
  scanRunInjection,
} from "../run_injection_scanner.ts";
import {
  scanWorkflowTriggers,
  type WorkflowTriggerFinding,
} from "../workflow_trigger_scanner.ts";
import {
  type CheckoutPersistCredentialsFinding,
  scanCheckoutPersistCredentials,
} from "../checkout_persist_credentials_scanner.ts";
import {
  type ArtifactUploadFinding,
  scanArtifactUploads,
} from "../artifact_upload_scanner.ts";
import {
  type MilestoneBranchFilterFinding,
  scanMilestoneBranchFilters,
} from "../milestone_branch_filter_scanner.ts";
import {
  type GitleaksDriftFinding,
  scanGitleaksDrift,
} from "../gitleaks_drift_scanner.ts";
import {
  type GitleaksPrCoverageFinding,
  scanGitleaksPrCoverage,
} from "../gitleaks_pr_coverage_scanner.ts";
import {
  type CiInstallPinFinding,
  scanCiInstallPins,
} from "../ci_install_pin_scanner.ts";
import {
  type ActionAdvisoryFinding,
  scanActionAdvisories,
} from "../action_advisory_scanner.ts";
import {
  type RepoSettingsFinding,
  scanRepoSettings,
} from "../repo_settings_scanner.ts";
import {
  scanWorkerTokenPrivileges,
  type WorkerTokenPrivilegeFinding,
} from "../worker_token_privilege_scanner.ts";
import { getRepoDefaultBranch } from "../shell_helpers.ts";
import {
  fileWorkflowFinding,
  readWorkflowFiles as defaultReadWorkflowFiles,
  type WorkflowFile,
} from "../workflow_scan_common.ts";
import {
  renderActionsCatalogueTable,
  renderEolRuntimesTable,
} from "../github_actions_catalogue.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import type { IdleTaskClaudeRunner } from "../idle_task_claude_budget.ts";
import type { ModelTier } from "../token_usage.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import { buildPromptPreviewBody } from "../idle_task_body_preview.ts";
import type { Logger, Result } from "../../types.ts";
import { defaultLogger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "github-actions-audit";

const DESCRIPTION =
  "Run the GitHub Actions audit against the target repository's " +
  "workflows and composite actions, and file each surviving finding as " +
  "its own issue.";

/** Label every filed github-actions-audit finding (and wrapper) carries. */
/**
 * Every repository `uses:` reference in the workflow files, resolved through
 * composite actions' own manifests to `<owner>/<repo>@*` patterns
 * (Issue #4424).
 */
async function defaultRequiredActionPatterns(
  files: readonly WorkflowFile[],
  ghCommandFn: GhCommandFn,
): Promise<string[]> {
  const references = new Set<string>();
  for (const file of files) {
    for (const line of file.rawText.split("\n")) {
      const value = extractUsesValue(line);
      if (!value || value.startsWith(".") || value.startsWith("docker://")) {
        continue;
      }
      references.add(value);
    }
  }
  const resolved = await resolveTransitiveActionCoordinates(
    [...references].sort(),
    ghCommandFn,
  );
  return buildAllowedActionPatterns(resolved.coordinates);
}

export const GITHUB_ACTIONS_AUDIT_LABEL = "github-actions-audit";

/** Static wrapper title — dispatch matches against this string. */
export const GITHUB_ACTIONS_AUDIT_ISSUE_TITLE = "Run a GitHub Actions audit";

/** Colour seed for the `github-actions-audit` label (matches prompt). */
export const GITHUB_ACTIONS_AUDIT_LABEL_COLOUR = "B60205";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "github_actions_audit";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a github-actions-audit
 * wrapper. Anchored to the prompt's H1 — `# GitHub Actions Audit —
 * Workflow-Focused Review (v1)`.
 */
export const GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT =
  /^#+\s+GitHub Actions Audit\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createGitHubActionsAuditTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure, linter-in-CI check, runner-deprecation
 * scanner) so they never touch the network or block on Claude.
 */
export interface GitHubActionsAuditTemplateDeps {
  /** gh CLI runner used for snapshots, dedup, and pre-filing. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /**
   * Ensure the `github-actions-audit` label exists in the target repo.
   * Defaults to `ensureLabelExists`.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Linter-in-CI pre-check — defaults to the real check, hard-wired to
   * the `github-actions` bucket so this template only audits actionlint.
   */
  checkLinterInCIFn?: (
    repoPath: string,
  ) => Promise<LinterCheckResult>;
  /**
   * Runner-deprecation scanner — defaults to the production
   * `scanRecentRunsForDeprecations`. Tests inject a stub that returns a
   * fixed list of findings (or throws to exercise the error path).
   */
  scanRunnerDeprecationsFn?: (
    repo: string,
    ghCommandFn: GhCommandFn,
  ) => Promise<DeprecationFinding[]>;
  /**
   * Read the repo's workflow and composite-action files for the native
   * SHA-pin pre-filer (Issue #2501). Defaults to `readWorkflowFiles`.
   * Tests inject a stub returning fixed {@link WorkflowFile} entries so
   * they exercise the pre-filer without a real `.github/` tree.
   */
  readWorkflowFilesFn?: (workDir: string) => Promise<WorkflowFile[]>;
  /**
   * Observed gitleaks coverage on recent PRs (Issue #601). Defaults to
   * `scanGitleaksPrCoverage`; tests inject a stub. Read-only — it lists
   * closed PRs and reads their check runs, and files nothing when the repo
   * has no gitleaks workflow.
   */
  scanGitleaksPrCoverageFn?: (
    repo: string,
    files: readonly WorkflowFile[],
    ghCommandFn: GhCommandFn,
    options: {
      knownOpenFindingIds: Iterable<string>;
      onSamplingNote: (note: string) => void;
    },
  ) => Promise<GitleaksPrCoverageFinding[]>;
  /**
   * GHSA cross-check of pinned actions (Issue #4405). Defaults to
   * `scanActionAdvisories` over `ghCommandFn`; tests inject a stub.
   */
  scanActionAdvisoriesFn?: (
    files: WorkflowFile[],
    ghCommandFn: GhCommandFn,
    knownOpenFindingIds: Iterable<string>,
    onLookupFailure: (coordinate: string, reason: string) => void,
  ) => Promise<ActionAdvisoryFinding[]>;
  /**
   * Repository-settings drift (Issues #4397, #4398, #4401). Defaults to
   * `scanRepoSettings`; tests inject a stub. `hasCodeowners` is resolved
   * from the checkout by the template.
   */
  scanRepoSettingsFn?: (
    repo: string,
    ghCommandFn: GhCommandFn,
    options: {
      defaultBranch: string;
      hasCodeowners: boolean;
      knownOpenFindingIds: Iterable<string>;
      onLookupFailure: (what: string, reason: string) => void;
      requiredActionPatterns?: readonly string[];
    },
  ) => Promise<RepoSettingsFinding[]>;
  /**
   * Worker-token privilege check (Issue #599). Defaults to
   * `scanWorkerTokenPrivileges`; tests inject a stub. Read-only — it never
   * probes ruleset access with a write.
   */
  scanWorkerTokenPrivilegesFn?: (
    repo: string,
    ghCommandFn: GhCommandFn,
    options: {
      knownOpenFindingIds: Iterable<string>;
      onLookupFailure: (what: string, reason: string) => void;
    },
  ) => Promise<WorkerTokenPrivilegeFinding[]>;
  /**
   * Ensure the escalation labels a worker-token finding carries
   * (`needs-human`, `security`) exist in the target repo before it is filed
   * — `gh issue create` fails outright on an unknown label. Defaults to
   * `ensureLabelExists` per label; tests inject a stub.
   */
  ensureFindingLabelsFn?: (
    repo: string,
    labels: readonly string[],
  ) => Promise<void>;
  /**
   * `<owner>/<repo>@*` patterns the workflows need, following composite
   * actions' own `uses:` (Issue #4424). Defaults to reading each action's
   * manifest at its pinned ref via `gh api`; tests inject a stub.
   */
  requiredActionPatternsFn?: (
    files: readonly WorkflowFile[],
    ghCommandFn: GhCommandFn,
  ) => Promise<string[]>;
  /**
   * Resolve the target repo's default branch for the native
   * trigger-audit pre-filer (Issue #2587). Defaults to
   * `getRepoDefaultBranch`. Tests inject a stub returning a fixed branch
   * (or an error) so they exercise the pre-filer without a real gh call.
   */
  getDefaultBranchFn?: (repo: string) => Promise<Result<string>>;
  /**
   * Where the persistent default-branch cache lives (Issue #964). Only
   * consulted by the default `getDefaultBranchFn`. Defaults to the cache
   * module's own resolution, so production passes nothing; a test names a
   * throwaway path instead of pointing the whole process at one with
   * `Deno.env.set`.
   */
  defaultBranchCachePath?: string;
  /**
   * Audit scan runner — invokes Claude with the assembled prompt.
   * Defaults to the production `claude_runner` wrapper. Tests inject a
   * stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
  /**
   * Logger for native pre-filer failures (Issue #3953). Defaults to
   * `defaultLogger`. The native pre-filer block used to swallow every
   * throw, so a scanner fault read as "no findings" — a clean audit. It
   * now fails loud in the worker log; tests inject a spy to assert that.
   */
  logger?: Logger;
}

/** Inputs to a github-actions-audit Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `github-actions-audit` issues — skip-list. */
  knownOpenFindingIds: string[];
  /**
   * Every issue currently open in the repo, whatever its label — the
   * cross-label dedup list (Issue #537).
   */
  openIssueTitles: OpenIssueTitle[];
  /** Stable ids the run should suppress (in-source markers, prior triage). */
  suppressedIds: string[];
  /**
   * Model tier the wrapper was filed for (Issue #4010). Passed through as
   * `RunClaudeOptions.model`; omitted leaves the phase default in force.
   */
  model?: ModelTier;
}

/** Discriminated failure mode from `runScanFn`. */
export interface ScanError {
  kind: "prompt" | "claude" | "timeout";
  message: string;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute the four placeholders defined by
 * `prompts/github_actions_audit/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `assembleTestAuditPrompt` so wrappers read naturally standalone and
 * inline. The catalogue tables are always rendered at file time (this
 * template is single-bucket — `github-actions` is the only scope).
 *
 * Pure — no I/O.
 */
export function assembleGitHubActionsAuditPrompt(
  template: string,
  opts: {
    suppressedIds: readonly string[];
    knownOpenFindingIds: readonly string[];
    /**
     * Every issue currently open in the target repo, whatever its
     * label (Issue #537) — the semantic second line of dedup. An
     * empty list renders the `(none)` sentinel.
     */
    openIssueTitles?: readonly OpenIssueTitle[];
    attributionFooter?: string;
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const openIssues = renderOpenIssueTitles(opts.openIssueTitles ?? []);
  const footer = opts.attributionFooter ?? "";
  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues)
    .replaceAll("{{ATTRIBUTION_FOOTER}}", footer)
    .replaceAll("{{ACTIONS_CATALOGUE_TABLE}}", renderActionsCatalogueTable())
    .replaceAll("{{EOL_RUNTIMES_TABLE}}", renderEolRuntimesTable());
}

// ---------------------------------------------------------------------------
// gh snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an open wrapper titled exactly `Run a GitHub Actions
 * audit` already exists in `repo`. A gh failure is treated as "no open
 * wrapper" so the gate never stalls on a transient hiccup.
 */
async function hasOpenAuditWrapper(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `"${GITHUB_ACTIONS_AUDIT_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (
    const item of parseGhJsonArray(raw, "find github-actions-audit wrapper")
  ) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" &&
      title.trim() === GITHUB_ACTIONS_AUDIT_ISSUE_TITLE
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Actionlint-in-CI pre-filer
// ---------------------------------------------------------------------------

/**
 * File a synthetic actionlint-missing-in-CI `github-actions-audit`
 * issue and return its number plus the stable finding id.
 *
 * **Back-compat:** the stable id retains the `BP-LINTER-github-actions`
 * shape used by the daily best-practices `github-actions` bucket so
 * dedup with findings filed by the old path continues to work.
 *
 * Returns `null` on any gh failure — the caller logs the issue in the
 * summary and continues.
 */
async function fileActionlintMissingIssue(
  repo: string,
  check: LinterCheckResult,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const findingId = `BP-LINTER-github-actions`;
  const title = `🟠 Missing CI lint gate for \`github-actions\``;
  const body = [
    `<!-- finding-id: ${findingId} -->`,
    "",
    `**Bucket:** \`github-actions\``,
    `**Severity:** high (missing CI lint gate)`,
    "",
    "## Why this matters",
    "",
    check.details,
    "",
    "## Suggested fix",
    "",
    "Add a CI step that invokes `actionlint` so workflow regressions " +
    "fail the build. See the orchestrating prompt's check #1 (linter " +
    "invocations) for the recommended invocation.",
  ].join("\n");

  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      GITHUB_ACTIONS_AUDIT_LABEL,
      "--label",
      "severity:high",
    ]);
  } catch {
    return null;
  }

  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/** Optional extras included in the close-comment summary. */
export interface GitHubActionsAuditSummaryExtras {
  /** Issue numbers of runner-deprecation findings pre-filed this run. */
  preFiledRunner?: readonly number[];
  /** Error message captured if the runner-deprecation scanner threw. */
  runnerScanError?: string;
}

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more newly-filed issues →
 *     `"GitHub Actions audit complete. Filed N issues: #A, #B, …"`
 *   - Runner-deprecation pre-files (when any) on a trailing line.
 *   - A runner-deprecation scanner error (when present) on a trailing
 *     line.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderGitHubActionsAuditSummary(
  newlyFiled: readonly number[],
  extras: GitHubActionsAuditSummaryExtras = {},
): string {
  const lines: string[] = [];
  if (newlyFiled.length === 0) {
    lines.push("no findings");
  } else {
    const sorted = [...newlyFiled].sort((a, b) => a - b);
    const list = sorted.map((n) => `#${n}`).join(", ");
    lines.push(
      `GitHub Actions audit complete. Filed ${sorted.length} issues: ${list}`,
    );
  }
  if (extras.preFiledRunner && extras.preFiledRunner.length > 0) {
    const sorted = [...extras.preFiledRunner].sort((a, b) => a - b);
    const list = sorted.map((n) => `#${n}`).join(", ");
    lines.push(`Runner-deprecation pre-files: ${list}.`);
  }
  if (extras.runnerScanError) {
    lines.push(`Runner-deprecation scan failed: ${extras.runnerScanError}.`);
  }
  return lines.join(" ");
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/github_actions_audit/prompt.md`,
 * substitutes placeholders, and invokes Claude with the same write-tool
 * blocklist as `best_practices_template.defaultRunScan`.
 *
 * The template injects a `runScanFn` stub in most tests; `runClaudeFn` is
 * injectable so the tier-threading path (Issue #4010) is covered here too.
 */
export async function runGitHubActionsAuditScan(
  opts: RunScanOptions,
  loadPromptFn: (name: string) => Promise<Result<string>>,
  runClaudeFn?: IdleTaskClaudeRunner,
): Promise<Result<true, ScanError>> {
  const promptResult = await loadPromptFn(PROMPT_NAME);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: { kind: "prompt", message: promptResult.error.message },
    };
  }

  const prompt = assembleGitHubActionsAuditPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  // Always via `runIdleTaskClaude` so the idle-task budget (#3657) is applied;
  // only the underlying runner is injectable, and only for tests.
  const result = await runIdleTaskClaude(
    {
      prompt,
      cwd: opts.workDir,
      phase: "github_actions_audit",
      disallowedTools: [
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "EnterPlanMode",
        "ExitPlanMode",
      ],
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
    undefined,
    runClaudeFn,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: { kind: "claude", message: result.error.message },
    };
  }
  const { exitCode, timedOut } = result.value;
  if (timedOut) {
    return {
      ok: false,
      error: {
        kind: "timeout",
        message: "Claude github-actions-audit scan timed out",
      },
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: { kind: "claude", message: `Claude exited with code ${exitCode}` },
    };
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/**
 * Build the github-actions-audit template using the supplied deps.
 * Default deps wire production behaviour; tests inject stubs.
 */
export function createGitHubActionsAuditTemplate(
  deps: GitHubActionsAuditTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        GITHUB_ACTIONS_AUDIT_LABEL,
        GITHUB_ACTIONS_AUDIT_LABEL_COLOUR,
        "GitHub Actions audit finding",
      ));
  const checkLinterInCIFn = deps.checkLinterInCIFn ??
    ((path) => defaultCheckLinterInCI(path, "github-actions"));
  const scanRunnerDeprecationsFn = deps.scanRunnerDeprecationsFn ??
    ((repo, gh) => defaultScanRunnerDeprecations(repo, gh));
  const readWorkflowFilesFn = deps.readWorkflowFilesFn ??
    ((workDir) => defaultReadWorkflowFiles(workDir));
  const scanGitleaksPrCoverageFn = deps.scanGitleaksPrCoverageFn ??
    ((repo, files, gh, options) =>
      scanGitleaksPrCoverage(repo, {
        files,
        ghCommandFn: gh,
        knownOpenFindingIds: options.knownOpenFindingIds,
        onSamplingNote: options.onSamplingNote,
      }));
  const scanActionAdvisoriesFn = deps.scanActionAdvisoriesFn ??
    ((files, gh, known, onLookupFailure) =>
      scanActionAdvisories(files, {
        ghCommandFn: gh,
        knownOpenFindingIds: known,
        onLookupFailure,
      }));
  const scanRepoSettingsFn = deps.scanRepoSettingsFn ??
    ((repo, gh, options) => scanRepoSettings(repo, gh, options));
  const requiredActionPatternsFn = deps.requiredActionPatternsFn ??
    defaultRequiredActionPatterns;
  const getDefaultBranchFn = deps.getDefaultBranchFn ??
    ((repo) =>
      getRepoDefaultBranch(repo, ghCommandFn, deps.defaultBranchCachePath));
  const runScanFn = deps.runScanFn ??
    ((opts) => runGitHubActionsAuditScan(opts, loadPromptFn));
  const logger = deps.logger ?? defaultLogger;
  const scanWorkerTokenPrivilegesFn = deps.scanWorkerTokenPrivilegesFn ??
    ((repo, gh, options) => scanWorkerTokenPrivileges(repo, gh, options));
  const ensureFindingLabelsFn = deps.ensureFindingLabelsFn ??
    (async (repo: string, labels: readonly string[]) => {
      for (const label of labels) {
        const ensured = await defaultEnsureLabelExists(
          repo,
          label,
          undefined,
          undefined,
          { ghCommandFn },
        );
        if (!ensured.ok) {
          // Loud, not fatal: the label may already exist, so still attempt
          // the filing — but never let the failure pass unrecorded.
          logger.error(
            `github-actions-audit: could not ensure label ${label} in ${repo}: ` +
              ensured.error.message,
            { repo, template: NAME },
          );
        }
      }
    });

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `github-actions-audit: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    const prompt = assembleGitHubActionsAuditPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
    // Issue #3863: the v16 prompt plus the rendered catalogue tables now
    // overshoot GitHub's 65,536-character issue-body ceiling. Condense to a
    // summary plus a commit-pinned permalink rather than file a clamped copy.
    return await buildPromptPreviewBody(prompt, {
      promptName: PROMPT_NAME,
      scope: DESCRIPTION,
      rootDir: opts.rootDir,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return GITHUB_ACTIONS_AUDIT_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    if (await hasOpenAuditWrapper(opts.repo, ghCommandFn)) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `github-actions-audit` label exists before any
      //    filing. It is not seeded elsewhere, so the first run must
      //    create it. The severity:* labels already exist in
      //    monitored repos.
      await ensureLabelFn(opts.repo);

      // Issue #3292: `opts.workDir` is the PARENT directory holding every
      // repo clone side by side; `setupRepo` checks each repo out at
      // `${workDir}/${repoName}`. The native workflow readers below read
      // `<root>/.github/workflows`, so they must be pointed at the repo's
      // own checkout (the #2880 pattern) — passing the parent read an
      // empty `.github` and silently loaded zero workflows.
      const repoPath = repoCheckoutPath(opts.workDir, opts.repo);

      // 2. Snapshot the repo's open audit issues before any filing
      //    happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        GITHUB_ACTIONS_AUDIT_LABEL,
        ghCommandFn,
      );

      // 3. Actionlint-in-CI pre-check. When the gate is missing, file a
      //    `BP-LINTER-github-actions` issue and add its id to the
      //    known-open list so Claude does not duplicate it.
      const preFiled: string[] = [];
      try {
        const check = await checkLinterInCIFn(repoPath);
        // Fail safe (Issue #2881): a zero-workflow load makes the gate
        // status *unknown*, not confirmed-missing — far more likely a scan
        // glitch than a genuine absence of CI. Skip filing the
        // `severity:high` BP-LINTER-github-actions finding in that case.
        if (!check.configured && check.workflowsLoaded !== false) {
          // Pre-file dedup (Issue #2882): skip creating when an open issue
          // with this finding-id already exists, so one finding never files
          // two open issues. A closed prior issue does not block re-filing.
          const filed = await fileFindingOnce({
            repo: opts.repo,
            logLabel: GITHUB_ACTIONS_AUDIT_LABEL,
            findingId: "BP-LINTER-github-actions",
            ghCommandFn,
            fileFn: () =>
              fileActionlintMissingIssue(opts.repo, check, ghCommandFn),
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
          }
        }
      } catch {
        // Defensive: a transient check failure must not abort the run.
      }

      // 4. Build the existing-known-open list now so the runner
      //    pre-filer can dedup against it.
      const existingIds = await listKnownOpenFindingIds(
        opts.repo,
        GITHUB_ACTIONS_AUDIT_LABEL,
        ghCommandFn,
      );

      // 5. Runner-deprecation pre-filer — file each surviving finding
      //    as its own `github-actions-audit` issue. The scan label is
      //    `github-actions-audit` (NOT `best-practices`); no `lang:*`
      //    label since this template is single-scope.
      const preFiledRunnerIssueNumbers: number[] = [];
      let runnerScanError: string | undefined;
      let runnerFindings: DeprecationFinding[] = [];
      try {
        runnerFindings = await scanRunnerDeprecationsFn(
          opts.repo,
          ghCommandFn,
        );
      } catch (err) {
        runnerScanError = err instanceof Error ? err.message : String(err);
      }
      const seenIds = new Set<string>([...existingIds, ...preFiled]);
      for (const finding of runnerFindings) {
        if (seenIds.has(finding.stableId)) continue;
        const filed = await sharedFileRunnerDeprecationIssue({
          repo: opts.repo,
          finding,
          ghCommandFn,
          scanLabel: GITHUB_ACTIONS_AUDIT_LABEL,
          extraLabels: [],
        });
        if (filed !== null) {
          preFiled.push(filed.findingId);
          seenIds.add(filed.findingId);
          preFiledRunnerIssueNumbers.push(filed.number);
        }
      }

      // 5b. Native SHA-pin pre-filer (Issue #2501). Flag every
      //     third-party `uses:` (action and cross-repo reusable
      //     workflow) not pinned to a full 40-char commit SHA. Each
      //     surviving consolidated finding becomes its own
      //     `github-actions-audit` issue; its id is added to the
      //     known-open list so Claude's #1 check does not double-file.
      //     A scanner failure must not abort the run.
      const runId = Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown";
      // Read once; the settings pre-filer (5k) reuses the same files.
      let workflowFiles: readonly WorkflowFile[] = [];
      try {
        const files = await readWorkflowFilesFn(repoPath);
        workflowFiles = files;
        const pinFindings: ActionPinFinding[] = scanActionPins(files, {
          knownOpenFindingIds: seenIds,
        });
        for (const finding of pinFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5c. Native permissions pre-filer (Issue #2502). Flag every
        //     workflow/job with no `permissions:` block (inherits the
        //     broad default) or a `permissions: write-all` grant — the
        //     decidable core of v7 prompt check #2. Each surviving
        //     finding becomes its own `github-actions-audit` issue at
        //     `severity:medium`; its id is added to the known-open list
        //     so Claude's #2 check does not double-file.
        const permFindings: WorkflowPermissionsFinding[] =
          scanWorkflowPermissions(files, {
            knownOpenFindingIds: seenIds,
          });
        for (const finding of permFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5d. Native script-injection pre-filer (Issue #2503). Flag every
        //     `run:` step that interpolates an attacker-controllable
        //     `${{ github.* }}` field directly into the shell — the
        //     decidable core of v7 prompt check #22. Each surviving
        //     finding becomes its own `github-actions-audit` issue at
        //     `severity:high`; its id is added to the known-open list so
        //     Claude's #22 check does not double-file.
        const injectionFindings: RunInjectionFinding[] = scanRunInjection(
          files,
          { knownOpenFindingIds: seenIds },
        );
        for (const finding of injectionFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5e. Native workflow-trigger pre-filer (Issue #2587, part of
        //     #2561). Flag every test/lint/scan workflow that still
        //     triggers on push to the default branch, so the actual YAML
        //     fix (drop `push:` to default, keep `pull_request` /
        //     `schedule` / `workflow_dispatch`) rides a normal worker PR.
        //     Deploy/publish/release and ambiguous workflows are left
        //     untouched. The default branch is resolved best-effort; if it
        //     cannot be determined the pre-filer is skipped (no findings).
        const defaultBranchResult = await getDefaultBranchFn(opts.repo);
        if (defaultBranchResult.ok) {
          const triggerFindings: WorkflowTriggerFinding[] =
            scanWorkflowTriggers(
              files,
              {
                defaultBranch: defaultBranchResult.value,
                knownOpenFindingIds: seenIds,
              },
            );
          for (const finding of triggerFindings) {
            if (seenIds.has(finding.findingId)) continue;
            const filed = await fileWorkflowFinding({
              repo: opts.repo,
              findingId: finding.findingId,
              severity: finding.severity,
              title: finding.title,
              file: finding.file,
              lines: finding.lines,
              whyItMatters: finding.whyItMatters,
              suggestedFix: finding.suggestedFix,
              evidence: finding.evidence,
              template: NAME,
              runId,
              ghCommandFn,
            });
            if (filed !== null) {
              preFiled.push(filed.findingId);
              seenIds.add(filed.findingId);
            }
          }
        }

        // 5f. Native checkout-persist-credentials pre-filer (Issue
        //     #2845, gap from #2834). Flag every `actions/checkout` step
        //     lacking `persist-credentials: false` in a job that gives no
        //     static signal of needing the persisted token (no `git
        //     push`/`fetch`, no known push action, no `submodules:`). The
        //     long-documented v3-slot check #23 was never implemented;
        //     this is its deterministic native counterpart. Each
        //     surviving finding becomes its own `github-actions-audit`
        //     issue at `severity:medium`; its id is added to the
        //     known-open list so the LLM does not double-file.
        const persistFindings: CheckoutPersistCredentialsFinding[] =
          scanCheckoutPersistCredentials(files, {
            knownOpenFindingIds: seenIds,
          });
        for (const finding of persistFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5g. Native broad-artefact-upload pre-filer (Issue #2846, gap
        //     from #2834). Flag every `actions/upload-artifact` step whose
        //     `with.path` is the whole workspace (`.`, `./`,
        //     `${{ github.workspace }}`, `*`, `**`) — the decidable core of
        //     v9 prompt check #30. Each surviving finding becomes its own
        //     `github-actions-audit` issue at `severity:low` baseline
        //     (`severity:medium` when the job has secrets or runs under a
        //     privileged trigger); its id is added to the known-open list
        //     so the LLM does not double-file.
        const artifactFindings: ArtifactUploadFinding[] = scanArtifactUploads(
          files,
          { knownOpenFindingIds: seenIds },
        );
        for (const finding of artifactFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5h. Native milestone-branch-filter pre-filer (Issue #3360).
        //     Flag every CI quality workflow (test/lint/scan) whose
        //     `pull_request` branch filter misses milestone feature
        //     branches (`milestone/<slug>`, Issue #1300), so milestone
        //     sub-issue PRs never merge past the gate unchecked. Each
        //     surviving finding becomes its own `github-actions-audit`
        //     issue at `severity:medium`; its id is added to the
        //     known-open list so the LLM does not double-file. Per Issue
        //     #3239 isolation the YAML fix (add `milestone/*` to the
        //     filter) rides a normal per-repo worker PR — the scan raises
        //     no PR and no cross-repo mechanism.
        const milestoneFindings: MilestoneBranchFilterFinding[] =
          scanMilestoneBranchFilters(files, {
            knownOpenFindingIds: seenIds,
          });
        for (const finding of milestoneFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5h2. Native gitleaks-drift pre-filer (Issue #598, part of #566).
        //      The `gitleaks` workflow spec detects presence by pattern, so
        //      a copy pushed months ago with `branches: ["*"]` and
        //      `gitleaks-action@v2` scores as fully covered while scanning
        //      almost nothing — presence is not currency. Flag each
        //      per-repo copy that has drifted from the canonical shape:
        //      milestone-blind branch filter, stale action pin, no
        //      licence-less CLI fallback, or no `pull_request` trigger at
        //      all. Runs immediately after 5h so the milestone ids just
        //      filed are in `seenIds` and the branch gap is never filed
        //      twice. Per Issue #3239 isolation the YAML fix rides a normal
        //      per-repo worker PR — the scan only reports.
        const gitleaksFindings: GitleaksDriftFinding[] = scanGitleaksDrift(
          files,
          { knownOpenFindingIds: seenIds },
        );
        for (const finding of gitleaksFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5h3. Observed gitleaks coverage on recent PRs (Issue #601, part
        //      of #566). 5h2 asks whether the committed copy has drifted;
        //      this asks whether it ever *ran*. A workflow file can be
        //      present and never execute — Actions disabled, the workflow
        //      disabled in the UI, a branch filter that misses the PRs'
        //      base, an `if:` that never fires, a YAML error that stops it
        //      being registered — and every one of those reads as "present"
        //      to the file-content audit. Sample the repo's recent closed
        //      PRs and file one `severity:medium` finding when no gitleaks
        //      check reported on any of them. Runs after 5h2 so a drifted
        //      copy is reported by its own class first. A degraded sample is
        //      logged, never reported as clean.
        const coverageFindings: GitleaksPrCoverageFinding[] =
          await scanGitleaksPrCoverageFn(
            opts.repo,
            files,
            ghCommandFn,
            {
              knownOpenFindingIds: seenIds,
              onSamplingNote: (note) =>
                logger.warn(
                  `github-actions-audit: ${note}`,
                  { repo: opts.repo, template: NAME, runId },
                ),
            },
          );
        for (const finding of coverageFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5i. Native unpinned-CI-install pre-filer (Issue #3668, split out
        //     of #3642). Flag every `run:`-level package install with no
        //     exact version pin (`npm install -g <pkg>`, `npx --yes <pkg>`,
        //     `gem install <pkg>`) — invisible to `action_pin_scanner.ts`,
        //     which only inspects `uses:`. Such an install resolves
        //     whatever the registry serves at run time, so it sits outside
        //     the repo's dependency quarantine. Findings consolidate one
        //     per package coordinate at `severity:medium`; each id is added
        //     to the known-open list so the LLM does not double-file. Per
        //     Issue #3239 isolation the pin rides a normal per-repo worker
        //     PR — the scan only reports.
        const installFindings: CiInstallPinFinding[] = scanCiInstallPins(
          files,
          { knownOpenFindingIds: seenIds },
        );
        for (const finding of installFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }

        // 5j. Native GHSA cross-check of pinned actions (Issue #4405,
        //     GHA-SUPPLY-018). The pin scanner proves SHAPE; this asks the
        //     advisory database whether a pinned action has a disclosed,
        //     unpatched vulnerability — one `gh api /advisories` per
        //     third-party coordinate, one finding per advisory. A lookup
        //     that fails is logged loud and yields nothing, never "clean".
        const advisoryFindings: ActionAdvisoryFinding[] =
          await scanActionAdvisoriesFn(
            files,
            ghCommandFn,
            seenIds,
            (coordinate, reason) =>
              logger.error(
                `github-actions-audit: GHSA lookup failed for ${coordinate}: ${reason}`,
                { repo: opts.repo, template: NAME, runId },
              ),
          );
        for (const finding of advisoryFindings) {
          if (seenIds.has(finding.findingId)) continue;
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
            seenIds.add(filed.findingId);
          }
        }
      } catch (err) {
        // Defensive: a scanner/read failure must not abort the run — but it
        // must never pass for a clean audit either (Issue #3953). The bare
        // catch this replaces swallowed every throw, so a broken scanner
        // filed nothing and looked identical to a repo with no findings.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          `github-actions-audit: native pre-filer block failed: ${message}`,
          { repo: opts.repo, template: NAME, runId },
        );
      }

      // 5k. Repository-settings drift (Issues #4397, #4398, #4401). Not
      //     workflow YAML, so outside the file block: read-only gh calls
      //     against the settings the YAML sits on (default token scope,
      //     approve-PRs, allowed actions, SHA-pin enforcement, the default
      //     branch's review rule, secret scanning / push protection). Only
      //     an admin can flip them, so each finding says so; a lookup that
      //     fails is logged loud and yields nothing.
      try {
        const defaultBranchForRules = await getDefaultBranchFn(opts.repo);
        if (defaultBranchForRules.ok) {
          let hasCodeowners = false;
          try {
            await Deno.stat(`${repoPath}/.github/CODEOWNERS`);
            hasCodeowners = true;
          } catch {
            hasCodeowners = false;
          }
          // The allow-list check needs the full action set the workflows
          // run, composite steps included (Issue #4424); a resolver failure
          // simply withholds that one check.
          let requiredActionPatterns: string[] | undefined;
          try {
            requiredActionPatterns = await requiredActionPatternsFn(
              workflowFiles,
              ghCommandFn,
            );
          } catch (err) {
            logger.error(
              `github-actions-audit: required action patterns could not be resolved: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { repo: opts.repo, template: NAME, runId },
            );
          }
          const settingsFindings: RepoSettingsFinding[] =
            await scanRepoSettingsFn(opts.repo, ghCommandFn, {
              defaultBranch: defaultBranchForRules.value,
              hasCodeowners,
              knownOpenFindingIds: seenIds,
              requiredActionPatterns,
              onLookupFailure: (what, reason) =>
                logger.error(
                  `github-actions-audit: repository settings lookup failed (${what}): ${reason}`,
                  { repo: opts.repo, template: NAME, runId },
                ),
            });
          for (const finding of settingsFindings) {
            if (seenIds.has(finding.findingId)) continue;
            const filed = await fileWorkflowFinding({
              repo: opts.repo,
              findingId: finding.findingId,
              severity: finding.severity,
              title: finding.title,
              file: finding.file,
              lines: finding.lines,
              whyItMatters: finding.whyItMatters,
              suggestedFix: finding.suggestedFix,
              evidence: finding.evidence,
              template: NAME,
              runId,
              ghCommandFn,
            });
            if (filed !== null) {
              preFiled.push(filed.findingId);
              seenIds.add(filed.findingId);
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          `github-actions-audit: repository-settings pre-filer failed: ${message}`,
          { repo: opts.repo, template: NAME, runId },
        );
      }

      // 5l. Worker-token privilege check (Issue #599, part of #566). The
      //     opposite direction to 5k: that asks whether the repository is
      //     locked down enough, this asks whether the worker's own token is
      //     trusted too much. `admin`/`maintain` on the repo carries the
      //     rulesets API, so the worker could delete the required-status-check
      //     ruleset that gates merges. Read-only — no ruleset is ever probed
      //     with a write — and a lookup that fails is logged loud and yields
      //     nothing, never a "verified safe".
      try {
        const tokenFindings = await scanWorkerTokenPrivilegesFn(
          opts.repo,
          ghCommandFn,
          {
            knownOpenFindingIds: seenIds,
            onLookupFailure: (what, reason) =>
              logger.error(
                `github-actions-audit: worker token privilege lookup failed (${what}): ${reason}`,
                { repo: opts.repo, template: NAME, runId },
              ),
          },
        );
        for (const finding of tokenFindings) {
          if (seenIds.has(finding.findingId)) continue;
          await ensureFindingLabelsFn(opts.repo, finding.labels);
          const filed = await fileWorkflowFinding({
            repo: opts.repo,
            findingId: finding.findingId,
            severity: finding.severity,
            title: finding.title,
            file: finding.file,
            lines: finding.lines,
            whyItMatters: finding.whyItMatters,
            suggestedFix: finding.suggestedFix,
            evidence: finding.evidence,
            extraLabels: finding.labels,
            template: NAME,
            runId,
            ghCommandFn,
          });
          if (filed === null) {
            // An over-privileged token that files nothing must not look like
            // a clean audit — say so.
            logger.error(
              `github-actions-audit: worker-token escalation ${finding.findingId} could not be filed in ${opts.repo}`,
              { repo: opts.repo, template: NAME, runId },
            );
            continue;
          }
          preFiled.push(filed.findingId);
          seenIds.add(filed.findingId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          `github-actions-audit: worker-token privilege pre-filer failed: ${message}`,
          { repo: opts.repo, template: NAME, runId },
        );
      }

      // 6. Build the known-open list (existing open findings + pre-filed
      //    ids from this run) so Claude does not re-emit findings the
      //    repo already tracks.
      //
      //    Pre-file dedup (Issue #2882): the actionlint pre-filer above routes
      //    through `fileFindingOnce`, which looks up an existing open issue by
      //    `finding-id` before creating, so one finding never yields two open
      //    issues (the duplicate observed in the previously-documented #2411
      //    race). The native pre-filers (SHA-pin, permissions, injection,
      //    trigger, persist-creds, artefact) already dedup against `seenIds`
      //    (which seeds from `existingIds`). A residual micro-race between the
      //    look-up and the create is acceptable; the guard closes the routine
      //    window, it is not a distributed lock.
      const knownOpenFindingIds = Array.from(
        new Set([...existingIds, ...preFiled]),
      );

      // Repo-wide open-issue titles (Issue #537) — the semantic second
      // line of dedup, so a finding already open under another label is
      // not re-filed. A gh failure returns an empty list, which renders
      // `(none)` and leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 7. Invoke Claude. It files surviving findings via `gh issue
      //    create` directly — no JSON parsing here.
      //    Issue #4010: honour the tier the wrapper was filed for; an
      //    unstamped wrapper leaves the phase default in force.
      const scanResult = await runScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        knownOpenFindingIds,
        openIssueTitles,
        suppressedIds: [],
        ...(opts.modelTier !== undefined ? { model: opts.modelTier } : {}),
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary: `github-actions-audit failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 8. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        GITHUB_ACTIONS_AUDIT_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderGitHubActionsAuditSummary(newlyFiled, {
          preFiledRunner: preFiledRunnerIssueNumbers,
          runnerScanError,
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `github-actions-audit threw: ${message}`,
      };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) =>
      GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: GITHUB_ACTIONS_AUDIT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const githubActionsAuditTemplate: IdleTaskTemplate =
  createGitHubActionsAuditTemplate();

registerTemplate(githubActionsAuditTemplate);
