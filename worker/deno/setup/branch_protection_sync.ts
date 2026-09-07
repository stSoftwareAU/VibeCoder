/**
 * Setup-time branch-enforcement sync for monitored repositories
 * (Issue #2588; converted from classic protection to rulesets by #4163).
 *
 * Applies the default-branch **ruleset** to every monitored repo, once, at
 * setup time. For each repo it resolves the repository's visibility and
 * default branch, then calls the idempotent
 * {@link ensureDefaultBranchRuleset} configurator — which writes only when the
 * live ruleset state drifts from the desired required-check set, defers
 * entirely to any human- or org-managed ruleset that already covers the
 * branch, and never locks a branch that takes direct pushes (Issue #4356 —
 * on such a branch it removes its own stale ruleset instead). **Classic branch
 * protection is never written.**
 *
 * {@link planBranchProtectionForRepo} is the read-only twin: same resolution,
 * same decision, no write — it backs the `audit-default-branch-rulesets`
 * sweep.
 *
 * RATE-LIMIT BUDGET — READ BEFORE WIRING THIS ANYWHERE NEW.
 * This sync must run ONLY at setup time (once per `setup.sh` invocation). It
 * must NEVER be called from the per-iteration main loop (`run_core.ts`),
 * `issue_finder.ts`, `idle-detect`, or any other per-tick path. Per repo it
 * spends two metadata reads (visibility + default branch), a small number of
 * ruleset/check-name reads, up to `3 + 20` direct-push-detection reads
 * (Issue #4356; usually 3), and at most one ruleset write — affordable only
 * because it runs once per setup, not once per loop. A repo already covered by
 * someone else's ruleset short-circuits before the direct-push detection and
 * the check-name discovery. This mirrors the budget discipline in
 * `setup/collaborator_precheck.ts`.
 *
 * Per-repo failures are non-fatal: each repo's outcome is captured in a
 * {@link SyncResult} and the walk continues, so a single unreachable or
 * misconfigured repo never aborts the overall setup run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  ensureDefaultBranchRuleset,
  type GhExec,
  planDefaultBranchRuleset,
  type RulesetPlan,
  type RulesetSkipReason,
} from "../lib/default_branch_ruleset.ts";
import {
  getRepoVisibility,
  type RepoVisibility,
} from "../lib/repo_visibility.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable command runner (overridable for testing). */
export type RunCommand = (cmd: string[]) => Promise<CommandOutput>;

/** Per-repo outcome of the branch-enforcement sync. */
export interface SyncResult {
  repo: string;
  /** True when ruleset state was successfully read and (if needed) converged. */
  ok: boolean;
  /** True when a ruleset was created or updated. */
  changed: boolean;
  /** Contexts added to the required set (desired − current). */
  added: string[];
  /**
   * Contexts already required by rulesets and kept as-is; convergence is
   * additive so they are never removed (Issue #3656).
   */
  preserved: string[];
  /**
   * Types of the live ruleset's other rules carried through unchanged by an
   * update (`pull_request`, `non_fast_forward`, …) — the full-document PUT
   * never drops a rule an admin added (Issue #1290).
   */
  preservedRules?: string[];
  /**
   * True when the worker's own stale ruleset was deleted because the branch
   * takes direct pushes or opted out (Issue #4356).
   */
  deleted?: boolean;
  /** Why no change was made, when none was (Issue #4163). */
  skipped?: RulesetSkipReason;
  /** Human-readable detail for a skip (offending commit, opt-out signal). */
  detail?: string;
  /**
   * True when the default branch still carries a legacy **classic** protection
   * rule. The worker never writes or deletes classic protection; this is
   * reported so an operator can clear a leftover rule that would otherwise
   * demand ghost contexts forever (Issue #4163).
   */
  legacyClassicProtection?: boolean;
  /** Resolved visibility, when the read succeeded. */
  visibility?: RepoVisibility;
  /** Resolved default branch, when the read succeeded. */
  branch?: string;
  /** Populated on failure with a human-readable reason. */
  error?: string;
}

/** Per-repo outcome of the read-only plan ({@link planBranchProtectionForRepo}). */
export interface PlanResult {
  repo: string;
  /** True when the repo was resolved and a plan was computed. */
  ok: boolean;
  /** The decision, when `ok`. */
  plan?: RulesetPlan;
  /** Resolved visibility, when the read succeeded. */
  visibility?: RepoVisibility;
  /** Resolved default branch, when the read succeeded. */
  branch?: string;
  /** Populated on failure with a human-readable reason. */
  error?: string;
}

/** Aggregate outcome for the full sync. */
export interface BranchProtectionSyncSummary {
  total: number;
  /** Repos whose ruleset state was successfully read/converged. */
  configured: number;
  /** Repos where a ruleset was written this run. */
  changed: number;
  /** Repos that failed (recorded, non-fatal). */
  failed: number;
  results: SyncResult[];
}

/** Options for {@link syncBranchProtectionForAllRepos}. */
export interface BranchProtectionSyncOptions {
  /** `org/repo` slugs from `.config.json`. */
  repos: readonly string[];
  /** Custom gh config directory (from `.config.json` `gh_config_dir`). */
  ghConfigDir?: string;
  /** Override for metadata-read command execution (testing). */
  runCommand?: RunCommand;
  /** Override for the ruleset read/write executor (testing). */
  ghFn?: GhExec;
}

/** Options for {@link syncBranchProtectionForRepo}. */
export interface SyncRepoOptions {
  /**
   * Pre-resolved visibility. When supplied (e.g. the add-repo onboarding
   * path already determined it during validation), the visibility read is
   * skipped; otherwise it is resolved via {@link getRepoVisibility}.
   */
  visibility?: RepoVisibility;
  /** Custom gh config directory (from `.config.json` `gh_config_dir`). */
  ghConfigDir?: string;
  /** Override for metadata-read command execution (testing). */
  runCommand?: RunCommand;
  /** Override for the ruleset read/write executor (testing). */
  ghFn?: GhExec;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate an `owner/repo` slug (allowlist — no shell metacharacters). */
function isValidRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo);
}

/** Create a default runner using `Deno.Command` with optional gh config. */
function createDefaultRunCommand(ghConfigDir?: string): RunCommand {
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
 * Read a repo's default branch via `gh api repos/<repo> --jq .default_branch`.
 * Returns the branch name, or `undefined` when the read fails or is empty.
 */
async function getDefaultBranch(
  repo: string,
  runner: RunCommand,
): Promise<string | undefined> {
  const result = await runner([
    "gh",
    "api",
    `repos/${repo}`,
    "--jq",
    ".default_branch",
  ]);
  if (!result.success) return undefined;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : undefined;
}

// ---------------------------------------------------------------------------
// Core entry points
// ---------------------------------------------------------------------------

/**
 * Idempotently apply the default-branch **ruleset** to a single repo.
 * Resolves visibility (unless pre-supplied via
 * {@link SyncRepoOptions.visibility}) and the default branch, then forwards
 * both to {@link ensureDefaultBranchRuleset}.
 *
 * Never throws: every failure mode (invalid slug, visibility/branch read,
 * configurator error) is captured in the returned {@link SyncResult} so the
 * caller can report it without aborting the wider flow. This is the per-repo
 * primitive reused by both the setup-time all-repos walk
 * ({@link syncBranchProtectionForAllRepos}) and the add-repo onboarding path
 * (Issue #2589), which already knows the visibility from validation and so
 * passes it in to skip the redundant read.
 *
 * @param repo - `owner/repo` slug.
 * @param options - Pre-resolved visibility, gh identity, and injectable executors.
 */
export async function syncBranchProtectionForRepo(
  repo: string,
  options: SyncRepoOptions = {},
): Promise<SyncResult> {
  const context = await resolveRepoContext(repo, options);
  if (!context.ok) {
    return {
      repo,
      ok: false,
      changed: false,
      added: [],
      preserved: [],
      visibility: context.visibility,
      error: context.error,
    };
  }
  const { visibility, branch } = context;

  // 3. Idempotently converge the default-branch ruleset (reads + at most one
  //    ruleset write or delete; classic protection is never written).
  const outcome = await ensureDefaultBranchRuleset(
    repo,
    { branch, visibility },
    options.ghFn,
  );
  if (!outcome.ok) {
    return {
      repo,
      ok: false,
      changed: false,
      added: [],
      preserved: [],
      visibility,
      branch,
      error: outcome.error.message,
    };
  }

  return {
    repo,
    ok: true,
    changed: outcome.changed,
    deleted: outcome.deleted,
    added: outcome.added,
    preserved: outcome.preserved,
    preservedRules: outcome.preservedRules,
    skipped: outcome.skipped,
    detail: outcome.detail,
    legacyClassicProtection: outcome.legacyClassicProtection,
    visibility,
    branch,
  };
}

/**
 * Read-only twin of {@link syncBranchProtectionForRepo}: resolves the same
 * visibility and default branch, then returns the
 * {@link planDefaultBranchRuleset} decision **without writing** (Issue #4356).
 * Backs the `audit-default-branch-rulesets` sweep.
 */
export async function planBranchProtectionForRepo(
  repo: string,
  options: SyncRepoOptions = {},
): Promise<PlanResult> {
  const context = await resolveRepoContext(repo, options);
  if (!context.ok) {
    return {
      repo,
      ok: false,
      visibility: context.visibility,
      error: context.error,
    };
  }
  const { visibility, branch } = context;
  const planned = await planDefaultBranchRuleset(
    repo,
    { branch, visibility },
    options.ghFn,
  );
  if (!planned.ok) {
    return {
      repo,
      ok: false,
      visibility,
      branch,
      error: planned.error.message,
    };
  }
  return { repo, ok: true, plan: planned.plan, visibility, branch };
}

/** Shared per-repo resolution: slug check, visibility, default branch. */
async function resolveRepoContext(
  repo: string,
  options: SyncRepoOptions,
): Promise<
  | { ok: true; visibility: RepoVisibility; branch: string }
  | { ok: false; error: string; visibility?: RepoVisibility }
> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);

  // Input validation — never trust a slug into a gh call.
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: `Invalid repo slug: ${repo}` };
  }

  // 1. Resolve visibility (use the pre-resolved value when supplied; otherwise
  //    one read, fail-safe to private inside the helper).
  let visibility: RepoVisibility;
  if (options.visibility !== undefined) {
    visibility = options.visibility;
  } else {
    const resolved = await getRepoVisibility(repo, {
      ghConfigDir: options.ghConfigDir,
      runCommand: runner,
    });
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    visibility = resolved.value;
  }

  // 2. Resolve the default branch (one read).
  const branch = await getDefaultBranch(repo, runner);
  if (!branch) {
    return {
      ok: false,
      visibility,
      error: `Could not resolve default branch for ${repo}`,
    };
  }

  return { ok: true, visibility, branch };
}

/**
 * Walk every configured repo and idempotently apply the default-branch
 * ruleset. Visibility and the default branch are resolved per repo (via
 * {@link syncBranchProtectionForRepo}) and forwarded to
 * {@link ensureDefaultBranchRuleset}.
 *
 * Per-repo failures are recorded and never abort the walk.
 *
 * @param options - Repos, gh identity, and injectable executors.
 */
export async function syncBranchProtectionForAllRepos(
  options: BranchProtectionSyncOptions,
): Promise<BranchProtectionSyncSummary> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);

  const results: SyncResult[] = [];
  let configured = 0;
  let changed = 0;
  let failed = 0;

  for (const repo of options.repos) {
    const result = await syncBranchProtectionForRepo(repo, {
      ghConfigDir: options.ghConfigDir,
      runCommand: runner,
      ghFn: options.ghFn,
    });
    results.push(result);
    if (result.ok) {
      configured++;
      if (result.changed) changed++;
    } else {
      failed++;
    }
  }

  return {
    total: options.repos.length,
    configured,
    changed,
    failed,
    results,
  };
}
