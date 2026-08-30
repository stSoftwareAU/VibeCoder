/**
 * Workflow synchronisation across all monitored repositories.
 *
 * Orchestrates language detection, workflow auditing, and issue creation
 * for missing GitHub Actions workflows. Issues are created in the TARGET
 * repository (not VibeCoder) and are idempotent — running twice will not
 * create duplicates.
 *
 * Issue #1395: Add workflow-sync subcommand to setup CLI.
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Options for workflow sync operations. */
export interface WorkflowSyncOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /** Whether to perform a dry run (report only, no issue creation). */
  dryRun?: boolean;
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
}

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

/** Create a default command runner using Deno.Command with optional gh config. */
function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  return async (cmd: string[]): Promise<CommandOutput> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env,
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      stdout: decoder.decode(output.stdout).trim(),
      stderr: decoder.decode(output.stderr).trim(),
    };
  };
}

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
): Promise<boolean> {
  // Search across both open and closed states so a previously-raised
  // (and possibly closed) issue suppresses recreation. Issue #1829: a
  // dedup limited to `--state open` allowed setup to re-raise issues
  // for workflows that were already present and had a prior sync issue
  // closed against them.
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
    "number",
    "--limit",
    "1",
  ]);

  if (!result.success) {
    // If the search fails, assume no issue exists (safe to create).
    return false;
  }

  try {
    const issues = JSON.parse(result.stdout) as { number: number }[];
    return issues.length > 0;
  } catch {
    return false;
  }
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

/** Build the issue body for a missing workflow. */
export function issueBody(spec: WorkflowSpec): string {
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
${spec.template.trim()}
\`\`\`

### How to apply

1. Copy the YAML template above
2. Save it as \`.github/workflows/${spec.suggestedFilename}\`
3. Commit and push to the default branch
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
${spec.template.trim()}
\`\`\`

### How to complete

1. Review \`.github/workflows/${foundIn}\` and confirm whether each "not detected" capability above is genuinely missing or implemented via an alternative the auditor does not recognise.
2. If the capability is genuinely missing, add an implementation for it — copy the relevant step from the suggested template above, or use any equivalent configuration that performs the same capability.
3. If every capability is in fact present via alternatives, close this issue as not-applicable. No workflow change is needed.
4. Otherwise, commit the additions to the default branch.
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
): Promise<boolean> {
  const title = issueTitle(spec);
  const body = issueBody(spec);

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
): Promise<boolean> {
  const title = issueTitlePartial(spec);
  const body = issueBodyPartial(spec, foundIn, missingGroups);

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
    createDefaultRunCommand(options.ghConfigDir);
  const langOpts: LanguageDetectorOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
  };
  const auditOpts: WorkflowAuditOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
    localRepoPath: options.localRepoPath,
  };

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
      try {
        const exists = await issueExistsByTag(
          repo,
          deduplicationTag(spec.id),
          runner,
        );
        if (exists) {
          issuesSkipped++;
          continue;
        }

        const created = await createWorkflowIssue(repo, spec, runner);
        if (created) {
          issuesRaised++;
        }
      } catch {
        // Skip this spec on failure — do not block other specs.
      }
    }

    // Step 4: Raise issues for partially matching workflows
    for (const partialMatch of audit.partial) {
      try {
        const exists = await issueExistsByTag(
          repo,
          partialDeduplicationTag(partialMatch.spec.id),
          runner,
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
  for (const repo of repos) {
    if (!repo) continue;
    // Derive a per-repo `localRepoPath` from `workDir` when the caller
    // hasn't already set one explicitly (Issue #1811). Each repo lives
    // under `<workDir>/<repoName>` (matches `gitignore_sync.ts`).
    const perRepoOptions: WorkflowSyncOptions =
      options.localRepoPath !== undefined ? options : (options.workDir
        ? {
          ...options,
          localRepoPath: `${options.workDir}/${repo.split("/").pop() ?? repo}`,
        }
        : options);
    const result = await syncWorkflowsForRepo(repo, perRepoOptions);
    results.push(result);
  }
  return results;
}
