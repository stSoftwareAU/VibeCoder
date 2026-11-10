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
import { spawnGh } from "./gh_spawn.ts";
import { fetchRootContents, type RepoLanguages } from "./language_detector.ts";
import { getRepoVisibility, type RepoVisibility } from "./repo_visibility.ts";
import {
  DEPENDABOT_CONFIG_PATH,
  DEPENDABOT_CONFIG_YAML_PATH,
  getWorkflowsForLanguagesAndVisibility,
  WORKFLOW_SPECS,
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
   * auditor reads `.github/workflows/*.{yml,yaml}` (and, for a
   * `dependabotConfig` spec, `.github/dependabot.{yml,yaml}`) from disk
   * instead of issuing `gh api` calls (Issue #1811). Falls back to the API
   * path when the file cannot be read locally — for example, a cross-repo
   * audit with no clone available.
   */
  localRepoPath?: string;
}

/** A workflow spec that was fully matched in an existing file. */
export interface WorkflowMatch {
  spec: WorkflowSpec;
  /**
   * Where the spec was detected. A bare workflow filename for every spec
   * except a `dependabotConfig` spec, whose `foundIn` is the full
   * repo-relative path (`.github/workflows/<file>` or `.github/dependabot.yml`).
   */
  foundIn: string;
}

/** A workflow spec that was only partially matched. */
export interface PartialMatch {
  spec: WorkflowSpec;
  /**
   * Where some patterns were found. A bare workflow filename for every spec
   * except a `dependabotConfig` spec, whose `foundIn` is the full
   * repo-relative path (`.github/workflows/<file>` or `.github/dependabot.yml`).
   */
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
  /** Known root-project specs whose prerequisite is absent, even if the language disappeared. */
  notApplicable: WorkflowSpec[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create the default command runner.
 *
 * Issue #1378: this module only ever runs `gh`, so the runner is the shared
 * chokepoint (`spawnGh`) rather than a `Deno.Command` built from `cmd[0]` —
 * an indirection that skipped the write-repo allowlist and the audit journal
 * while the quality gate's literal-string scan saw nothing. Any other binary
 * is refused loudly rather than spawned outside the chokepoint.
 */
export function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  const env = ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : undefined;
  return async (cmd: string[]): Promise<CommandOutput> => {
    if (cmd[0] !== "gh") {
      throw new Error(
        `workflow_auditor only spawns gh through the chokepoint; ` +
          `refusing to run "${cmd[0] ?? ""}"`,
      );
    }
    const result = await spawnGh(cmd.slice(1), env ? { env } : {});
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
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

/** A repository's Dependabot configuration, as read by the auditor. */
interface DependabotConfigFile {
  /** Repo-relative path the configuration was read from. */
  path: string;
  content: string;
}

/**
 * Fetch the repository's Dependabot configuration (Issue #4904).
 *
 * Tries `.github/dependabot.yml`, then `.github/dependabot.yaml`. For each
 * name the local working tree is read first when `localRepoPath` is set, and
 * a failed local read falls through to `gh api`. A "not found" / 404 from the
 * API means that name is absent. Any other failure is an error rather than
 * "absent", so a transient fault cannot raise a spurious "Add … configuration"
 * issue (the Issue #1829 rationale in {@link fetchWorkflowFiles}).
 *
 * @returns The first configuration found, or `undefined` when neither exists.
 */
async function fetchDependabotConfig(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
  localRepoPath?: string,
): Promise<Result<DependabotConfigFile | undefined, string>> {
  const candidates = [DEPENDABOT_CONFIG_PATH, DEPENDABOT_CONFIG_YAML_PATH];
  for (const path of candidates) {
    if (localRepoPath !== undefined) {
      try {
        const content = await Deno.readTextFile(`${localRepoPath}/${path}`);
        return { ok: true, value: { path, content } };
      } catch {
        // Local read failed — fall through to the API for this name.
      }
    }

    const result = await runner([
      "gh",
      "api",
      `repos/${repo}/contents/${path}`,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ]);
    if (result.success) {
      return { ok: true, value: { path, content: result.stdout } };
    }
    if (!/\b(?:not found|404)\b/i.test(result.stderr)) {
      return {
        ok: false,
        error: `Failed to fetch ${path} for ${repo}: ${
          result.stderr || "unknown error"
        }`,
      };
    }
  }
  return { ok: true, value: undefined };
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

  // Resolve language and visibility candidates, then require root-marker
  // evidence only for templates whose commands run at the repository root.
  const langNames = languages.detected.map((d) => d.language);
  const resolveSpecs = options.specsResolver ??
    getWorkflowsForLanguagesAndVisibility;
  const candidates = resolveSpecs(langNames, visibility);
  let rootFiles = languages.rootFiles;
  if (rootFiles === undefined) {
    const contents = await fetchRootContents(repo, runner);
    if (!contents.ok) return contents;
    rootFiles = contents.value.filter((entry) => entry.type === "file")
      .map((entry) => entry.name);
  }
  const rootMarkerFiles = new Set(rootFiles);
  const hasRootProject = (spec: WorkflowSpec): boolean =>
    !spec.rootProjectMarkers ||
    spec.rootProjectMarkers.some((marker) => rootMarkerFiles.has(marker));
  const requiredSpecs = candidates.filter(hasRootProject);
  // Reconciliation covers the whole known catalogue: a language can vanish
  // from GitHub entirely while its old generated requests are still open.
  const notApplicable = WORKFLOW_SPECS.filter((spec) => !hasRootProject(spec));

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

  // Read the Dependabot configuration only when a required spec is one, so a
  // repository without such a spec costs no extra `gh` call (Issue #4904).
  let dependabotConfig: DependabotConfigFile | undefined;
  if (requiredSpecs.some((spec) => spec.dependabotConfig)) {
    try {
      const configResult = await fetchDependabotConfig(
        repo,
        runner,
        options.localRepoPath,
      );
      if (!configResult.ok) return { ok: false, error: configResult.error };
      dependabotConfig = configResult.value;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Failed to fetch Dependabot config for ${repo}: ${message}`,
      };
    }
  }

  // Classify each required spec as present, partial, or missing.
  const present: WorkflowMatch[] = [];
  const missing: WorkflowSpec[] = [];
  const partial: PartialMatch[] = [];

  for (const spec of requiredSpecs) {
    const totalGroups = spec.detectionPatternGroups.length;
    let bestFoundIn = "";
    let bestSatisfiedCount = 0;
    let bestMissingGroups: string[][] = spec.detectionPatternGroups;

    // A `dependabotConfig` spec reports full repo-relative paths and is also
    // evaluated against the Dependabot configuration (Issue #4904). Every
    // other spec keeps the bare workflow filename.
    // The config is matched on its `package-ecosystem` entry only, so a
    // "dependabot" header comment cannot satisfy another ecosystem's spec.
    const sources: [foundIn: string, content: string, groups: string[][]][] =
      [];
    for (const [filename, content] of fileContents) {
      sources.push([
        spec.dependabotConfig ? `.github/workflows/${filename}` : filename,
        content,
        spec.detectionPatternGroups,
      ]);
    }
    if (spec.dependabotConfig && dependabotConfig !== undefined) {
      sources.push([
        dependabotConfig.path,
        dependabotConfig.content,
        spec.dependabotConfigPatternGroups ?? spec.detectionPatternGroups,
      ]);
    }

    for (const [foundIn, content, groups] of sources) {
      const missingGroups = findMissingGroups(content, groups);
      const satisfiedCount = totalGroups - missingGroups.length;
      if (satisfiedCount > bestSatisfiedCount) {
        bestSatisfiedCount = satisfiedCount;
        bestFoundIn = foundIn;
        bestMissingGroups = missingGroups;
      }
    }

    if (bestSatisfiedCount === totalGroups) {
      // Every group satisfied — fully present.
      present.push({ spec, foundIn: bestFoundIn });
    } else if (bestSatisfiedCount > 0) {
      // Some groups satisfied, some missing — partial.
      partial.push({
        spec,
        foundIn: bestFoundIn,
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
      notApplicable,
    },
  };
}
