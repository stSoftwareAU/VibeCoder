/**
 * Label synchronisation across all monitored repositories.
 *
 * Creates or updates labels to ensure consistent names, colours, and
 * descriptions across every repo in the configuration.
 *
 * Issue #864: Standardise labels across repos we monitor.
 * Issue #923: Migrate to Deno TypeScript.
 * Issue #1295: The pass is destructive — it deletes labels and rewrites the
 * colour and description of any label whose name collides with the canonical
 * table. `dryRun` plans the whole pass from a read-only listing so an
 * operator can see what a repo would lose before anything is touched, and
 * GitHub's stock labels are never deleted at all.
 */

import {
  DEPRECATED_LABELS,
  getApplicableLabels,
  isProtectedStockLabel,
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
  /** True when the run only planned — nothing was created, edited or deleted. */
  dryRun: boolean;
  /** Failure detail, set when the repo could not be planned or synced. */
  error?: string;
}

/** Options for label sync operations. */
export interface LabelSyncOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /**
   * Plan only: report what the pass would do without issuing a single
   * mutating `gh` call (Issue #1295).
   */
  dryRun?: boolean;
  /**
   * Lower-cased names of the labels already on the repo. A dry run reads
   * them once per repo and passes the snapshot down so planning never
   * re-lists for every label.
   */
  remoteLabels?: ReadonlySet<string>;
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
 * Read the names of the labels a repo currently carries, lower-cased.
 *
 * Read-only — this is how a dry run plans without issuing a mutating call.
 * Throws rather than returning an empty set: a repo that cannot be read must
 * never be reported as "nothing to change".
 */
export async function fetchRemoteLabelNames(
  repo: string,
  opts: LabelSyncOptions = {},
): Promise<Set<string>> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);
  const result = await runner([
    "gh",
    "label",
    "list",
    "--repo",
    repo,
    "--limit",
    "500",
    "--json",
    "name",
  ]);
  if (!result.success) {
    throw new Error(
      `gh label list failed for ${repo}: ${result.stderr || "no stderr"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch (err) {
    throw new Error(
      `could not parse gh label list output for ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh label list did not return a JSON array for ${repo}`);
  }

  const names = new Set<string>();
  for (const entry of parsed) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name === "string") names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Create or update a single label in a repository.
 *
 * First attempts to create. If it already exists, attempts to update
 * its colour and description to match the canonical definition.
 *
 * Under `dryRun` nothing is created or edited: the outcome is planned from
 * the repo's existing labels, so "created" reads as "would be created".
 *
 * @returns "created" | "updated" | "failed"
 */
export async function syncSingleLabel(
  repo: string,
  label: LabelDefinition,
  opts: LabelSyncOptions = {},
): Promise<"created" | "updated" | "failed"> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);

  if (opts.dryRun) {
    const existing = opts.remoteLabels ??
      await fetchRemoteLabelNames(repo, opts);
    return existing.has(label.name.toLowerCase()) ? "updated" : "created";
  }

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
 * Two boundaries (Issue #1295): GitHub's stock labels are never deleted, and
 * under `dryRun` no `gh label delete` is issued at all — the return value is
 * then the number of deprecated labels that *would* be removed.
 *
 * @returns Number of labels removed (or, in a dry run, planned for removal)
 */
export async function removeDeprecatedLabels(
  repo: string,
  opts: LabelSyncOptions = {},
): Promise<number> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);
  const deletable = DEPRECATED_LABELS.filter((l) => !isProtectedStockLabel(l));

  if (opts.dryRun) {
    const existing = opts.remoteLabels ??
      await fetchRemoteLabelNames(repo, opts);
    return deletable.filter((l) => existing.has(l.toLowerCase())).length;
  }

  let removed = 0;
  for (const label of deletable) {
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
 * Under `dryRun` the repo's labels are read once and the whole pass is
 * planned from that snapshot — no label is created, edited or deleted
 * (Issue #1295).
 *
 * @param repo - Repository in "owner/repo" format
 * @param hasUi - Whether the repo has UI (auto-detected if not provided)
 */
export async function syncLabelsForRepo(
  repo: string,
  hasUi?: boolean,
  opts: LabelSyncOptions = {},
): Promise<LabelSyncResult> {
  const dryRun = opts.dryRun === true;
  // Auto-detect UI capability if not specified
  const uiCapable = hasUi ?? await detectRepoUi(repo, opts);
  const skipped = getLabelSkipCount(uiCapable);

  // One read-only listing per repo feeds the whole plan.
  let passOpts = opts;
  if (dryRun && !opts.remoteLabels) {
    try {
      passOpts = {
        ...opts,
        remoteLabels: await fetchRemoteLabelNames(repo, opts),
      };
    } catch (err) {
      // Fail loud: an unreadable repo is a failure, not an empty plan.
      return {
        ok: false,
        repo,
        created: 0,
        updated: 0,
        skipped,
        failures: 1,
        deprecated_removed: 0,
        dryRun,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const applicableLabels = getApplicableLabels(uiCapable);
  let created = 0;
  let updated = 0;
  let failures = 0;
  for (const label of applicableLabels) {
    const result = await syncSingleLabel(repo, label, passOpts);
    if (result === "created") created++;
    else if (result === "updated") updated++;
    else failures++;
  }

  // Remove deprecated labels
  const deprecatedRemoved = await removeDeprecatedLabels(repo, passOpts);

  return {
    ok: failures === 0,
    repo,
    created,
    updated,
    skipped,
    failures,
    deprecated_removed: deprecatedRemoved,
    dryRun,
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
