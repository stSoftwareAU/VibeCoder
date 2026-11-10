/**
 * Per-repository Claude session manager (Issue #1321, Issue #1322).
 *
 * Maintains separate Claude session directories per repository so that
 * context from previous work is preserved, while ensuring sessions are
 * never shared across repos. Replaces the blanket `.claude/` deletion
 * that was introduced in Issue #384.
 *
 * Session state is stored per work stream (Issue #1322):
 *   - Default branch:  `${workDir}/.claude-sessions/${owner}/${repo}/default/`
 *   - Milestone work:  `${workDir}/.claude-sessions/${owner}/${repo}/milestone-${id}/`
 *
 * On first milestone invocation, the default branch session is copied as a
 * starting point (copy-on-first-use). Subsequent milestone work uses the
 * milestone's own session independently.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { defaultLogger } from "./logger.ts";
import { isAllowedSessionPath } from "./session_file_policy.ts";
import { resolveAgentStateDir } from "./agent_state_dir.ts";
import { runGitCommand } from "./git_timeout.ts";
/** Maximum total size in bytes for a single repo's session store (50 MB). */ const DEFAULT_MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024;
/** Maximum age in days for session files before cleanup. */ const DEFAULT_MAX_SESSION_AGE_DAYS = 7;
/**
 * Build the base session store path for a given repo.
 *
 * This returns the repo-level directory that contains work stream
 * subdirectories (`default/`, `milestone-N/`). Use
 * {@link getWorkStreamSessionPath} for the actual session store.
 *
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 * @returns Absolute path to the per-repo session store base
 */ export function getSessionStorePath(workDir, repo) {
  // Issue #1407: rooted on the agent-state volume, a sibling of the work dir.
  // Session isolation is unchanged — the store is still keyed per owner, per
  // repository and per work stream — only the root moves, so tightening the
  // work volume cannot reach the agent's own sessions. Falls back to the work
  // dir when it names no directory to sit beside.
  const root = resolveAgentStateDir(workDir) || workDir;
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Fallback: use the full repo string sanitised
    return `${root}/.claude-sessions/${repo.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }
  return `${root}/.claude-sessions/${parts[0]}/${parts[1]}`;
}
/**
 * Build the session store path for a specific work stream (Issue #1322).
 *
 * - Without milestoneId: returns the default branch session path
 *   (`${base}/default/`)
 * - With milestoneId: returns the milestone session path
 *   (`${base}/milestone-${milestoneId}/`)
 *
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 * @param milestoneId - Optional milestone ID for milestone sessions
 * @returns Absolute path to the work stream session store
 */ export function getWorkStreamSessionPath(workDir, repo, milestoneId) {
  const base = getSessionStorePath(workDir, repo);
  if (milestoneId !== undefined) {
    return `${base}/milestone-${milestoneId}`;
  }
  return `${base}/default`;
}
/**
 * Restore a repo's Claude session from the per-repo store.
 *
 * Copies stored session files into `${repoPath}/.claude`.
 * If no stored session exists, ensures `.claude/` is absent (clean start),
 * apart from any files the checked-out commit tracks there, which are put
 * back exactly as `HEAD` holds them (Issue #2774).
 *
 * When milestoneId is provided, restores the milestone-specific session.
 * When not provided, restores the default branch session.
 *
 * Handles migration from old-style sessions (Issue #1321 format) where
 * files lived directly in `${owner}/${repo}/` instead of `${owner}/${repo}/default/`.
 *
 * @param repoPath - Path to the cloned repository
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 * @param milestoneId - Optional milestone ID (Issue #1322)
 * @returns Result indicating success or failure
 */ export async function restoreSession(repoPath, workDir, repo, milestoneId) {
  const restored = await replaceSessionDir(repoPath, workDir, repo, milestoneId);
  const tracked = await restoreTrackedClaudePaths(repoPath);
  return restored.ok ? tracked : restored;
}
/**
 * Put back what the checked-out commit tracks under `.claude/` (Issue #2774).
 *
 * {@link restoreSession} erases `.claude/` wholesale, so nothing a previous
 * run wrote there reaches this one — but a repository may track files there
 * too (this one tracks `.claude/skills/` since #2676). Erased and never put
 * back, they read as deleted: `git add -A` staged the deletions, the
 * pre-commit safety gate refused them, and a run's WIP was lost. Each is
 * restored from `HEAD`, so a previous run's edit to one does not survive
 * either. Outside a git checkout, or when `HEAD` tracks nothing under
 * `.claude/`, there is nothing to restore.
 */ async function restoreTrackedClaudePaths(repoPath) {
  const listed = await runGitCommand([
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ".claude"
  ], {
    cwd: repoPath
  });
  if (!listed.ok || listed.value.code !== 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  if (listed.value.stdout.trim() === "") return {
    ok: true,
    value: undefined
  };
  const checkout = await runGitCommand([
    "checkout",
    "HEAD",
    "--",
    ".claude"
  ], {
    cwd: repoPath
  });
  if (checkout.ok && checkout.value.code === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  const detail = checkout.ok ? checkout.value.stderr.trim() || `exit ${checkout.value.code}` : checkout.error.message;
  return {
    ok: false,
    error: new Error(`Failed to restore the tracked .claude/ files in ${repoPath} ` + `(Issue #2774): ${detail}`)
  };
}
/** Erase `.claude/` and copy the work stream's stored session into it. */ async function replaceSessionDir(repoPath, workDir, repo, milestoneId) {
  // Migrate old-style sessions if needed (Issue #1322)
  if (milestoneId === undefined) {
    await migrateOldStyleSession(workDir, repo);
  }
  const storePath = getWorkStreamSessionPath(workDir, repo, milestoneId);
  // Always remove existing .claude/ first to ensure clean state
  try {
    await Deno.remove(`${repoPath}/.claude`, {
      recursive: true
    });
  } catch  {
  // Directory doesn't exist — fine
  }
  // Check if we have a stored session
  try {
    const stat = await Deno.stat(storePath);
    if (!stat.isDirectory) {
      return {
        ok: true,
        value: undefined
      };
    }
  } catch  {
    // No stored session — clean start
    return {
      ok: true,
      value: undefined
    };
  }
  // Copy stored session into .claude/
  try {
    await copyDirectory(storePath, `${repoPath}/.claude`);
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    // If copy fails, remove partial .claude/ and continue with clean state
    try {
      await Deno.remove(`${repoPath}/.claude`, {
        recursive: true
      });
    } catch  {
    // Ignore cleanup failure
    }
    return {
      ok: false,
      error: new Error(`Failed to restore session for ${repo}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Save the current `.claude/` session state to the per-repo store.
 *
 * Replaces the stored session with the current state.
 * Also runs cleanup to enforce size/age limits.
 *
 * When milestoneId is provided, saves to the milestone-specific session store.
 * When not provided, saves to the default branch session store.
 *
 * @param repoPath - Path to the cloned repository
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 * @param options - Optional size/age limits
 * @param milestoneId - Optional milestone ID (Issue #1322)
 * @returns Result indicating success or failure
 */ export async function saveSession(repoPath, workDir, repo, options, milestoneId) {
  const claudePath = `${repoPath}/.claude`;
  const storePath = getWorkStreamSessionPath(workDir, repo, milestoneId);
  // Check if .claude/ exists
  try {
    const stat = await Deno.stat(claudePath);
    if (!stat.isDirectory) {
      return {
        ok: true,
        value: undefined
      };
    }
  } catch  {
    // No .claude/ to save
    return {
      ok: true,
      value: undefined
    };
  }
  try {
    // Remove old stored session
    try {
      await Deno.remove(storePath, {
        recursive: true
      });
    } catch  {
    // Didn't exist
    }
    // Ensure parent directories exist
    const parentDir = storePath.substring(0, storePath.lastIndexOf("/"));
    await Deno.mkdir(parentDir, {
      recursive: true
    });
    // Copy .claude/ to store
    await copyDirectory(claudePath, storePath);
    // Enforce size/age limits
    await cleanupSessionStore(storePath, options);
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to save session for ${repo}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Initialise a milestone session from the default branch session (Issue #1322).
 *
 * Copy-on-first-use: if the milestone session directory does not yet exist,
 * copies the default branch's session to create the milestone's initial
 * session. If the milestone session already exists, does nothing (preserving
 * any milestone-specific context accumulated during previous work).
 *
 * If no default branch session exists, succeeds without creating the
 * milestone directory (clean start).
 *
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 * @param milestoneId - Milestone ID
 * @returns Result indicating success or failure
 */ export async function initialiseMilestoneSession(workDir, repo, milestoneId) {
  const milestonePath = getWorkStreamSessionPath(workDir, repo, milestoneId);
  const defaultPath = getWorkStreamSessionPath(workDir, repo);
  // If milestone session already exists, do not re-copy
  try {
    const stat = await Deno.stat(milestonePath);
    if (stat.isDirectory) {
      return {
        ok: true,
        value: undefined
      };
    }
  } catch  {
  // Milestone session doesn't exist yet — continue with copy
  }
  // Check if default session exists
  try {
    const stat = await Deno.stat(defaultPath);
    if (!stat.isDirectory) {
      // No default session — clean start
      return {
        ok: true,
        value: undefined
      };
    }
  } catch  {
    // No default session — clean start
    return {
      ok: true,
      value: undefined
    };
  }
  // Copy default session to milestone session
  try {
    await copyDirectory(defaultPath, milestonePath);
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    // If copy fails, clean up partial milestone session
    try {
      await Deno.remove(milestonePath, {
        recursive: true
      });
    } catch  {
    // Ignore cleanup failure
    }
    return {
      ok: false,
      error: new Error(`Failed to initialise milestone ${milestoneId} session for ${repo}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Migrate old-style session to the new default/ subdirectory (Issue #1322).
 *
 * Pre-Issue #1322, sessions were stored directly in `${owner}/${repo}/`.
 * The new structure uses `${owner}/${repo}/default/` for the default branch
 * session. This function detects old-style sessions (files directly in the
 * base path with no `default/` subdirectory) and migrates them.
 *
 * @param workDir - The worker's base working directory
 * @param repo - Repository in "owner/repo" format
 */ async function migrateOldStyleSession(workDir, repo) {
  const basePath = getSessionStorePath(workDir, repo);
  const defaultPath = `${basePath}/default`;
  // If default/ already exists, no migration needed
  try {
    const stat = await Deno.stat(defaultPath);
    if (stat.isDirectory) return;
  } catch  {
  // default/ doesn't exist — check if old-style session needs migration
  }
  // Check if base path exists and has files (old-style session)
  try {
    const stat = await Deno.stat(basePath);
    if (!stat.isDirectory) return;
  } catch  {
    return; // Base doesn't exist at all
  }
  // Check for files directly in basePath (not just milestone-* dirs)
  let hasFiles = false;
  try {
    for await (const entry of Deno.readDir(basePath)){
      if (entry.isFile) {
        hasFiles = true;
        break;
      }
      // Check for non-milestone subdirs (old-style nested content)
      if (entry.isDirectory && entry.name !== "default" && !entry.name.startsWith("milestone-")) {
        hasFiles = true;
        break;
      }
    }
  } catch  {
    return;
  }
  if (!hasFiles) return;
  // Migrate: copy old-style content to default/, then remove old files
  try {
    await Deno.mkdir(defaultPath, {
      recursive: true
    });
    for await (const entry of Deno.readDir(basePath)){
      if (entry.name === "default" || entry.name.startsWith("milestone-")) {
        continue; // Skip work stream directories
      }
      const srcPath = `${basePath}/${entry.name}`;
      const destPath = `${defaultPath}/${entry.name}`;
      if (entry.isDirectory) {
        // Filtered copy, then drop the old copy either way (Issue #3663).
        if (isAllowedSessionPath(entry.name, "directory")) {
          await copyDirectory(srcPath, destPath, entry.name);
        } else {
          logBlockedEntry(entry.name);
        }
        await Deno.remove(srcPath, {
          recursive: true
        });
      } else if (entry.isFile) {
        if (isAllowedSessionPath(entry.name, "file")) {
          await Deno.copyFile(srcPath, destPath);
        } else {
          logBlockedEntry(entry.name);
        }
        await Deno.remove(srcPath);
      }
    }
  } catch  {
  // Migration is best-effort — if it fails, the old session is still usable
  }
}
/**
 * Clean up session files that exceed size or age limits.
 *
 * Removes files older than maxSessionAgeDays, then if the total size
 * still exceeds maxSessionSizeBytes, removes oldest files first.
 *
 * @param storePath - Path to the per-repo session store
 * @param options - Size/age limits
 */ export async function cleanupSessionStore(storePath, options) {
  const maxSize = options?.maxSessionSizeBytes ?? DEFAULT_MAX_SESSION_SIZE_BYTES;
  const maxAgeDays = options?.maxSessionAgeDays ?? DEFAULT_MAX_SESSION_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  // Collect all files with their stats
  const files = [];
  try {
    await collectFiles(storePath, files);
  } catch  {
    // Store doesn't exist or can't be read
    return;
  }
  // Remove files older than maxAgeDays
  for (const file of files){
    if (now - file.mtime > maxAgeMs) {
      try {
        await Deno.remove(file.path);
      } catch  {
      // Ignore individual file removal failures
      }
    }
  }
  // Re-collect remaining files
  const remainingFiles = [];
  try {
    await collectFiles(storePath, remainingFiles);
  } catch  {
    return;
  }
  // Sort by mtime ascending (oldest first)
  remainingFiles.sort((a, b)=>a.mtime - b.mtime);
  // Remove oldest files until under size limit
  let totalSize = remainingFiles.reduce((sum, f)=>sum + f.size, 0);
  for (const file of remainingFiles){
    if (totalSize <= maxSize) break;
    try {
      await Deno.remove(file.path);
      totalSize -= file.size;
    } catch  {
    // Ignore individual file removal failures
    }
  }
}
/**
 * Recursively collect all files in a directory with their stats.
 */ async function collectFiles(dirPath, files) {
  for await (const entry of Deno.readDir(dirPath)){
    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFiles(fullPath, files);
    } else if (entry.isFile) {
      try {
        const stat = await Deno.stat(fullPath);
        files.push({
          path: fullPath,
          size: stat.size,
          mtime: stat.mtime?.getTime() ?? Date.now()
        });
      } catch  {
      // Skip files we can't stat
      }
    }
  }
}
/**
 * Report an entry the allowlist refused to carry across a run (Issue #3663).
 *
 * Blocked entries are policy, not faults — but they stay visible so a
 * model-authored `settings.json` or hook script cannot be dropped silently.
 */ function logBlockedEntry(relativePath) {
  defaultLogger.security("SESSION_ENTRY_BLOCKED", `Refused to persist .claude/${relativePath} — outside the session allowlist`);
}
/**
 * Recursively copy a directory, carrying only allowlisted session state.
 *
 * Applied to every leg of the copy (save, restore, milestone seeding and
 * migration), so neither a poisoned working tree nor a poisoned store can
 * reintroduce executable or configuration content (Issue #3663).
 *
 * @param src - Source directory
 * @param dest - Destination directory
 * @param relative - Path of `src` relative to the `.claude/` root
 */ async function copyDirectory(src, dest, relative = "") {
  await Deno.mkdir(dest, {
    recursive: true
  });
  for await (const entry of Deno.readDir(src)){
    const srcPath = `${src}/${entry.name}`;
    const destPath = `${dest}/${entry.name}`;
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (!isAllowedSessionPath(entryRelative, "directory")) {
        logBlockedEntry(entryRelative);
        continue;
      }
      await copyDirectory(srcPath, destPath, entryRelative);
    } else if (entry.isFile) {
      if (!isAllowedSessionPath(entryRelative, "file")) {
        logBlockedEntry(entryRelative);
        continue;
      }
      await Deno.copyFile(srcPath, destPath);
    }
  // Skip symlinks and other special entries for safety
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZXNzaW9uX21hbmFnZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQZXItcmVwb3NpdG9yeSBDbGF1ZGUgc2Vzc2lvbiBtYW5hZ2VyIChJc3N1ZSAjMTMyMSwgSXNzdWUgIzEzMjIpLlxuICpcbiAqIE1haW50YWlucyBzZXBhcmF0ZSBDbGF1ZGUgc2Vzc2lvbiBkaXJlY3RvcmllcyBwZXIgcmVwb3NpdG9yeSBzbyB0aGF0XG4gKiBjb250ZXh0IGZyb20gcHJldmlvdXMgd29yayBpcyBwcmVzZXJ2ZWQsIHdoaWxlIGVuc3VyaW5nIHNlc3Npb25zIGFyZVxuICogbmV2ZXIgc2hhcmVkIGFjcm9zcyByZXBvcy4gUmVwbGFjZXMgdGhlIGJsYW5rZXQgYC5jbGF1ZGUvYCBkZWxldGlvblxuICogdGhhdCB3YXMgaW50cm9kdWNlZCBpbiBJc3N1ZSAjMzg0LlxuICpcbiAqIFNlc3Npb24gc3RhdGUgaXMgc3RvcmVkIHBlciB3b3JrIHN0cmVhbSAoSXNzdWUgIzEzMjIpOlxuICogICAtIERlZmF1bHQgYnJhbmNoOiAgYCR7d29ya0Rpcn0vLmNsYXVkZS1zZXNzaW9ucy8ke293bmVyfS8ke3JlcG99L2RlZmF1bHQvYFxuICogICAtIE1pbGVzdG9uZSB3b3JrOiAgYCR7d29ya0Rpcn0vLmNsYXVkZS1zZXNzaW9ucy8ke293bmVyfS8ke3JlcG99L21pbGVzdG9uZS0ke2lkfS9gXG4gKlxuICogT24gZmlyc3QgbWlsZXN0b25lIGludm9jYXRpb24sIHRoZSBkZWZhdWx0IGJyYW5jaCBzZXNzaW9uIGlzIGNvcGllZCBhcyBhXG4gKiBzdGFydGluZyBwb2ludCAoY29weS1vbi1maXJzdC11c2UpLiBTdWJzZXF1ZW50IG1pbGVzdG9uZSB3b3JrIHVzZXMgdGhlXG4gKiBtaWxlc3RvbmUncyBvd24gc2Vzc2lvbiBpbmRlcGVuZGVudGx5LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9nZ2VyIH0gZnJvbSBcIi4vbG9nZ2VyLnRzXCI7XG5pbXBvcnQgeyBpc0FsbG93ZWRTZXNzaW9uUGF0aCB9IGZyb20gXCIuL3Nlc3Npb25fZmlsZV9wb2xpY3kudHNcIjtcbmltcG9ydCB7IHJlc29sdmVBZ2VudFN0YXRlRGlyIH0gZnJvbSBcIi4vYWdlbnRfc3RhdGVfZGlyLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcblxuLyoqIE1heGltdW0gdG90YWwgc2l6ZSBpbiBieXRlcyBmb3IgYSBzaW5nbGUgcmVwbydzIHNlc3Npb24gc3RvcmUgKDUwIE1CKS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1NFU1NJT05fU0laRV9CWVRFUyA9IDUwICogMTAyNCAqIDEwMjQ7XG5cbi8qKiBNYXhpbXVtIGFnZSBpbiBkYXlzIGZvciBzZXNzaW9uIGZpbGVzIGJlZm9yZSBjbGVhbnVwLiAqL1xuY29uc3QgREVGQVVMVF9NQVhfU0VTU0lPTl9BR0VfREFZUyA9IDc7XG5cbi8qKiBPcHRpb25zIGZvciBzZXNzaW9uIG1hbmFnZW1lbnQgb3BlcmF0aW9ucy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbk1hbmFnZXJPcHRpb25zIHtcbiAgLyoqIE1heGltdW0gdG90YWwgc2l6ZSBpbiBieXRlcyBmb3IgYSByZXBvJ3Mgc2Vzc2lvbiBzdG9yZS4gKi9cbiAgbWF4U2Vzc2lvblNpemVCeXRlcz86IG51bWJlcjtcbiAgLyoqIE1heGltdW0gYWdlIGluIGRheXMgZm9yIHNlc3Npb24gZmlsZXMuICovXG4gIG1heFNlc3Npb25BZ2VEYXlzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBiYXNlIHNlc3Npb24gc3RvcmUgcGF0aCBmb3IgYSBnaXZlbiByZXBvLlxuICpcbiAqIFRoaXMgcmV0dXJucyB0aGUgcmVwby1sZXZlbCBkaXJlY3RvcnkgdGhhdCBjb250YWlucyB3b3JrIHN0cmVhbVxuICogc3ViZGlyZWN0b3JpZXMgKGBkZWZhdWx0L2AsIGBtaWxlc3RvbmUtTi9gKS4gVXNlXG4gKiB7QGxpbmsgZ2V0V29ya1N0cmVhbVNlc3Npb25QYXRofSBmb3IgdGhlIGFjdHVhbCBzZXNzaW9uIHN0b3JlLlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIHdvcmtlcidzIGJhc2Ugd29ya2luZyBkaXJlY3RvcnlcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEByZXR1cm5zIEFic29sdXRlIHBhdGggdG8gdGhlIHBlci1yZXBvIHNlc3Npb24gc3RvcmUgYmFzZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2Vzc2lvblN0b3JlUGF0aCh3b3JrRGlyOiBzdHJpbmcsIHJlcG86IHN0cmluZyk6IHN0cmluZyB7XG4gIC8vIElzc3VlICMxNDA3OiByb290ZWQgb24gdGhlIGFnZW50LXN0YXRlIHZvbHVtZSwgYSBzaWJsaW5nIG9mIHRoZSB3b3JrIGRpci5cbiAgLy8gU2Vzc2lvbiBpc29sYXRpb24gaXMgdW5jaGFuZ2VkIOKAlCB0aGUgc3RvcmUgaXMgc3RpbGwga2V5ZWQgcGVyIG93bmVyLCBwZXJcbiAgLy8gcmVwb3NpdG9yeSBhbmQgcGVyIHdvcmsgc3RyZWFtIOKAlCBvbmx5IHRoZSByb290IG1vdmVzLCBzbyB0aWdodGVuaW5nIHRoZVxuICAvLyB3b3JrIHZvbHVtZSBjYW5ub3QgcmVhY2ggdGhlIGFnZW50J3Mgb3duIHNlc3Npb25zLiBGYWxscyBiYWNrIHRvIHRoZSB3b3JrXG4gIC8vIGRpciB3aGVuIGl0IG5hbWVzIG5vIGRpcmVjdG9yeSB0byBzaXQgYmVzaWRlLlxuICBjb25zdCByb290ID0gcmVzb2x2ZUFnZW50U3RhdGVEaXIod29ya0RpcikgfHwgd29ya0RpcjtcbiAgY29uc3QgcGFydHMgPSByZXBvLnNwbGl0KFwiL1wiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCAhPT0gMiB8fCAhcGFydHNbMF0gfHwgIXBhcnRzWzFdKSB7XG4gICAgLy8gRmFsbGJhY2s6IHVzZSB0aGUgZnVsbCByZXBvIHN0cmluZyBzYW5pdGlzZWRcbiAgICByZXR1cm4gYCR7cm9vdH0vLmNsYXVkZS1zZXNzaW9ucy8ke3JlcG8ucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpfWA7XG4gIH1cbiAgcmV0dXJuIGAke3Jvb3R9Ly5jbGF1ZGUtc2Vzc2lvbnMvJHtwYXJ0c1swXX0vJHtwYXJ0c1sxXX1gO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBzZXNzaW9uIHN0b3JlIHBhdGggZm9yIGEgc3BlY2lmaWMgd29yayBzdHJlYW0gKElzc3VlICMxMzIyKS5cbiAqXG4gKiAtIFdpdGhvdXQgbWlsZXN0b25lSWQ6IHJldHVybnMgdGhlIGRlZmF1bHQgYnJhbmNoIHNlc3Npb24gcGF0aFxuICogICAoYCR7YmFzZX0vZGVmYXVsdC9gKVxuICogLSBXaXRoIG1pbGVzdG9uZUlkOiByZXR1cm5zIHRoZSBtaWxlc3RvbmUgc2Vzc2lvbiBwYXRoXG4gKiAgIChgJHtiYXNlfS9taWxlc3RvbmUtJHttaWxlc3RvbmVJZH0vYClcbiAqXG4gKiBAcGFyYW0gd29ya0RpciAtIFRoZSB3b3JrZXIncyBiYXNlIHdvcmtpbmcgZGlyZWN0b3J5XG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gbWlsZXN0b25lSWQgLSBPcHRpb25hbCBtaWxlc3RvbmUgSUQgZm9yIG1pbGVzdG9uZSBzZXNzaW9uc1xuICogQHJldHVybnMgQWJzb2x1dGUgcGF0aCB0byB0aGUgd29yayBzdHJlYW0gc2Vzc2lvbiBzdG9yZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0V29ya1N0cmVhbVNlc3Npb25QYXRoKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ/OiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gZ2V0U2Vzc2lvblN0b3JlUGF0aCh3b3JrRGlyLCByZXBvKTtcbiAgaWYgKG1pbGVzdG9uZUlkICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gYCR7YmFzZX0vbWlsZXN0b25lLSR7bWlsZXN0b25lSWR9YDtcbiAgfVxuICByZXR1cm4gYCR7YmFzZX0vZGVmYXVsdGA7XG59XG5cbi8qKlxuICogUmVzdG9yZSBhIHJlcG8ncyBDbGF1ZGUgc2Vzc2lvbiBmcm9tIHRoZSBwZXItcmVwbyBzdG9yZS5cbiAqXG4gKiBDb3BpZXMgc3RvcmVkIHNlc3Npb24gZmlsZXMgaW50byBgJHtyZXBvUGF0aH0vLmNsYXVkZWAuXG4gKiBJZiBubyBzdG9yZWQgc2Vzc2lvbiBleGlzdHMsIGVuc3VyZXMgYC5jbGF1ZGUvYCBpcyBhYnNlbnQgKGNsZWFuIHN0YXJ0KSxcbiAqIGFwYXJ0IGZyb20gYW55IGZpbGVzIHRoZSBjaGVja2VkLW91dCBjb21taXQgdHJhY2tzIHRoZXJlLCB3aGljaCBhcmUgcHV0XG4gKiBiYWNrIGV4YWN0bHkgYXMgYEhFQURgIGhvbGRzIHRoZW0gKElzc3VlICMyNzc0KS5cbiAqXG4gKiBXaGVuIG1pbGVzdG9uZUlkIGlzIHByb3ZpZGVkLCByZXN0b3JlcyB0aGUgbWlsZXN0b25lLXNwZWNpZmljIHNlc3Npb24uXG4gKiBXaGVuIG5vdCBwcm92aWRlZCwgcmVzdG9yZXMgdGhlIGRlZmF1bHQgYnJhbmNoIHNlc3Npb24uXG4gKlxuICogSGFuZGxlcyBtaWdyYXRpb24gZnJvbSBvbGQtc3R5bGUgc2Vzc2lvbnMgKElzc3VlICMxMzIxIGZvcm1hdCkgd2hlcmVcbiAqIGZpbGVzIGxpdmVkIGRpcmVjdGx5IGluIGAke293bmVyfS8ke3JlcG99L2AgaW5zdGVhZCBvZiBgJHtvd25lcn0vJHtyZXBvfS9kZWZhdWx0L2AuXG4gKlxuICogQHBhcmFtIHJlcG9QYXRoIC0gUGF0aCB0byB0aGUgY2xvbmVkIHJlcG9zaXRvcnlcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIHdvcmtlcidzIGJhc2Ugd29ya2luZyBkaXJlY3RvcnlcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBtaWxlc3RvbmVJZCAtIE9wdGlvbmFsIG1pbGVzdG9uZSBJRCAoSXNzdWUgIzEzMjIpXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyBzdWNjZXNzIG9yIGZhaWx1cmVcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RvcmVTZXNzaW9uKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ/OiBudW1iZXIsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCByZXN0b3JlZCA9IGF3YWl0IHJlcGxhY2VTZXNzaW9uRGlyKFxuICAgIHJlcG9QYXRoLFxuICAgIHdvcmtEaXIsXG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVJZCxcbiAgKTtcbiAgY29uc3QgdHJhY2tlZCA9IGF3YWl0IHJlc3RvcmVUcmFja2VkQ2xhdWRlUGF0aHMocmVwb1BhdGgpO1xuICByZXR1cm4gcmVzdG9yZWQub2sgPyB0cmFja2VkIDogcmVzdG9yZWQ7XG59XG5cbi8qKlxuICogUHV0IGJhY2sgd2hhdCB0aGUgY2hlY2tlZC1vdXQgY29tbWl0IHRyYWNrcyB1bmRlciBgLmNsYXVkZS9gIChJc3N1ZSAjMjc3NCkuXG4gKlxuICoge0BsaW5rIHJlc3RvcmVTZXNzaW9ufSBlcmFzZXMgYC5jbGF1ZGUvYCB3aG9sZXNhbGUsIHNvIG5vdGhpbmcgYSBwcmV2aW91c1xuICogcnVuIHdyb3RlIHRoZXJlIHJlYWNoZXMgdGhpcyBvbmUg4oCUIGJ1dCBhIHJlcG9zaXRvcnkgbWF5IHRyYWNrIGZpbGVzIHRoZXJlXG4gKiB0b28gKHRoaXMgb25lIHRyYWNrcyBgLmNsYXVkZS9za2lsbHMvYCBzaW5jZSAjMjY3NikuIEVyYXNlZCBhbmQgbmV2ZXIgcHV0XG4gKiBiYWNrLCB0aGV5IHJlYWQgYXMgZGVsZXRlZDogYGdpdCBhZGQgLUFgIHN0YWdlZCB0aGUgZGVsZXRpb25zLCB0aGVcbiAqIHByZS1jb21taXQgc2FmZXR5IGdhdGUgcmVmdXNlZCB0aGVtLCBhbmQgYSBydW4ncyBXSVAgd2FzIGxvc3QuIEVhY2ggaXNcbiAqIHJlc3RvcmVkIGZyb20gYEhFQURgLCBzbyBhIHByZXZpb3VzIHJ1bidzIGVkaXQgdG8gb25lIGRvZXMgbm90IHN1cnZpdmVcbiAqIGVpdGhlci4gT3V0c2lkZSBhIGdpdCBjaGVja291dCwgb3Igd2hlbiBgSEVBRGAgdHJhY2tzIG5vdGhpbmcgdW5kZXJcbiAqIGAuY2xhdWRlL2AsIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVzdG9yZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzdG9yZVRyYWNrZWRDbGF1ZGVQYXRocyhcbiAgcmVwb1BhdGg6IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGxpc3RlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wibHMtdHJlZVwiLCBcIi1yXCIsIFwiLS1uYW1lLW9ubHlcIiwgXCJIRUFEXCIsIFwiLS1cIiwgXCIuY2xhdWRlXCJdLFxuICAgIHsgY3dkOiByZXBvUGF0aCB9LFxuICApO1xuICBpZiAoIWxpc3RlZC5vayB8fCBsaXN0ZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cbiAgaWYgKGxpc3RlZC52YWx1ZS5zdGRvdXQudHJpbSgpID09PSBcIlwiKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuXG4gIGNvbnN0IGNoZWNrb3V0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJjaGVja291dFwiLCBcIkhFQURcIiwgXCItLVwiLCBcIi5jbGF1ZGVcIl0sXG4gICAgeyBjd2Q6IHJlcG9QYXRoIH0sXG4gICk7XG4gIGlmIChjaGVja291dC5vayAmJiBjaGVja291dC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuICBjb25zdCBkZXRhaWwgPSBjaGVja291dC5va1xuICAgID8gY2hlY2tvdXQudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCBgZXhpdCAke2NoZWNrb3V0LnZhbHVlLmNvZGV9YFxuICAgIDogY2hlY2tvdXQuZXJyb3IubWVzc2FnZTtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGBGYWlsZWQgdG8gcmVzdG9yZSB0aGUgdHJhY2tlZCAuY2xhdWRlLyBmaWxlcyBpbiAke3JlcG9QYXRofSBgICtcbiAgICAgICAgYChJc3N1ZSAjMjc3NCk6ICR7ZGV0YWlsfWAsXG4gICAgKSxcbiAgfTtcbn1cblxuLyoqIEVyYXNlIGAuY2xhdWRlL2AgYW5kIGNvcHkgdGhlIHdvcmsgc3RyZWFtJ3Mgc3RvcmVkIHNlc3Npb24gaW50byBpdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlcGxhY2VTZXNzaW9uRGlyKFxuICByZXBvUGF0aDogc3RyaW5nLFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ/OiBudW1iZXIsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICAvLyBNaWdyYXRlIG9sZC1zdHlsZSBzZXNzaW9ucyBpZiBuZWVkZWQgKElzc3VlICMxMzIyKVxuICBpZiAobWlsZXN0b25lSWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGF3YWl0IG1pZ3JhdGVPbGRTdHlsZVNlc3Npb24od29ya0RpciwgcmVwbyk7XG4gIH1cblxuICBjb25zdCBzdG9yZVBhdGggPSBnZXRXb3JrU3RyZWFtU2Vzc2lvblBhdGgod29ya0RpciwgcmVwbywgbWlsZXN0b25lSWQpO1xuXG4gIC8vIEFsd2F5cyByZW1vdmUgZXhpc3RpbmcgLmNsYXVkZS8gZmlyc3QgdG8gZW5zdXJlIGNsZWFuIHN0YXRlXG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7cmVwb1BhdGh9Ly5jbGF1ZGVgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IGRvZXNuJ3QgZXhpc3Qg4oCUIGZpbmVcbiAgfVxuXG4gIC8vIENoZWNrIGlmIHdlIGhhdmUgYSBzdG9yZWQgc2Vzc2lvblxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoc3RvcmVQYXRoKTtcbiAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkpIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBObyBzdG9yZWQgc2Vzc2lvbiDigJQgY2xlYW4gc3RhcnRcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgLy8gQ29weSBzdG9yZWQgc2Vzc2lvbiBpbnRvIC5jbGF1ZGUvXG4gIHRyeSB7XG4gICAgYXdhaXQgY29weURpcmVjdG9yeShzdG9yZVBhdGgsIGAke3JlcG9QYXRofS8uY2xhdWRlYCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBJZiBjb3B5IGZhaWxzLCByZW1vdmUgcGFydGlhbCAuY2xhdWRlLyBhbmQgY29udGludWUgd2l0aCBjbGVhbiBzdGF0ZVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZShgJHtyZXBvUGF0aH0vLmNsYXVkZWAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gSWdub3JlIGNsZWFudXAgZmFpbHVyZVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byByZXN0b3JlIHNlc3Npb24gZm9yICR7cmVwb306ICR7XG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogU2F2ZSB0aGUgY3VycmVudCBgLmNsYXVkZS9gIHNlc3Npb24gc3RhdGUgdG8gdGhlIHBlci1yZXBvIHN0b3JlLlxuICpcbiAqIFJlcGxhY2VzIHRoZSBzdG9yZWQgc2Vzc2lvbiB3aXRoIHRoZSBjdXJyZW50IHN0YXRlLlxuICogQWxzbyBydW5zIGNsZWFudXAgdG8gZW5mb3JjZSBzaXplL2FnZSBsaW1pdHMuXG4gKlxuICogV2hlbiBtaWxlc3RvbmVJZCBpcyBwcm92aWRlZCwgc2F2ZXMgdG8gdGhlIG1pbGVzdG9uZS1zcGVjaWZpYyBzZXNzaW9uIHN0b3JlLlxuICogV2hlbiBub3QgcHJvdmlkZWQsIHNhdmVzIHRvIHRoZSBkZWZhdWx0IGJyYW5jaCBzZXNzaW9uIHN0b3JlLlxuICpcbiAqIEBwYXJhbSByZXBvUGF0aCAtIFBhdGggdG8gdGhlIGNsb25lZCByZXBvc2l0b3J5XG4gKiBAcGFyYW0gd29ya0RpciAtIFRoZSB3b3JrZXIncyBiYXNlIHdvcmtpbmcgZGlyZWN0b3J5XG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gb3B0aW9ucyAtIE9wdGlvbmFsIHNpemUvYWdlIGxpbWl0c1xuICogQHBhcmFtIG1pbGVzdG9uZUlkIC0gT3B0aW9uYWwgbWlsZXN0b25lIElEIChJc3N1ZSAjMTMyMilcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3Mgb3IgZmFpbHVyZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVNlc3Npb24oXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBvcHRpb25zPzogU2Vzc2lvbk1hbmFnZXJPcHRpb25zLFxuICBtaWxlc3RvbmVJZD86IG51bWJlcixcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGNsYXVkZVBhdGggPSBgJHtyZXBvUGF0aH0vLmNsYXVkZWA7XG4gIGNvbnN0IHN0b3JlUGF0aCA9IGdldFdvcmtTdHJlYW1TZXNzaW9uUGF0aCh3b3JrRGlyLCByZXBvLCBtaWxlc3RvbmVJZCk7XG5cbiAgLy8gQ2hlY2sgaWYgLmNsYXVkZS8gZXhpc3RzXG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChjbGF1ZGVQYXRoKTtcbiAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkpIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBObyAuY2xhdWRlLyB0byBzYXZlXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gUmVtb3ZlIG9sZCBzdG9yZWQgc2Vzc2lvblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZShzdG9yZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gRGlkbid0IGV4aXN0XG4gICAgfVxuXG4gICAgLy8gRW5zdXJlIHBhcmVudCBkaXJlY3RvcmllcyBleGlzdFxuICAgIGNvbnN0IHBhcmVudERpciA9IHN0b3JlUGF0aC5zdWJzdHJpbmcoMCwgc3RvcmVQYXRoLmxhc3RJbmRleE9mKFwiL1wiKSk7XG4gICAgYXdhaXQgRGVuby5ta2RpcihwYXJlbnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgLy8gQ29weSAuY2xhdWRlLyB0byBzdG9yZVxuICAgIGF3YWl0IGNvcHlEaXJlY3RvcnkoY2xhdWRlUGF0aCwgc3RvcmVQYXRoKTtcblxuICAgIC8vIEVuZm9yY2Ugc2l6ZS9hZ2UgbGltaXRzXG4gICAgYXdhaXQgY2xlYW51cFNlc3Npb25TdG9yZShzdG9yZVBhdGgsIG9wdGlvbnMpO1xuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBzYXZlIHNlc3Npb24gZm9yICR7cmVwb306ICR7XG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogSW5pdGlhbGlzZSBhIG1pbGVzdG9uZSBzZXNzaW9uIGZyb20gdGhlIGRlZmF1bHQgYnJhbmNoIHNlc3Npb24gKElzc3VlICMxMzIyKS5cbiAqXG4gKiBDb3B5LW9uLWZpcnN0LXVzZTogaWYgdGhlIG1pbGVzdG9uZSBzZXNzaW9uIGRpcmVjdG9yeSBkb2VzIG5vdCB5ZXQgZXhpc3QsXG4gKiBjb3BpZXMgdGhlIGRlZmF1bHQgYnJhbmNoJ3Mgc2Vzc2lvbiB0byBjcmVhdGUgdGhlIG1pbGVzdG9uZSdzIGluaXRpYWxcbiAqIHNlc3Npb24uIElmIHRoZSBtaWxlc3RvbmUgc2Vzc2lvbiBhbHJlYWR5IGV4aXN0cywgZG9lcyBub3RoaW5nIChwcmVzZXJ2aW5nXG4gKiBhbnkgbWlsZXN0b25lLXNwZWNpZmljIGNvbnRleHQgYWNjdW11bGF0ZWQgZHVyaW5nIHByZXZpb3VzIHdvcmspLlxuICpcbiAqIElmIG5vIGRlZmF1bHQgYnJhbmNoIHNlc3Npb24gZXhpc3RzLCBzdWNjZWVkcyB3aXRob3V0IGNyZWF0aW5nIHRoZVxuICogbWlsZXN0b25lIGRpcmVjdG9yeSAoY2xlYW4gc3RhcnQpLlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIHdvcmtlcidzIGJhc2Ugd29ya2luZyBkaXJlY3RvcnlcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBtaWxlc3RvbmVJZCAtIE1pbGVzdG9uZSBJRFxuICogQHJldHVybnMgUmVzdWx0IGluZGljYXRpbmcgc3VjY2VzcyBvciBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbml0aWFsaXNlTWlsZXN0b25lU2Vzc2lvbihcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBudW1iZXIsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCBtaWxlc3RvbmVQYXRoID0gZ2V0V29ya1N0cmVhbVNlc3Npb25QYXRoKHdvcmtEaXIsIHJlcG8sIG1pbGVzdG9uZUlkKTtcbiAgY29uc3QgZGVmYXVsdFBhdGggPSBnZXRXb3JrU3RyZWFtU2Vzc2lvblBhdGgod29ya0RpciwgcmVwbyk7XG5cbiAgLy8gSWYgbWlsZXN0b25lIHNlc3Npb24gYWxyZWFkeSBleGlzdHMsIGRvIG5vdCByZS1jb3B5XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChtaWxlc3RvbmVQYXRoKTtcbiAgICBpZiAoc3RhdC5pc0RpcmVjdG9yeSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE1pbGVzdG9uZSBzZXNzaW9uIGRvZXNuJ3QgZXhpc3QgeWV0IOKAlCBjb250aW51ZSB3aXRoIGNvcHlcbiAgfVxuXG4gIC8vIENoZWNrIGlmIGRlZmF1bHQgc2Vzc2lvbiBleGlzdHNcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGRlZmF1bHRQYXRoKTtcbiAgICBpZiAoIXN0YXQuaXNEaXJlY3RvcnkpIHtcbiAgICAgIC8vIE5vIGRlZmF1bHQgc2Vzc2lvbiDigJQgY2xlYW4gc3RhcnRcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBObyBkZWZhdWx0IHNlc3Npb24g4oCUIGNsZWFuIHN0YXJ0XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIC8vIENvcHkgZGVmYXVsdCBzZXNzaW9uIHRvIG1pbGVzdG9uZSBzZXNzaW9uXG4gIHRyeSB7XG4gICAgYXdhaXQgY29weURpcmVjdG9yeShkZWZhdWx0UGF0aCwgbWlsZXN0b25lUGF0aCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBJZiBjb3B5IGZhaWxzLCBjbGVhbiB1cCBwYXJ0aWFsIG1pbGVzdG9uZSBzZXNzaW9uXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKG1pbGVzdG9uZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gSWdub3JlIGNsZWFudXAgZmFpbHVyZVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBpbml0aWFsaXNlIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBzZXNzaW9uIGZvciAke3JlcG99OiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIE1pZ3JhdGUgb2xkLXN0eWxlIHNlc3Npb24gdG8gdGhlIG5ldyBkZWZhdWx0LyBzdWJkaXJlY3RvcnkgKElzc3VlICMxMzIyKS5cbiAqXG4gKiBQcmUtSXNzdWUgIzEzMjIsIHNlc3Npb25zIHdlcmUgc3RvcmVkIGRpcmVjdGx5IGluIGAke293bmVyfS8ke3JlcG99L2AuXG4gKiBUaGUgbmV3IHN0cnVjdHVyZSB1c2VzIGAke293bmVyfS8ke3JlcG99L2RlZmF1bHQvYCBmb3IgdGhlIGRlZmF1bHQgYnJhbmNoXG4gKiBzZXNzaW9uLiBUaGlzIGZ1bmN0aW9uIGRldGVjdHMgb2xkLXN0eWxlIHNlc3Npb25zIChmaWxlcyBkaXJlY3RseSBpbiB0aGVcbiAqIGJhc2UgcGF0aCB3aXRoIG5vIGBkZWZhdWx0L2Agc3ViZGlyZWN0b3J5KSBhbmQgbWlncmF0ZXMgdGhlbS5cbiAqXG4gKiBAcGFyYW0gd29ya0RpciAtIFRoZSB3b3JrZXIncyBiYXNlIHdvcmtpbmcgZGlyZWN0b3J5XG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1pZ3JhdGVPbGRTdHlsZVNlc3Npb24oXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gZ2V0U2Vzc2lvblN0b3JlUGF0aCh3b3JrRGlyLCByZXBvKTtcbiAgY29uc3QgZGVmYXVsdFBhdGggPSBgJHtiYXNlUGF0aH0vZGVmYXVsdGA7XG5cbiAgLy8gSWYgZGVmYXVsdC8gYWxyZWFkeSBleGlzdHMsIG5vIG1pZ3JhdGlvbiBuZWVkZWRcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGRlZmF1bHRQYXRoKTtcbiAgICBpZiAoc3RhdC5pc0RpcmVjdG9yeSkgcmV0dXJuO1xuICB9IGNhdGNoIHtcbiAgICAvLyBkZWZhdWx0LyBkb2Vzbid0IGV4aXN0IOKAlCBjaGVjayBpZiBvbGQtc3R5bGUgc2Vzc2lvbiBuZWVkcyBtaWdyYXRpb25cbiAgfVxuXG4gIC8vIENoZWNrIGlmIGJhc2UgcGF0aCBleGlzdHMgYW5kIGhhcyBmaWxlcyAob2xkLXN0eWxlIHNlc3Npb24pXG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChiYXNlUGF0aCk7XG4gICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KSByZXR1cm47XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjsgLy8gQmFzZSBkb2Vzbid0IGV4aXN0IGF0IGFsbFxuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIGZpbGVzIGRpcmVjdGx5IGluIGJhc2VQYXRoIChub3QganVzdCBtaWxlc3RvbmUtKiBkaXJzKVxuICBsZXQgaGFzRmlsZXMgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihiYXNlUGF0aCkpIHtcbiAgICAgIGlmIChlbnRyeS5pc0ZpbGUpIHtcbiAgICAgICAgaGFzRmlsZXMgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIC8vIENoZWNrIGZvciBub24tbWlsZXN0b25lIHN1YmRpcnMgKG9sZC1zdHlsZSBuZXN0ZWQgY29udGVudClcbiAgICAgIGlmIChcbiAgICAgICAgZW50cnkuaXNEaXJlY3RvcnkgJiYgZW50cnkubmFtZSAhPT0gXCJkZWZhdWx0XCIgJiZcbiAgICAgICAgIWVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIm1pbGVzdG9uZS1cIilcbiAgICAgICkge1xuICAgICAgICBoYXNGaWxlcyA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCFoYXNGaWxlcykgcmV0dXJuO1xuXG4gIC8vIE1pZ3JhdGU6IGNvcHkgb2xkLXN0eWxlIGNvbnRlbnQgdG8gZGVmYXVsdC8sIHRoZW4gcmVtb3ZlIG9sZCBmaWxlc1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIoZGVmYXVsdFBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKGJhc2VQYXRoKSkge1xuICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09IFwiZGVmYXVsdFwiIHx8IGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChcIm1pbGVzdG9uZS1cIikpIHtcbiAgICAgICAgY29udGludWU7IC8vIFNraXAgd29yayBzdHJlYW0gZGlyZWN0b3JpZXNcbiAgICAgIH1cbiAgICAgIGNvbnN0IHNyY1BhdGggPSBgJHtiYXNlUGF0aH0vJHtlbnRyeS5uYW1lfWA7XG4gICAgICBjb25zdCBkZXN0UGF0aCA9IGAke2RlZmF1bHRQYXRofS8ke2VudHJ5Lm5hbWV9YDtcbiAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSkge1xuICAgICAgICAvLyBGaWx0ZXJlZCBjb3B5LCB0aGVuIGRyb3AgdGhlIG9sZCBjb3B5IGVpdGhlciB3YXkgKElzc3VlICMzNjYzKS5cbiAgICAgICAgaWYgKGlzQWxsb3dlZFNlc3Npb25QYXRoKGVudHJ5Lm5hbWUsIFwiZGlyZWN0b3J5XCIpKSB7XG4gICAgICAgICAgYXdhaXQgY29weURpcmVjdG9yeShzcmNQYXRoLCBkZXN0UGF0aCwgZW50cnkubmFtZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbG9nQmxvY2tlZEVudHJ5KGVudHJ5Lm5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHNyY1BhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgfSBlbHNlIGlmIChlbnRyeS5pc0ZpbGUpIHtcbiAgICAgICAgaWYgKGlzQWxsb3dlZFNlc3Npb25QYXRoKGVudHJ5Lm5hbWUsIFwiZmlsZVwiKSkge1xuICAgICAgICAgIGF3YWl0IERlbm8uY29weUZpbGUoc3JjUGF0aCwgZGVzdFBhdGgpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxvZ0Jsb2NrZWRFbnRyeShlbnRyeS5uYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBEZW5vLnJlbW92ZShzcmNQYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE1pZ3JhdGlvbiBpcyBiZXN0LWVmZm9ydCDigJQgaWYgaXQgZmFpbHMsIHRoZSBvbGQgc2Vzc2lvbiBpcyBzdGlsbCB1c2FibGVcbiAgfVxufVxuXG4vKipcbiAqIENsZWFuIHVwIHNlc3Npb24gZmlsZXMgdGhhdCBleGNlZWQgc2l6ZSBvciBhZ2UgbGltaXRzLlxuICpcbiAqIFJlbW92ZXMgZmlsZXMgb2xkZXIgdGhhbiBtYXhTZXNzaW9uQWdlRGF5cywgdGhlbiBpZiB0aGUgdG90YWwgc2l6ZVxuICogc3RpbGwgZXhjZWVkcyBtYXhTZXNzaW9uU2l6ZUJ5dGVzLCByZW1vdmVzIG9sZGVzdCBmaWxlcyBmaXJzdC5cbiAqXG4gKiBAcGFyYW0gc3RvcmVQYXRoIC0gUGF0aCB0byB0aGUgcGVyLXJlcG8gc2Vzc2lvbiBzdG9yZVxuICogQHBhcmFtIG9wdGlvbnMgLSBTaXplL2FnZSBsaW1pdHNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFudXBTZXNzaW9uU3RvcmUoXG4gIHN0b3JlUGF0aDogc3RyaW5nLFxuICBvcHRpb25zPzogU2Vzc2lvbk1hbmFnZXJPcHRpb25zLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG1heFNpemUgPSBvcHRpb25zPy5tYXhTZXNzaW9uU2l6ZUJ5dGVzID8/XG4gICAgREVGQVVMVF9NQVhfU0VTU0lPTl9TSVpFX0JZVEVTO1xuICBjb25zdCBtYXhBZ2VEYXlzID0gb3B0aW9ucz8ubWF4U2Vzc2lvbkFnZURheXMgPz8gREVGQVVMVF9NQVhfU0VTU0lPTl9BR0VfREFZUztcbiAgY29uc3QgbWF4QWdlTXMgPSBtYXhBZ2VEYXlzICogMjQgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICAvLyBDb2xsZWN0IGFsbCBmaWxlcyB3aXRoIHRoZWlyIHN0YXRzXG4gIGNvbnN0IGZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgc2l6ZTogbnVtYmVyOyBtdGltZTogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgYXdhaXQgY29sbGVjdEZpbGVzKHN0b3JlUGF0aCwgZmlsZXMpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBTdG9yZSBkb2Vzbid0IGV4aXN0IG9yIGNhbid0IGJlIHJlYWRcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZW1vdmUgZmlsZXMgb2xkZXIgdGhhbiBtYXhBZ2VEYXlzXG4gIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgIGlmIChub3cgLSBmaWxlLm10aW1lID4gbWF4QWdlTXMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKGZpbGUucGF0aCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSWdub3JlIGluZGl2aWR1YWwgZmlsZSByZW1vdmFsIGZhaWx1cmVzXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUmUtY29sbGVjdCByZW1haW5pbmcgZmlsZXNcbiAgY29uc3QgcmVtYWluaW5nRmlsZXM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBzaXplOiBudW1iZXI7IG10aW1lOiBudW1iZXIgfT4gPVxuICAgIFtdO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbGxlY3RGaWxlcyhzdG9yZVBhdGgsIHJlbWFpbmluZ0ZpbGVzKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU29ydCBieSBtdGltZSBhc2NlbmRpbmcgKG9sZGVzdCBmaXJzdClcbiAgcmVtYWluaW5nRmlsZXMuc29ydCgoYSwgYikgPT4gYS5tdGltZSAtIGIubXRpbWUpO1xuXG4gIC8vIFJlbW92ZSBvbGRlc3QgZmlsZXMgdW50aWwgdW5kZXIgc2l6ZSBsaW1pdFxuICBsZXQgdG90YWxTaXplID0gcmVtYWluaW5nRmlsZXMucmVkdWNlKChzdW0sIGYpID0+IHN1bSArIGYuc2l6ZSwgMCk7XG4gIGZvciAoY29uc3QgZmlsZSBvZiByZW1haW5pbmdGaWxlcykge1xuICAgIGlmICh0b3RhbFNpemUgPD0gbWF4U2l6ZSkgYnJlYWs7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKGZpbGUucGF0aCk7XG4gICAgICB0b3RhbFNpemUgLT0gZmlsZS5zaXplO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gSWdub3JlIGluZGl2aWR1YWwgZmlsZSByZW1vdmFsIGZhaWx1cmVzXG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogUmVjdXJzaXZlbHkgY29sbGVjdCBhbGwgZmlsZXMgaW4gYSBkaXJlY3Rvcnkgd2l0aCB0aGVpciBzdGF0cy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY29sbGVjdEZpbGVzKFxuICBkaXJQYXRoOiBzdHJpbmcsXG4gIGZpbGVzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgc2l6ZTogbnVtYmVyOyBtdGltZTogbnVtYmVyIH0+LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKGRpclBhdGgpKSB7XG4gICAgY29uc3QgZnVsbFBhdGggPSBgJHtkaXJQYXRofS8ke2VudHJ5Lm5hbWV9YDtcbiAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkpIHtcbiAgICAgIGF3YWl0IGNvbGxlY3RGaWxlcyhmdWxsUGF0aCwgZmlsZXMpO1xuICAgIH0gZWxzZSBpZiAoZW50cnkuaXNGaWxlKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGZ1bGxQYXRoKTtcbiAgICAgICAgZmlsZXMucHVzaCh7XG4gICAgICAgICAgcGF0aDogZnVsbFBhdGgsXG4gICAgICAgICAgc2l6ZTogc3RhdC5zaXplLFxuICAgICAgICAgIG10aW1lOiBzdGF0Lm10aW1lPy5nZXRUaW1lKCkgPz8gRGF0ZS5ub3coKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gU2tpcCBmaWxlcyB3ZSBjYW4ndCBzdGF0XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogUmVwb3J0IGFuIGVudHJ5IHRoZSBhbGxvd2xpc3QgcmVmdXNlZCB0byBjYXJyeSBhY3Jvc3MgYSBydW4gKElzc3VlICMzNjYzKS5cbiAqXG4gKiBCbG9ja2VkIGVudHJpZXMgYXJlIHBvbGljeSwgbm90IGZhdWx0cyDigJQgYnV0IHRoZXkgc3RheSB2aXNpYmxlIHNvIGFcbiAqIG1vZGVsLWF1dGhvcmVkIGBzZXR0aW5ncy5qc29uYCBvciBob29rIHNjcmlwdCBjYW5ub3QgYmUgZHJvcHBlZCBzaWxlbnRseS5cbiAqL1xuZnVuY3Rpb24gbG9nQmxvY2tlZEVudHJ5KHJlbGF0aXZlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGRlZmF1bHRMb2dnZXIuc2VjdXJpdHkoXG4gICAgXCJTRVNTSU9OX0VOVFJZX0JMT0NLRURcIixcbiAgICBgUmVmdXNlZCB0byBwZXJzaXN0IC5jbGF1ZGUvJHtyZWxhdGl2ZVBhdGh9IOKAlCBvdXRzaWRlIHRoZSBzZXNzaW9uIGFsbG93bGlzdGAsXG4gICk7XG59XG5cbi8qKlxuICogUmVjdXJzaXZlbHkgY29weSBhIGRpcmVjdG9yeSwgY2Fycnlpbmcgb25seSBhbGxvd2xpc3RlZCBzZXNzaW9uIHN0YXRlLlxuICpcbiAqIEFwcGxpZWQgdG8gZXZlcnkgbGVnIG9mIHRoZSBjb3B5IChzYXZlLCByZXN0b3JlLCBtaWxlc3RvbmUgc2VlZGluZyBhbmRcbiAqIG1pZ3JhdGlvbiksIHNvIG5laXRoZXIgYSBwb2lzb25lZCB3b3JraW5nIHRyZWUgbm9yIGEgcG9pc29uZWQgc3RvcmUgY2FuXG4gKiByZWludHJvZHVjZSBleGVjdXRhYmxlIG9yIGNvbmZpZ3VyYXRpb24gY29udGVudCAoSXNzdWUgIzM2NjMpLlxuICpcbiAqIEBwYXJhbSBzcmMgLSBTb3VyY2UgZGlyZWN0b3J5XG4gKiBAcGFyYW0gZGVzdCAtIERlc3RpbmF0aW9uIGRpcmVjdG9yeVxuICogQHBhcmFtIHJlbGF0aXZlIC0gUGF0aCBvZiBgc3JjYCByZWxhdGl2ZSB0byB0aGUgYC5jbGF1ZGUvYCByb290XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvcHlEaXJlY3RvcnkoXG4gIHNyYzogc3RyaW5nLFxuICBkZXN0OiBzdHJpbmcsXG4gIHJlbGF0aXZlID0gXCJcIixcbik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBEZW5vLm1rZGlyKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihzcmMpKSB7XG4gICAgY29uc3Qgc3JjUGF0aCA9IGAke3NyY30vJHtlbnRyeS5uYW1lfWA7XG4gICAgY29uc3QgZGVzdFBhdGggPSBgJHtkZXN0fS8ke2VudHJ5Lm5hbWV9YDtcbiAgICBjb25zdCBlbnRyeVJlbGF0aXZlID0gcmVsYXRpdmUgPyBgJHtyZWxhdGl2ZX0vJHtlbnRyeS5uYW1lfWAgOiBlbnRyeS5uYW1lO1xuICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSkge1xuICAgICAgaWYgKCFpc0FsbG93ZWRTZXNzaW9uUGF0aChlbnRyeVJlbGF0aXZlLCBcImRpcmVjdG9yeVwiKSkge1xuICAgICAgICBsb2dCbG9ja2VkRW50cnkoZW50cnlSZWxhdGl2ZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYXdhaXQgY29weURpcmVjdG9yeShzcmNQYXRoLCBkZXN0UGF0aCwgZW50cnlSZWxhdGl2ZSk7XG4gICAgfSBlbHNlIGlmIChlbnRyeS5pc0ZpbGUpIHtcbiAgICAgIGlmICghaXNBbGxvd2VkU2Vzc2lvblBhdGgoZW50cnlSZWxhdGl2ZSwgXCJmaWxlXCIpKSB7XG4gICAgICAgIGxvZ0Jsb2NrZWRFbnRyeShlbnRyeVJlbGF0aXZlKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBEZW5vLmNvcHlGaWxlKHNyY1BhdGgsIGRlc3RQYXRoKTtcbiAgICB9XG4gICAgLy8gU2tpcCBzeW1saW5rcyBhbmQgb3RoZXIgc3BlY2lhbCBlbnRyaWVzIGZvciBzYWZldHlcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7OztDQWlCQyxHQUdELFNBQVMsYUFBYSxRQUFRLGNBQWM7QUFDNUMsU0FBUyxvQkFBb0IsUUFBUSwyQkFBMkI7QUFDaEUsU0FBUyxvQkFBb0IsUUFBUSx1QkFBdUI7QUFDNUQsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBRWpELDJFQUEyRSxHQUMzRSxNQUFNLGlDQUFpQyxLQUFLLE9BQU87QUFFbkQsMERBQTBELEdBQzFELE1BQU0sK0JBQStCO0FBVXJDOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsb0JBQW9CLE9BQWUsRUFBRSxJQUFZO0VBQy9ELDRFQUE0RTtFQUM1RSwyRUFBMkU7RUFDM0UsMEVBQTBFO0VBQzFFLDRFQUE0RTtFQUM1RSxnREFBZ0Q7RUFDaEQsTUFBTSxPQUFPLHFCQUFxQixZQUFZO0VBQzlDLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQztFQUN6QixJQUFJLE1BQU0sTUFBTSxLQUFLLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRTtJQUNoRCwrQ0FBK0M7SUFDL0MsT0FBTyxHQUFHLEtBQUssa0JBQWtCLEVBQUUsS0FBSyxPQUFPLENBQUMsbUJBQW1CLE1BQU07RUFDM0U7RUFDQSxPQUFPLEdBQUcsS0FBSyxrQkFBa0IsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxFQUFFO0FBQzNEO0FBRUE7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLE9BQWUsRUFDZixJQUFZLEVBQ1osV0FBb0I7RUFFcEIsTUFBTSxPQUFPLG9CQUFvQixTQUFTO0VBQzFDLElBQUksZ0JBQWdCLFdBQVc7SUFDN0IsT0FBTyxHQUFHLEtBQUssV0FBVyxFQUFFLGFBQWE7RUFDM0M7RUFDQSxPQUFPLEdBQUcsS0FBSyxRQUFRLENBQUM7QUFDMUI7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUNELE9BQU8sZUFBZSxlQUNwQixRQUFnQixFQUNoQixPQUFlLEVBQ2YsSUFBWSxFQUNaLFdBQW9CO0VBRXBCLE1BQU0sV0FBVyxNQUFNLGtCQUNyQixVQUNBLFNBQ0EsTUFDQTtFQUVGLE1BQU0sVUFBVSxNQUFNLDBCQUEwQjtFQUNoRCxPQUFPLFNBQVMsRUFBRSxHQUFHLFVBQVU7QUFDakM7QUFFQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELGVBQWUsMEJBQ2IsUUFBZ0I7RUFFaEIsTUFBTSxTQUFTLE1BQU0sY0FDbkI7SUFBQztJQUFXO0lBQU07SUFBZTtJQUFRO0lBQU07R0FBVSxFQUN6RDtJQUFFLEtBQUs7RUFBUztFQUVsQixJQUFJLENBQUMsT0FBTyxFQUFFLElBQUksT0FBTyxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDekMsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEM7RUFDQSxJQUFJLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE9BQU8sSUFBSSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87RUFBVTtFQUUzRSxNQUFNLFdBQVcsTUFBTSxjQUNyQjtJQUFDO0lBQVk7SUFBUTtJQUFNO0dBQVUsRUFDckM7SUFBRSxLQUFLO0VBQVM7RUFFbEIsSUFBSSxTQUFTLEVBQUUsSUFBSSxTQUFTLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUM1QyxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBVTtFQUN0QztFQUNBLE1BQU0sU0FBUyxTQUFTLEVBQUUsR0FDdEIsU0FBUyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLEtBQUssRUFBRSxTQUFTLEtBQUssQ0FBQyxJQUFJLEVBQUUsR0FDN0QsU0FBUyxLQUFLLENBQUMsT0FBTztFQUMxQixPQUFPO0lBQ0wsSUFBSTtJQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsZ0RBQWdELEVBQUUsU0FBUyxDQUFDLENBQUMsR0FDNUQsQ0FBQyxlQUFlLEVBQUUsUUFBUTtFQUVoQztBQUNGO0FBRUEsd0VBQXdFLEdBQ3hFLGVBQWUsa0JBQ2IsUUFBZ0IsRUFDaEIsT0FBZSxFQUNmLElBQVksRUFDWixXQUFvQjtFQUVwQixxREFBcUQ7RUFDckQsSUFBSSxnQkFBZ0IsV0FBVztJQUM3QixNQUFNLHVCQUF1QixTQUFTO0VBQ3hDO0VBRUEsTUFBTSxZQUFZLHlCQUF5QixTQUFTLE1BQU07RUFFMUQsOERBQThEO0VBQzlELElBQUk7SUFDRixNQUFNLEtBQUssTUFBTSxDQUFDLEdBQUcsU0FBUyxRQUFRLENBQUMsRUFBRTtNQUFFLFdBQVc7SUFBSztFQUM3RCxFQUFFLE9BQU07RUFDTixpQ0FBaUM7RUFDbkM7RUFFQSxvQ0FBb0M7RUFDcEMsSUFBSTtJQUNGLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO0lBQzdCLElBQUksQ0FBQyxLQUFLLFdBQVcsRUFBRTtNQUNyQixPQUFPO1FBQUUsSUFBSTtRQUFNLE9BQU87TUFBVTtJQUN0QztFQUNGLEVBQUUsT0FBTTtJQUNOLGtDQUFrQztJQUNsQyxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBVTtFQUN0QztFQUVBLG9DQUFvQztFQUNwQyxJQUFJO0lBQ0YsTUFBTSxjQUFjLFdBQVcsR0FBRyxTQUFTLFFBQVEsQ0FBQztJQUNwRCxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBVTtFQUN0QyxFQUFFLE9BQU8sT0FBTztJQUNkLHVFQUF1RTtJQUN2RSxJQUFJO01BQ0YsTUFBTSxLQUFLLE1BQU0sQ0FBQyxHQUFHLFNBQVMsUUFBUSxDQUFDLEVBQUU7UUFBRSxXQUFXO01BQUs7SUFDN0QsRUFBRSxPQUFNO0lBQ04seUJBQXlCO0lBQzNCO0lBQ0EsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLDhCQUE4QixFQUFFLEtBQUssRUFBRSxFQUN0QyxpQkFBaUIsUUFBUSxNQUFNLE9BQU8sR0FBRyxPQUFPLFFBQ2hEO0lBRU47RUFDRjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsT0FBTyxlQUFlLFlBQ3BCLFFBQWdCLEVBQ2hCLE9BQWUsRUFDZixJQUFZLEVBQ1osT0FBK0IsRUFDL0IsV0FBb0I7RUFFcEIsTUFBTSxhQUFhLEdBQUcsU0FBUyxRQUFRLENBQUM7RUFDeEMsTUFBTSxZQUFZLHlCQUF5QixTQUFTLE1BQU07RUFFMUQsMkJBQTJCO0VBQzNCLElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztJQUM3QixJQUFJLENBQUMsS0FBSyxXQUFXLEVBQUU7TUFDckIsT0FBTztRQUFFLElBQUk7UUFBTSxPQUFPO01BQVU7SUFDdEM7RUFDRixFQUFFLE9BQU07SUFDTixzQkFBc0I7SUFDdEIsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEM7RUFFQSxJQUFJO0lBQ0YsNEJBQTRCO0lBQzVCLElBQUk7TUFDRixNQUFNLEtBQUssTUFBTSxDQUFDLFdBQVc7UUFBRSxXQUFXO01BQUs7SUFDakQsRUFBRSxPQUFNO0lBQ04sZUFBZTtJQUNqQjtJQUVBLGtDQUFrQztJQUNsQyxNQUFNLFlBQVksVUFBVSxTQUFTLENBQUMsR0FBRyxVQUFVLFdBQVcsQ0FBQztJQUMvRCxNQUFNLEtBQUssS0FBSyxDQUFDLFdBQVc7TUFBRSxXQUFXO0lBQUs7SUFFOUMseUJBQXlCO0lBQ3pCLE1BQU0sY0FBYyxZQUFZO0lBRWhDLDBCQUEwQjtJQUMxQixNQUFNLG9CQUFvQixXQUFXO0lBRXJDLE9BQU87TUFBRSxJQUFJO01BQU0sT0FBTztJQUFVO0VBQ3RDLEVBQUUsT0FBTyxPQUFPO0lBQ2QsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLDJCQUEyQixFQUFFLEtBQUssRUFBRSxFQUNuQyxpQkFBaUIsUUFBUSxNQUFNLE9BQU8sR0FBRyxPQUFPLFFBQ2hEO0lBRU47RUFDRjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsT0FBTyxlQUFlLDJCQUNwQixPQUFlLEVBQ2YsSUFBWSxFQUNaLFdBQW1CO0VBRW5CLE1BQU0sZ0JBQWdCLHlCQUF5QixTQUFTLE1BQU07RUFDOUQsTUFBTSxjQUFjLHlCQUF5QixTQUFTO0VBRXRELHNEQUFzRDtFQUN0RCxJQUFJO0lBQ0YsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLENBQUM7SUFDN0IsSUFBSSxLQUFLLFdBQVcsRUFBRTtNQUNwQixPQUFPO1FBQUUsSUFBSTtRQUFNLE9BQU87TUFBVTtJQUN0QztFQUNGLEVBQUUsT0FBTTtFQUNOLDJEQUEyRDtFQUM3RDtFQUVBLGtDQUFrQztFQUNsQyxJQUFJO0lBQ0YsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLENBQUM7SUFDN0IsSUFBSSxDQUFDLEtBQUssV0FBVyxFQUFFO01BQ3JCLG1DQUFtQztNQUNuQyxPQUFPO1FBQUUsSUFBSTtRQUFNLE9BQU87TUFBVTtJQUN0QztFQUNGLEVBQUUsT0FBTTtJQUNOLG1DQUFtQztJQUNuQyxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBVTtFQUN0QztFQUVBLDRDQUE0QztFQUM1QyxJQUFJO0lBQ0YsTUFBTSxjQUFjLGFBQWE7SUFDakMsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQVU7RUFDdEMsRUFBRSxPQUFPLE9BQU87SUFDZCxvREFBb0Q7SUFDcEQsSUFBSTtNQUNGLE1BQU0sS0FBSyxNQUFNLENBQUMsZUFBZTtRQUFFLFdBQVc7TUFBSztJQUNyRCxFQUFFLE9BQU07SUFDTix5QkFBeUI7SUFDM0I7SUFDQSxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsK0JBQStCLEVBQUUsWUFBWSxhQUFhLEVBQUUsS0FBSyxFQUFFLEVBQ2xFLGlCQUFpQixRQUFRLE1BQU0sT0FBTyxHQUFHLE9BQU8sUUFDaEQ7SUFFTjtFQUNGO0FBQ0Y7QUFFQTs7Ozs7Ozs7OztDQVVDLEdBQ0QsZUFBZSx1QkFDYixPQUFlLEVBQ2YsSUFBWTtFQUVaLE1BQU0sV0FBVyxvQkFBb0IsU0FBUztFQUM5QyxNQUFNLGNBQWMsR0FBRyxTQUFTLFFBQVEsQ0FBQztFQUV6QyxrREFBa0Q7RUFDbEQsSUFBSTtJQUNGLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO0lBQzdCLElBQUksS0FBSyxXQUFXLEVBQUU7RUFDeEIsRUFBRSxPQUFNO0VBQ04sc0VBQXNFO0VBQ3hFO0VBRUEsOERBQThEO0VBQzlELElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztJQUM3QixJQUFJLENBQUMsS0FBSyxXQUFXLEVBQUU7RUFDekIsRUFBRSxPQUFNO0lBQ04sUUFBUSw0QkFBNEI7RUFDdEM7RUFFQSxtRUFBbUU7RUFDbkUsSUFBSSxXQUFXO0VBQ2YsSUFBSTtJQUNGLFdBQVcsTUFBTSxTQUFTLEtBQUssT0FBTyxDQUFDLFVBQVc7TUFDaEQsSUFBSSxNQUFNLE1BQU0sRUFBRTtRQUNoQixXQUFXO1FBQ1g7TUFDRjtNQUNBLDZEQUE2RDtNQUM3RCxJQUNFLE1BQU0sV0FBVyxJQUFJLE1BQU0sSUFBSSxLQUFLLGFBQ3BDLENBQUMsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLGVBQ3ZCO1FBQ0EsV0FBVztRQUNYO01BQ0Y7SUFDRjtFQUNGLEVBQUUsT0FBTTtJQUNOO0VBQ0Y7RUFFQSxJQUFJLENBQUMsVUFBVTtFQUVmLHFFQUFxRTtFQUNyRSxJQUFJO0lBQ0YsTUFBTSxLQUFLLEtBQUssQ0FBQyxhQUFhO01BQUUsV0FBVztJQUFLO0lBQ2hELFdBQVcsTUFBTSxTQUFTLEtBQUssT0FBTyxDQUFDLFVBQVc7TUFDaEQsSUFBSSxNQUFNLElBQUksS0FBSyxhQUFhLE1BQU0sSUFBSSxDQUFDLFVBQVUsQ0FBQyxlQUFlO1FBQ25FLFVBQVUsK0JBQStCO01BQzNDO01BQ0EsTUFBTSxVQUFVLEdBQUcsU0FBUyxDQUFDLEVBQUUsTUFBTSxJQUFJLEVBQUU7TUFDM0MsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLEVBQUUsTUFBTSxJQUFJLEVBQUU7TUFDL0MsSUFBSSxNQUFNLFdBQVcsRUFBRTtRQUNyQixrRUFBa0U7UUFDbEUsSUFBSSxxQkFBcUIsTUFBTSxJQUFJLEVBQUUsY0FBYztVQUNqRCxNQUFNLGNBQWMsU0FBUyxVQUFVLE1BQU0sSUFBSTtRQUNuRCxPQUFPO1VBQ0wsZ0JBQWdCLE1BQU0sSUFBSTtRQUM1QjtRQUNBLE1BQU0sS0FBSyxNQUFNLENBQUMsU0FBUztVQUFFLFdBQVc7UUFBSztNQUMvQyxPQUFPLElBQUksTUFBTSxNQUFNLEVBQUU7UUFDdkIsSUFBSSxxQkFBcUIsTUFBTSxJQUFJLEVBQUUsU0FBUztVQUM1QyxNQUFNLEtBQUssUUFBUSxDQUFDLFNBQVM7UUFDL0IsT0FBTztVQUNMLGdCQUFnQixNQUFNLElBQUk7UUFDNUI7UUFDQSxNQUFNLEtBQUssTUFBTSxDQUFDO01BQ3BCO0lBQ0Y7RUFDRixFQUFFLE9BQU07RUFDTiwwRUFBMEU7RUFDNUU7QUFDRjtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxlQUFlLG9CQUNwQixTQUFpQixFQUNqQixPQUErQjtFQUUvQixNQUFNLFVBQVUsU0FBUyx1QkFDdkI7RUFDRixNQUFNLGFBQWEsU0FBUyxxQkFBcUI7RUFDakQsTUFBTSxXQUFXLGFBQWEsS0FBSyxLQUFLLEtBQUs7RUFDN0MsTUFBTSxNQUFNLEtBQUssR0FBRztFQUVwQixxQ0FBcUM7RUFDckMsTUFBTSxRQUE4RCxFQUFFO0VBQ3RFLElBQUk7SUFDRixNQUFNLGFBQWEsV0FBVztFQUNoQyxFQUFFLE9BQU07SUFDTix1Q0FBdUM7SUFDdkM7RUFDRjtFQUVBLHFDQUFxQztFQUNyQyxLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLElBQUksTUFBTSxLQUFLLEtBQUssR0FBRyxVQUFVO01BQy9CLElBQUk7UUFDRixNQUFNLEtBQUssTUFBTSxDQUFDLEtBQUssSUFBSTtNQUM3QixFQUFFLE9BQU07TUFDTiwwQ0FBMEM7TUFDNUM7SUFDRjtFQUNGO0VBRUEsNkJBQTZCO0VBQzdCLE1BQU0saUJBQ0osRUFBRTtFQUNKLElBQUk7SUFDRixNQUFNLGFBQWEsV0FBVztFQUNoQyxFQUFFLE9BQU07SUFDTjtFQUNGO0VBRUEseUNBQXlDO0VBQ3pDLGVBQWUsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFNLEVBQUUsS0FBSyxHQUFHLEVBQUUsS0FBSztFQUUvQyw2Q0FBNkM7RUFDN0MsSUFBSSxZQUFZLGVBQWUsTUFBTSxDQUFDLENBQUMsS0FBSyxJQUFNLE1BQU0sRUFBRSxJQUFJLEVBQUU7RUFDaEUsS0FBSyxNQUFNLFFBQVEsZUFBZ0I7SUFDakMsSUFBSSxhQUFhLFNBQVM7SUFDMUIsSUFBSTtNQUNGLE1BQU0sS0FBSyxNQUFNLENBQUMsS0FBSyxJQUFJO01BQzNCLGFBQWEsS0FBSyxJQUFJO0lBQ3hCLEVBQUUsT0FBTTtJQUNOLDBDQUEwQztJQUM1QztFQUNGO0FBQ0Y7QUFFQTs7Q0FFQyxHQUNELGVBQWUsYUFDYixPQUFlLEVBQ2YsS0FBMkQ7RUFFM0QsV0FBVyxNQUFNLFNBQVMsS0FBSyxPQUFPLENBQUMsU0FBVTtJQUMvQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUMsRUFBRSxNQUFNLElBQUksRUFBRTtJQUMzQyxJQUFJLE1BQU0sV0FBVyxFQUFFO01BQ3JCLE1BQU0sYUFBYSxVQUFVO0lBQy9CLE9BQU8sSUFBSSxNQUFNLE1BQU0sRUFBRTtNQUN2QixJQUFJO1FBQ0YsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLENBQUM7UUFDN0IsTUFBTSxJQUFJLENBQUM7VUFDVCxNQUFNO1VBQ04sTUFBTSxLQUFLLElBQUk7VUFDZixPQUFPLEtBQUssS0FBSyxFQUFFLGFBQWEsS0FBSyxHQUFHO1FBQzFDO01BQ0YsRUFBRSxPQUFNO01BQ04sMkJBQTJCO01BQzdCO0lBQ0Y7RUFDRjtBQUNGO0FBRUE7Ozs7O0NBS0MsR0FDRCxTQUFTLGdCQUFnQixZQUFvQjtFQUMzQyxjQUFjLFFBQVEsQ0FDcEIseUJBQ0EsQ0FBQywyQkFBMkIsRUFBRSxhQUFhLGdDQUFnQyxDQUFDO0FBRWhGO0FBRUE7Ozs7Ozs7Ozs7Q0FVQyxHQUNELGVBQWUsY0FDYixHQUFXLEVBQ1gsSUFBWSxFQUNaLFdBQVcsRUFBRTtFQUViLE1BQU0sS0FBSyxLQUFLLENBQUMsTUFBTTtJQUFFLFdBQVc7RUFBSztFQUN6QyxXQUFXLE1BQU0sU0FBUyxLQUFLLE9BQU8sQ0FBQyxLQUFNO0lBQzNDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxFQUFFLE1BQU0sSUFBSSxFQUFFO0lBQ3RDLE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxFQUFFLE1BQU0sSUFBSSxFQUFFO0lBQ3hDLE1BQU0sZ0JBQWdCLFdBQVcsR0FBRyxTQUFTLENBQUMsRUFBRSxNQUFNLElBQUksRUFBRSxHQUFHLE1BQU0sSUFBSTtJQUN6RSxJQUFJLE1BQU0sV0FBVyxFQUFFO01BQ3JCLElBQUksQ0FBQyxxQkFBcUIsZUFBZSxjQUFjO1FBQ3JELGdCQUFnQjtRQUNoQjtNQUNGO01BQ0EsTUFBTSxjQUFjLFNBQVMsVUFBVTtJQUN6QyxPQUFPLElBQUksTUFBTSxNQUFNLEVBQUU7TUFDdkIsSUFBSSxDQUFDLHFCQUFxQixlQUFlLFNBQVM7UUFDaEQsZ0JBQWdCO1FBQ2hCO01BQ0Y7TUFDQSxNQUFNLEtBQUssUUFBUSxDQUFDLFNBQVM7SUFDL0I7RUFDQSxxREFBcUQ7RUFDdkQ7QUFDRiJ9
// denoCacheMetadata=541596817989612218,16403987359167321112