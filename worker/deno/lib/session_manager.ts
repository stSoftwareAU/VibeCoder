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
 */

import type { Result } from "../types.ts";
import { defaultLogger } from "./logger.ts";
import { isAllowedSessionPath } from "./session_file_policy.ts";

/** Maximum total size in bytes for a single repo's session store (50 MB). */
const DEFAULT_MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024;

/** Maximum age in days for session files before cleanup. */
const DEFAULT_MAX_SESSION_AGE_DAYS = 7;

/** Options for session management operations. */
export interface SessionManagerOptions {
  /** Maximum total size in bytes for a repo's session store. */
  maxSessionSizeBytes?: number;
  /** Maximum age in days for session files. */
  maxSessionAgeDays?: number;
}

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
 */
export function getSessionStorePath(workDir: string, repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Fallback: use the full repo string sanitised
    return `${workDir}/.claude-sessions/${
      repo.replace(/[^a-zA-Z0-9_-]/g, "_")
    }`;
  }
  return `${workDir}/.claude-sessions/${parts[0]}/${parts[1]}`;
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
 */
export function getWorkStreamSessionPath(
  workDir: string,
  repo: string,
  milestoneId?: number,
): string {
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
 * If no stored session exists, ensures `.claude/` is absent (clean start).
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
 */
export async function restoreSession(
  repoPath: string,
  workDir: string,
  repo: string,
  milestoneId?: number,
): Promise<Result<void>> {
  // Migrate old-style sessions if needed (Issue #1322)
  if (milestoneId === undefined) {
    await migrateOldStyleSession(workDir, repo);
  }

  const storePath = getWorkStreamSessionPath(workDir, repo, milestoneId);

  // Always remove existing .claude/ first to ensure clean state
  try {
    await Deno.remove(`${repoPath}/.claude`, { recursive: true });
  } catch {
    // Directory doesn't exist — fine
  }

  // Check if we have a stored session
  try {
    const stat = await Deno.stat(storePath);
    if (!stat.isDirectory) {
      return { ok: true, value: undefined };
    }
  } catch {
    // No stored session — clean start
    return { ok: true, value: undefined };
  }

  // Copy stored session into .claude/
  try {
    await copyDirectory(storePath, `${repoPath}/.claude`);
    return { ok: true, value: undefined };
  } catch (error) {
    // If copy fails, remove partial .claude/ and continue with clean state
    try {
      await Deno.remove(`${repoPath}/.claude`, { recursive: true });
    } catch {
      // Ignore cleanup failure
    }
    return {
      ok: false,
      error: new Error(
        `Failed to restore session for ${repo}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
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
 */
export async function saveSession(
  repoPath: string,
  workDir: string,
  repo: string,
  options?: SessionManagerOptions,
  milestoneId?: number,
): Promise<Result<void>> {
  const claudePath = `${repoPath}/.claude`;
  const storePath = getWorkStreamSessionPath(workDir, repo, milestoneId);

  // Check if .claude/ exists
  try {
    const stat = await Deno.stat(claudePath);
    if (!stat.isDirectory) {
      return { ok: true, value: undefined };
    }
  } catch {
    // No .claude/ to save
    return { ok: true, value: undefined };
  }

  try {
    // Remove old stored session
    try {
      await Deno.remove(storePath, { recursive: true });
    } catch {
      // Didn't exist
    }

    // Ensure parent directories exist
    const parentDir = storePath.substring(0, storePath.lastIndexOf("/"));
    await Deno.mkdir(parentDir, { recursive: true });

    // Copy .claude/ to store
    await copyDirectory(claudePath, storePath);

    // Enforce size/age limits
    await cleanupSessionStore(storePath, options);

    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `Failed to save session for ${repo}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
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
 */
export async function initialiseMilestoneSession(
  workDir: string,
  repo: string,
  milestoneId: number,
): Promise<Result<void>> {
  const milestonePath = getWorkStreamSessionPath(workDir, repo, milestoneId);
  const defaultPath = getWorkStreamSessionPath(workDir, repo);

  // If milestone session already exists, do not re-copy
  try {
    const stat = await Deno.stat(milestonePath);
    if (stat.isDirectory) {
      return { ok: true, value: undefined };
    }
  } catch {
    // Milestone session doesn't exist yet — continue with copy
  }

  // Check if default session exists
  try {
    const stat = await Deno.stat(defaultPath);
    if (!stat.isDirectory) {
      // No default session — clean start
      return { ok: true, value: undefined };
    }
  } catch {
    // No default session — clean start
    return { ok: true, value: undefined };
  }

  // Copy default session to milestone session
  try {
    await copyDirectory(defaultPath, milestonePath);
    return { ok: true, value: undefined };
  } catch (error) {
    // If copy fails, clean up partial milestone session
    try {
      await Deno.remove(milestonePath, { recursive: true });
    } catch {
      // Ignore cleanup failure
    }
    return {
      ok: false,
      error: new Error(
        `Failed to initialise milestone ${milestoneId} session for ${repo}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
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
 */
async function migrateOldStyleSession(
  workDir: string,
  repo: string,
): Promise<void> {
  const basePath = getSessionStorePath(workDir, repo);
  const defaultPath = `${basePath}/default`;

  // If default/ already exists, no migration needed
  try {
    const stat = await Deno.stat(defaultPath);
    if (stat.isDirectory) return;
  } catch {
    // default/ doesn't exist — check if old-style session needs migration
  }

  // Check if base path exists and has files (old-style session)
  try {
    const stat = await Deno.stat(basePath);
    if (!stat.isDirectory) return;
  } catch {
    return; // Base doesn't exist at all
  }

  // Check for files directly in basePath (not just milestone-* dirs)
  let hasFiles = false;
  try {
    for await (const entry of Deno.readDir(basePath)) {
      if (entry.isFile) {
        hasFiles = true;
        break;
      }
      // Check for non-milestone subdirs (old-style nested content)
      if (
        entry.isDirectory && entry.name !== "default" &&
        !entry.name.startsWith("milestone-")
      ) {
        hasFiles = true;
        break;
      }
    }
  } catch {
    return;
  }

  if (!hasFiles) return;

  // Migrate: copy old-style content to default/, then remove old files
  try {
    await Deno.mkdir(defaultPath, { recursive: true });
    for await (const entry of Deno.readDir(basePath)) {
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
        await Deno.remove(srcPath, { recursive: true });
      } else if (entry.isFile) {
        if (isAllowedSessionPath(entry.name, "file")) {
          await Deno.copyFile(srcPath, destPath);
        } else {
          logBlockedEntry(entry.name);
        }
        await Deno.remove(srcPath);
      }
    }
  } catch {
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
 */
export async function cleanupSessionStore(
  storePath: string,
  options?: SessionManagerOptions,
): Promise<void> {
  const maxSize = options?.maxSessionSizeBytes ??
    DEFAULT_MAX_SESSION_SIZE_BYTES;
  const maxAgeDays = options?.maxSessionAgeDays ?? DEFAULT_MAX_SESSION_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Collect all files with their stats
  const files: Array<{ path: string; size: number; mtime: number }> = [];
  try {
    await collectFiles(storePath, files);
  } catch {
    // Store doesn't exist or can't be read
    return;
  }

  // Remove files older than maxAgeDays
  for (const file of files) {
    if (now - file.mtime > maxAgeMs) {
      try {
        await Deno.remove(file.path);
      } catch {
        // Ignore individual file removal failures
      }
    }
  }

  // Re-collect remaining files
  const remainingFiles: Array<{ path: string; size: number; mtime: number }> =
    [];
  try {
    await collectFiles(storePath, remainingFiles);
  } catch {
    return;
  }

  // Sort by mtime ascending (oldest first)
  remainingFiles.sort((a, b) => a.mtime - b.mtime);

  // Remove oldest files until under size limit
  let totalSize = remainingFiles.reduce((sum, f) => sum + f.size, 0);
  for (const file of remainingFiles) {
    if (totalSize <= maxSize) break;
    try {
      await Deno.remove(file.path);
      totalSize -= file.size;
    } catch {
      // Ignore individual file removal failures
    }
  }
}

/**
 * Recursively collect all files in a directory with their stats.
 */
async function collectFiles(
  dirPath: string,
  files: Array<{ path: string; size: number; mtime: number }>,
): Promise<void> {
  for await (const entry of Deno.readDir(dirPath)) {
    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFiles(fullPath, files);
    } else if (entry.isFile) {
      try {
        const stat = await Deno.stat(fullPath);
        files.push({
          path: fullPath,
          size: stat.size,
          mtime: stat.mtime?.getTime() ?? Date.now(),
        });
      } catch {
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
 */
function logBlockedEntry(relativePath: string): void {
  defaultLogger.security(
    "SESSION_ENTRY_BLOCKED",
    `Refused to persist .claude/${relativePath} — outside the session allowlist`,
  );
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
 */
async function copyDirectory(
  src: string,
  dest: string,
  relative = "",
): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
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
