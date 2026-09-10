/**
 * Workflow synchronisation across all monitored repositories.
 *
 * Orchestrates language detection, workflow auditing, and issue creation
 * for missing GitHub Actions workflows. Issues are created in the TARGET
 * repository (not VibeCoder) and are idempotent — running twice will not
 * create duplicates.
 *
 * Issue #1395: Add workflow-sync subcommand to setup CLI.
 *
 * The dedup search runs `--state all`, so a match suppresses the issue
 * **permanently** — no expiry, no recovery. A dedup tag is a string in an
 * issue body, which on a public repository anyone who can open an issue
 * writes, so the match is author-verified against the fleet identity
 * (`lib/alert_dedup_authors.ts`) before it may suppress anything. The fail
 * direction is towards filing: an unresolvable fleet raises the issue, and
 * a duplicate a maintainer closes beats a missing-workflow issue that is
 * never raised again.
 */

import {
  detectRepoLanguages,
  type LanguageDetectorOptions,
  type RepoLanguages,
} from "../lib/language_detector.ts";
import {
  auditRepoWorkflows,
  type WorkflowAuditOptions,
  type WorkflowAuditResult,
} from "../lib/workflow_auditor.ts";
import {
  capabilityLabelForGroup,
  type WorkflowSpec,
} from "../lib/workflow_definitions.ts";
import {
  checkNamesFromWorkflow,
  requiredStatusCheckSection,
} from "../lib/required_status_check_guidance.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "../lib/alert_dedup_authors.ts";
import {
  type ActionPinResolverDeps,
  applyResolvedPins,
  resolveActionPins,
  type ResolvedActionPins,
} from "../lib/action_pin_resolver.ts";
import type { ActionPin } from "../lib/pinned_actions.ts";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";
import { createSetupRunCommand } from "./setup_command_runner.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Options for workflow sync operations.
 *
 * Extends {@link AlertDedupAuthorOptions}: `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose dedup tag counts.
 */
export interface WorkflowSyncOptions extends AlertDedupAuthorOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /** Whether to perform a dry run (report only, no issue creation). */
  dryRun?: boolean;
  /** Sink for the author-verification diagnostics. Defaults to `console.warn`. */
  log?: (message: string) => void;
  /**
   * Path to the local working tree of the repository being synced.
   * When provided, the auditor reads workflow files from disk instead
   * of issuing `gh api` calls (Issue #1811). Used by single-repo
   * `syncWorkflowsForRepo` calls.
   */
  localRepoPath?: string;
  /**
   * Directory containing per-repo clones (typically `WORK_DIR`). Used
   * by `syncWorkflowsForAllRepos` to derive a per-repo
   * `localRepoPath` (`<workDir>/<repoName>`) so each audit reads from
   * the local clone where one exists. Ignored when `localRepoPath` is
   * already set.
   */
  workDir?: string;
  /**
   * Resolve the action pins every rendered issue body carries (Issue
   * #1824). Defaults to {@link resolveActionPins} over the same runner the
   * `gh` calls use, so no new credential path is introduced.
   *
   * Called at most once per sync — lazily, immediately before the first
   * body is rendered — so a dry run, which renders no body, never resolves.
   */
  resolvePins?: PinResolver;
}

/** Resolve the whole pin catalogue against upstream. */
export type PinResolver = () => Promise<ResolvedActionPins>;

/** The pins a rendered issue body is interpolated with. */
export type ResolvedPins = Record<string, ActionPin>;

/** Result of syncing workflows for a single repo. */
export interface WorkflowSyncResult {
  ok: boolean;
  repo: string;
  /** Languages detected in the repo. */
  languages: string[];
  /** Number of workflows already present. */
  present: number;
  /** Number of issues raised for missing workflows. */
  issuesRaised: number;
  /** Number of issues skipped (already exist). */
  issuesSkipped: number;
  /** Number of workflows with partial matches. */
  partial: number;
  /** Number of issues raised for partially matching workflows. */
  partialIssuesRaised: number;
  /** Number of partial-match issues skipped (already exist). */
  partialIssuesSkipped: number;
  /** Error message if the sync failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate the deduplication tag for a missing workflow spec. */
export function deduplicationTag(specId: string): string {
  return `<!-- vibe-coder:workflow-sync:${specId} -->`;
}

/** Generate the deduplication tag for a partially matching workflow spec. */
export function partialDeduplicationTag(specId: string): string {
  return `<!-- vibe-coder:workflow-sync:partial:${specId} -->`;
}

/**
 * Check if an issue already exists in the target repo carrying the given tag.
 *
 * Searches open issues for the deduplication tag.
 */
async function issueExistsByTag(
  repo: string,
  tag: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  options: AlertDedupAuthorOptions,
  log: (message: string) => void,
): Promise<boolean> {
  // Search across both open and closed states so a previously-raised
  // (and possibly closed) issue suppresses recreation. Issue #1829: a
  // dedup limited to `--state open` allowed setup to re-raise issues
  // for workflows that were already present and had a prior sync issue
  // closed against them.
  //
  // `--limit 1` would let a single planted issue occupy the only slot the
  // search returns, so the limit is wide enough to see past one and the
  // tag is re-checked against each body rather than trusted from the
  // search alone.
  const result = await runner([
    "gh",
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `"${tag}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);

  if (!result.success) {
    // If the search fails, assume no issue exists (safe to create).
    return false;
  }

  let rows: (AlertDedupRow & { body?: string })[];
  try {
    rows = JSON.parse(result.stdout) as (AlertDedupRow & { body?: string })[];
  } catch {
    return false;
  }
  const verified = await selectFleetAuthoredMatches(
    rows.filter((row) => (row.body ?? "").includes(tag)),
    `workflow-sync ${repo} ${tag}`,
    options,
    log,
    "the issue is raised — a tag anyone can type must not suppress a " +
      "workflow-sync issue for ever",
  );
  return verified.length > 0;
}

/** Build the issue title for a missing workflow. */
function issueTitle(spec: WorkflowSpec): string {
  return `Add ${spec.name} workflow`;
}

/** Build the issue title for a partially matching workflow. */
function issueTitlePartial(spec: WorkflowSpec): string {
  return `Complete ${spec.name} workflow`;
}

/** Human-readable category label used in issue bodies. */
function categoryLabel(spec: WorkflowSpec): string {
  return spec.category === "security"
    ? "🔒 Security"
    : spec.category === "dependency-update"
    ? "📦 Dependency Updates"
    : "✅ Quality";
}

/**
 * Human-action guidance making a security spec's check *block* merges
 * (Issue #600).
 *
 * Security scans are the ones whose result must gate a merge, so only
 * `category: "security"` specs carry the section — a quality or
 * dependency-update recommendation gets an empty string and its body is
 * unchanged. The check name is derived from the spec's own template, so it
 * always matches what the workflow the issue recommends actually reports.
 *
 * Returned with a leading blank-line separator so callers can interpolate it
 * directly.
 */
function requiredCheckGuidance(spec: WorkflowSpec): string {
  if (spec.category !== "security") return "";
  const checkNames = checkNamesFromWorkflow(
    spec.template,
    `.github/workflows/${spec.suggestedFilename}`,
  );
  return `\n${requiredStatusCheckSection(checkNames)}\n`;
}

/**
 * The rule the implementer applies to the YAML the body carries
 * (Issue #1824).
 *
 * The templates mark no value as repository-specific, so the body says so
 * outright rather than leaving the implementer to guess which strings are
 * placeholders — a guess that has produced hand-edited workflows the fleet's
 * own Actions audit then reports.
 */
export const COPY_VERBATIM_CLAUSE =
  "no value in it is repository-specific unless listed here, and nothing is " +
  "listed for this template";

/**
 * The rule covering the `uses:` pins, which are resolved when the issue is
 * filed rather than being the catalogue's frozen SHAs.
 */
export const COPY_PINS_AS_GIVEN_RULE =
  "The action pins above are already resolved to the highest release that has " +
  "aged past the fleet's supply-chain quarantine window (24 hours by " +
  "default) — copy them as given, and do not re-resolve, bump or reformat " +
  "them.";

/**
 * The file-scoped checks the committed workflow has to survive.
 *
 * Rendered from {@link WORKFLOW_FILE_CHECKS} rather than hand-copied, so a
 * check added to the audit reaches every issue body the next sync files.
 */
function workflowCheckSection(): string {
  const labels = WORKFLOW_FILE_CHECKS.map((check) => `- ${check.label}`)
    .join("\n");
  return `### Checks the committed file must pass

The file as committed must yield no finding from any of these checks:

${labels}`;
}

/** Build the issue body for a missing workflow. */
export function issueBody(spec: WorkflowSpec, pins: ResolvedPins): string {
  const tag = deduplicationTag(spec.id);

  return `## ${spec.name}

**Category:** ${categoryLabel(spec)}
**Suggested filename:** \`.github/workflows/${spec.suggestedFilename}\`

### Why this workflow is needed

This repository is missing the **${spec.name}** GitHub Actions workflow. Adding this workflow will improve the repository's ${
    spec.category === "security"
      ? "security posture"
      : spec.category === "dependency-update"
      ? "dependency management"
      : "code quality"
  }.

### Suggested workflow template

\`\`\`yaml
${applyResolvedPins(spec.template, pins).trim()}
\`\`\`

### How to apply

1. Copy the YAML above **verbatim** — ${COPY_VERBATIM_CLAUSE}.
2. ${COPY_PINS_AS_GIVEN_RULE}
3. Save it as \`.github/workflows/${spec.suggestedFilename}\` and push to the default branch.

${workflowCheckSection()}
${requiredCheckGuidance(spec)}
---
*Raised automatically by VibeCoder workflow sync.*
${tag}`;
}

/**
 * Build the issue body for a partially matching workflow.
 *
 * Highlights which capability groups were satisfied (and in which file) and
 * which were not detected, in capability-oriented language. The body
 * acknowledges that the auditor uses substring matching against a finite
 * list of expected patterns and may flag a workflow that is in fact
 * configured correctly via an unlisted alternative — so maintainers know
 * a "Capabilities not detected" entry is a *prompt to review*, not a
 * confirmed gap.
 *
 * `missingGroups` lists the detection-pattern groups for which no
 * alternative was found. Detected groups are derived as the spec's groups
 * minus the missing ones.
 */
export function issueBodyPartial(
  spec: WorkflowSpec,
  foundIn: string,
  missingGroups: string[][],
  pins: ResolvedPins,
): string {
  const tag = partialDeduplicationTag(spec.id);
  const missingSet = new Set(missingGroups.map((g) => g.join("|")));
  const foundGroups = spec.detectionPatternGroups.filter(
    (g) => !missingSet.has(g.join("|")),
  );
  const formatGroup = (group: string[]): string => {
    const label = capabilityLabelForGroup(spec, group);
    const patterns = group.map((p) => `\`${p}\``).join(", ");
    return group.length === 1
      ? `- ${label} (${patterns})`
      : `- ${label} (any of: ${patterns})`;
  };
  const foundList = foundGroups.length > 0
    ? foundGroups.map(formatGroup).join("\n")
    : "_None._";
  const missingList = missingGroups.length > 0
    ? missingGroups.map(formatGroup).join("\n")
    : "_None._";

  return `## ${spec.name} — Partial Match

**Category:** ${categoryLabel(spec)}
**Workflow file:** \`.github/workflows/${foundIn}\`

### Current status

The **${spec.name}** workflow appears to be partially configured in \`.github/workflows/${foundIn}\`. The auditor checks each capability by substring-matching a finite list of expected patterns, so a "not detected" entry below may also mean the workflow is configured correctly via an alternative implementation that is not in the auditor's pattern list. Please review before treating the gap as a real one — and close this issue as not-applicable if every capability is in fact present via an unlisted alternative.

### Capabilities detected

${foundList}

### Capabilities not detected

${missingList}

### Suggested workflow template

\`\`\`yaml
${applyResolvedPins(spec.template, pins).trim()}
\`\`\`

### How to complete

1. Review \`.github/workflows/${foundIn}\` and confirm whether each "not detected" capability above is genuinely missing or implemented via an alternative the auditor does not recognise.
2. If the capability is genuinely missing, add an implementation for it — copy the relevant step from the suggested template above **verbatim** (${COPY_VERBATIM_CLAUSE}), or use any equivalent configuration that performs the same capability. ${COPY_PINS_AS_GIVEN_RULE}
3. If every capability is in fact present via alternatives, close this issue as not-applicable. No workflow change is needed.
4. Otherwise, commit the additions to the default branch.

${workflowCheckSection()}
${requiredCheckGuidance(spec)}
---
*Raised automatically by VibeCoder workflow sync.*
${tag}`;
}

/**
 * Create an issue in the target repo for a missing workflow.
 *
 * @returns true if the issue was created, false if creation failed.
 */
async function createWorkflowIssue(
  repo: string,
  spec: WorkflowSpec,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  pins: ResolvedPins,
): Promise<boolean> {
  const title = issueTitle(spec);
  const body = issueBody(spec, pins);

  // Try to create with the "enhancement" label first.
  const withLabel = await runner([
    "gh",
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "enhancement",
  ]);
  if (withLabel.success) return true;

  // If that fails (label may not exist), try without the label.
  const withoutLabel = await runner([
    "gh",
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
  ]);
  return withoutLabel.success;
}

/**
 * Create an issue in the target repo for a partially matching workflow.
 *
 * @returns true if the issue was created, false if creation failed.
 */
async function createPartialWorkflowIssue(
  repo: string,
  spec: WorkflowSpec,
  foundIn: string,
  missingGroups: string[][],
  runner: (cmd: string[]) => Promise<CommandOutput>,
  pins: ResolvedPins,
): Promise<boolean> {
  const title = issueTitlePartial(spec);
  const body = issueBodyPartial(spec, foundIn, missingGroups, pins);

  // Try to create with the "enhancement" label first.
  const withLabel = await runner([
    "gh",
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "enhancement",
  ]);
  if (withLabel.success) return true;

  // If that fails (label may not exist), try without the label.
  const withoutLabel = await runner([
    "gh",
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
  ]);
  return withoutLabel.success;
}

/**
 * Adapt the setup runner to the resolver's `runFn` shape.
 *
 * The setup runner owns its own timeout (`spawnGh` → `runGitCommand`), so the
 * resolver's per-call budget is not re-applied here. A process that ran and
 * exited non-zero is reported as such rather than as a runner error, which is
 * the distinction `resolveGitHubReleaseHistory` branches on: either way the
 * action falls back to its catalogue pin with one logged reason.
 */
function pinResolverRunFn(
  runner: (cmd: string[]) => Promise<CommandOutput>,
): ActionPinResolverDeps["runFn"] {
  return async (cmd: string[]) => {
    const result = await runner(cmd);
    return {
      ok: true,
      value: {
        exitCode: result.success ? 0 : 1,
        output: result.success ? result.stdout : result.stderr,
      },
    };
  };
}

/**
 * Build the once-per-sync pin lookup a body render calls.
 *
 * The returned function memoises the resolution — the pins do not vary by
 * repository, so a fleet-wide sync resolves the catalogue once — and is
 * **lazy**, so a dry run (which renders no body) issues no `gh` call at all.
 */
function createPinLookup(
  options: WorkflowSyncOptions,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  log: (message: string) => void,
): () => Promise<ResolvedPins> {
  const resolve = memoisePinResolver(
    options.resolvePins ??
      (() => resolveActionPins({ runFn: pinResolverRunFn(runner), log })),
  );
  return async () => (await resolve()).pins;
}

/** Wrap a resolver so it runs at most once, however many bodies are rendered. */
function memoisePinResolver(resolve: PinResolver): PinResolver {
  let inFlight: Promise<ResolvedActionPins> | undefined;
  return () => (inFlight ??= resolve());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronise workflows for a single repository.
 *
 * 1. Detect languages in the repo
 * 2. Audit existing workflows against expected specs
 * 3. For each missing workflow, check for existing issues and create if needed
 *
 * @param repo - Repository in "owner/repo" format.
 * @param options - Optional configuration for command execution.
 * @returns Sync result for the repository.
 */
export async function syncWorkflowsForRepo(
  repo: string,
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult> {
  const runner = options.runCommand ??
    createSetupRunCommand(options.ghConfigDir);
  const log = options.log ?? ((message: string) => console.warn(message));
  const langOpts: LanguageDetectorOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
  };
  const auditOpts: WorkflowAuditOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
    localRepoPath: options.localRepoPath,
  };
  // Lazy and memoised: resolved once, immediately before the first body is
  // rendered, and never at all when nothing is filed (Issue #1824).
  const pins = createPinLookup(options, runner, log);

  // Step 1: Detect languages
  let languages: RepoLanguages;
  try {
    const langResult = await detectRepoLanguages(repo, langOpts);
    if (!langResult.ok) {
      return {
        ok: false,
        repo,
        languages: [],
        present: 0,
        issuesRaised: 0,
        issuesSkipped: 0,
        partial: 0,
        partialIssuesRaised: 0,
        partialIssuesSkipped: 0,
        error: langResult.error,
      };
    }
    languages = langResult.value;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      repo,
      languages: [],
      present: 0,
      issuesRaised: 0,
      issuesSkipped: 0,
      partial: 0,
      partialIssuesRaised: 0,
      partialIssuesSkipped: 0,
      error: `Language detection failed: ${message}`,
    };
  }

  // Step 2: Audit workflows
  let audit: WorkflowAuditResult;
  try {
    const auditResult = await auditRepoWorkflows(repo, languages, auditOpts);
    if (!auditResult.ok) {
      return {
        ok: false,
        repo,
        languages: languages.detected.map((d) => d.language),
        present: 0,
        issuesRaised: 0,
        issuesSkipped: 0,
        partial: 0,
        partialIssuesRaised: 0,
        partialIssuesSkipped: 0,
        error: auditResult.error,
      };
    }
    audit = auditResult.value;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      repo,
      languages: languages.detected.map((d) => d.language),
      present: 0,
      issuesRaised: 0,
      issuesSkipped: 0,
      partial: 0,
      partialIssuesRaised: 0,
      partialIssuesSkipped: 0,
      error: `Workflow audit failed: ${message}`,
    };
  }

  // Step 3: Raise issues for missing workflows
  let issuesRaised = 0;
  let issuesSkipped = 0;
  let partialIssuesRaised = 0;
  let partialIssuesSkipped = 0;

  if (!options.dryRun) {
    for (const spec of audit.missing) {
      // Resolved outside the per-spec `catch`: a pin-resolution fault is
      // fleet-wide, not one spec's, so it must surface rather than be
      // swallowed into a sync that quietly files nothing (Issue #1824).
      const resolvedPins = await pins();
      try {
        const exists = await issueExistsByTag(
          repo,
          deduplicationTag(spec.id),
          runner,
          options,
          log,
        );
        if (exists) {
          issuesSkipped++;
          continue;
        }

        const created = await createWorkflowIssue(
          repo,
          spec,
          runner,
          resolvedPins,
        );
        if (created) {
          issuesRaised++;
        }
      } catch {
        // Skip this spec on failure — do not block other specs.
      }
    }

    // Step 4: Raise issues for partially matching workflows
    for (const partialMatch of audit.partial) {
      const resolvedPins = await pins();
      try {
        const exists = await issueExistsByTag(
          repo,
          partialDeduplicationTag(partialMatch.spec.id),
          runner,
          options,
          log,
        );
        if (exists) {
          partialIssuesSkipped++;
          continue;
        }

        const created = await createPartialWorkflowIssue(
          repo,
          partialMatch.spec,
          partialMatch.foundIn,
          partialMatch.missingGroups,
          runner,
          resolvedPins,
        );
        if (created) {
          partialIssuesRaised++;
        }
      } catch {
        // Skip this spec on failure — do not block other specs.
      }
    }
  } else {
    // Dry run: count all missing and partial as would-be-raised.
    issuesRaised = audit.missing.length;
    partialIssuesRaised = audit.partial.length;
  }

  return {
    ok: true,
    repo,
    languages: audit.languages,
    present: audit.present.length,
    issuesRaised,
    issuesSkipped,
    partial: audit.partial.length,
    partialIssuesRaised,
    partialIssuesSkipped,
  };
}

/**
 * Synchronise workflows across all configured repositories.
 *
 * @param repos - Array of repo strings in "owner/repo" format.
 * @param options - Optional configuration for command execution.
 * @returns Array of sync results, one per repo.
 */
export async function syncWorkflowsForAllRepos(
  repos: string[],
  options: WorkflowSyncOptions = {},
): Promise<WorkflowSyncResult[]> {
  const results: WorkflowSyncResult[] = [];
  // The pins do not vary by repository, so the whole fleet-wide sync shares
  // one lazily-resolved catalogue: at most one resolution per call, and none
  // when no body is rendered (Issue #1824).
  const sharedResolve = memoisePinResolver(
    options.resolvePins ??
      (() =>
        resolveActionPins({
          runFn: pinResolverRunFn(
            options.runCommand ?? createSetupRunCommand(options.ghConfigDir),
          ),
          log: options.log ?? ((message: string) => console.warn(message)),
        })),
  );
  for (const repo of repos) {
    if (!repo) continue;
    // Derive a per-repo `localRepoPath` from `workDir` when the caller
    // hasn't already set one explicitly (Issue #1811). Each repo lives
    // under `<workDir>/<repoName>` (matches `gitignore_sync.ts`).
    const base: WorkflowSyncOptions = {
      ...options,
      resolvePins: sharedResolve,
    };
    const perRepoOptions: WorkflowSyncOptions =
      options.localRepoPath !== undefined ? base : (options.workDir
        ? {
          ...base,
          localRepoPath: `${options.workDir}/${repo.split("/").pop() ?? repo}`,
        }
        : base);
    const result = await syncWorkflowsForRepo(repo, perRepoOptions);
    results.push(result);
  }
  return results;
}
