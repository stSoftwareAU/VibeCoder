/**
 * Merge conflict detection and resolution (Issue #321, #912).
 *
 * When GitHub Actions (CI) reformats code on push, the remote branch diverges
 * from the local branch. During rebase, this creates merge conflicts on files
 * that both the worker and CI modified. This module resolves those conflicts
 * by accepting the upstream version — since CI has the authoritative formatting.
 *
 * Migrated from worker/shared/git_operations.sh (resolve_rebase_conflicts).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { buildAddPathArgs, buildCheckoutStrategyArgs } from "./git_conflict_args.ts";
/** Maximum number of conflict resolution rounds during a rebase. */ const MAX_RESOLUTION_ROUNDS = 10;
/**
 * Check whether a rebase is currently in progress.
 *
 * @param options - Git command options (cwd, etc.)
 * @returns True if a rebase is in progress
 */ export async function isRebaseInProgress(options = {}) {
  const gitDirResult = await runGitCommand([
    "rev-parse",
    "--git-dir"
  ], options);
  if (!gitDirResult.ok || gitDirResult.value.code !== 0) {
    return false;
  }
  const gitDir = gitDirResult.value.stdout.trim();
  const cwd = options.cwd ?? Deno.cwd();
  const resolvedGitDir = gitDir.startsWith("/") ? gitDir : `${cwd}/${gitDir}`;
  for (const dir of [
    "rebase-merge",
    "rebase-apply"
  ]){
    try {
      const stat = await Deno.stat(`${resolvedGitDir}/${dir}`);
      if (stat.isDirectory) return true;
    } catch  {
    // Directory doesn't exist
    }
  }
  return false;
}
/**
 * Get the list of files with unresolved merge conflicts.
 *
 * @param options - Git command options (cwd, etc.)
 * @returns Array of conflicted file paths
 */ async function getConflictedFiles(options = {}) {
  const result = await runGitCommand([
    "diff",
    "--name-only",
    "--diff-filter=U"
  ], options);
  if (!result.ok || result.value.code !== 0) {
    return [];
  }
  return result.value.stdout.trim().split("\n").filter((f)=>f.length > 0);
}
/**
 * Resolve conflicted files by accepting the specified strategy.
 *
 * During rebase, "ours" is the upstream (remote) side and "theirs" is the
 * patch being replayed (our local commit). Accept the upstream version so
 * CI-formatted content wins.
 *
 * @param files - Array of conflicted file paths
 * @param strategy - Which side to accept ("ours" for upstream, "theirs" for local)
 * @param options - Git command options
 * @returns Number of files resolved
 */ async function resolveFiles(files, strategy, options = {}) {
  let resolved = 0;
  for (const file of files){
    const checkoutResult = await runGitCommand(buildCheckoutStrategyArgs(strategy, file), options);
    if (checkoutResult.ok && checkoutResult.value.code === 0) {
      await runGitCommand(buildAddPathArgs(file), options);
      resolved++;
    }
  }
  return resolved;
}
/**
 * Resolve merge conflicts during a rebase (Issue #321).
 *
 * This must be called while a rebase is in progress (i.e., after git rebase
 * or git pull --rebase has failed due to conflicts).
 *
 * @param options - Git command options (cwd, etc.)
 * @returns Result with resolution details on success, error on failure
 */ export async function resolveRebaseConflicts(options = {}) {
  // Verify HEAD is valid
  const headResult = await runGitCommand([
    "rev-parse",
    "--verify",
    "HEAD"
  ], options);
  if (!headResult.ok || headResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error("Not in a git repository or HEAD is invalid")
    };
  }
  // Check for rebase in progress
  if (!await isRebaseInProgress(options)) {
    return {
      ok: false,
      error: new Error("No rebase in progress")
    };
  }
  // Get initial conflicted files
  let conflictedFiles = await getConflictedFiles(options);
  if (conflictedFiles.length === 0) {
    return {
      ok: false,
      error: new Error("No conflicted files found")
    };
  }
  let totalResolved = 0;
  // First round: accept upstream ("ours" during rebase = remote)
  totalResolved += await resolveFiles(conflictedFiles, "ours", options);
  // Continue the rebase after resolving
  const continueEnv = {
    ...options.env,
    GIT_EDITOR: "true"
  };
  const continueResult = await runGitCommand([
    "rebase",
    "--continue"
  ], {
    ...options,
    env: continueEnv
  });
  if (continueResult.ok && continueResult.value.code === 0) {
    return {
      ok: true,
      value: {
        filesResolved: totalResolved,
        rounds: 1
      }
    };
  }
  // Multiple conflict rounds — rebases can have multiple conflicting commits
  let round = 0;
  while(round < MAX_RESOLUTION_ROUNDS){
    conflictedFiles = await getConflictedFiles(options);
    if (conflictedFiles.length === 0) {
      break;
    }
    totalResolved += await resolveFiles(conflictedFiles, "theirs", options);
    const retryResult = await runGitCommand([
      "rebase",
      "--continue"
    ], {
      ...options,
      env: continueEnv
    });
    if (retryResult.ok && retryResult.value.code === 0) {
      return {
        ok: true,
        value: {
          filesResolved: totalResolved,
          rounds: round + 2
        }
      };
    }
    round++;
  }
  return {
    ok: false,
    error: new Error(`Failed to resolve all conflicts after ${round + 1} rounds`)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfY29uZmxpY3RfcmVzb2x1dGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1lcmdlIGNvbmZsaWN0IGRldGVjdGlvbiBhbmQgcmVzb2x1dGlvbiAoSXNzdWUgIzMyMSwgIzkxMikuXG4gKlxuICogV2hlbiBHaXRIdWIgQWN0aW9ucyAoQ0kpIHJlZm9ybWF0cyBjb2RlIG9uIHB1c2gsIHRoZSByZW1vdGUgYnJhbmNoIGRpdmVyZ2VzXG4gKiBmcm9tIHRoZSBsb2NhbCBicmFuY2guIER1cmluZyByZWJhc2UsIHRoaXMgY3JlYXRlcyBtZXJnZSBjb25mbGljdHMgb24gZmlsZXNcbiAqIHRoYXQgYm90aCB0aGUgd29ya2VyIGFuZCBDSSBtb2RpZmllZC4gVGhpcyBtb2R1bGUgcmVzb2x2ZXMgdGhvc2UgY29uZmxpY3RzXG4gKiBieSBhY2NlcHRpbmcgdGhlIHVwc3RyZWFtIHZlcnNpb24g4oCUIHNpbmNlIENJIGhhcyB0aGUgYXV0aG9yaXRhdGl2ZSBmb3JtYXR0aW5nLlxuICpcbiAqIE1pZ3JhdGVkIGZyb20gd29ya2VyL3NoYXJlZC9naXRfb3BlcmF0aW9ucy5zaCAocmVzb2x2ZV9yZWJhc2VfY29uZmxpY3RzKS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQWRkUGF0aEFyZ3MsXG4gIGJ1aWxkQ2hlY2tvdXRTdHJhdGVneUFyZ3MsXG59IGZyb20gXCIuL2dpdF9jb25mbGljdF9hcmdzLnRzXCI7XG5cbi8qKiBNYXhpbXVtIG51bWJlciBvZiBjb25mbGljdCByZXNvbHV0aW9uIHJvdW5kcyBkdXJpbmcgYSByZWJhc2UuICovXG5jb25zdCBNQVhfUkVTT0xVVElPTl9ST1VORFMgPSAxMDtcblxuLyoqIERldGFpbHMgYWJvdXQgdGhlIGNvbmZsaWN0IHJlc29sdXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0UmVzb2x1dGlvbkRldGFpbHMge1xuICAvKiogVG90YWwgbnVtYmVyIG9mIGZpbGVzIHJlc29sdmVkLiAqL1xuICBmaWxlc1Jlc29sdmVkOiBudW1iZXI7XG4gIC8qKiBOdW1iZXIgb2YgcmVzb2x1dGlvbiByb3VuZHMgbmVlZGVkLiAqL1xuICByb3VuZHM6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgcmViYXNlIGlzIGN1cnJlbnRseSBpbiBwcm9ncmVzcy5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZXRjLilcbiAqIEByZXR1cm5zIFRydWUgaWYgYSByZWJhc2UgaXMgaW4gcHJvZ3Jlc3NcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzUmViYXNlSW5Qcm9ncmVzcyhcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBnaXREaXJSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWRpclwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuXG4gIGlmICghZ2l0RGlyUmVzdWx0Lm9rIHx8IGdpdERpclJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgZ2l0RGlyID0gZ2l0RGlyUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIGNvbnN0IGN3ZCA9IG9wdGlvbnMuY3dkID8/IERlbm8uY3dkKCk7XG4gIGNvbnN0IHJlc29sdmVkR2l0RGlyID0gZ2l0RGlyLnN0YXJ0c1dpdGgoXCIvXCIpID8gZ2l0RGlyIDogYCR7Y3dkfS8ke2dpdERpcn1gO1xuXG4gIGZvciAoY29uc3QgZGlyIG9mIFtcInJlYmFzZS1tZXJnZVwiLCBcInJlYmFzZS1hcHBseVwiXSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGAke3Jlc29sdmVkR2l0RGlyfS8ke2Rpcn1gKTtcbiAgICAgIGlmIChzdGF0LmlzRGlyZWN0b3J5KSByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERpcmVjdG9yeSBkb2Vzbid0IGV4aXN0XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEdldCB0aGUgbGlzdCBvZiBmaWxlcyB3aXRoIHVucmVzb2x2ZWQgbWVyZ2UgY29uZmxpY3RzLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkLCBldGMuKVxuICogQHJldHVybnMgQXJyYXkgb2YgY29uZmxpY3RlZCBmaWxlIHBhdGhzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldENvbmZsaWN0ZWRGaWxlcyhcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJkaWZmXCIsIFwiLS1uYW1lLW9ubHlcIiwgXCItLWRpZmYtZmlsdGVyPVVcIl0sXG4gICAgb3B0aW9ucyxcbiAgKTtcblxuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQudmFsdWUuc3Rkb3V0XG4gICAgLnRyaW0oKVxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maWx0ZXIoKGYpID0+IGYubGVuZ3RoID4gMCk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBjb25mbGljdGVkIGZpbGVzIGJ5IGFjY2VwdGluZyB0aGUgc3BlY2lmaWVkIHN0cmF0ZWd5LlxuICpcbiAqIER1cmluZyByZWJhc2UsIFwib3Vyc1wiIGlzIHRoZSB1cHN0cmVhbSAocmVtb3RlKSBzaWRlIGFuZCBcInRoZWlyc1wiIGlzIHRoZVxuICogcGF0Y2ggYmVpbmcgcmVwbGF5ZWQgKG91ciBsb2NhbCBjb21taXQpLiBBY2NlcHQgdGhlIHVwc3RyZWFtIHZlcnNpb24gc29cbiAqIENJLWZvcm1hdHRlZCBjb250ZW50IHdpbnMuXG4gKlxuICogQHBhcmFtIGZpbGVzIC0gQXJyYXkgb2YgY29uZmxpY3RlZCBmaWxlIHBhdGhzXG4gKiBAcGFyYW0gc3RyYXRlZ3kgLSBXaGljaCBzaWRlIHRvIGFjY2VwdCAoXCJvdXJzXCIgZm9yIHVwc3RyZWFtLCBcInRoZWlyc1wiIGZvciBsb2NhbClcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9uc1xuICogQHJldHVybnMgTnVtYmVyIG9mIGZpbGVzIHJlc29sdmVkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGaWxlcyhcbiAgZmlsZXM6IHN0cmluZ1tdLFxuICBzdHJhdGVneTogXCJvdXJzXCIgfCBcInRoZWlyc1wiLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHJlc29sdmVkID0gMDtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICBjb25zdCBjaGVja291dFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBidWlsZENoZWNrb3V0U3RyYXRlZ3lBcmdzKHN0cmF0ZWd5LCBmaWxlKSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoY2hlY2tvdXRSZXN1bHQub2sgJiYgY2hlY2tvdXRSZXN1bHQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgICAgYXdhaXQgcnVuR2l0Q29tbWFuZChidWlsZEFkZFBhdGhBcmdzKGZpbGUpLCBvcHRpb25zKTtcbiAgICAgIHJlc29sdmVkKys7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc29sdmVkO1xufVxuXG4vKipcbiAqIFJlc29sdmUgbWVyZ2UgY29uZmxpY3RzIGR1cmluZyBhIHJlYmFzZSAoSXNzdWUgIzMyMSkuXG4gKlxuICogVGhpcyBtdXN0IGJlIGNhbGxlZCB3aGlsZSBhIHJlYmFzZSBpcyBpbiBwcm9ncmVzcyAoaS5lLiwgYWZ0ZXIgZ2l0IHJlYmFzZVxuICogb3IgZ2l0IHB1bGwgLS1yZWJhc2UgaGFzIGZhaWxlZCBkdWUgdG8gY29uZmxpY3RzKS5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZXRjLilcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHJlc29sdXRpb24gZGV0YWlscyBvbiBzdWNjZXNzLCBlcnJvciBvbiBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlUmViYXNlQ29uZmxpY3RzKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8Q29uZmxpY3RSZXNvbHV0aW9uRGV0YWlscz4+IHtcbiAgLy8gVmVyaWZ5IEhFQUQgaXMgdmFsaWRcbiAgY29uc3QgaGVhZFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJIRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghaGVhZFJlc3VsdC5vayB8fCBoZWFkUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIk5vdCBpbiBhIGdpdCByZXBvc2l0b3J5IG9yIEhFQUQgaXMgaW52YWxpZFwiKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIHJlYmFzZSBpbiBwcm9ncmVzc1xuICBpZiAoIShhd2FpdCBpc1JlYmFzZUluUHJvZ3Jlc3Mob3B0aW9ucykpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKFwiTm8gcmViYXNlIGluIHByb2dyZXNzXCIpIH07XG4gIH1cblxuICAvLyBHZXQgaW5pdGlhbCBjb25mbGljdGVkIGZpbGVzXG4gIGxldCBjb25mbGljdGVkRmlsZXMgPSBhd2FpdCBnZXRDb25mbGljdGVkRmlsZXMob3B0aW9ucyk7XG4gIGlmIChjb25mbGljdGVkRmlsZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKFwiTm8gY29uZmxpY3RlZCBmaWxlcyBmb3VuZFwiKSB9O1xuICB9XG5cbiAgbGV0IHRvdGFsUmVzb2x2ZWQgPSAwO1xuXG4gIC8vIEZpcnN0IHJvdW5kOiBhY2NlcHQgdXBzdHJlYW0gKFwib3Vyc1wiIGR1cmluZyByZWJhc2UgPSByZW1vdGUpXG4gIHRvdGFsUmVzb2x2ZWQgKz0gYXdhaXQgcmVzb2x2ZUZpbGVzKGNvbmZsaWN0ZWRGaWxlcywgXCJvdXJzXCIsIG9wdGlvbnMpO1xuXG4gIC8vIENvbnRpbnVlIHRoZSByZWJhc2UgYWZ0ZXIgcmVzb2x2aW5nXG4gIGNvbnN0IGNvbnRpbnVlRW52ID0geyAuLi5vcHRpb25zLmVudiwgR0lUX0VESVRPUjogXCJ0cnVlXCIgfTtcbiAgY29uc3QgY29udGludWVSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJlYmFzZVwiLCBcIi0tY29udGludWVcIl0sXG4gICAgeyAuLi5vcHRpb25zLCBlbnY6IGNvbnRpbnVlRW52IH0sXG4gICk7XG5cbiAgaWYgKGNvbnRpbnVlUmVzdWx0Lm9rICYmIGNvbnRpbnVlUmVzdWx0LnZhbHVlLmNvZGUgPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogeyBmaWxlc1Jlc29sdmVkOiB0b3RhbFJlc29sdmVkLCByb3VuZHM6IDEgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTXVsdGlwbGUgY29uZmxpY3Qgcm91bmRzIOKAlCByZWJhc2VzIGNhbiBoYXZlIG11bHRpcGxlIGNvbmZsaWN0aW5nIGNvbW1pdHNcbiAgbGV0IHJvdW5kID0gMDtcbiAgd2hpbGUgKHJvdW5kIDwgTUFYX1JFU09MVVRJT05fUk9VTkRTKSB7XG4gICAgY29uZmxpY3RlZEZpbGVzID0gYXdhaXQgZ2V0Q29uZmxpY3RlZEZpbGVzKG9wdGlvbnMpO1xuICAgIGlmIChjb25mbGljdGVkRmlsZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICB0b3RhbFJlc29sdmVkICs9IGF3YWl0IHJlc29sdmVGaWxlcyhjb25mbGljdGVkRmlsZXMsIFwidGhlaXJzXCIsIG9wdGlvbnMpO1xuXG4gICAgY29uc3QgcmV0cnlSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wicmViYXNlXCIsIFwiLS1jb250aW51ZVwiXSxcbiAgICAgIHsgLi4ub3B0aW9ucywgZW52OiBjb250aW51ZUVudiB9LFxuICAgICk7XG5cbiAgICBpZiAocmV0cnlSZXN1bHQub2sgJiYgcmV0cnlSZXN1bHQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7IGZpbGVzUmVzb2x2ZWQ6IHRvdGFsUmVzb2x2ZWQsIHJvdW5kczogcm91bmQgKyAyIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJvdW5kKys7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgYEZhaWxlZCB0byByZXNvbHZlIGFsbCBjb25mbGljdHMgYWZ0ZXIgJHtyb3VuZCArIDF9IHJvdW5kc2As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
// denoCacheMetadata=11251297822297312323,10618872774781521454