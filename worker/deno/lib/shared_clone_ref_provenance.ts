/** Last-writer provenance collection for a repaired shared-clone ref (Issue #2889). */

import { type GitCommandOptions, runGitCommand } from "./git_timeout.ts";
import type { SharedCloneRefSweepDeps } from "./shared_clone_ref_sweep.ts";

/** Last-writer provenance collected for a repaired ref. */
export interface RefProvenance {
  /** ISO mtime of the loose ref file when one existed. */
  refFileMtime?: string;
  /** Last line of the ref's reflog, truncated to 300 characters. */
  lastReflogEntry?: string;
  /** Worktree paths (from `git worktree list`) with this branch checked out. */
  checkedOutIn?: string[];
  /** `oom-*` log basenames whose mtime is close to the ref's mtime. */
  nearbyOomLogs?: string[];
}

/** Best-effort provenance collection; every I/O error is narrowed and logged. */
export async function collectProvenance(
  ref: string,
  clone: string,
  commonDir: string,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
): Promise<RefProvenance> {
  const provenance: RefProvenance = {};

  let refFileMtimeMs: number | undefined;
  try {
    const stat = await Deno.lstat(`${commonDir}/${ref}`);
    if (stat.mtime) {
      provenance.refFileMtime = stat.mtime.toISOString();
      refFileMtimeMs = stat.mtime.getTime();
    }
  } catch (error) {
    // Already removed, or never existed as a loose file (packed-only).
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not stat ${ref} for provenance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const reflog = await Deno.readTextFile(`${commonDir}/logs/${ref}`);
    const lastLine = reflog.split("\n").map((l) => l.trim()).filter(Boolean)
      .at(-1);
    if (lastLine) provenance.lastReflogEntry = lastLine.slice(0, 300);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not read reflog for ${ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length);
    const checkedOutIn = await checkedOutWorktrees(clone, branch, deps);
    if (checkedOutIn.length > 0) provenance.checkedOutIn = checkedOutIn;
  }

  if (deps.logsDir) {
    const nearby = await nearbyOomLogs(
      deps.logsDir,
      refFileMtimeMs ?? now().getTime(),
      deps,
    );
    if (nearby.length > 0) provenance.nearbyOomLogs = nearby;
  }

  return provenance;
}

/** Worktree paths with `branch` checked out, from `git worktree list --porcelain`. */
async function checkedOutWorktrees(
  clone: string,
  branch: string,
  deps: SharedCloneRefSweepDeps,
): Promise<string[]> {
  const runGit = deps.runGit ?? runGitCommand;
  const result = await runGit(
    ["worktree", "list", "--porcelain"],
    {
      cwd: clone,
    } satisfies GitCommandOptions,
  );
  if (!result.ok || result.value.code !== 0) return [];

  const paths: string[] = [];
  let currentPath: string | null = null;
  for (const line of result.value.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const branchRef = line.slice("branch ".length).trim();
      if (currentPath && branchRef === `refs/heads/${branch}`) {
        paths.push(currentPath);
      }
    } else if (line === "") {
      currentPath = null;
    }
  }
  return paths;
}

/** `logsDir/oom-*` basenames whose mtime is within 15 minutes of `targetMs`. */
async function nearbyOomLogs(
  logsDir: string,
  targetMs: number,
  deps: SharedCloneRefSweepDeps,
): Promise<string[]> {
  const windowMs = 15 * 60 * 1000;
  const matches: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(logsDir)) entries.push(entry);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not read logsDir for OOM correlation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return matches;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.startsWith("oom-")) continue;
    try {
      const stat = await Deno.stat(`${logsDir}/${entry.name}`);
      if (stat.mtime && Math.abs(stat.mtime.getTime() - targetMs) <= windowMs) {
        matches.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        deps.log(
          `Shared-clone sweep: could not stat ${entry.name} for OOM correlation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return matches;
}
