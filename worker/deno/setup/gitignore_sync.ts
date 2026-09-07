/**
 * Setup-time `.gitignore` and `.gitattributes` enforcement for monitored
 * repositories (Issue #1774, follow-up to Issue #1757; extended for
 * `.gitattributes` by Issues #2332/#2340).
 *
 * Previously `setupRepo()` (called dozens of times per worker cycle)
 * invoked `ensureGitignorePatterns()` on every clone or update. Because
 * the call ran *after* `git reset --hard origin/<default>`, the patterns
 * were re-added every iteration even when already on disk — producing
 * the noisy log line `[setup-repo] gitignore: 8 patterns added, 2 already
 * present` on every PR-branch update.
 *
 * The enforcement now runs at setup time only: `setup.sh` invokes the
 * `gitignore-sync` subcommand once, which walks every monitored repo
 * already cloned under `WORK_DIR` and applies both
 * `ensureGitignorePatterns()` and `ensureGitattributesPatterns()`. Repos
 * that haven't been cloned yet are skipped — the worker will pick them
 * up on first `setup-repo` invocation, and the patterns will be applied
 * on the next setup.sh run after the repo is materialised. File changes
 * ride along in the next normal worker PR for the repo — no dedicated
 * commit machinery (per Issue #2332).
 *
 * Defence-in-depth from Issue #1751 is preserved:
 *   - Layer 1: prompt rule in `prompts/coding_guidelines/`
 *   - Layer 2: `.gitignore` + `.gitattributes` patterns (setup-time only)
 *   - Layer 3: pre-commit gate (`pre_commit_safety.ts`) — every commit
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  ensureGitattributesPatterns,
  ensureGitignorePatterns,
} from "../lib/gitignore_enforcer.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "../lib/repo_slug.ts";

/** Result of a single repo's enforcement pass. */
export interface RepoSyncResult {
  repo: string;
  /** True when the repo directory was found and the enforcer(s) ran. */
  applied: boolean;
  /** `.gitignore` patterns appended this pass (empty when already protected). */
  added: string[];
  /** `.gitignore` patterns that were already in place. */
  existed: string[];
  /** `.gitattributes` lines appended this pass (empty when already protected). */
  gitattributesAdded: string[];
  /** `.gitattributes` lines that were already in place. */
  gitattributesExisted: string[];
  /** Populated when the repo was skipped (not cloned yet). */
  skippedReason?: string;
  /** Populated when `.gitignore` enforcement failed. */
  error?: string;
  /** Populated when `.gitattributes` enforcement failed (non-fatal — the
   * whole repo is only marked `failed` when either call errors). */
  gitattributesError?: string;
}

/** Aggregate outcome for the full sync. */
export interface GitignoreSyncSummary {
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  results: RepoSyncResult[];
}

/**
 * Walk every configured repo under `workDir` and apply the canonical
 * `.gitignore` and `.gitattributes` safety blocks. Missing repo
 * directories are skipped (not an error) — the worker will materialise
 * them on demand.
 *
 * @param repos `org/repo` slugs from `.config.json`.
 * @param workDir Directory containing per-repo clones (`WORK_DIR`).
 */
export async function syncGitignoreForAllRepos(
  repos: readonly string[],
  workDir: string,
): Promise<GitignoreSyncSummary> {
  const results: RepoSyncResult[] = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const repo of repos) {
    // Defence in depth (Issue #1291): the config readers validate slugs, but
    // a path is derived from `repo` here, so a `..` or empty segment would
    // steer the enforcers at the work-volume root or its parent — outside
    // every clone. Refuse loudly rather than writing there.
    if (!isValidRepoSlug(repo)) {
      failed++;
      results.push({
        repo: renderInertRepoSlug(repo),
        applied: false,
        added: [],
        existed: [],
        gitattributesAdded: [],
        gitattributesExisted: [],
        error:
          "invalid owner/repo slug — refusing to derive a path from it (Issue #1291)",
      });
      continue;
    }

    const repoName = repo.split("/").pop() ?? repo;
    const repoPath = `${workDir}/${repoName}`;

    // Skip repos that have not been cloned yet.
    try {
      const stat = await Deno.stat(repoPath);
      if (!stat.isDirectory) {
        skipped++;
        results.push({
          repo,
          applied: false,
          added: [],
          existed: [],
          gitattributesAdded: [],
          gitattributesExisted: [],
          skippedReason: `${repoPath} is not a directory`,
        });
        continue;
      }
    } catch {
      skipped++;
      results.push({
        repo,
        applied: false,
        added: [],
        existed: [],
        gitattributesAdded: [],
        gitattributesExisted: [],
        skippedReason: `${repoPath} does not exist (not cloned yet)`,
      });
      continue;
    }

    const gitignoreResult = await ensureGitignorePatterns(repoPath);
    // Run the `.gitattributes` enforcer regardless of the `.gitignore`
    // outcome so a failure in one does not silently mask the other. Both
    // failures together still mark the repo as failed once.
    const gitattributesResult = await ensureGitattributesPatterns(repoPath);

    const repoFailed = !gitignoreResult.ok || !gitattributesResult.ok;
    if (repoFailed) {
      failed++;
      results.push({
        repo,
        applied: false,
        added: gitignoreResult.ok ? gitignoreResult.value.added : [],
        existed: gitignoreResult.ok ? gitignoreResult.value.existed : [],
        gitattributesAdded: gitattributesResult.ok
          ? gitattributesResult.value.added
          : [],
        gitattributesExisted: gitattributesResult.ok
          ? gitattributesResult.value.existed
          : [],
        error: gitignoreResult.ok ? undefined : gitignoreResult.error.message,
        gitattributesError: gitattributesResult.ok
          ? undefined
          : gitattributesResult.error.message,
      });
      continue;
    }

    applied++;
    results.push({
      repo,
      applied: true,
      added: gitignoreResult.value.added,
      existed: gitignoreResult.value.existed,
      gitattributesAdded: gitattributesResult.value.added,
      gitattributesExisted: gitattributesResult.value.existed,
    });
  }

  return { total: repos.length, applied, skipped, failed, results };
}
