/**
 * Stale repository work directory detection and cleanup (Issue #1493).
 *
 * Scans repository clones under `workDir` and classifies each as active,
 * stale, or partial. Stale or partial directories are removed so the next
 * run can re-clone cleanly, avoiding wasted disk without the heavy-handed
 * full-nuke triggered only at 90% disk pressure by `disk_space.ts`.
 *
 * Classification rules per entry `${workDir}/${name}`:
 *   - Skipped          — dot-prefixed (e.g. `.claude-sessions`, heartbeat
 *                        files, marker state) or non-directory entries.
 *   - **Partial**      — directory exists but `.git` is missing — remove so
 *                        the next clone re-initialises cleanly.
 *   - **Active**       — a heartbeat file `.heartbeat_*_{name}_{issue}`
 *                        has a timestamp newer than `now - maxAge`,
 *                        OR the directory mtime is newer than `now - maxAge`.
 *   - **Stale**        — no recent heartbeat and mtime is older than
 *                        `now - maxAge` — remove.
 *
 * Every removal logs a single `SELF-HEALING:` line so the shell wrapper
 * and operators can audit the cleanup.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { checkCloneOwnership } from "./broken_clone.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isProtectedBranch } from "./git_branch.ts";
import { runGitCommand } from "./git_timeout.ts";
import { LANE_WORKTREE_ROOT } from "./lane_worktree.ts";
/** Default age threshold in days before a repo clone with no heartbeat is stale. */ export const DEFAULT_STALE_WORKDIR_DAYS = 7;
/**
 * Subdirectory names that are *not* repository clones and must be left
 * alone by the scanner. Without this list the scanner classifies them
 * as "partial" (no `.git`) and deletes them every cycle, only for the
 * owning subsystem to recreate them on the next call.
 *
 * - `logs` — `self_heal_events.ts` writes `${workDir}/logs/self-heal.jsonl`.
 * - `lost+found` — the vibe-work named volume (#4203) is a real ext4
 *   filesystem whose root always carries this root-owned directory; the
 *   worker (uid 1000) cannot remove it, and trying produced a
 *   Permission-denied SELF-HEALING warning every cycle (Issue #4212).
 * - `audit` — `audit_journal.ts` writes the hash-chained mutation journals
 *   to `${WORK_DIR}/audit/`. It has no `.git` and sits untouched between
 *   sweeps, so every housekeeping path treated it as a disposable clone and
 *   deleted the worker's own tamper-evident record — `audit-chain-verify`
 *   then reported `AUDIT_CHAIN_BROKEN` on every swept host (Issue #337).
 * - `worktrees` — `lane_worktree.ts` puts each lane's linked worktree under
 *   `${WORK_DIR}/worktrees/<lane>/<repo>` so lanes stop sharing one clone's
 *   `HEAD`, index and working tree (Issue #394). The directory itself holds
 *   no clone, and removing a live worktree's checkout under the lane using
 *   it is the very collision it exists to prevent.
 */ export const RESERVED_WORKDIR_NAMES = new Set([
  "logs",
  "lost+found",
  "audit",
  LANE_WORKTREE_ROOT
]);
/**
 * Work-root **file** names that belong to a reserved subsystem rather than
 * to a clone: the audit trail's roster and its last-known-non-empty marker,
 * kept beside (not inside) `audit/` precisely so removing the directory
 * cannot remove the expectation (Issues #3949, #270).
 */ const RESERVED_WORKDIR_FILES = new Set([
  "audit.roster.jsonl",
  "audit.roster.seen"
]);
/**
 * Prefix of the sidecars a torn-roster repair preserves (Issue #1202).
 *
 * `audit.roster.jsonl.torn-<n>` holds the bytes a repair moved aside rather
 * than deleted. Letting housekeeping remove them would delete the only copy
 * of the evidence the repair promised to keep.
 */ const RESERVED_ROSTER_TORN_PREFIX = "audit.roster.jsonl.torn-";
/**
 * Is this work-root entry owned by a subsystem and off-limits to every
 * cleanup sweep? Covers {@link RESERVED_WORKDIR_NAMES} and the audit
 * trail's sibling files, so a sweep that walks files as well as directories
 * (`nukeWorkDir`) cannot half-erase the trail (Issue #337).
 *
 * @param name - Entry name directly under the work root
 * @returns True when the entry must be left alone
 */ export function isReservedWorkRootEntry(name) {
  return RESERVED_WORKDIR_NAMES.has(name) || RESERVED_WORKDIR_FILES.has(name) || name.startsWith(RESERVED_ROSTER_TORN_PREFIX);
}
/**
 * Classify a single repository work directory.
 *
 * Inspects heartbeat files in `workDir`, the presence of `.git`, and
 * the directory mtime to decide the correct disposition.
 */ export async function classifyWorkDir(workDir, repoDir, maxAgeSeconds, now) {
  const repoName = basename(repoDir);
  // 1. Live heartbeat pinned to this repo keeps it alive regardless of mtime.
  const heartbeatHit = await findRecentHeartbeat(workDir, repoName, maxAgeSeconds, now);
  if (heartbeatHit !== null) {
    return {
      kind: "active",
      reason: `heartbeat ${heartbeatHit.filename} within window`
    };
  }
  // 2. Missing `.git` — the clone is partial/broken.
  const hasGit = await pathExists(`${repoDir}/.git`);
  if (!hasGit) {
    return {
      kind: "partial",
      reason: ".git missing or inaccessible"
    };
  }
  // 3. Mtime-based freshness check.
  try {
    const stat = await Deno.stat(repoDir);
    const mtime = stat.mtime;
    if (mtime !== null) {
      const ageSeconds = now - Math.floor(mtime.getTime() / 1000);
      if (ageSeconds <= maxAgeSeconds) {
        const days = (ageSeconds / 86400).toFixed(1);
        return {
          kind: "active",
          reason: `modified ${days} days ago`
        };
      }
      const days = (ageSeconds / 86400).toFixed(1);
      return {
        kind: "stale",
        reason: `modified ${days} days ago, exceeds threshold`
      };
    }
  } catch (err) {
    // Fall through — unreadable stat is treated as stale below.
    recordFaultEvent("catch_block_warning", `stale_workdir stat failed for ${repoDir}: ${err}`);
  }
  return {
    kind: "stale",
    reason: "no mtime available"
  };
}
/**
 * Scan `workDir` and remove stale or partial repository clones.
 *
 * Returns a summary describing which entries were scanned, preserved,
 * or removed. Errors reading `workDir` or removing a specific entry are
 * collected into `errors` — they never throw out of this function so
 * callers can rely on it during startup.
 */ export async function scanAndCleanupStaleWorkDirs(options) {
  const workDir = options.workDir;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_STALE_WORKDIR_DAYS;
  const maxAgeSeconds = Math.max(0, maxAgeDays) * 86400;
  const nowFn = options.nowFn ?? (()=>Math.floor(Date.now() / 1000));
  const now = nowFn();
  const result = {
    scanned: 0,
    active: [],
    removedStale: [],
    removedPartial: [],
    errors: []
  };
  const entries = [];
  try {
    for await (const entry of Deno.readDir(workDir)){
      entries.push(entry);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Cannot read ${workDir}: ${msg}`);
    return result;
  }
  for (const entry of entries){
    // Skip dotfiles/dotdirs — these are heartbeats, marker state,
    // .claude-sessions, .vibe_* metadata, etc. and are owned by other
    // subsystems.
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory) continue;
    // Skip reserved non-repo subdirs that other subsystems own. Without
    // this guard the scanner deletes them every cycle and the owning
    // subsystem recreates them — see RESERVED_WORKDIR_NAMES.
    if (isReservedWorkRootEntry(entry.name)) continue;
    result.scanned++;
    const repoDir = `${workDir}/${entry.name}`;
    const classification = await classifyWorkDir(workDir, repoDir, maxAgeSeconds, now);
    if (classification.kind === "active") {
      result.active.push(entry.name);
      continue;
    }
    // Push-before-delete guard (Issue #4170): a stale clone may hold the
    // only copy of a killed session's commits. Push every branch that is
    // ahead of its remote before removal; if any push fails, keep the
    // directory (loud warning) so the work survives for another cycle.
    if (classification.kind === "stale") {
      const rescue = await (options.rescue ?? pushUnpushedBranches)(repoDir);
      if (!rescue.ok) {
        if (rescue.untrusted) {
          const message = `Kept untrusted clone ${repoDir} for inspection (${rescue.detail})`;
          result.errors.push(message);
          console.warn(`SELF-HEALING: ${message}`);
          continue;
        }
        result.errors.push(`Kept ${repoDir}: unpushed commits could not be pushed (${rescue.detail})`);
        console.warn(`SELF-HEALING: NOT removing stale work directory ${repoDir} — it ` + `has unpushed commits and pushing them failed (${rescue.detail}). ` + `The work is preserved for another cycle; push it manually if ` + `this repeats.`);
        continue;
      }
      if (rescue.pushedBranches.length > 0) {
        console.log(`SELF-HEALING: pushed unpushed work from ${repoDir} before ` + `removal (branches: ${rescue.pushedBranches.join(", ")})`);
      }
    }
    const removedOk = await removeDirectory(repoDir);
    if (!removedOk.ok) {
      result.errors.push(`Failed to remove ${repoDir}: ${removedOk.error}`);
      console.warn(`SELF-HEALING: failed to remove ${classification.kind} work directory ` + `${repoDir}: ${removedOk.error}`);
      continue;
    }
    if (classification.kind === "stale") {
      result.removedStale.push(entry.name);
    } else {
      result.removedPartial.push(entry.name);
    }
    console.log(`SELF-HEALING: removed ${classification.kind} work directory ` + `${repoDir} (${classification.reason})`);
    recordFaultEvent("disk_space_cleanup", `stale_workdir removed ${classification.kind} ${repoDir}`);
  }
  return result;
}
/**
 * Find a heartbeat file in `workDir` that references the given repo name
 * and has a timestamp newer than `now - maxAgeSeconds`.
 *
 * Heartbeat filenames use the format `.heartbeat_{owner}_{repo}_{issue}`.
 * Only the repo segment needs to match — the issue number and owner are
 * free to vary.
 */ async function findRecentHeartbeat(workDir, repoName, maxAgeSeconds, now) {
  try {
    for await (const entry of Deno.readDir(workDir)){
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(".heartbeat_")) continue;
      if (!filenameReferencesRepo(entry.name, repoName)) continue;
      try {
        const raw = await Deno.readTextFile(`${workDir}/${entry.name}`);
        const epoch = parseInt(raw.trim(), 10);
        if (isNaN(epoch)) continue;
        if (now - epoch <= maxAgeSeconds) {
          return {
            filename: entry.name,
            epoch
          };
        }
      } catch  {
      // Unreadable heartbeat — ignore.
      }
    }
  } catch  {
  // Parent directory gone during scan — treat as "no heartbeat".
  }
  return null;
}
/**
 * Check whether a heartbeat filename references the given repo name.
 *
 * The filename format is `.heartbeat_{owner}_{repo}_{issue}`. Because
 * owner and repo segments may themselves contain underscores, we strip
 * the trailing `_{issue}` and the leading `{owner}_` and check whether
 * the remainder equals the repo name.
 */ function filenameReferencesRepo(filename, repoName) {
  const prefix = ".heartbeat_";
  if (!filename.startsWith(prefix)) return false;
  const body = filename.slice(prefix.length);
  const lastUnderscore = body.lastIndexOf("_");
  if (lastUnderscore < 0) return false;
  const issueSegment = body.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(issueSegment)) return false;
  const ownerAndRepo = body.slice(0, lastUnderscore);
  const firstUnderscore = ownerAndRepo.indexOf("_");
  if (firstUnderscore < 0) return false;
  const repoPart = ownerAndRepo.slice(firstUnderscore + 1);
  return repoPart === repoName;
}
/**
 * Push every local branch of `repoDir` that is ahead of its remote
 * counterpart (or has no remote counterpart) to origin (Issue #4170).
 *
 * Protected branches are never pushed — a stale clone must not be the
 * thing that writes to `main`/`Develop`; unpushed commits there fail the
 * rescue instead, keeping the directory. Any git failure fails the
 * rescue: the caller keeps the directory rather than deleting unpushed
 * work.
 */ export async function pushUnpushedBranches(repoDir, deps = {}) {
  const refusal = await (deps.checkOwnership ?? checkCloneOwnership)(repoDir, undefined, undefined, true, true);
  if (refusal) {
    return {
      ok: false,
      pushedBranches: [],
      detail: refusal,
      untrusted: true
    };
  }
  // Routed through the shared chokepoint (Issue #1214): the rescue pushes to
  // a remote, so an untimed spawn here hangs the worker outright, and the
  // push must reach the audit journal like every other git mutation.
  const run = async (args)=>{
    const result = await (deps.runGit ?? runGitCommand)([
      "-C",
      repoDir,
      ...args
    ]);
    if (!result.ok) {
      return {
        code: -1,
        stdout: "",
        stderr: result.error.message
      };
    }
    return result.value;
  };
  // Fast path: nothing anywhere is ahead of any remote — safe to delete.
  const anyUnpushed = await run([
    "log",
    "--branches",
    "--not",
    "--remotes",
    "--oneline",
    "-1"
  ]);
  if (anyUnpushed.code !== 0) {
    // A directory git cannot even read as a repository (empty or corrupt
    // `.git`) has no rescuable commits — deleting it loses nothing, so
    // fail open. Every other git failure fails closed: the caller keeps
    // the directory rather than deleting possibly-unpushed work.
    if (/not a git repository/i.test(anyUnpushed.stderr)) {
      return {
        ok: true,
        pushedBranches: [],
        detail: ""
      };
    }
    return {
      ok: false,
      pushedBranches: [],
      detail: `git log failed: ${anyUnpushed.stderr.trim() || "unknown"}`
    };
  }
  if (anyUnpushed.stdout.trim().length === 0) {
    return {
      ok: true,
      pushedBranches: [],
      detail: ""
    };
  }
  const branchList = await run([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads"
  ]);
  if (branchList.code !== 0) {
    return {
      ok: false,
      pushedBranches: [],
      detail: `git for-each-ref failed: ${branchList.stderr.trim()}`
    };
  }
  const pushed = [];
  for (const branch of branchList.stdout.split("\n")){
    const name = branch.trim();
    if (!name) continue;
    // A branch is unpushed when it has commits not on origin/<name>
    // (a missing remote ref makes rev-list fail — treat as unpushed).
    const ahead = await run([
      "rev-list",
      "--count",
      `origin/${name}..${name}`
    ]);
    const isUnpushed = ahead.code !== 0 || (parseInt(ahead.stdout.trim(), 10) || 0) > 0;
    if (!isUnpushed) continue;
    if (isProtectedBranch(name)) {
      return {
        ok: false,
        pushedBranches: pushed,
        detail: `branch '${name}' has unpushed commits but is protected — not ` + `pushing, not deleting`
      };
    }
    const push = await run([
      "push",
      "origin",
      `${name}:${name}`
    ]);
    if (push.code !== 0) {
      return {
        ok: false,
        pushedBranches: pushed,
        detail: `push of '${name}' failed: ${push.stderr.trim() || "unknown"}`
      };
    }
    pushed.push(name);
  }
  return {
    ok: true,
    pushedBranches: pushed,
    detail: ""
  };
}
/** Return true when the path exists and is accessible. */ async function pathExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch  {
    return false;
  }
}
/** Remove a directory recursively; returns Result-style outcome. */ async function removeDirectory(path) {
  try {
    await Deno.remove(path, {
      recursive: true
    });
    return {
      ok: true
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
/** Minimal path-basename implementation (avoids std/path import). */ function basename(p) {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdGFsZV93b3JrZGlyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RhbGUgcmVwb3NpdG9yeSB3b3JrIGRpcmVjdG9yeSBkZXRlY3Rpb24gYW5kIGNsZWFudXAgKElzc3VlICMxNDkzKS5cbiAqXG4gKiBTY2FucyByZXBvc2l0b3J5IGNsb25lcyB1bmRlciBgd29ya0RpcmAgYW5kIGNsYXNzaWZpZXMgZWFjaCBhcyBhY3RpdmUsXG4gKiBzdGFsZSwgb3IgcGFydGlhbC4gU3RhbGUgb3IgcGFydGlhbCBkaXJlY3RvcmllcyBhcmUgcmVtb3ZlZCBzbyB0aGUgbmV4dFxuICogcnVuIGNhbiByZS1jbG9uZSBjbGVhbmx5LCBhdm9pZGluZyB3YXN0ZWQgZGlzayB3aXRob3V0IHRoZSBoZWF2eS1oYW5kZWRcbiAqIGZ1bGwtbnVrZSB0cmlnZ2VyZWQgb25seSBhdCA5MCUgZGlzayBwcmVzc3VyZSBieSBgZGlza19zcGFjZS50c2AuXG4gKlxuICogQ2xhc3NpZmljYXRpb24gcnVsZXMgcGVyIGVudHJ5IGAke3dvcmtEaXJ9LyR7bmFtZX1gOlxuICogICAtIFNraXBwZWQgICAgICAgICAg4oCUIGRvdC1wcmVmaXhlZCAoZS5nLiBgLmNsYXVkZS1zZXNzaW9uc2AsIGhlYXJ0YmVhdFxuICogICAgICAgICAgICAgICAgICAgICAgICBmaWxlcywgbWFya2VyIHN0YXRlKSBvciBub24tZGlyZWN0b3J5IGVudHJpZXMuXG4gKiAgIC0gKipQYXJ0aWFsKiogICAgICDigJQgZGlyZWN0b3J5IGV4aXN0cyBidXQgYC5naXRgIGlzIG1pc3Npbmcg4oCUIHJlbW92ZSBzb1xuICogICAgICAgICAgICAgICAgICAgICAgICB0aGUgbmV4dCBjbG9uZSByZS1pbml0aWFsaXNlcyBjbGVhbmx5LlxuICogICAtICoqQWN0aXZlKiogICAgICAg4oCUIGEgaGVhcnRiZWF0IGZpbGUgYC5oZWFydGJlYXRfKl97bmFtZX1fe2lzc3VlfWBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgaGFzIGEgdGltZXN0YW1wIG5ld2VyIHRoYW4gYG5vdyAtIG1heEFnZWAsXG4gKiAgICAgICAgICAgICAgICAgICAgICAgIE9SIHRoZSBkaXJlY3RvcnkgbXRpbWUgaXMgbmV3ZXIgdGhhbiBgbm93IC0gbWF4QWdlYC5cbiAqICAgLSAqKlN0YWxlKiogICAgICAgIOKAlCBubyByZWNlbnQgaGVhcnRiZWF0IGFuZCBtdGltZSBpcyBvbGRlciB0aGFuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgIGBub3cgLSBtYXhBZ2VgIOKAlCByZW1vdmUuXG4gKlxuICogRXZlcnkgcmVtb3ZhbCBsb2dzIGEgc2luZ2xlIGBTRUxGLUhFQUxJTkc6YCBsaW5lIHNvIHRoZSBzaGVsbCB3cmFwcGVyXG4gKiBhbmQgb3BlcmF0b3JzIGNhbiBhdWRpdCB0aGUgY2xlYW51cC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBjaGVja0Nsb25lT3duZXJzaGlwIH0gZnJvbSBcIi4vYnJva2VuX2Nsb25lLnRzXCI7XG5pbXBvcnQgeyByZWNvcmRGYXVsdEV2ZW50IH0gZnJvbSBcIi4vZmF1bHRfdG9sZXJhbmNlX2NvdW50ZXJzLnRzXCI7XG5pbXBvcnQgeyBpc1Byb3RlY3RlZEJyYW5jaCB9IGZyb20gXCIuL2dpdF9icmFuY2gudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHsgTEFORV9XT1JLVFJFRV9ST09UIH0gZnJvbSBcIi4vbGFuZV93b3JrdHJlZS50c1wiO1xuXG4vKiogRGVmYXVsdCBhZ2UgdGhyZXNob2xkIGluIGRheXMgYmVmb3JlIGEgcmVwbyBjbG9uZSB3aXRoIG5vIGhlYXJ0YmVhdCBpcyBzdGFsZS4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NUQUxFX1dPUktESVJfREFZUyA9IDc7XG5cbi8qKlxuICogU3ViZGlyZWN0b3J5IG5hbWVzIHRoYXQgYXJlICpub3QqIHJlcG9zaXRvcnkgY2xvbmVzIGFuZCBtdXN0IGJlIGxlZnRcbiAqIGFsb25lIGJ5IHRoZSBzY2FubmVyLiBXaXRob3V0IHRoaXMgbGlzdCB0aGUgc2Nhbm5lciBjbGFzc2lmaWVzIHRoZW1cbiAqIGFzIFwicGFydGlhbFwiIChubyBgLmdpdGApIGFuZCBkZWxldGVzIHRoZW0gZXZlcnkgY3ljbGUsIG9ubHkgZm9yIHRoZVxuICogb3duaW5nIHN1YnN5c3RlbSB0byByZWNyZWF0ZSB0aGVtIG9uIHRoZSBuZXh0IGNhbGwuXG4gKlxuICogLSBgbG9nc2Ag4oCUIGBzZWxmX2hlYWxfZXZlbnRzLnRzYCB3cml0ZXMgYCR7d29ya0Rpcn0vbG9ncy9zZWxmLWhlYWwuanNvbmxgLlxuICogLSBgbG9zdCtmb3VuZGAg4oCUIHRoZSB2aWJlLXdvcmsgbmFtZWQgdm9sdW1lICgjNDIwMykgaXMgYSByZWFsIGV4dDRcbiAqICAgZmlsZXN5c3RlbSB3aG9zZSByb290IGFsd2F5cyBjYXJyaWVzIHRoaXMgcm9vdC1vd25lZCBkaXJlY3Rvcnk7IHRoZVxuICogICB3b3JrZXIgKHVpZCAxMDAwKSBjYW5ub3QgcmVtb3ZlIGl0LCBhbmQgdHJ5aW5nIHByb2R1Y2VkIGFcbiAqICAgUGVybWlzc2lvbi1kZW5pZWQgU0VMRi1IRUFMSU5HIHdhcm5pbmcgZXZlcnkgY3ljbGUgKElzc3VlICM0MjEyKS5cbiAqIC0gYGF1ZGl0YCDigJQgYGF1ZGl0X2pvdXJuYWwudHNgIHdyaXRlcyB0aGUgaGFzaC1jaGFpbmVkIG11dGF0aW9uIGpvdXJuYWxzXG4gKiAgIHRvIGAke1dPUktfRElSfS9hdWRpdC9gLiBJdCBoYXMgbm8gYC5naXRgIGFuZCBzaXRzIHVudG91Y2hlZCBiZXR3ZWVuXG4gKiAgIHN3ZWVwcywgc28gZXZlcnkgaG91c2VrZWVwaW5nIHBhdGggdHJlYXRlZCBpdCBhcyBhIGRpc3Bvc2FibGUgY2xvbmUgYW5kXG4gKiAgIGRlbGV0ZWQgdGhlIHdvcmtlcidzIG93biB0YW1wZXItZXZpZGVudCByZWNvcmQg4oCUIGBhdWRpdC1jaGFpbi12ZXJpZnlgXG4gKiAgIHRoZW4gcmVwb3J0ZWQgYEFVRElUX0NIQUlOX0JST0tFTmAgb24gZXZlcnkgc3dlcHQgaG9zdCAoSXNzdWUgIzMzNykuXG4gKiAtIGB3b3JrdHJlZXNgIOKAlCBgbGFuZV93b3JrdHJlZS50c2AgcHV0cyBlYWNoIGxhbmUncyBsaW5rZWQgd29ya3RyZWUgdW5kZXJcbiAqICAgYCR7V09SS19ESVJ9L3dvcmt0cmVlcy88bGFuZT4vPHJlcG8+YCBzbyBsYW5lcyBzdG9wIHNoYXJpbmcgb25lIGNsb25lJ3NcbiAqICAgYEhFQURgLCBpbmRleCBhbmQgd29ya2luZyB0cmVlIChJc3N1ZSAjMzk0KS4gVGhlIGRpcmVjdG9yeSBpdHNlbGYgaG9sZHNcbiAqICAgbm8gY2xvbmUsIGFuZCByZW1vdmluZyBhIGxpdmUgd29ya3RyZWUncyBjaGVja291dCB1bmRlciB0aGUgbGFuZSB1c2luZ1xuICogICBpdCBpcyB0aGUgdmVyeSBjb2xsaXNpb24gaXQgZXhpc3RzIHRvIHByZXZlbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVNFUlZFRF9XT1JLRElSX05BTUVTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwibG9nc1wiLFxuICBcImxvc3QrZm91bmRcIixcbiAgXCJhdWRpdFwiLFxuICBMQU5FX1dPUktUUkVFX1JPT1QsXG5dKTtcblxuLyoqXG4gKiBXb3JrLXJvb3QgKipmaWxlKiogbmFtZXMgdGhhdCBiZWxvbmcgdG8gYSByZXNlcnZlZCBzdWJzeXN0ZW0gcmF0aGVyIHRoYW5cbiAqIHRvIGEgY2xvbmU6IHRoZSBhdWRpdCB0cmFpbCdzIHJvc3RlciBhbmQgaXRzIGxhc3Qta25vd24tbm9uLWVtcHR5IG1hcmtlcixcbiAqIGtlcHQgYmVzaWRlIChub3QgaW5zaWRlKSBgYXVkaXQvYCBwcmVjaXNlbHkgc28gcmVtb3ZpbmcgdGhlIGRpcmVjdG9yeVxuICogY2Fubm90IHJlbW92ZSB0aGUgZXhwZWN0YXRpb24gKElzc3VlcyAjMzk0OSwgIzI3MCkuXG4gKi9cbmNvbnN0IFJFU0VSVkVEX1dPUktESVJfRklMRVM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJhdWRpdC5yb3N0ZXIuanNvbmxcIixcbiAgXCJhdWRpdC5yb3N0ZXIuc2VlblwiLFxuXSk7XG5cbi8qKlxuICogUHJlZml4IG9mIHRoZSBzaWRlY2FycyBhIHRvcm4tcm9zdGVyIHJlcGFpciBwcmVzZXJ2ZXMgKElzc3VlICMxMjAyKS5cbiAqXG4gKiBgYXVkaXQucm9zdGVyLmpzb25sLnRvcm4tPG4+YCBob2xkcyB0aGUgYnl0ZXMgYSByZXBhaXIgbW92ZWQgYXNpZGUgcmF0aGVyXG4gKiB0aGFuIGRlbGV0ZWQuIExldHRpbmcgaG91c2VrZWVwaW5nIHJlbW92ZSB0aGVtIHdvdWxkIGRlbGV0ZSB0aGUgb25seSBjb3B5XG4gKiBvZiB0aGUgZXZpZGVuY2UgdGhlIHJlcGFpciBwcm9taXNlZCB0byBrZWVwLlxuICovXG5jb25zdCBSRVNFUlZFRF9ST1NURVJfVE9STl9QUkVGSVggPSBcImF1ZGl0LnJvc3Rlci5qc29ubC50b3JuLVwiO1xuXG4vKipcbiAqIElzIHRoaXMgd29yay1yb290IGVudHJ5IG93bmVkIGJ5IGEgc3Vic3lzdGVtIGFuZCBvZmYtbGltaXRzIHRvIGV2ZXJ5XG4gKiBjbGVhbnVwIHN3ZWVwPyBDb3ZlcnMge0BsaW5rIFJFU0VSVkVEX1dPUktESVJfTkFNRVN9IGFuZCB0aGUgYXVkaXRcbiAqIHRyYWlsJ3Mgc2libGluZyBmaWxlcywgc28gYSBzd2VlcCB0aGF0IHdhbGtzIGZpbGVzIGFzIHdlbGwgYXMgZGlyZWN0b3JpZXNcbiAqIChgbnVrZVdvcmtEaXJgKSBjYW5ub3QgaGFsZi1lcmFzZSB0aGUgdHJhaWwgKElzc3VlICMzMzcpLlxuICpcbiAqIEBwYXJhbSBuYW1lIC0gRW50cnkgbmFtZSBkaXJlY3RseSB1bmRlciB0aGUgd29yayByb290XG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gdGhlIGVudHJ5IG11c3QgYmUgbGVmdCBhbG9uZVxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNSZXNlcnZlZFdvcmtSb290RW50cnkobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBSRVNFUlZFRF9XT1JLRElSX05BTUVTLmhhcyhuYW1lKSB8fFxuICAgIFJFU0VSVkVEX1dPUktESVJfRklMRVMuaGFzKG5hbWUpIHx8XG4gICAgbmFtZS5zdGFydHNXaXRoKFJFU0VSVkVEX1JPU1RFUl9UT1JOX1BSRUZJWCk7XG59XG5cbi8qKiBPcHRpb25zIGZvciBzY2FubmluZyB0aGUgd29yayBkaXJlY3RvcnkuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YWxlV29ya0Rpck9wdGlvbnMge1xuICAvKiogRGlyZWN0b3J5IGNvbnRhaW5pbmcgcmVwb3NpdG9yeSBjbG9uZXMgKHVzdWFsbHkgV09SS19ESVIpLiAqL1xuICB3b3JrRGlyOiBzdHJpbmc7XG4gIC8qKiBBZ2UgdGhyZXNob2xkIGluIGRheXMg4oCUIGRlZmF1bHRzIHRvIHtAbGluayBERUZBVUxUX1NUQUxFX1dPUktESVJfREFZU30uICovXG4gIG1heEFnZURheXM/OiBudW1iZXI7XG4gIC8qKiBPdmVycmlkZSB0aGUgXCJub3dcIiBjbG9jayBmb3IgdGVzdGluZy4gUmV0dXJucyBlcG9jaCBzZWNvbmRzLiAqL1xuICBub3dGbj86ICgpID0+IG51bWJlcjtcbiAgLyoqIE92ZXJyaWRlIHJlc2N1ZSBmb3IgdGVzdHMuICovXG4gIHJlc2N1ZT86IHR5cGVvZiBwdXNoVW5wdXNoZWRCcmFuY2hlcztcbn1cblxuLyoqIE91dGNvbWUgb2YgYSBzaW5nbGUgd29yay1kaXJlY3Rvcnkgc2Nhbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RhbGVXb3JrRGlyUmVzdWx0IHtcbiAgLyoqIE51bWJlciBvZiBjYW5kaWRhdGUgZGlyZWN0b3JpZXMgaW5zcGVjdGVkLiAqL1xuICBzY2FubmVkOiBudW1iZXI7XG4gIC8qKiBOYW1lcyBwcmVzZXJ2ZWQgYmVjYXVzZSB0aGV5IGFyZSBhY3RpdmUuICovXG4gIGFjdGl2ZTogc3RyaW5nW107XG4gIC8qKiBOYW1lcyByZW1vdmVkIGJlY2F1c2UgdGhleSB3ZXJlIHN0YWxlIChvbGQgbXRpbWUsIG5vIGhlYXJ0YmVhdCkuICovXG4gIHJlbW92ZWRTdGFsZTogc3RyaW5nW107XG4gIC8qKiBOYW1lcyByZW1vdmVkIGJlY2F1c2UgdGhleSB3ZXJlIHBhcnRpYWwgKG1pc3NpbmcgYC5naXRgKS4gKi9cbiAgcmVtb3ZlZFBhcnRpYWw6IHN0cmluZ1tdO1xuICAvKiogSHVtYW4tcmVhZGFibGUgZXJyb3IgbWVzc2FnZXMgY29sbGVjdGVkIGR1cmluZyB0aGUgc2Nhbi4gKi9cbiAgZXJyb3JzOiBzdHJpbmdbXTtcbn1cblxuLyoqIENsYXNzaWZpY2F0aW9uIG9mIGEgc2luZ2xlIHJlcG9zaXRvcnkgd29yayBkaXJlY3RvcnkuICovXG5leHBvcnQgdHlwZSBXb3JrRGlyQ2xhc3NpZmljYXRpb24gPVxuICB8IHsga2luZDogXCJhY3RpdmVcIjsgcmVhc29uOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJzdGFsZVwiOyByZWFzb246IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInBhcnRpYWxcIjsgcmVhc29uOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBDbGFzc2lmeSBhIHNpbmdsZSByZXBvc2l0b3J5IHdvcmsgZGlyZWN0b3J5LlxuICpcbiAqIEluc3BlY3RzIGhlYXJ0YmVhdCBmaWxlcyBpbiBgd29ya0RpcmAsIHRoZSBwcmVzZW5jZSBvZiBgLmdpdGAsIGFuZFxuICogdGhlIGRpcmVjdG9yeSBtdGltZSB0byBkZWNpZGUgdGhlIGNvcnJlY3QgZGlzcG9zaXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeVdvcmtEaXIoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwb0Rpcjogc3RyaW5nLFxuICBtYXhBZ2VTZWNvbmRzOiBudW1iZXIsXG4gIG5vdzogbnVtYmVyLFxuKTogUHJvbWlzZTxXb3JrRGlyQ2xhc3NpZmljYXRpb24+IHtcbiAgY29uc3QgcmVwb05hbWUgPSBiYXNlbmFtZShyZXBvRGlyKTtcblxuICAvLyAxLiBMaXZlIGhlYXJ0YmVhdCBwaW5uZWQgdG8gdGhpcyByZXBvIGtlZXBzIGl0IGFsaXZlIHJlZ2FyZGxlc3Mgb2YgbXRpbWUuXG4gIGNvbnN0IGhlYXJ0YmVhdEhpdCA9IGF3YWl0IGZpbmRSZWNlbnRIZWFydGJlYXQoXG4gICAgd29ya0RpcixcbiAgICByZXBvTmFtZSxcbiAgICBtYXhBZ2VTZWNvbmRzLFxuICAgIG5vdyxcbiAgKTtcbiAgaWYgKGhlYXJ0YmVhdEhpdCAhPT0gbnVsbCkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcImFjdGl2ZVwiLFxuICAgICAgcmVhc29uOiBgaGVhcnRiZWF0ICR7aGVhcnRiZWF0SGl0LmZpbGVuYW1lfSB3aXRoaW4gd2luZG93YCxcbiAgICB9O1xuICB9XG5cbiAgLy8gMi4gTWlzc2luZyBgLmdpdGAg4oCUIHRoZSBjbG9uZSBpcyBwYXJ0aWFsL2Jyb2tlbi5cbiAgY29uc3QgaGFzR2l0ID0gYXdhaXQgcGF0aEV4aXN0cyhgJHtyZXBvRGlyfS8uZ2l0YCk7XG4gIGlmICghaGFzR2l0KSB7XG4gICAgcmV0dXJuIHsga2luZDogXCJwYXJ0aWFsXCIsIHJlYXNvbjogXCIuZ2l0IG1pc3Npbmcgb3IgaW5hY2Nlc3NpYmxlXCIgfTtcbiAgfVxuXG4gIC8vIDMuIE10aW1lLWJhc2VkIGZyZXNobmVzcyBjaGVjay5cbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KHJlcG9EaXIpO1xuICAgIGNvbnN0IG10aW1lID0gc3RhdC5tdGltZTtcbiAgICBpZiAobXRpbWUgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGFnZVNlY29uZHMgPSBub3cgLSBNYXRoLmZsb29yKG10aW1lLmdldFRpbWUoKSAvIDEwMDApO1xuICAgICAgaWYgKGFnZVNlY29uZHMgPD0gbWF4QWdlU2Vjb25kcykge1xuICAgICAgICBjb25zdCBkYXlzID0gKGFnZVNlY29uZHMgLyA4NjQwMCkudG9GaXhlZCgxKTtcbiAgICAgICAgcmV0dXJuIHsga2luZDogXCJhY3RpdmVcIiwgcmVhc29uOiBgbW9kaWZpZWQgJHtkYXlzfSBkYXlzIGFnb2AgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRheXMgPSAoYWdlU2Vjb25kcyAvIDg2NDAwKS50b0ZpeGVkKDEpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAga2luZDogXCJzdGFsZVwiLFxuICAgICAgICByZWFzb246IGBtb2RpZmllZCAke2RheXN9IGRheXMgYWdvLCBleGNlZWRzIHRocmVzaG9sZGAsXG4gICAgICB9O1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gRmFsbCB0aHJvdWdoIOKAlCB1bnJlYWRhYmxlIHN0YXQgaXMgdHJlYXRlZCBhcyBzdGFsZSBiZWxvdy5cbiAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgXCJjYXRjaF9ibG9ja193YXJuaW5nXCIsXG4gICAgICBgc3RhbGVfd29ya2RpciBzdGF0IGZhaWxlZCBmb3IgJHtyZXBvRGlyfTogJHtlcnJ9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsga2luZDogXCJzdGFsZVwiLCByZWFzb246IFwibm8gbXRpbWUgYXZhaWxhYmxlXCIgfTtcbn1cblxuLyoqXG4gKiBTY2FuIGB3b3JrRGlyYCBhbmQgcmVtb3ZlIHN0YWxlIG9yIHBhcnRpYWwgcmVwb3NpdG9yeSBjbG9uZXMuXG4gKlxuICogUmV0dXJucyBhIHN1bW1hcnkgZGVzY3JpYmluZyB3aGljaCBlbnRyaWVzIHdlcmUgc2Nhbm5lZCwgcHJlc2VydmVkLFxuICogb3IgcmVtb3ZlZC4gRXJyb3JzIHJlYWRpbmcgYHdvcmtEaXJgIG9yIHJlbW92aW5nIGEgc3BlY2lmaWMgZW50cnkgYXJlXG4gKiBjb2xsZWN0ZWQgaW50byBgZXJyb3JzYCDigJQgdGhleSBuZXZlciB0aHJvdyBvdXQgb2YgdGhpcyBmdW5jdGlvbiBzb1xuICogY2FsbGVycyBjYW4gcmVseSBvbiBpdCBkdXJpbmcgc3RhcnR1cC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNjYW5BbmRDbGVhbnVwU3RhbGVXb3JrRGlycyhcbiAgb3B0aW9uczogU3RhbGVXb3JrRGlyT3B0aW9ucyxcbik6IFByb21pc2U8U3RhbGVXb3JrRGlyUmVzdWx0PiB7XG4gIGNvbnN0IHdvcmtEaXIgPSBvcHRpb25zLndvcmtEaXI7XG4gIGNvbnN0IG1heEFnZURheXMgPSBvcHRpb25zLm1heEFnZURheXMgPz8gREVGQVVMVF9TVEFMRV9XT1JLRElSX0RBWVM7XG4gIGNvbnN0IG1heEFnZVNlY29uZHMgPSBNYXRoLm1heCgwLCBtYXhBZ2VEYXlzKSAqIDg2NDAwO1xuICBjb25zdCBub3dGbiA9IG9wdGlvbnMubm93Rm4gPz8gKCgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApKTtcbiAgY29uc3Qgbm93ID0gbm93Rm4oKTtcblxuICBjb25zdCByZXN1bHQ6IFN0YWxlV29ya0RpclJlc3VsdCA9IHtcbiAgICBzY2FubmVkOiAwLFxuICAgIGFjdGl2ZTogW10sXG4gICAgcmVtb3ZlZFN0YWxlOiBbXSxcbiAgICByZW1vdmVkUGFydGlhbDogW10sXG4gICAgZXJyb3JzOiBbXSxcbiAgfTtcblxuICBjb25zdCBlbnRyaWVzOiBEZW5vLkRpckVudHJ5W10gPSBbXTtcbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcih3b3JrRGlyKSkge1xuICAgICAgZW50cmllcy5wdXNoKGVudHJ5KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICByZXN1bHQuZXJyb3JzLnB1c2goYENhbm5vdCByZWFkICR7d29ya0Rpcn06ICR7bXNnfWApO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAvLyBTa2lwIGRvdGZpbGVzL2RvdGRpcnMg4oCUIHRoZXNlIGFyZSBoZWFydGJlYXRzLCBtYXJrZXIgc3RhdGUsXG4gICAgLy8gLmNsYXVkZS1zZXNzaW9ucywgLnZpYmVfKiBtZXRhZGF0YSwgZXRjLiBhbmQgYXJlIG93bmVkIGJ5IG90aGVyXG4gICAgLy8gc3Vic3lzdGVtcy5cbiAgICBpZiAoZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSkgY29udGludWU7XG4gICAgLy8gU2tpcCByZXNlcnZlZCBub24tcmVwbyBzdWJkaXJzIHRoYXQgb3RoZXIgc3Vic3lzdGVtcyBvd24uIFdpdGhvdXRcbiAgICAvLyB0aGlzIGd1YXJkIHRoZSBzY2FubmVyIGRlbGV0ZXMgdGhlbSBldmVyeSBjeWNsZSBhbmQgdGhlIG93bmluZ1xuICAgIC8vIHN1YnN5c3RlbSByZWNyZWF0ZXMgdGhlbSDigJQgc2VlIFJFU0VSVkVEX1dPUktESVJfTkFNRVMuXG4gICAgaWYgKGlzUmVzZXJ2ZWRXb3JrUm9vdEVudHJ5KGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcblxuICAgIHJlc3VsdC5zY2FubmVkKys7XG4gICAgY29uc3QgcmVwb0RpciA9IGAke3dvcmtEaXJ9LyR7ZW50cnkubmFtZX1gO1xuXG4gICAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBhd2FpdCBjbGFzc2lmeVdvcmtEaXIoXG4gICAgICB3b3JrRGlyLFxuICAgICAgcmVwb0RpcixcbiAgICAgIG1heEFnZVNlY29uZHMsXG4gICAgICBub3csXG4gICAgKTtcblxuICAgIGlmIChjbGFzc2lmaWNhdGlvbi5raW5kID09PSBcImFjdGl2ZVwiKSB7XG4gICAgICByZXN1bHQuYWN0aXZlLnB1c2goZW50cnkubmFtZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBQdXNoLWJlZm9yZS1kZWxldGUgZ3VhcmQgKElzc3VlICM0MTcwKTogYSBzdGFsZSBjbG9uZSBtYXkgaG9sZCB0aGVcbiAgICAvLyBvbmx5IGNvcHkgb2YgYSBraWxsZWQgc2Vzc2lvbidzIGNvbW1pdHMuIFB1c2ggZXZlcnkgYnJhbmNoIHRoYXQgaXNcbiAgICAvLyBhaGVhZCBvZiBpdHMgcmVtb3RlIGJlZm9yZSByZW1vdmFsOyBpZiBhbnkgcHVzaCBmYWlscywga2VlcCB0aGVcbiAgICAvLyBkaXJlY3RvcnkgKGxvdWQgd2FybmluZykgc28gdGhlIHdvcmsgc3Vydml2ZXMgZm9yIGFub3RoZXIgY3ljbGUuXG4gICAgaWYgKGNsYXNzaWZpY2F0aW9uLmtpbmQgPT09IFwic3RhbGVcIikge1xuICAgICAgY29uc3QgcmVzY3VlID0gYXdhaXQgKG9wdGlvbnMucmVzY3VlID8/IHB1c2hVbnB1c2hlZEJyYW5jaGVzKShyZXBvRGlyKTtcbiAgICAgIGlmICghcmVzY3VlLm9rKSB7XG4gICAgICAgIGlmIChyZXNjdWUudW50cnVzdGVkKSB7XG4gICAgICAgICAgY29uc3QgbWVzc2FnZSA9XG4gICAgICAgICAgICBgS2VwdCB1bnRydXN0ZWQgY2xvbmUgJHtyZXBvRGlyfSBmb3IgaW5zcGVjdGlvbiAoJHtyZXNjdWUuZGV0YWlsfSlgO1xuICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaChtZXNzYWdlKTtcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFNFTEYtSEVBTElORzogJHttZXNzYWdlfWApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaChcbiAgICAgICAgICBgS2VwdCAke3JlcG9EaXJ9OiB1bnB1c2hlZCBjb21taXRzIGNvdWxkIG5vdCBiZSBwdXNoZWQgKCR7cmVzY3VlLmRldGFpbH0pYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBTRUxGLUhFQUxJTkc6IE5PVCByZW1vdmluZyBzdGFsZSB3b3JrIGRpcmVjdG9yeSAke3JlcG9EaXJ9IOKAlCBpdCBgICtcbiAgICAgICAgICAgIGBoYXMgdW5wdXNoZWQgY29tbWl0cyBhbmQgcHVzaGluZyB0aGVtIGZhaWxlZCAoJHtyZXNjdWUuZGV0YWlsfSkuIGAgK1xuICAgICAgICAgICAgYFRoZSB3b3JrIGlzIHByZXNlcnZlZCBmb3IgYW5vdGhlciBjeWNsZTsgcHVzaCBpdCBtYW51YWxseSBpZiBgICtcbiAgICAgICAgICAgIGB0aGlzIHJlcGVhdHMuYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAocmVzY3VlLnB1c2hlZEJyYW5jaGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYFNFTEYtSEVBTElORzogcHVzaGVkIHVucHVzaGVkIHdvcmsgZnJvbSAke3JlcG9EaXJ9IGJlZm9yZSBgICtcbiAgICAgICAgICAgIGByZW1vdmFsIChicmFuY2hlczogJHtyZXNjdWUucHVzaGVkQnJhbmNoZXMuam9pbihcIiwgXCIpfSlgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHJlbW92ZWRPayA9IGF3YWl0IHJlbW92ZURpcmVjdG9yeShyZXBvRGlyKTtcbiAgICBpZiAoIXJlbW92ZWRPay5vaykge1xuICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKFxuICAgICAgICBgRmFpbGVkIHRvIHJlbW92ZSAke3JlcG9EaXJ9OiAke3JlbW92ZWRPay5lcnJvcn1gLFxuICAgICAgKTtcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYFNFTEYtSEVBTElORzogZmFpbGVkIHRvIHJlbW92ZSAke2NsYXNzaWZpY2F0aW9uLmtpbmR9IHdvcmsgZGlyZWN0b3J5IGAgK1xuICAgICAgICAgIGAke3JlcG9EaXJ9OiAke3JlbW92ZWRPay5lcnJvcn1gLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChjbGFzc2lmaWNhdGlvbi5raW5kID09PSBcInN0YWxlXCIpIHtcbiAgICAgIHJlc3VsdC5yZW1vdmVkU3RhbGUucHVzaChlbnRyeS5uYW1lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0LnJlbW92ZWRQYXJ0aWFsLnB1c2goZW50cnkubmFtZSk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgU0VMRi1IRUFMSU5HOiByZW1vdmVkICR7Y2xhc3NpZmljYXRpb24ua2luZH0gd29yayBkaXJlY3RvcnkgYCArXG4gICAgICAgIGAke3JlcG9EaXJ9ICgke2NsYXNzaWZpY2F0aW9uLnJlYXNvbn0pYCxcbiAgICApO1xuICAgIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgICBcImRpc2tfc3BhY2VfY2xlYW51cFwiLFxuICAgICAgYHN0YWxlX3dvcmtkaXIgcmVtb3ZlZCAke2NsYXNzaWZpY2F0aW9uLmtpbmR9ICR7cmVwb0Rpcn1gLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEZpbmQgYSBoZWFydGJlYXQgZmlsZSBpbiBgd29ya0RpcmAgdGhhdCByZWZlcmVuY2VzIHRoZSBnaXZlbiByZXBvIG5hbWVcbiAqIGFuZCBoYXMgYSB0aW1lc3RhbXAgbmV3ZXIgdGhhbiBgbm93IC0gbWF4QWdlU2Vjb25kc2AuXG4gKlxuICogSGVhcnRiZWF0IGZpbGVuYW1lcyB1c2UgdGhlIGZvcm1hdCBgLmhlYXJ0YmVhdF97b3duZXJ9X3tyZXBvfV97aXNzdWV9YC5cbiAqIE9ubHkgdGhlIHJlcG8gc2VnbWVudCBuZWVkcyB0byBtYXRjaCDigJQgdGhlIGlzc3VlIG51bWJlciBhbmQgb3duZXIgYXJlXG4gKiBmcmVlIHRvIHZhcnkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZpbmRSZWNlbnRIZWFydGJlYXQoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwb05hbWU6IHN0cmluZyxcbiAgbWF4QWdlU2Vjb25kczogbnVtYmVyLFxuICBub3c6IG51bWJlcixcbik6IFByb21pc2U8eyBmaWxlbmFtZTogc3RyaW5nOyBlcG9jaDogbnVtYmVyIH0gfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIod29ya0RpcikpIHtcbiAgICAgIGlmICghZW50cnkuaXNGaWxlKSBjb250aW51ZTtcbiAgICAgIGlmICghZW50cnkubmFtZS5zdGFydHNXaXRoKFwiLmhlYXJ0YmVhdF9cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFmaWxlbmFtZVJlZmVyZW5jZXNSZXBvKGVudHJ5Lm5hbWUsIHJlcG9OYW1lKSkgY29udGludWU7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGAke3dvcmtEaXJ9LyR7ZW50cnkubmFtZX1gKTtcbiAgICAgICAgY29uc3QgZXBvY2ggPSBwYXJzZUludChyYXcudHJpbSgpLCAxMCk7XG4gICAgICAgIGlmIChpc05hTihlcG9jaCkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAobm93IC0gZXBvY2ggPD0gbWF4QWdlU2Vjb25kcykge1xuICAgICAgICAgIHJldHVybiB7IGZpbGVuYW1lOiBlbnRyeS5uYW1lLCBlcG9jaCB9O1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gVW5yZWFkYWJsZSBoZWFydGJlYXQg4oCUIGlnbm9yZS5cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBhcmVudCBkaXJlY3RvcnkgZ29uZSBkdXJpbmcgc2NhbiDigJQgdHJlYXQgYXMgXCJubyBoZWFydGJlYXRcIi5cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgaGVhcnRiZWF0IGZpbGVuYW1lIHJlZmVyZW5jZXMgdGhlIGdpdmVuIHJlcG8gbmFtZS5cbiAqXG4gKiBUaGUgZmlsZW5hbWUgZm9ybWF0IGlzIGAuaGVhcnRiZWF0X3tvd25lcn1fe3JlcG99X3tpc3N1ZX1gLiBCZWNhdXNlXG4gKiBvd25lciBhbmQgcmVwbyBzZWdtZW50cyBtYXkgdGhlbXNlbHZlcyBjb250YWluIHVuZGVyc2NvcmVzLCB3ZSBzdHJpcFxuICogdGhlIHRyYWlsaW5nIGBfe2lzc3VlfWAgYW5kIHRoZSBsZWFkaW5nIGB7b3duZXJ9X2AgYW5kIGNoZWNrIHdoZXRoZXJcbiAqIHRoZSByZW1haW5kZXIgZXF1YWxzIHRoZSByZXBvIG5hbWUuXG4gKi9cbmZ1bmN0aW9uIGZpbGVuYW1lUmVmZXJlbmNlc1JlcG8oZmlsZW5hbWU6IHN0cmluZywgcmVwb05hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBwcmVmaXggPSBcIi5oZWFydGJlYXRfXCI7XG4gIGlmICghZmlsZW5hbWUuc3RhcnRzV2l0aChwcmVmaXgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGJvZHkgPSBmaWxlbmFtZS5zbGljZShwcmVmaXgubGVuZ3RoKTtcbiAgY29uc3QgbGFzdFVuZGVyc2NvcmUgPSBib2R5Lmxhc3RJbmRleE9mKFwiX1wiKTtcbiAgaWYgKGxhc3RVbmRlcnNjb3JlIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBpc3N1ZVNlZ21lbnQgPSBib2R5LnNsaWNlKGxhc3RVbmRlcnNjb3JlICsgMSk7XG4gIGlmICghL15cXGQrJC8udGVzdChpc3N1ZVNlZ21lbnQpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG93bmVyQW5kUmVwbyA9IGJvZHkuc2xpY2UoMCwgbGFzdFVuZGVyc2NvcmUpO1xuICBjb25zdCBmaXJzdFVuZGVyc2NvcmUgPSBvd25lckFuZFJlcG8uaW5kZXhPZihcIl9cIik7XG4gIGlmIChmaXJzdFVuZGVyc2NvcmUgPCAwKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHJlcG9QYXJ0ID0gb3duZXJBbmRSZXBvLnNsaWNlKGZpcnN0VW5kZXJzY29yZSArIDEpO1xuICByZXR1cm4gcmVwb1BhcnQgPT09IHJlcG9OYW1lO1xufVxuXG4vKiogT3V0Y29tZSBvZiB0aGUgcHVzaC1iZWZvcmUtZGVsZXRlIHJlc2N1ZSAoSXNzdWUgIzQxNzApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBVbnB1c2hlZFJlc2N1ZVJlc3VsdCB7XG4gIC8qKiBUcnVlIHdoZW4gdGhlIGRpcmVjdG9yeSBpcyBzYWZlIHRvIGRlbGV0ZSAobm90aGluZyB1bnB1c2hlZCByZW1haW5zKS4gKi9cbiAgb2s6IGJvb2xlYW47XG4gIC8qKiBCcmFuY2hlcyB0aGF0IHdlcmUgcHVzaGVkIGJ5IHRoZSByZXNjdWUuICovXG4gIHB1c2hlZEJyYW5jaGVzOiBzdHJpbmdbXTtcbiAgLyoqIEZhaWx1cmUgZGV0YWlsIHdoZW4gYG9rYCBpcyBmYWxzZS4gKi9cbiAgZGV0YWlsOiBzdHJpbmc7XG4gIC8qKiBPd25lcnNoaXAgY291bGQgbm90IGJlIHRydXN0ZWQ7IGRvIG5vdCBydW4gZ2l0IGluIHRoaXMgY2xvbmUuICovXG4gIHVudHJ1c3RlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUHVzaCBldmVyeSBsb2NhbCBicmFuY2ggb2YgYHJlcG9EaXJgIHRoYXQgaXMgYWhlYWQgb2YgaXRzIHJlbW90ZVxuICogY291bnRlcnBhcnQgKG9yIGhhcyBubyByZW1vdGUgY291bnRlcnBhcnQpIHRvIG9yaWdpbiAoSXNzdWUgIzQxNzApLlxuICpcbiAqIFByb3RlY3RlZCBicmFuY2hlcyBhcmUgbmV2ZXIgcHVzaGVkIOKAlCBhIHN0YWxlIGNsb25lIG11c3Qgbm90IGJlIHRoZVxuICogdGhpbmcgdGhhdCB3cml0ZXMgdG8gYG1haW5gL2BEZXZlbG9wYDsgdW5wdXNoZWQgY29tbWl0cyB0aGVyZSBmYWlsIHRoZVxuICogcmVzY3VlIGluc3RlYWQsIGtlZXBpbmcgdGhlIGRpcmVjdG9yeS4gQW55IGdpdCBmYWlsdXJlIGZhaWxzIHRoZVxuICogcmVzY3VlOiB0aGUgY2FsbGVyIGtlZXBzIHRoZSBkaXJlY3RvcnkgcmF0aGVyIHRoYW4gZGVsZXRpbmcgdW5wdXNoZWRcbiAqIHdvcmsuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwdXNoVW5wdXNoZWRCcmFuY2hlcyhcbiAgcmVwb0Rpcjogc3RyaW5nLFxuICBkZXBzOiB7XG4gICAgY2hlY2tPd25lcnNoaXA/OiB0eXBlb2YgY2hlY2tDbG9uZU93bmVyc2hpcDtcbiAgICBydW5HaXQ/OiB0eXBlb2YgcnVuR2l0Q29tbWFuZDtcbiAgfSA9IHt9LFxuKTogUHJvbWlzZTxVbnB1c2hlZFJlc2N1ZVJlc3VsdD4ge1xuICBjb25zdCByZWZ1c2FsID0gYXdhaXQgKGRlcHMuY2hlY2tPd25lcnNoaXAgPz8gY2hlY2tDbG9uZU93bmVyc2hpcCkoXG4gICAgcmVwb0RpcixcbiAgICB1bmRlZmluZWQsXG4gICAgdW5kZWZpbmVkLFxuICAgIHRydWUsXG4gICAgdHJ1ZSxcbiAgKTtcbiAgaWYgKHJlZnVzYWwpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIHB1c2hlZEJyYW5jaGVzOiBbXSwgZGV0YWlsOiByZWZ1c2FsLCB1bnRydXN0ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8vIFJvdXRlZCB0aHJvdWdoIHRoZSBzaGFyZWQgY2hva2Vwb2ludCAoSXNzdWUgIzEyMTQpOiB0aGUgcmVzY3VlIHB1c2hlcyB0b1xuICAvLyBhIHJlbW90ZSwgc28gYW4gdW50aW1lZCBzcGF3biBoZXJlIGhhbmdzIHRoZSB3b3JrZXIgb3V0cmlnaHQsIGFuZCB0aGVcbiAgLy8gcHVzaCBtdXN0IHJlYWNoIHRoZSBhdWRpdCBqb3VybmFsIGxpa2UgZXZlcnkgb3RoZXIgZ2l0IG11dGF0aW9uLlxuICBjb25zdCBydW4gPSBhc3luYyAoYXJnczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCAoZGVwcy5ydW5HaXQgPz8gcnVuR2l0Q29tbWFuZCkoW1xuICAgICAgXCItQ1wiLFxuICAgICAgcmVwb0RpcixcbiAgICAgIC4uLmFyZ3MsXG4gICAgXSk7XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIHJldHVybiB7IGNvZGU6IC0xLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogcmVzdWx0LmVycm9yLm1lc3NhZ2UgfTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdC52YWx1ZTtcbiAgfTtcblxuICAvLyBGYXN0IHBhdGg6IG5vdGhpbmcgYW55d2hlcmUgaXMgYWhlYWQgb2YgYW55IHJlbW90ZSDigJQgc2FmZSB0byBkZWxldGUuXG4gIGNvbnN0IGFueVVucHVzaGVkID0gYXdhaXQgcnVuKFtcbiAgICBcImxvZ1wiLFxuICAgIFwiLS1icmFuY2hlc1wiLFxuICAgIFwiLS1ub3RcIixcbiAgICBcIi0tcmVtb3Rlc1wiLFxuICAgIFwiLS1vbmVsaW5lXCIsXG4gICAgXCItMVwiLFxuICBdKTtcbiAgaWYgKGFueVVucHVzaGVkLmNvZGUgIT09IDApIHtcbiAgICAvLyBBIGRpcmVjdG9yeSBnaXQgY2Fubm90IGV2ZW4gcmVhZCBhcyBhIHJlcG9zaXRvcnkgKGVtcHR5IG9yIGNvcnJ1cHRcbiAgICAvLyBgLmdpdGApIGhhcyBubyByZXNjdWFibGUgY29tbWl0cyDigJQgZGVsZXRpbmcgaXQgbG9zZXMgbm90aGluZywgc29cbiAgICAvLyBmYWlsIG9wZW4uIEV2ZXJ5IG90aGVyIGdpdCBmYWlsdXJlIGZhaWxzIGNsb3NlZDogdGhlIGNhbGxlciBrZWVwc1xuICAgIC8vIHRoZSBkaXJlY3RvcnkgcmF0aGVyIHRoYW4gZGVsZXRpbmcgcG9zc2libHktdW5wdXNoZWQgd29yay5cbiAgICBpZiAoL25vdCBhIGdpdCByZXBvc2l0b3J5L2kudGVzdChhbnlVbnB1c2hlZC5zdGRlcnIpKSB7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcHVzaGVkQnJhbmNoZXM6IFtdLCBkZXRhaWw6IFwiXCIgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIHB1c2hlZEJyYW5jaGVzOiBbXSxcbiAgICAgIGRldGFpbDogYGdpdCBsb2cgZmFpbGVkOiAke2FueVVucHVzaGVkLnN0ZGVyci50cmltKCkgfHwgXCJ1bmtub3duXCJ9YCxcbiAgICB9O1xuICB9XG4gIGlmIChhbnlVbnB1c2hlZC5zdGRvdXQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBwdXNoZWRCcmFuY2hlczogW10sIGRldGFpbDogXCJcIiB9O1xuICB9XG5cbiAgY29uc3QgYnJhbmNoTGlzdCA9IGF3YWl0IHJ1bihbXG4gICAgXCJmb3ItZWFjaC1yZWZcIixcbiAgICBcIi0tZm9ybWF0PSUocmVmbmFtZTpzaG9ydClcIixcbiAgICBcInJlZnMvaGVhZHNcIixcbiAgXSk7XG4gIGlmIChicmFuY2hMaXN0LmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgcHVzaGVkQnJhbmNoZXM6IFtdLFxuICAgICAgZGV0YWlsOiBgZ2l0IGZvci1lYWNoLXJlZiBmYWlsZWQ6ICR7YnJhbmNoTGlzdC5zdGRlcnIudHJpbSgpfWAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHB1c2hlZDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBicmFuY2ggb2YgYnJhbmNoTGlzdC5zdGRvdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBuYW1lID0gYnJhbmNoLnRyaW0oKTtcbiAgICBpZiAoIW5hbWUpIGNvbnRpbnVlO1xuICAgIC8vIEEgYnJhbmNoIGlzIHVucHVzaGVkIHdoZW4gaXQgaGFzIGNvbW1pdHMgbm90IG9uIG9yaWdpbi88bmFtZT5cbiAgICAvLyAoYSBtaXNzaW5nIHJlbW90ZSByZWYgbWFrZXMgcmV2LWxpc3QgZmFpbCDigJQgdHJlYXQgYXMgdW5wdXNoZWQpLlxuICAgIGNvbnN0IGFoZWFkID0gYXdhaXQgcnVuKFtcbiAgICAgIFwicmV2LWxpc3RcIixcbiAgICAgIFwiLS1jb3VudFwiLFxuICAgICAgYG9yaWdpbi8ke25hbWV9Li4ke25hbWV9YCxcbiAgICBdKTtcbiAgICBjb25zdCBpc1VucHVzaGVkID0gYWhlYWQuY29kZSAhPT0gMCB8fFxuICAgICAgKHBhcnNlSW50KGFoZWFkLnN0ZG91dC50cmltKCksIDEwKSB8fCAwKSA+IDA7XG4gICAgaWYgKCFpc1VucHVzaGVkKSBjb250aW51ZTtcblxuICAgIGlmIChpc1Byb3RlY3RlZEJyYW5jaChuYW1lKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBwdXNoZWRCcmFuY2hlczogcHVzaGVkLFxuICAgICAgICBkZXRhaWw6XG4gICAgICAgICAgYGJyYW5jaCAnJHtuYW1lfScgaGFzIHVucHVzaGVkIGNvbW1pdHMgYnV0IGlzIHByb3RlY3RlZCDigJQgbm90IGAgK1xuICAgICAgICAgIGBwdXNoaW5nLCBub3QgZGVsZXRpbmdgLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBwdXNoID0gYXdhaXQgcnVuKFtcInB1c2hcIiwgXCJvcmlnaW5cIiwgYCR7bmFtZX06JHtuYW1lfWBdKTtcbiAgICBpZiAocHVzaC5jb2RlICE9PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIHB1c2hlZEJyYW5jaGVzOiBwdXNoZWQsXG4gICAgICAgIGRldGFpbDogYHB1c2ggb2YgJyR7bmFtZX0nIGZhaWxlZDogJHtwdXNoLnN0ZGVyci50cmltKCkgfHwgXCJ1bmtub3duXCJ9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIHB1c2hlZC5wdXNoKG5hbWUpO1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHB1c2hlZEJyYW5jaGVzOiBwdXNoZWQsIGRldGFpbDogXCJcIiB9O1xufVxuXG4vKiogUmV0dXJuIHRydWUgd2hlbiB0aGUgcGF0aCBleGlzdHMgYW5kIGlzIGFjY2Vzc2libGUuICovXG5hc3luYyBmdW5jdGlvbiBwYXRoRXhpc3RzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBSZW1vdmUgYSBkaXJlY3RvcnkgcmVjdXJzaXZlbHk7IHJldHVybnMgUmVzdWx0LXN0eWxlIG91dGNvbWUuICovXG5hc3luYyBmdW5jdGlvbiByZW1vdmVEaXJlY3RvcnkoXG4gIHBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8eyBvazogdHJ1ZSB9IHwgeyBvazogZmFsc2U7IGVycm9yOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqIE1pbmltYWwgcGF0aC1iYXNlbmFtZSBpbXBsZW1lbnRhdGlvbiAoYXZvaWRzIHN0ZC9wYXRoIGltcG9ydCkuICovXG5mdW5jdGlvbiBiYXNlbmFtZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gcC5lbmRzV2l0aChcIi9cIikgPyBwLnNsaWNlKDAsIC0xKSA6IHA7XG4gIGNvbnN0IGlkeCA9IHRyaW1tZWQubGFzdEluZGV4T2YoXCIvXCIpO1xuICByZXR1cm4gaWR4IDwgMCA/IHRyaW1tZWQgOiB0cmltbWVkLnNsaWNlKGlkeCArIDEpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUVELFNBQVMsbUJBQW1CLFFBQVEsb0JBQW9CO0FBQ3hELFNBQVMsZ0JBQWdCLFFBQVEsZ0NBQWdDO0FBQ2pFLFNBQVMsaUJBQWlCLFFBQVEsa0JBQWtCO0FBQ3BELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUNqRCxTQUFTLGtCQUFrQixRQUFRLHFCQUFxQjtBQUV4RCxrRkFBa0YsR0FDbEYsT0FBTyxNQUFNLDZCQUE2QixFQUFFO0FBRTVDOzs7Ozs7Ozs7Ozs7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
// denoCacheMetadata=9177611909654333792,1980707733183130027