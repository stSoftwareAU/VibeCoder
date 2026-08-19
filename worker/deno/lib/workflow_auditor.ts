/**
 * Repository workflow gap analysis library.
 *
 * Audits a repository's existing GitHub Actions workflows against the
 * expected set (based on detected languages), producing a gap analysis
 * of what is present, missing, or partially matching.
 *
 * Issue #1393: Create workflow auditor to check repos for required GitHub Actions.
 */

import type { Result } from "../types.ts";
import type { RepoLanguages } from "./language_detector.ts";
import { getRepoVisibility, type RepoVisibility } from "./repo_visibility.ts";
import {
  getWorkflowsForLanguagesAndVisibility,
  type WorkflowSpec,
} from "./workflow_definitions.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Options for the workflow auditor. */
export interface WorkflowAuditOptions {
  /** Override for command execution (useful for testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /**
   * Override the function that resolves required specs from the
   * detected languages and repository visibility. Defaults to
   * {@link getWorkflowsForLanguagesAndVisibility}. Intended for tests
   * that want to inject a stub spec (e.g. a `public-only` spec to
   * verify visibility-aware filtering — Issue #1753).
   */
  specsResolver?: (
    languages: string[],
    visibility: RepoVisibility,
  ) => WorkflowSpec[];
  /**
   * Path to a local working tree of the repository. When provided, the
   * auditor reads `.github/workflows/*.{yml,yaml}` from disk instead of
   * issuing `gh api` calls (Issue #1811). Falls back to the API path
   * when the workflows directory cannot be read locally — for example,
   * a cross-repo audit with no clone available.
   */
  localRepoPath?: string;
}

/** A workflow spec that was fully matched in an existing file. */
export interface WorkflowMatch {
  spec: WorkflowSpec;
  /** Workflow filename where the spec was detected. */
  foundIn: string;
}

/** A workflow spec that was only partially matched. */
export interface PartialMatch {
  spec: WorkflowSpec;
  /** Workflow filename where some patterns were found. */
  foundIn: string;
  /**
   * Detection-pattern groups for which no alternative was found in the
   * workflow content. Each entry is the full list of acceptable patterns
   * for that capability — the workflow needs to satisfy at least one
   * pattern from each missing group to become fully present.
   */
  missingGroups: string[][];
}

/** Result of auditing a repository's workflows. */
export interface WorkflowAuditResult {
  repo: string;
  languages: string[];
  /** Workflows fully present (all detection patterns matched). */
  present: WorkflowMatch[];
  /** Workflows entirely missing (no detection patterns matched). */
  missing: WorkflowSpec[];
  /** Workflows with some but not all detection patterns matched. */
  partial: PartialMatch[];
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

/** Entry from the GitHub Contents API listing. */
interface WorkflowFileEntry {
  name: string;
  type: string;
  download_url?: string;
}

/**
 * Fetch the list of workflow files from a repository.
 *
 * When `localRepoPath` is provided AND the workflows directory exists
 * on disk, the listing is read from the local working tree
 * (`<localRepoPath>/.github/workflows`). Otherwise — including when
 * the local directory is missing (e.g. the repo has not been cloned
 * yet, or has no `.github/workflows`) — falls through to the existing
 * `gh api` path (Issue #1811).
 */
async function fetchWorkflowFiles(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  localRepoPath?: string,
): Promise<Result<WorkflowFileEntry[], string>> {
  if (localRepoPath !== undefined) {
    const dir = `${localRepoPath}/.github/workflows`;
    try {
      const entries: WorkflowFileEntry[] = [];
      for await (const item of Deno.readDir(dir)) {
        if (item.isFile) {
          entries.push({ name: item.name, type: "file" });
        }
      }
      return { ok: true, value: entries };
    } catch {
      // Local read failed — fall through to the API path so
      // not-yet-cloned repos still get audited.
    }
  }

  const result = await runner([
    "gh",
    "api",
    `repos/${repo}/contents/.github/workflows`,
  ]);

  if (!result.success) {
    // Distinguish a legitimately empty directory (404) from transient
    // failures (rate limit, auth glitch, 5xx). Issue #1829: silently
    // returning an empty list on every failure misclassified every
    // required workflow as missing and caused workflow-sync to raise
    // duplicate "Add … workflow" issues against repos where the
    // workflows were in fact present. Treat only an explicit "Not Found"
    // / 404 as legitimately empty; propagate other failures so the
    // audit fails loudly and no spurious issues are raised.
    const stderr = result.stderr;
    const isNotFound = /\b(?:not found|404)\b/i.test(stderr);
    if (isNotFound) {
      return { ok: true, value: [] };
    }
    return {
      ok: false,
      error: `Failed to list workflows for ${repo}: ${
        stderr || "unknown error"
      }`,
    };
  }

  try {
    const entries = JSON.parse(result.stdout) as WorkflowFileEntry[];
    return { ok: true, value: entries };
  } catch {
    return { ok: false, error: "Failed to parse workflow directory listing" };
  }
}

/**
 * Fetch the raw content of a single workflow file.
 *
 * When `localRepoPath` is provided AND the file exists on disk, the
 * content is read from the local working tree. Otherwise — including
 * when the local read fails (file missing, permission denied, etc.) —
 * falls through to the `gh api` path so the audit still sees the file
 * content the listing endpoint just told us exists.
 *
 * Issue #1838: previously this helper returned an error when the local
 * read failed, instead of falling through to the API like
 * `fetchWorkflowFiles` does. When `localRepoPath` was set but the repo
 * was not yet cloned, the listing endpoint correctly fell back to the
 * API and returned a non-empty file list, but every per-file content
 * read then failed silently — leaving the audit with an empty content
 * map and misclassifying every required workflow as missing. The
 * symptom was a flood of duplicate "Add … workflow" issues against
 * repos whose workflows were in fact present (e.g. private-repo-16 got
 * seven duplicate sync issues). The fix mirrors the listing
 * fall-through semantics here.
 */
async function fetchWorkflowContent(
  repo: string,
  filename: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  localRepoPath?: string,
): Promise<Result<string, string>> {
  if (localRepoPath !== undefined) {
    try {
      const content = await Deno.readTextFile(
        `${localRepoPath}/.github/workflows/${filename}`,
      );
      return { ok: true, value: content };
    } catch {
      // Local read failed — fall through to the API path so the audit
      // can still see file content the listing endpoint just told us
      // exists. (Issue #1838)
    }
  }

  const result = await runner([
    "gh",
    "api",
    `repos/${repo}/contents/.github/workflows/${filename}`,
    "-H",
    "Accept: application/vnd.github.raw+json",
  ]);

  if (!result.success) {
    return {
      ok: false,
      error: `Failed to fetch workflow ${filename}: ${result.stderr}`,
    };
  }

  return { ok: true, value: result.stdout };
}

/**
 * Evaluate detection-pattern groups against content.
 *
 * A group is satisfied when at least one of its patterns matches the
 * content (case-insensitive). Groups themselves are AND-combined — all
 * groups must be satisfied for full coverage.
 *
 * @returns The groups that did NOT match (empty when all groups are
 *   satisfied).
 */
function findMissingGroups(
  content: string,
  groups: string[][],
): string[][] {
  const lower = content.toLowerCase();
  return groups.filter((group) =>
    !group.some((p) => lower.includes(p.toLowerCase()))
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit a repository's existing GitHub Actions workflows against expected specs.
 *
 * Fetches workflow files from the repo, scans their content for detection
 * patterns from the workflow specifications, and produces a gap analysis.
 *
 * @param repo - Repository in "owner/repo" format.
 * @param languages - Detected languages for the repository.
 * @param options - Optional configuration for command execution and gh identity.
 * @returns Result containing the audit analysis or an error message.
 */
export async function auditRepoWorkflows(
  repo: string,
  languages: RepoLanguages,
  options: WorkflowAuditOptions = {},
): Promise<Result<WorkflowAuditResult, string>> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);

  // Determine repository visibility so visibility-scoped specs (Issue
  // #1753) can be filtered out for repos where they do not apply. On
  // lookup failure (Result error or thrown exception), fall back to
  // "private" — the fail-safe choice that suppresses any public-only
  // spec rather than raising a noise issue against a repo we cannot
  // classify.
  let visibility: RepoVisibility = "private";
  try {
    const visibilityResult = await getRepoVisibility(repo, {
      runCommand: runner,
      ghConfigDir: options.ghConfigDir,
    });
    if (visibilityResult.ok) {
      visibility = visibilityResult.value;
    }
  } catch {
    // Fail-safe — leave visibility as "private".
  }

  // Determine required workflows based on detected languages and visibility.
  const langNames = languages.detected.map((d) => d.language);
  const resolveSpecs = options.specsResolver ??
    getWorkflowsForLanguagesAndVisibility;
  const requiredSpecs = resolveSpecs(langNames, visibility);

  // Fetch workflow file listing.
  let workflowFiles: WorkflowFileEntry[];
  try {
    const listResult = await fetchWorkflowFiles(
      repo,
      runner,
      options.localRepoPath,
    );
    if (!listResult.ok) {
      return { ok: false, error: listResult.error };
    }
    workflowFiles = listResult.value;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to list workflow files: ${message}` };
  }

  // Fetch content for each workflow file.
  const fileContents: Map<string, string> = new Map();
  for (const file of workflowFiles) {
    if (!file.name.endsWith(".yml") && !file.name.endsWith(".yaml")) {
      continue;
    }
    try {
      const contentResult = await fetchWorkflowContent(
        repo,
        file.name,
        runner,
        options.localRepoPath,
      );
      if (contentResult.ok) {
        fileContents.set(file.name, contentResult.value);
      }
    } catch {
      // Skip files that cannot be fetched — do not fail the entire audit.
    }
  }

  // Classify each required spec as present, partial, or missing.
  const present: WorkflowMatch[] = [];
  const missing: WorkflowSpec[] = [];
  const partial: PartialMatch[] = [];

  for (const spec of requiredSpecs) {
    const totalGroups = spec.detectionPatternGroups.length;
    let bestFilename = "";
    let bestSatisfiedCount = 0;
    let bestMissingGroups: string[][] = spec.detectionPatternGroups;

    for (const [filename, content] of fileContents) {
      const missingGroups = findMissingGroups(
        content,
        spec.detectionPatternGroups,
      );
      const satisfiedCount = totalGroups - missingGroups.length;
      if (satisfiedCount > bestSatisfiedCount) {
        bestSatisfiedCount = satisfiedCount;
        bestFilename = filename;
        bestMissingGroups = missingGroups;
      }
    }

    if (bestSatisfiedCount === totalGroups) {
      // Every group satisfied — fully present.
      present.push({ spec, foundIn: bestFilename });
    } else if (bestSatisfiedCount > 0) {
      // Some groups satisfied, some missing — partial.
      partial.push({
        spec,
        foundIn: bestFilename,
        missingGroups: bestMissingGroups,
      });
    } else {
      // No group satisfied — missing.
      missing.push(spec);
    }
  }

  return {
    ok: true,
    value: {
      repo,
      languages: langNames,
      present,
      missing,
      partial,
    },
  };
}
