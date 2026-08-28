/**
 * The deterministic pass over a conflicted tree (Issue #466, part of #456).
 *
 * This is the step `pr_merge_conflict_processor.ts` runs **before** the AI
 * agent. It applies the registered manifest rules to each conflicted path,
 * regenerates the lock files whose manifest came out merged, and stages what it
 * resolved. Everything it cannot decide is handed back with a reason, and the
 * agent is then asked about those paths only.
 *
 * ```mermaid
 * flowchart TD
 *     A[Conflicted paths] --> B{Lock file?}
 *     B -- no --> C{Registered rule?}
 *     C -- no --> D[deferred: no rule]
 *     C -- yes --> E[Parse hunks and resolve]
 *     E -- unresolved --> F[deferred: rule reason]
 *     E -- resolved --> G[Write + git add]
 *     G -- stage failed --> H[git checkout --merge] --> F
 *     G -- staged --> I[resolved + decisions]
 *     B -- yes --> J[Regenerate from the merged manifest]
 *     J --> K[resolved or deferred]
 * ```
 *
 * Two invariants hold on every path:
 *
 * - **A deferral stages nothing and changes nothing.** The conflicted file is
 *   left exactly as git wrote it, markers and all, so the AI fallback and the
 *   processor's existing marker/unmerged guards still see the real conflict.
 * - **A resolution is all-or-nothing per file.** The rule core has no `partial`
 *   outcome, so a staged file can never carry a conflict marker.
 *
 * Failures are loud: a write or a stage that fails restores the conflicted file
 * and defers with the git output in the reason, rather than reporting a file as
 * resolved that is not.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type DependencyDecision,
  extractDependencyDecisions,
} from "./dependency_conflict_decisions.ts";
import {
  type ManifestRuleRegistry,
  manifestRuleRegistry,
  parseConflictSegments,
} from "./dependency_conflict_rules.ts";
// Imported for their registration side effect: importing this module is all it
// takes for every ecosystem's rules to be available to the pass.
import "./dependency_conflict_json.ts";
import "./dependency_conflict_native.ts";
import {
  isSafeRepoRelativePath,
  type LockRegenLogger,
  type LockRegenOptions,
  lockSpecForPath,
  type ManifestStatus,
  regenerateLockFiles,
} from "./dependency_lock_regen.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Exit status of a git command the pass runs. */
export interface ConflictGitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a git command in the repository working directory.
 *
 * Injected so this module never decides how git is spawned, and so tests never
 * shell out. A spawn failure must be folded into a non-zero code by the caller
 * — "could not run git" is not "git was happy".
 */
export type ConflictGitRunner = (
  args: readonly string[],
) => Promise<ConflictGitOutcome>;

/** A conflicted file the rules resolved. */
export interface ResolvedConflictFile {
  /** Repository-relative path. */
  path: string;
  /** Whether a manifest rule or a lock regeneration resolved it. */
  kind: "manifest" | "lock";
  /** The manifest rule's name, or the command that regenerated the lock. */
  resolvedBy: string;
  /** Per-dependency decisions; empty for a lock file. */
  decisions: readonly DependencyDecision[];
  /**
   * True when the resolution could not be attributed to individual
   * dependencies, so the comment says so instead of naming a wrong pick.
   */
  decisionsUnattributed: boolean;
}

/** A conflicted file the rules left for the AI fallback. */
export interface DeferredConflictFile {
  path: string;
  /** Why it was deferred — logged, and reported on the PR when it fails. */
  reason: string;
}

/** What the deterministic pass did with the conflicted tree. */
export interface DeterministicConflictReport {
  resolved: ResolvedConflictFile[];
  deferred: DeferredConflictFile[];
}

/** Options for {@link applyDependencyConflictRules}. */
export interface DeterministicConflictOptions {
  /** Absolute path of the repository working directory. */
  workingDir: string;
  /** Repository-relative conflicted paths, from `--diff-filter=U`. */
  conflictedFiles: readonly string[];
  /** Git runner, already bound to the working directory. */
  git: ConflictGitRunner;
  /** Rule registry; defaults to the shared one every ecosystem registers into. */
  registry?: ManifestRuleRegistry;
  /** Manifest reader — defaults to reading under `workingDir`. */
  readFile?: (path: string) => Promise<string | null>;
  /** Manifest writer — defaults to writing under `workingDir`. */
  writeFile?: (path: string, text: string) => Promise<void>;
  logger?: LockRegenLogger;
  /** Lock-regeneration seams, passed straight through (tests). */
  lockRegen?: Pick<
    LockRegenOptions,
    "runner" | "hasTool" | "readLockFile" | "timeoutMs"
  >;
}

/** The pass itself, as a type so the processor can inject a stub in tests. */
export type DependencyRuleApplier = (
  options: DeterministicConflictOptions,
) => Promise<DeterministicConflictReport>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Join a working directory with a repository-relative path. */
function joinPath(workingDir: string, relative: string): string {
  return `${workingDir.replace(/\/+$/, "")}/${relative}`;
}

function defaultReader(
  workingDir: string,
): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      return await Deno.readTextFile(joinPath(workingDir, path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
}

function defaultWriter(
  workingDir: string,
): (path: string, text: string) => Promise<void> {
  return (path, text) => Deno.writeTextFile(joinPath(workingDir, path), text);
}

/** Bound git output so one runaway command cannot flood a PR comment. */
function gitDetail(outcome: ConflictGitOutcome): string {
  const text = `${outcome.stderr}\n${outcome.stdout}`.trim();
  return text.length > 0 ? text.slice(0, 500) : `exit ${outcome.code}`;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Resolve every conflicted path the deterministic rules can decide.
 *
 * Manifests are attempted first: a lock file is only regenerated once its own
 * manifest is known to be merged, which is exactly what the lock-regeneration
 * module refuses to assume on its own.
 *
 * @returns The rule-resolved files (already staged) and the deferred ones.
 */
export async function applyDependencyConflictRules(
  options: DeterministicConflictOptions,
): Promise<DeterministicConflictReport> {
  const {
    workingDir,
    conflictedFiles,
    git,
    registry = manifestRuleRegistry,
    readFile = defaultReader(workingDir),
    writeFile = defaultWriter(workingDir),
    logger,
  } = options;

  const resolved: ResolvedConflictFile[] = [];
  const deferred: DeferredConflictFile[] = [];
  const manifestOutcomes = new Map<string, ManifestStatus>();

  const defer = (path: string, reason: string): void => {
    logger?.warn(`Conflicted file left for the AI fallback: ${reason}`, {
      path,
      reason,
    });
    deferred.push({ path, reason });
  };

  const lockFiles = conflictedFiles.filter((path) =>
    lockSpecForPath(path) !== undefined
  );
  const manifests = conflictedFiles.filter((path) =>
    lockSpecForPath(path) === undefined
  );

  for (const path of manifests) {
    if (!isSafeRepoRelativePath(path)) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `unsafe path outside the working directory: ${path}`);
      continue;
    }

    const rule = registry.find(path);
    if (!rule) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, "no deterministic rule handles this file");
      continue;
    }

    let text: string | null;
    try {
      text = await readFile(path);
    } catch (error) {
      text = null;
      logger?.warn(`Reading the conflicted ${path} failed`, {
        path,
        error: (error as Error).message,
      });
    }
    if (text === null) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `${path} could not be read from the working tree`);
      continue;
    }

    const parsed = parseConflictSegments(text);
    if (!parsed.ok) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `${path} could not be parsed: ${parsed.error}`);
      continue;
    }

    const outcome = rule.resolve(parsed.value);
    if (outcome.kind === "unresolved") {
      manifestOutcomes.set(path, "unresolved");
      defer(path, outcome.reason);
      continue;
    }

    /** Put the conflicted file back so the AI fallback sees a real conflict. */
    const restore = async (): Promise<void> => {
      await git(["checkout", "--merge", "--", path]);
    };

    try {
      await writeFile(path, outcome.text);
    } catch (error) {
      await restore();
      manifestOutcomes.set(path, "unresolved");
      defer(
        path,
        `writing the resolved ${path} failed: ${(error as Error).message}`,
      );
      continue;
    }

    const staged = await git(["add", "--", path]);
    if (staged.code !== 0) {
      await restore();
      manifestOutcomes.set(path, "unresolved");
      defer(path, `staging the resolved ${path} failed: ${gitDetail(staged)}`);
      continue;
    }

    const decisions = extractDependencyDecisions(parsed.value, outcome.text);
    manifestOutcomes.set(path, "resolved");
    resolved.push({
      path,
      kind: "manifest",
      resolvedBy: rule.name,
      decisions: decisions ?? [],
      decisionsUnattributed: decisions === null,
    });
    logger?.info?.(`Resolved ${path} by rule ${rule.name}`, {
      path,
      rule: rule.name,
      decisions: (decisions ?? []).length,
    });
  }

  if (lockFiles.length > 0) {
    const outcomes = await regenerateLockFiles({
      workingDir,
      manifestOutcomes,
      lockFiles,
      ...(logger ? { logger } : {}),
      ...options.lockRegen,
    });
    for (const outcome of outcomes) {
      if (outcome.kind === "unresolved") {
        defer(outcome.path, outcome.reason);
        continue;
      }
      resolved.push({
        path: outcome.path,
        kind: "lock",
        resolvedBy: [outcome.command.bin, ...outcome.command.args].join(" "),
        decisions: [],
        decisionsUnattributed: false,
      });
    }
  }

  return { resolved, deferred };
}
