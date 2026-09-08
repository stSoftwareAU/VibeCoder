/**
 * Where a PR-kind pass writes its heartbeat state (Issue #1662).
 *
 * The PR-feedback, CI-fix and spelling passes all run with two directories in
 * play — the clone every git and agent `cwd` uses, and the `WORK_DIR` root
 * that holds `.heartbeat_*` and `.heartbeat-marker_*`. Each suite asserts the
 * state landed in the root and the clone gained nothing, so the recorder stub
 * and the stray scan live here rather than three times over.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CrashHandlingDeps } from "../../lib/issue_worker_wiring.ts";
import {
  heartbeatFilePath,
  markerStateFilePath,
} from "../../lib/heartbeat_storage.ts";

/** The directories a pass handed its heartbeat calls. */
export interface HeartbeatDirs {
  /** Every directory `recordHeartbeat` was called with, in order. */
  record: string[];
  /** Every directory `clearHeartbeat` was called with, in order. */
  clear: string[];
}

/**
 * Crash-handling overrides whose recorder writes the same two state files the
 * real one does, so the directory a pass points at is observable on disk.
 */
export function trackHeartbeatDirs(
  dirs: HeartbeatDirs,
): Partial<CrashHandlingDeps> {
  return {
    recordHeartbeat: async (dir, repo, issueNumber) => {
      dirs.record.push(dir);
      await Deno.writeTextFile(
        heartbeatFilePath(dir, repo, issueNumber),
        `${Date.now()}`,
      );
      await Deno.writeTextFile(
        markerStateFilePath(dir, repo, issueNumber),
        "{}",
      );
      return { ok: true, value: undefined };
    },
    clearHeartbeat: (dir) => {
      dirs.clear.push(dir);
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

/** The heartbeat and marker files sitting at the top level of `dir`. */
export async function heartbeatStrays(dir: string): Promise<string[]> {
  const strays: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.name.startsWith(".heartbeat_") ||
      entry.name.startsWith(".heartbeat-marker_")
    ) {
      strays.push(entry.name);
    }
  }
  return strays.sort();
}
