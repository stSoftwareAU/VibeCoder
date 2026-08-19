/**
 * Structured fault tolerance event counters for observability (Issue #1168, #1173).
 *
 * Provides a centralised way to observe retry, backoff, circuit-breaker
 * activation, heartbeat failure, and timeout frequencies. Counters are
 * in-memory only (reset each worker cycle) and intended for diagnostic
 * logging at the end of a scan cycle.
 *
 * Issue #1173 adds the structured counter API (incrementCounter, getCounters,
 * resetCounters, writeSummary) and wires counters into all fault tolerance
 * source files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Categories of fault tolerance events that can be counted. */
export type FaultEvent =
  | "heartbeat_failure"
  | "heartbeat_success"
  | "circuit_breaker_open"
  | "circuit_breaker_reset"
  | "retry_attempt"
  | "rate_limit_backoff"
  | "timeout"
  | "crash_recovery"
  | "claim_conflict"
  | "disk_space_cleanup"
  | "catch_block_warning"
  | "promise_settled_rejection";

/** Snapshot of all counters at a point in time. */
export interface CounterSnapshot {
  readonly counters: ReadonlyMap<FaultEvent, number>;
  readonly totalEvents: number;
}

const faultEventCounters = new Map<FaultEvent, number>();

const namedCounters = new Map<string, number>();

/**
 * Increment the counter for a fault tolerance event.
 *
 * Optionally logs a warning-level message for diagnostic purposes.
 *
 * Issue #3648: the diagnostic line goes to `console.warn`, which bypasses the
 * logger's redacting write path (`logger.ts`). Callers pass attacker- and
 * secret-adjacent text — `subprocess_timeout.ts` hands over a full interpolated
 * command line, which can carry a tokenised clone URL or a `--api-key` flag —
 * so the context is scrubbed here rather than relying on the sink.
 */
export function recordFaultEvent(
  event: FaultEvent,
  context?: string,
): void {
  const current = faultEventCounters.get(event) ?? 0;
  faultEventCounters.set(event, current + 1);
  if (context) {
    console.warn(`[fault-tolerance] ${event}: ${redactSecrets(context)}`);
  }
}

/**
 * Get the current count for a specific event type.
 */
export function getFaultEventCount(event: FaultEvent): number {
  return faultEventCounters.get(event) ?? 0;
}

/**
 * Get a snapshot of all counters.
 */
export function getCounterSnapshot(): CounterSnapshot {
  let total = 0;
  for (const count of faultEventCounters.values()) {
    total += count;
  }
  return {
    counters: new Map(faultEventCounters),
    totalEvents: total,
  };
}

/**
 * Reset all counters to zero. Call at the start of each scan cycle.
 */
export function resetFaultCounters(): void {
  faultEventCounters.clear();
}

/**
 * Format a summary of all non-zero counters for logging.
 *
 * Returns null if no events were recorded.
 */
export function formatCounterSummary(): string | null {
  const snapshot = getCounterSnapshot();
  if (snapshot.totalEvents === 0) return null;

  const lines: string[] = ["[fault-tolerance] Cycle summary:"];
  for (const [event, count] of snapshot.counters) {
    if (count > 0) {
      lines.push(`  ${event}: ${count}`);
    }
  }
  lines.push(`  total: ${snapshot.totalEvents}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Structured counter API (Issue #1173)
// ---------------------------------------------------------------------------

/**
 * Increment a named counter by one.
 *
 * Accepts any string name, allowing callers to use the issue-specified
 * counter names (retryAttempts, rateLimitBackoffs, etc.) directly.
 */
export function incrementCounter(name: string): void {
  const current = namedCounters.get(name) ?? 0;
  namedCounters.set(name, current + 1);
}

/**
 * Get all non-zero named counters as a plain object.
 */
export function getCounters(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, count] of namedCounters) {
    if (count > 0) {
      result[name] = count;
    }
  }
  return result;
}

/**
 * Reset all named counters to zero. Call at the start of each worker cycle.
 */
export function resetCounters(): void {
  namedCounters.clear();
}

/**
 * Write a JSON summary of all named counters to disk.
 *
 * Writes to `{workDir}/fault_tolerance_summary.json` with timestamp,
 * counters, and worker identity. This file is diagnostic only — it
 * does not affect worker behaviour.
 */
export async function writeSummary(workDir: string): Promise<Result<void>> {
  const counters = getCounters();
  let hostname = "unknown";
  try {
    hostname = Deno.hostname();
  } catch {
    // hostname unavailable — use fallback
  }

  const summary = {
    timestamp: new Date().toISOString(),
    counters,
    workerIdentity: hostname,
  };

  const path = `${workDir}/fault_tolerance_summary.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to write fault tolerance summary to ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
}
