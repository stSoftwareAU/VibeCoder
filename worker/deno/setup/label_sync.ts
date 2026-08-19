/**
 * Label synchronisation across all monitored repositories.
 *
 * Creates or updates labels to ensure consistent names, colours, and
 * descriptions across every repo in the configuration.
 *
 * Issue #864: Standardise labels across repos we monitor.
 * Issue #923: Migrate to Deno TypeScript.
 */

import {
  DEPRECATED_LABELS,
  getApplicableLabels,
  repoHasUi,
} from "./label_definitions.ts";
import type { LabelDefinition } from "./label_definitions.ts";

/** Result of syncing labels for a single repo. */
export interface LabelSyncResult {
  ok: boolean;
  repo: string;
  created: number;
  updated: number;
  skipped: number;
  failures: number;
  deprecated_removed: number;
}

/** Options for label sync operations. */
export interface LabelSyncOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
}

interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

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

/**
 * Create or update a single label in a repository.
 *
 * First attempts to create. If it already exists, attempts to update
 * its colour and description to match the canonical definition.
 *
 * @returns "created" | "updated" | "failed"
 */
export async function syncSingleLabel(
  repo: string,
  label: LabelDefinition,
  opts: LabelSyncOptions = {},
): Promise<"created" | "updated" | "failed"> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);

  // Try to create the label
  const createResult = await runner([
    "gh",
    "label",
    "create",
    label.name,
    "--repo",
    repo,
    "--color",
    label.colour,
    "--description",
    label.description,
  ]);
  if (createResult.success) return "created";

  // Label likely already exists — update it
  const editResult = await runner([
    "gh",
    "label",
    "edit",
    label.name,
    "--repo",
    repo,
    "--color",
    label.colour,
    "--description",
    label.description,
  ]);
  if (editResult.success) return "updated";

  return "failed";
}

/**
 * Remove deprecated labels from a repository.
 *
 * @returns Number of labels removed
 */
export async function removeDeprecatedLabels(
  repo: string,
  opts: LabelSyncOptions = {},
): Promise<number> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);
  let removed = 0;

  for (const label of DEPRECATED_LABELS) {
    const result = await runner([
      "gh",
      "label",
      "delete",
      label,
      "--repo",
      repo,
      "--yes",
    ]);
    if (result.success) {
      removed++;
    }
  }

  return removed;
}

/**
 * Detect whether a repo has UI components via the GitHub API.
 */
export async function detectRepoUi(
  repo: string,
  opts: LabelSyncOptions = {},
): Promise<boolean> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);
  const result = await runner(["gh", "api", `repos/${repo}/languages`]);
  if (!result.success) return false;

  try {
    const languages: Record<string, number> = JSON.parse(result.stdout);
    return repoHasUi(languages);
  } catch {
    return false;
  }
}

/**
 * Synchronise all applicable labels for a single repository.
 *
 * @param repo - Repository in "owner/repo" format
 * @param hasUi - Whether the repo has UI (auto-detected if not provided)
 */
export async function syncLabelsForRepo(
  repo: string,
  hasUi?: boolean,
  opts: LabelSyncOptions = {},
): Promise<LabelSyncResult> {
  // Auto-detect UI capability if not specified
  const uiCapable = hasUi ?? await detectRepoUi(repo, opts);

  const applicableLabels = getApplicableLabels(uiCapable);
  let created = 0;
  let updated = 0;
  let failures = 0;
  for (const label of applicableLabels) {
    const result = await syncSingleLabel(repo, label, opts);
    if (result === "created") created++;
    else if (result === "updated") updated++;
    else failures++;
  }

  // Remove deprecated labels
  const deprecatedRemoved = await removeDeprecatedLabels(repo, opts);

  return {
    ok: failures === 0,
    repo,
    created,
    updated,
    skipped: getLabelSkipCount(uiCapable),
    failures,
    deprecated_removed: deprecatedRemoved,
  };
}

/** Calculate number of labels skipped (UI labels on non-UI repos). */
function getLabelSkipCount(hasUi: boolean): number {
  if (hasUi) return 0;
  // Count UI-only labels that would be skipped for non-UI repos
  return getApplicableLabels(true).length - getApplicableLabels(false).length;
}

/**
 * Synchronise labels across all configured repositories.
 *
 * @param repos - Array of repo strings in "owner/repo" format
 * @returns Array of sync results, one per repo
 */
export async function syncLabelsForAllRepos(
  repos: string[],
  opts: LabelSyncOptions = {},
): Promise<LabelSyncResult[]> {
  const results: LabelSyncResult[] = [];
  for (const repo of repos) {
    if (!repo) continue;
    const result = await syncLabelsForRepo(repo, undefined, opts);
    results.push(result);
  }
  return results;
}
