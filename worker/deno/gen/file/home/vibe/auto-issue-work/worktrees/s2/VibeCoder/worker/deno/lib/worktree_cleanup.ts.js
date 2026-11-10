/**
 * Orphaned git worktree cleanup (Issue #1492).
 *
 * On worker startup, scans every repository clone under `workDir` and:
 *   1. Runs `git worktree prune` — removes administrative files for
 *      worktrees whose on-disk directory is gone.
 *   2. Lists remaining worktrees via `git worktree list --porcelain` and
 *      removes any worktree directory whose linked branch no longer
 *      exists and whose mtime is older than `maxAgeHours`.
 *
 * Every removal emits a `SELF-HEALING:` log line so operators can audit
 * the cleanup.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";
/** Default age threshold — only remove orphaned worktrees older than 24h. */ export const DEFAULT_MAX_AGE_HOURS = 24;
/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * The first worktree listed is always the main worktree; subsequent
 * entries are linked worktrees. Each entry is separated by a blank line.
 */ export function parseWorktreeList(output) {
  const blocks = output.split(/\n\n+/).map((b)=>b.trim()).filter((b)=>b.length > 0);
  const entries = [];
  for(let i = 0; i < blocks.length; i++){
    const block = blocks[i];
    let path = "";
    let branch = null;
    for (const line of block.split("\n")){
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim();
      } else if (line === "detached") {
        branch = null;
      }
    }
    if (path) {
      entries.push({
        path,
        branch,
        isMain: i === 0
      });
    }
  }
  return entries;
}
/**
 * Verify a branch ref exists in the repository.
 *
 * Uses `git rev-parse --verify` which returns exit code 0 when the ref
 * resolves and non-zero otherwise.
 */ export async function branchExists(repoDir, branchRef) {
  const result = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    branchRef
  ], {
    cwd: repoDir
  });
  return result.ok && result.value.code === 0;
}
/**
 * Cleanup orphaned git worktrees across all repositories in `workDir`.
 *
 * For each subdirectory of `workDir` that is itself a git repository
 * (contains a `.git` directory or file), runs `git worktree prune` and
 * then removes any linked worktree whose branch no longer exists and
 * whose mtime is older than `maxAgeHours`.
 *
 * Errors are collected into the result — this function never throws,
 * so it is safe to call during startup.
 */ export async function cleanupOrphanedWorktrees(options) {
  const workDir = options.workDir;
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const maxAgeMs = Math.max(0, maxAgeHours) * 3600 * 1000;
  const nowFn = options.nowFn ?? (()=>Date.now());
  const result = {
    reposScanned: 0,
    pruned: 0,
    removedDirs: [],
    preserved: [],
    errors: []
  };
  if (!workDir) {
    result.errors.push("worktree-cleanup: workDir is required");
    return result;
  }
  let entries;
  try {
    entries = [];
    for await (const entry of Deno.readDir(workDir)){
      entries.push(entry);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Cannot read ${workDir}: ${msg}`);
    return result;
  }
  for (const entry of entries){
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory) continue;
    // Reserved non-repo entries (ext4 lost+found, the logs dir) are other
    // subsystems' — or the filesystem's — property (Issue #4212).
    if (isReservedWorkRootEntry(entry.name)) continue;
    const repoDir = `${workDir}/${entry.name}`;
    // Only treat a directory as a main repo when `.git` is itself a
    // directory. A `.git` *file* indicates a linked worktree that will
    // be handled through its main repo — scanning it separately would
    // double-count and emit duplicate prune output.
    const isMainRepo = await isDirectory(`${repoDir}/.git`);
    if (!isMainRepo) continue;
    result.reposScanned++;
    await processRepository(repoDir, maxAgeMs, nowFn(), result);
  }
  return result;
}
/**
 * Process a single repository: prune admin files, then remove linked
 * worktrees whose branch is gone and whose mtime is older than the
 * threshold.
 */ async function processRepository(repoDir, maxAgeMs, nowMs, result) {
  // 1. Prune admin files for missing worktree directories.
  const pruneResult = await runGitCommand([
    "worktree",
    "prune",
    "-v"
  ], {
    cwd: repoDir
  });
  if (pruneResult.ok && pruneResult.value.code === 0) {
    // `git worktree prune -v` writes its "Removing worktrees/..." lines
    // to stderr, not stdout, so check both.
    const pruneOutput = `${pruneResult.value.stdout}\n${pruneResult.value.stderr}`;
    const prunedLines = pruneOutput.split("\n").filter((l)=>l.trim().startsWith("Removing "));
    if (prunedLines.length > 0) {
      result.pruned += prunedLines.length;
      for (const line of prunedLines){
        console.log(`SELF-HEALING: worktree prune in ${repoDir}: ${line}`);
      }
      recordFaultEvent("disk_space_cleanup", `worktree_cleanup pruned ${prunedLines.length} admin entries in ${repoDir}`);
    }
  } else if (!pruneResult.ok) {
    result.errors.push(`git worktree prune failed in ${repoDir}: ${pruneResult.error.message}`);
    return;
  }
  // 2. List remaining worktrees.
  const listResult = await runGitCommand([
    "worktree",
    "list",
    "--porcelain"
  ], {
    cwd: repoDir
  });
  if (!listResult.ok || listResult.value.code !== 0) {
    const msg = !listResult.ok ? listResult.error.message : listResult.value.stderr.trim();
    result.errors.push(`git worktree list failed in ${repoDir}: ${msg}`);
    return;
  }
  const worktrees = parseWorktreeList(listResult.value.stdout);
  for (const wt of worktrees){
    if (wt.isMain) continue;
    // A detached worktree has no branch — treat as orphan candidate.
    let branchIsGone = true;
    if (wt.branch) {
      branchIsGone = !await branchExists(repoDir, wt.branch);
    }
    if (!branchIsGone) {
      result.preserved.push(`${wt.path}: branch ${wt.branch} still exists`);
      continue;
    }
    const mtimeMs = await getMtimeMs(wt.path);
    if (mtimeMs === null) {
      // Directory is gone — let the next prune handle it.
      result.preserved.push(`${wt.path}: not accessible (will prune next run)`);
      continue;
    }
    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) {
      const hours = (ageMs / 3600_000).toFixed(1);
      result.preserved.push(`${wt.path}: only ${hours}h old, below threshold`);
      continue;
    }
    // Remove the orphaned worktree.
    const removeResult = await runGitCommand([
      "worktree",
      "remove",
      "--force",
      wt.path
    ], {
      cwd: repoDir
    });
    if (!removeResult.ok || removeResult.value.code !== 0) {
      const msg = !removeResult.ok ? removeResult.error.message : removeResult.value.stderr.trim();
      result.errors.push(`Failed to remove worktree ${wt.path}: ${msg}`);
      console.warn(`SELF-HEALING: failed to remove orphaned worktree ${wt.path}: ${msg}`);
      continue;
    }
    result.removedDirs.push(wt.path);
    const branchDesc = wt.branch ?? "detached";
    const ageH = (ageMs / 3600_000).toFixed(1);
    console.log(`SELF-HEALING: removed orphaned worktree ${wt.path} ` + `(branch ${branchDesc} missing, age ${ageH}h)`);
    recordFaultEvent("disk_space_cleanup", `worktree_cleanup removed orphan ${wt.path}`);
  }
}
/** Get directory mtime as epoch ms, or null if stat fails. */ async function getMtimeMs(path) {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime ? stat.mtime.getTime() : null;
  } catch  {
    return null;
  }
}
/** True when the path exists and resolves to a directory. */ async function isDirectory(path) {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch  {
    return false;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93b3JrdHJlZV9jbGVhbnVwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT3JwaGFuZWQgZ2l0IHdvcmt0cmVlIGNsZWFudXAgKElzc3VlICMxNDkyKS5cbiAqXG4gKiBPbiB3b3JrZXIgc3RhcnR1cCwgc2NhbnMgZXZlcnkgcmVwb3NpdG9yeSBjbG9uZSB1bmRlciBgd29ya0RpcmAgYW5kOlxuICogICAxLiBSdW5zIGBnaXQgd29ya3RyZWUgcHJ1bmVgIOKAlCByZW1vdmVzIGFkbWluaXN0cmF0aXZlIGZpbGVzIGZvclxuICogICAgICB3b3JrdHJlZXMgd2hvc2Ugb24tZGlzayBkaXJlY3RvcnkgaXMgZ29uZS5cbiAqICAgMi4gTGlzdHMgcmVtYWluaW5nIHdvcmt0cmVlcyB2aWEgYGdpdCB3b3JrdHJlZSBsaXN0IC0tcG9yY2VsYWluYCBhbmRcbiAqICAgICAgcmVtb3ZlcyBhbnkgd29ya3RyZWUgZGlyZWN0b3J5IHdob3NlIGxpbmtlZCBicmFuY2ggbm8gbG9uZ2VyXG4gKiAgICAgIGV4aXN0cyBhbmQgd2hvc2UgbXRpbWUgaXMgb2xkZXIgdGhhbiBgbWF4QWdlSG91cnNgLlxuICpcbiAqIEV2ZXJ5IHJlbW92YWwgZW1pdHMgYSBgU0VMRi1IRUFMSU5HOmAgbG9nIGxpbmUgc28gb3BlcmF0b3JzIGNhbiBhdWRpdFxuICogdGhlIGNsZWFudXAuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyByZWNvcmRGYXVsdEV2ZW50IH0gZnJvbSBcIi4vZmF1bHRfdG9sZXJhbmNlX2NvdW50ZXJzLnRzXCI7XG5pbXBvcnQgeyBpc1Jlc2VydmVkV29ya1Jvb3RFbnRyeSB9IGZyb20gXCIuL3N0YWxlX3dvcmtkaXIudHNcIjtcblxuLyoqIERlZmF1bHQgYWdlIHRocmVzaG9sZCDigJQgb25seSByZW1vdmUgb3JwaGFuZWQgd29ya3RyZWVzIG9sZGVyIHRoYW4gMjRoLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTUFYX0FHRV9IT1VSUyA9IDI0O1xuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGNsZWFudXBPcnBoYW5lZFdvcmt0cmVlc30uICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlQ2xlYW51cE9wdGlvbnMge1xuICAvKiogRGlyZWN0b3J5IGNvbnRhaW5pbmcgcmVwb3NpdG9yeSBjbG9uZXMgKHVzdWFsbHkgV09SS19ESVIpLiAqL1xuICB3b3JrRGlyOiBzdHJpbmc7XG4gIC8qKiBPbmx5IHJlbW92ZSBvcnBoYW5zIG9sZGVyIHRoYW4gdGhpcyBtYW55IGhvdXJzLiBEZWZhdWx0OiAyNC4gKi9cbiAgbWF4QWdlSG91cnM/OiBudW1iZXI7XG4gIC8qKiBPdmVycmlkZSB0aGUgXCJub3dcIiBjbG9jayBmb3IgdGVzdGluZy4gUmV0dXJucyBlcG9jaCBtcy4gKi9cbiAgbm93Rm4/OiAoKSA9PiBudW1iZXI7XG59XG5cbi8qKiBBIHNpbmdsZSB3b3JrdHJlZSBhcyByZXBvcnRlZCBieSBgZ2l0IHdvcmt0cmVlIGxpc3QgLS1wb3JjZWxhaW5gLiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3JrdHJlZUVudHJ5IHtcbiAgLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIHdvcmt0cmVlIGRpcmVjdG9yeS4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogRnVsbCByZWYgbmFtZSAoZS5nLiwgYHJlZnMvaGVhZHMvZmVhdHVyZS14YCkgb3IgbnVsbCBmb3IgZGV0YWNoZWQvYmFyZS4gKi9cbiAgYnJhbmNoOiBzdHJpbmcgfCBudWxsO1xuICAvKiogV2hldGhlciB0aGlzIGlzIHRoZSBtYWluIHdvcmt0cmVlIChub3QgYSBsaW5rZWQgd29ya3RyZWUpLiAqL1xuICBpc01haW46IGJvb2xlYW47XG59XG5cbi8qKiBPdXRjb21lIG9mIHRoZSBjbGVhbnVwIHJ1bi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3RyZWVDbGVhbnVwUmVzdWx0IHtcbiAgLyoqIE51bWJlciBvZiByZXBvc2l0b3JpZXMgaW5zcGVjdGVkLiAqL1xuICByZXBvc1NjYW5uZWQ6IG51bWJlcjtcbiAgLyoqIE51bWJlciBvZiBhZG1pbiBmaWxlcyBwcnVuZWQgdmlhIGBnaXQgd29ya3RyZWUgcHJ1bmVgLiAqL1xuICBwcnVuZWQ6IG51bWJlcjtcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIHdvcmt0cmVlIGRpcmVjdG9yaWVzIHJlbW92ZWQuICovXG4gIHJlbW92ZWREaXJzOiBzdHJpbmdbXTtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIHJlYXNvbnMgYSBjYW5kaWRhdGUgd2FzIGtlcHQgKGZvciBkZWJ1Z2dpbmcvdGVzdHMpLiAqL1xuICBwcmVzZXJ2ZWQ6IHN0cmluZ1tdO1xuICAvKiogRXJyb3JzIGNvbGxlY3RlZCBkdXJpbmcgdGhlIHNjYW4g4oCUIG5ldmVyIHRocm93bi4gKi9cbiAgZXJyb3JzOiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBQYXJzZSBgZ2l0IHdvcmt0cmVlIGxpc3QgLS1wb3JjZWxhaW5gIG91dHB1dCBpbnRvIHN0cnVjdHVyZWQgZW50cmllcy5cbiAqXG4gKiBUaGUgZmlyc3Qgd29ya3RyZWUgbGlzdGVkIGlzIGFsd2F5cyB0aGUgbWFpbiB3b3JrdHJlZTsgc3Vic2VxdWVudFxuICogZW50cmllcyBhcmUgbGlua2VkIHdvcmt0cmVlcy4gRWFjaCBlbnRyeSBpcyBzZXBhcmF0ZWQgYnkgYSBibGFuayBsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXb3JrdHJlZUxpc3Qob3V0cHV0OiBzdHJpbmcpOiBXb3JrdHJlZUVudHJ5W10ge1xuICBjb25zdCBibG9ja3MgPSBvdXRwdXQuc3BsaXQoL1xcblxcbisvKS5tYXAoKGIpID0+IGIudHJpbSgpKS5maWx0ZXIoKGIpID0+XG4gICAgYi5sZW5ndGggPiAwXG4gICk7XG4gIGNvbnN0IGVudHJpZXM6IFdvcmt0cmVlRW50cnlbXSA9IFtdO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmxvY2tzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYmxvY2sgPSBibG9ja3NbaV0hO1xuICAgIGxldCBwYXRoID0gXCJcIjtcbiAgICBsZXQgYnJhbmNoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIndvcmt0cmVlIFwiKSkge1xuICAgICAgICBwYXRoID0gbGluZS5zbGljZShcIndvcmt0cmVlIFwiLmxlbmd0aCkudHJpbSgpO1xuICAgICAgfSBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJicmFuY2ggXCIpKSB7XG4gICAgICAgIGJyYW5jaCA9IGxpbmUuc2xpY2UoXCJicmFuY2ggXCIubGVuZ3RoKS50cmltKCk7XG4gICAgICB9IGVsc2UgaWYgKGxpbmUgPT09IFwiZGV0YWNoZWRcIikge1xuICAgICAgICBicmFuY2ggPSBudWxsO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwYXRoKSB7XG4gICAgICBlbnRyaWVzLnB1c2goeyBwYXRoLCBicmFuY2gsIGlzTWFpbjogaSA9PT0gMCB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZW50cmllcztcbn1cblxuLyoqXG4gKiBWZXJpZnkgYSBicmFuY2ggcmVmIGV4aXN0cyBpbiB0aGUgcmVwb3NpdG9yeS5cbiAqXG4gKiBVc2VzIGBnaXQgcmV2LXBhcnNlIC0tdmVyaWZ5YCB3aGljaCByZXR1cm5zIGV4aXQgY29kZSAwIHdoZW4gdGhlIHJlZlxuICogcmVzb2x2ZXMgYW5kIG5vbi16ZXJvIG90aGVyd2lzZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJyYW5jaEV4aXN0cyhcbiAgcmVwb0Rpcjogc3RyaW5nLFxuICBicmFuY2hSZWY6IHN0cmluZyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwiLS1xdWlldFwiLCBicmFuY2hSZWZdLFxuICAgIHsgY3dkOiByZXBvRGlyIH0sXG4gICk7XG4gIHJldHVybiByZXN1bHQub2sgJiYgcmVzdWx0LnZhbHVlLmNvZGUgPT09IDA7XG59XG5cbi8qKlxuICogQ2xlYW51cCBvcnBoYW5lZCBnaXQgd29ya3RyZWVzIGFjcm9zcyBhbGwgcmVwb3NpdG9yaWVzIGluIGB3b3JrRGlyYC5cbiAqXG4gKiBGb3IgZWFjaCBzdWJkaXJlY3Rvcnkgb2YgYHdvcmtEaXJgIHRoYXQgaXMgaXRzZWxmIGEgZ2l0IHJlcG9zaXRvcnlcbiAqIChjb250YWlucyBhIGAuZ2l0YCBkaXJlY3Rvcnkgb3IgZmlsZSksIHJ1bnMgYGdpdCB3b3JrdHJlZSBwcnVuZWAgYW5kXG4gKiB0aGVuIHJlbW92ZXMgYW55IGxpbmtlZCB3b3JrdHJlZSB3aG9zZSBicmFuY2ggbm8gbG9uZ2VyIGV4aXN0cyBhbmRcbiAqIHdob3NlIG10aW1lIGlzIG9sZGVyIHRoYW4gYG1heEFnZUhvdXJzYC5cbiAqXG4gKiBFcnJvcnMgYXJlIGNvbGxlY3RlZCBpbnRvIHRoZSByZXN1bHQg4oCUIHRoaXMgZnVuY3Rpb24gbmV2ZXIgdGhyb3dzLFxuICogc28gaXQgaXMgc2FmZSB0byBjYWxsIGR1cmluZyBzdGFydHVwLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYW51cE9ycGhhbmVkV29ya3RyZWVzKFxuICBvcHRpb25zOiBXb3JrdHJlZUNsZWFudXBPcHRpb25zLFxuKTogUHJvbWlzZTxXb3JrdHJlZUNsZWFudXBSZXN1bHQ+IHtcbiAgY29uc3Qgd29ya0RpciA9IG9wdGlvbnMud29ya0RpcjtcbiAgY29uc3QgbWF4QWdlSG91cnMgPSBvcHRpb25zLm1heEFnZUhvdXJzID8/IERFRkFVTFRfTUFYX0FHRV9IT1VSUztcbiAgY29uc3QgbWF4QWdlTXMgPSBNYXRoLm1heCgwLCBtYXhBZ2VIb3VycykgKiAzNjAwICogMTAwMDtcbiAgY29uc3Qgbm93Rm4gPSBvcHRpb25zLm5vd0ZuID8/ICgoKSA9PiBEYXRlLm5vdygpKTtcblxuICBjb25zdCByZXN1bHQ6IFdvcmt0cmVlQ2xlYW51cFJlc3VsdCA9IHtcbiAgICByZXBvc1NjYW5uZWQ6IDAsXG4gICAgcHJ1bmVkOiAwLFxuICAgIHJlbW92ZWREaXJzOiBbXSxcbiAgICBwcmVzZXJ2ZWQ6IFtdLFxuICAgIGVycm9yczogW10sXG4gIH07XG5cbiAgaWYgKCF3b3JrRGlyKSB7XG4gICAgcmVzdWx0LmVycm9ycy5wdXNoKFwid29ya3RyZWUtY2xlYW51cDogd29ya0RpciBpcyByZXF1aXJlZFwiKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgbGV0IGVudHJpZXM6IERlbm8uRGlyRW50cnlbXTtcbiAgdHJ5IHtcbiAgICBlbnRyaWVzID0gW107XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIod29ya0RpcikpIHtcbiAgICAgIGVudHJpZXMucHVzaChlbnRyeSk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgcmVzdWx0LmVycm9ycy5wdXNoKGBDYW5ub3QgcmVhZCAke3dvcmtEaXJ9OiAke21zZ31gKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkpIGNvbnRpbnVlO1xuICAgIC8vIFJlc2VydmVkIG5vbi1yZXBvIGVudHJpZXMgKGV4dDQgbG9zdCtmb3VuZCwgdGhlIGxvZ3MgZGlyKSBhcmUgb3RoZXJcbiAgICAvLyBzdWJzeXN0ZW1zJyDigJQgb3IgdGhlIGZpbGVzeXN0ZW0ncyDigJQgcHJvcGVydHkgKElzc3VlICM0MjEyKS5cbiAgICBpZiAoaXNSZXNlcnZlZFdvcmtSb290RW50cnkoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgcmVwb0RpciA9IGAke3dvcmtEaXJ9LyR7ZW50cnkubmFtZX1gO1xuICAgIC8vIE9ubHkgdHJlYXQgYSBkaXJlY3RvcnkgYXMgYSBtYWluIHJlcG8gd2hlbiBgLmdpdGAgaXMgaXRzZWxmIGFcbiAgICAvLyBkaXJlY3RvcnkuIEEgYC5naXRgICpmaWxlKiBpbmRpY2F0ZXMgYSBsaW5rZWQgd29ya3RyZWUgdGhhdCB3aWxsXG4gICAgLy8gYmUgaGFuZGxlZCB0aHJvdWdoIGl0cyBtYWluIHJlcG8g4oCUIHNjYW5uaW5nIGl0IHNlcGFyYXRlbHkgd291bGRcbiAgICAvLyBkb3VibGUtY291bnQgYW5kIGVtaXQgZHVwbGljYXRlIHBydW5lIG91dHB1dC5cbiAgICBjb25zdCBpc01haW5SZXBvID0gYXdhaXQgaXNEaXJlY3RvcnkoYCR7cmVwb0Rpcn0vLmdpdGApO1xuICAgIGlmICghaXNNYWluUmVwbykgY29udGludWU7XG5cbiAgICByZXN1bHQucmVwb3NTY2FubmVkKys7XG4gICAgYXdhaXQgcHJvY2Vzc1JlcG9zaXRvcnkocmVwb0RpciwgbWF4QWdlTXMsIG5vd0ZuKCksIHJlc3VsdCk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFByb2Nlc3MgYSBzaW5nbGUgcmVwb3NpdG9yeTogcHJ1bmUgYWRtaW4gZmlsZXMsIHRoZW4gcmVtb3ZlIGxpbmtlZFxuICogd29ya3RyZWVzIHdob3NlIGJyYW5jaCBpcyBnb25lIGFuZCB3aG9zZSBtdGltZSBpcyBvbGRlciB0aGFuIHRoZVxuICogdGhyZXNob2xkLlxuICovXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzUmVwb3NpdG9yeShcbiAgcmVwb0Rpcjogc3RyaW5nLFxuICBtYXhBZ2VNczogbnVtYmVyLFxuICBub3dNczogbnVtYmVyLFxuICByZXN1bHQ6IFdvcmt0cmVlQ2xlYW51cFJlc3VsdCxcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyAxLiBQcnVuZSBhZG1pbiBmaWxlcyBmb3IgbWlzc2luZyB3b3JrdHJlZSBkaXJlY3Rvcmllcy5cbiAgY29uc3QgcHJ1bmVSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcIndvcmt0cmVlXCIsIFwicHJ1bmVcIiwgXCItdlwiXSxcbiAgICB7IGN3ZDogcmVwb0RpciB9LFxuICApO1xuICBpZiAocHJ1bmVSZXN1bHQub2sgJiYgcHJ1bmVSZXN1bHQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIC8vIGBnaXQgd29ya3RyZWUgcHJ1bmUgLXZgIHdyaXRlcyBpdHMgXCJSZW1vdmluZyB3b3JrdHJlZXMvLi4uXCIgbGluZXNcbiAgICAvLyB0byBzdGRlcnIsIG5vdCBzdGRvdXQsIHNvIGNoZWNrIGJvdGguXG4gICAgY29uc3QgcHJ1bmVPdXRwdXQgPVxuICAgICAgYCR7cHJ1bmVSZXN1bHQudmFsdWUuc3Rkb3V0fVxcbiR7cHJ1bmVSZXN1bHQudmFsdWUuc3RkZXJyfWA7XG4gICAgY29uc3QgcHJ1bmVkTGluZXMgPSBwcnVuZU91dHB1dFxuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAuZmlsdGVyKChsKSA9PiBsLnRyaW0oKS5zdGFydHNXaXRoKFwiUmVtb3ZpbmcgXCIpKTtcbiAgICBpZiAocHJ1bmVkTGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgcmVzdWx0LnBydW5lZCArPSBwcnVuZWRMaW5lcy5sZW5ndGg7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcHJ1bmVkTGluZXMpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFNFTEYtSEVBTElORzogd29ya3RyZWUgcHJ1bmUgaW4gJHtyZXBvRGlyfTogJHtsaW5lfWApO1xuICAgICAgfVxuICAgICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgICAgXCJkaXNrX3NwYWNlX2NsZWFudXBcIixcbiAgICAgICAgYHdvcmt0cmVlX2NsZWFudXAgcHJ1bmVkICR7cHJ1bmVkTGluZXMubGVuZ3RofSBhZG1pbiBlbnRyaWVzIGluICR7cmVwb0Rpcn1gLFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoIXBydW5lUmVzdWx0Lm9rKSB7XG4gICAgcmVzdWx0LmVycm9ycy5wdXNoKFxuICAgICAgYGdpdCB3b3JrdHJlZSBwcnVuZSBmYWlsZWQgaW4gJHtyZXBvRGlyfTogJHtwcnVuZVJlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyAyLiBMaXN0IHJlbWFpbmluZyB3b3JrdHJlZXMuXG4gIGNvbnN0IGxpc3RSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcIndvcmt0cmVlXCIsIFwibGlzdFwiLCBcIi0tcG9yY2VsYWluXCJdLFxuICAgIHsgY3dkOiByZXBvRGlyIH0sXG4gICk7XG4gIGlmICghbGlzdFJlc3VsdC5vayB8fCBsaXN0UmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICBjb25zdCBtc2cgPSAhbGlzdFJlc3VsdC5va1xuICAgICAgPyBsaXN0UmVzdWx0LmVycm9yLm1lc3NhZ2VcbiAgICAgIDogbGlzdFJlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpO1xuICAgIHJlc3VsdC5lcnJvcnMucHVzaChgZ2l0IHdvcmt0cmVlIGxpc3QgZmFpbGVkIGluICR7cmVwb0Rpcn06ICR7bXNnfWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHdvcmt0cmVlcyA9IHBhcnNlV29ya3RyZWVMaXN0KGxpc3RSZXN1bHQudmFsdWUuc3Rkb3V0KTtcblxuICBmb3IgKGNvbnN0IHd0IG9mIHdvcmt0cmVlcykge1xuICAgIGlmICh3dC5pc01haW4pIGNvbnRpbnVlO1xuXG4gICAgLy8gQSBkZXRhY2hlZCB3b3JrdHJlZSBoYXMgbm8gYnJhbmNoIOKAlCB0cmVhdCBhcyBvcnBoYW4gY2FuZGlkYXRlLlxuICAgIGxldCBicmFuY2hJc0dvbmUgPSB0cnVlO1xuICAgIGlmICh3dC5icmFuY2gpIHtcbiAgICAgIGJyYW5jaElzR29uZSA9ICEoYXdhaXQgYnJhbmNoRXhpc3RzKHJlcG9EaXIsIHd0LmJyYW5jaCkpO1xuICAgIH1cblxuICAgIGlmICghYnJhbmNoSXNHb25lKSB7XG4gICAgICByZXN1bHQucHJlc2VydmVkLnB1c2goYCR7d3QucGF0aH06IGJyYW5jaCAke3d0LmJyYW5jaH0gc3RpbGwgZXhpc3RzYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBtdGltZU1zID0gYXdhaXQgZ2V0TXRpbWVNcyh3dC5wYXRoKTtcbiAgICBpZiAobXRpbWVNcyA9PT0gbnVsbCkge1xuICAgICAgLy8gRGlyZWN0b3J5IGlzIGdvbmUg4oCUIGxldCB0aGUgbmV4dCBwcnVuZSBoYW5kbGUgaXQuXG4gICAgICByZXN1bHQucHJlc2VydmVkLnB1c2goYCR7d3QucGF0aH06IG5vdCBhY2Nlc3NpYmxlICh3aWxsIHBydW5lIG5leHQgcnVuKWApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgYWdlTXMgPSBub3dNcyAtIG10aW1lTXM7XG4gICAgaWYgKGFnZU1zIDwgbWF4QWdlTXMpIHtcbiAgICAgIGNvbnN0IGhvdXJzID0gKGFnZU1zIC8gMzYwMF8wMDApLnRvRml4ZWQoMSk7XG4gICAgICByZXN1bHQucHJlc2VydmVkLnB1c2goYCR7d3QucGF0aH06IG9ubHkgJHtob3Vyc31oIG9sZCwgYmVsb3cgdGhyZXNob2xkYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgdGhlIG9ycGhhbmVkIHdvcmt0cmVlLlxuICAgIGNvbnN0IHJlbW92ZVJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJ3b3JrdHJlZVwiLCBcInJlbW92ZVwiLCBcIi0tZm9yY2VcIiwgd3QucGF0aF0sXG4gICAgICB7IGN3ZDogcmVwb0RpciB9LFxuICAgICk7XG4gICAgaWYgKCFyZW1vdmVSZXN1bHQub2sgfHwgcmVtb3ZlUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIGNvbnN0IG1zZyA9ICFyZW1vdmVSZXN1bHQub2tcbiAgICAgICAgPyByZW1vdmVSZXN1bHQuZXJyb3IubWVzc2FnZVxuICAgICAgICA6IHJlbW92ZVJlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpO1xuICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKGBGYWlsZWQgdG8gcmVtb3ZlIHdvcmt0cmVlICR7d3QucGF0aH06ICR7bXNnfWApO1xuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgU0VMRi1IRUFMSU5HOiBmYWlsZWQgdG8gcmVtb3ZlIG9ycGhhbmVkIHdvcmt0cmVlICR7d3QucGF0aH06ICR7bXNnfWAsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgcmVzdWx0LnJlbW92ZWREaXJzLnB1c2god3QucGF0aCk7XG4gICAgY29uc3QgYnJhbmNoRGVzYyA9IHd0LmJyYW5jaCA/PyBcImRldGFjaGVkXCI7XG4gICAgY29uc3QgYWdlSCA9IChhZ2VNcyAvIDM2MDBfMDAwKS50b0ZpeGVkKDEpO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFNFTEYtSEVBTElORzogcmVtb3ZlZCBvcnBoYW5lZCB3b3JrdHJlZSAke3d0LnBhdGh9IGAgK1xuICAgICAgICBgKGJyYW5jaCAke2JyYW5jaERlc2N9IG1pc3NpbmcsIGFnZSAke2FnZUh9aClgLFxuICAgICk7XG4gICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgIFwiZGlza19zcGFjZV9jbGVhbnVwXCIsXG4gICAgICBgd29ya3RyZWVfY2xlYW51cCByZW1vdmVkIG9ycGhhbiAke3d0LnBhdGh9YCxcbiAgICApO1xuICB9XG59XG5cbi8qKiBHZXQgZGlyZWN0b3J5IG10aW1lIGFzIGVwb2NoIG1zLCBvciBudWxsIGlmIHN0YXQgZmFpbHMuICovXG5hc3luYyBmdW5jdGlvbiBnZXRNdGltZU1zKHBhdGg6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQocGF0aCk7XG4gICAgcmV0dXJuIHN0YXQubXRpbWUgPyBzdGF0Lm10aW1lLmdldFRpbWUoKSA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBUcnVlIHdoZW4gdGhlIHBhdGggZXhpc3RzIGFuZCByZXNvbHZlcyB0byBhIGRpcmVjdG9yeS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGlyZWN0b3J5KHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQocGF0aCk7XG4gICAgcmV0dXJuIHN0YXQuaXNEaXJlY3Rvcnk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBRUQsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBQ2pELFNBQVMsZ0JBQWdCLFFBQVEsZ0NBQWdDO0FBQ2pFLFNBQVMsdUJBQXVCLFFBQVEscUJBQXFCO0FBRTdELDJFQUEyRSxHQUMzRSxPQUFPLE1BQU0sd0JBQXdCLEdBQUc7QUFvQ3hDOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLGtCQUFrQixNQUFjO0VBQzlDLE1BQU0sU0FBUyxPQUFPLEtBQUssQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLElBQU0sRUFBRSxJQUFJLElBQUksTUFBTSxDQUFDLENBQUMsSUFDaEUsRUFBRSxNQUFNLEdBQUc7RUFFYixNQUFNLFVBQTJCLEVBQUU7RUFFbkMsSUFBSyxJQUFJLElBQUksR0FBRyxJQUFJLE9BQU8sTUFBTSxFQUFFLElBQUs7SUFDdEMsTUFBTSxRQUFRLE1BQU0sQ0FBQyxF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
// denoCacheMetadata=13305584144517392580,756111619149120601