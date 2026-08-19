/**
 * Worker identity helpers for multi-worker visibility.
 *
 * Provides functions to determine the display name for the current worker
 * and to build a standard footer line for issue comments and PR descriptions.
 *
 * Migrated from worker/shared/worker_identity.sh (Issue #900).
 * Issue #436: Add worker name to issue comments and PR descriptions.
 * Issue #604: Add unique worker ID for multi-worker claim tie-breaking.
 */

import { buildRunIdFooterLine } from "./run_id.ts";

/** Options for resolving worker identity. */
export interface WorkerIdentityOptions {
  /** Configured worker name (may be empty). */
  workerName: string;
  /** GitHub username used as fallback when workerName is empty. */
  githubUser: string;
  /**
   * Canonical run id for this worker invocation (Issue #2381). When set,
   * the footer carries a greppable "Run id" line so every comment and PR
   * body is traceable back to the run that produced it. When omitted the
   * footer keeps its historical shape.
   */
  runId?: string;
}

/** Data returned by the worker-identity command. */
export interface WorkerIdentityData {
  displayName: string;
  uniqueId: string;
  footer: string;
}

/**
 * Get the human-readable display name for this worker.
 *
 * Returns workerName if configured, otherwise falls back to the GitHub username.
 */
export function getWorkerDisplayName(options: WorkerIdentityOptions): string {
  if (options.workerName.length > 0) {
    return options.workerName;
  }
  return options.githubUser;
}

/**
 * Get a unique identifier for this worker instance.
 *
 * Always includes the hostname so that workers on different machines are
 * distinguishable even when they share the same workerName or GitHub
 * username (Issue #604).
 *
 * Format: "{workerName}@{hostname}" or "{hostname}-{pid}" as fallback.
 *
 * Used for multi-worker claim tie-breaking (Issue #604).
 */
export function getWorkerUniqueId(workerName: string): string {
  const host = getHostname();
  if (workerName.length > 0) {
    return `${workerName}@${host}`;
  }
  return `${host}-${Deno.pid}`;
}

/**
 * Get the machine hostname using multiple fallback strategies.
 *
 * Tries in order (Issue #1058):
 *   1. Deno.hostname() — requires --allow-sys=hostname
 *   2. Environment variables: HOSTNAME (Linux), COMPUTERNAME (Windows), NAME
 *   3. Running `hostname` command — requires --allow-run
 *   4. Falls back to "unknown-host" only as a last resort
 *
 * Must work on both macOS and Ubuntu.
 */
export function getHostname(): string {
  // Strategy 1: Deno.hostname() (requires --allow-sys=hostname)
  try {
    const h = Deno.hostname();
    if (h.length > 0) return h;
  } catch {
    // Permission denied or unavailable — try fallbacks
  }

  // Strategy 2: Environment variables (requires --allow-env)
  try {
    for (const envVar of ["HOSTNAME", "COMPUTERNAME", "NAME"]) {
      const val = Deno.env.get(envVar);
      if (val !== undefined && val.length > 0) return val;
    }
  } catch {
    // Permission denied — try next fallback
  }

  // Strategy 3: Run hostname command (requires --allow-run)
  try {
    const cmd = new Deno.Command("hostname", {
      stdout: "piped",
      stderr: "null",
    });
    const output = cmd.outputSync();
    if (output.success) {
      const h = new TextDecoder().decode(output.stdout).trim();
      if (h.length > 0) return h;
    }
  } catch {
    // Command not found or permission denied
  }

  return "unknown-host";
}

/**
 * Build a standard footer line for comments and PR bodies.
 *
 * Produces a formatted footer like:
 *   \n---\n\n🤖 Processed by: Vibe Coder Alpha
 *
 * When `options.runId` is set (Issue #2381) a traceability line is added
 * underneath the display name:
 *   \n---\n\n🤖 Processed by: Vibe Coder Alpha\n🏷️ Run id: `vibe-...`
 */
export function buildWorkerFooter(options: WorkerIdentityOptions): string {
  const displayName = getWorkerDisplayName(options);
  let footer = `\n---\n\n🤖 Processed by: ${displayName}`;
  if (options.runId !== undefined && options.runId.trim().length > 0) {
    footer += `\n${buildRunIdFooterLine(options.runId.trim())}`;
  }
  return footer;
}
