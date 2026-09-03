/**
 * Durable fleet-telemetry sidecar (Issue #855).
 *
 * `fleet_telemetry.ts` accumulates in memory for the life of one run. This
 * module persists those numbers as a machine-readable JSON sidecar so idle
 * time, blocked time and success rate can be trended across runs rather
 * than lost at exit:
 *
 *   {workDir}/fleet_telemetry_{host}.json
 *
 * The hostname rides in the filename — never the PID — so several workers
 * sharing a work volume keep separate files instead of clobbering one
 * another, matching `scan_cursor.ts`.
 *
 * `run` holds this run's totals; `cumulative` holds every run this host has
 * recorded. Re-writing during a run replaces `run` and recomputes
 * `cumulative` from the totals read when the run first wrote, so a
 * per-cycle write never double counts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import {
  type FleetTelemetrySnapshot,
  type FleetTelemetryTotals,
  getFleetTelemetry,
} from "./fleet_telemetry.ts";
import { getHostname } from "./worker_identity.ts";

/** Sidecar schema version — bumped when the shape changes. */
export const FLEET_TELEMETRY_SCHEMA = 1;

/** On-disk shape of the sidecar. */
export interface FleetTelemetryFile {
  schema: number;
  host: string;
  /** ISO timestamp of the write. */
  updatedAt: string;
  /** This run's totals plus its derived rates. */
  run: FleetTelemetrySnapshot;
  /** Every run this host has recorded. */
  cumulative: FleetTelemetryTotals;
}

/** Options for {@link writeFleetTelemetryFile}. */
export interface WriteFleetTelemetryOptions {
  hostname?: string;
  nowMs?: number;
  /**
   * Reports a sidecar that exists but could not be used as a baseline.
   * The write still proceeds from zero, but the loss of the host's
   * accumulated history is never silent.
   */
  warn?: (message: string) => void;
}

/**
 * Sanitise a hostname for safe use in a filename. Anything outside the
 * allowlist becomes `_`, so a hostname carrying a separator can never
 * escape the sidecar out of `workDir`.
 */
function sanitiseHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

/** Path to this host's fleet-telemetry sidecar inside `workDir`. */
export function fleetTelemetryPath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/fleet_telemetry_${sanitiseHostname(hostname)}.json`;
}

/** Zeroed totals — the baseline when no sidecar exists yet. */
export function emptyTotals(): FleetTelemetryTotals {
  return {
    wallSeconds: 0,
    idleSeconds: 0,
    idleByReason: {},
    occupiedSeconds: 0,
    busySeconds: 0,
    busyByStream: {},
    tokenBlockedSeconds: 0,
    rateLimitedSeconds: 0,
    rateLimitWaits: 0,
    tokenBlockedWaits: 0,
    claims: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    failuresByClass: {},
  };
}

function addMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

/** Add a run's totals to the prior cumulative totals. */
export function mergeCumulative(
  prior: FleetTelemetryTotals,
  run: FleetTelemetryTotals,
): FleetTelemetryTotals {
  return {
    wallSeconds: prior.wallSeconds + run.wallSeconds,
    idleSeconds: prior.idleSeconds + run.idleSeconds,
    idleByReason: addMaps(prior.idleByReason, run.idleByReason),
    occupiedSeconds: prior.occupiedSeconds + run.occupiedSeconds,
    busySeconds: prior.busySeconds + run.busySeconds,
    busyByStream: addMaps(prior.busyByStream, run.busyByStream),
    tokenBlockedSeconds: prior.tokenBlockedSeconds + run.tokenBlockedSeconds,
    rateLimitedSeconds: prior.rateLimitedSeconds + run.rateLimitedSeconds,
    rateLimitWaits: prior.rateLimitWaits + run.rateLimitWaits,
    tokenBlockedWaits: prior.tokenBlockedWaits + run.tokenBlockedWaits,
    claims: prior.claims + run.claims,
    successes: prior.successes + run.successes,
    failures: prior.failures + run.failures,
    skips: prior.skips + run.skips,
    failuresByClass: addMaps(prior.failuresByClass, run.failuresByClass),
  };
}

/** Why a sidecar could not be used as a baseline. */
export type FleetTelemetryReadFault =
  | "absent"
  | "unreadable"
  | "unparseable"
  | "future-schema";

/**
 * Read the sidecar. A corrupt sidecar is diagnostic data, so it is
 * replaced on the next write rather than failing the run — but the
 * distinction between "absent" and "present but unusable" is preserved so
 * the caller can say which happened instead of silently resetting the
 * host's accumulated history.
 */
export async function readFleetTelemetryFile(
  workDir: string,
  hostname: string = getHostname(),
): Promise<FleetTelemetryFile | FleetTelemetryReadFault> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(fleetTelemetryPath(workDir, hostname));
  } catch (err) {
    return err instanceof Deno.errors.NotFound ? "absent" : "unreadable";
  }
  let parsed: FleetTelemetryFile;
  try {
    parsed = JSON.parse(raw) as FleetTelemetryFile;
  } catch {
    return "unparseable";
  }
  if (
    typeof parsed?.schema !== "number" ||
    typeof parsed?.cumulative?.idleSeconds !== "number"
  ) {
    return "unparseable";
  }
  // A file written by a newer worker is not ours to merge as if it were
  // schema 1 — that would silently mix incompatible totals.
  if (parsed.schema > FLEET_TELEMETRY_SCHEMA) return "future-schema";
  return parsed;
}

/** Narrow a {@link readFleetTelemetryFile} result to a usable file. */
export function isFleetTelemetryFile(
  result: FleetTelemetryFile | FleetTelemetryReadFault,
): result is FleetTelemetryFile {
  return typeof result !== "string";
}

/**
 * Cumulative totals this run started from. Keyed by sidecar path and the
 * accumulation window's run token, so a second write in the same run
 * reuses the baseline (no double count) while a new run re-reads it.
 */
let baselineKey: string | undefined;
let baselineTotals: FleetTelemetryTotals | undefined;

/**
 * Write the sidecar. Fails loudly (a non-ok `Result`) when the file cannot
 * be written — a telemetry write that quietly does nothing is exactly the
 * silent failure this telemetry exists to surface.
 */
export async function writeFleetTelemetryFile(
  workDir: string,
  options: WriteFleetTelemetryOptions = {},
): Promise<Result<string>> {
  const hostname = options.hostname ?? getHostname();
  const nowMs = options.nowMs ?? Date.now();
  const path = fleetTelemetryPath(workDir, hostname);
  const run = getFleetTelemetry(nowMs);

  const cacheKey = `${path}#${run.runToken}`;
  if (baselineKey !== cacheKey || baselineTotals === undefined) {
    const prior = await readFleetTelemetryFile(workDir, hostname);
    if (isFleetTelemetryFile(prior)) {
      baselineTotals = prior.cumulative;
    } else {
      // "absent" is the ordinary first write; anything else means this
      // host's accumulated totals are being dropped, and that must be
      // said out loud rather than reported as a clean start.
      if (prior !== "absent") {
        options.warn?.(
          `Fleet telemetry sidecar at ${path} is ${prior} — cumulative ` +
            `totals restart from zero.`,
        );
      }
      baselineTotals = emptyTotals();
    }
    baselineKey = cacheKey;
  }
  const baseline = baselineTotals;

  const contents: FleetTelemetryFile = {
    schema: FLEET_TELEMETRY_SCHEMA,
    host: hostname,
    updatedAt: new Date(nowMs).toISOString(),
    run,
    cumulative: mergeCumulative(baseline, run),
  };

  const written = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(contents, null, 2),
  });
  if (!written.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to write fleet telemetry to ${path}: ${written.error.message}`,
      ),
    };
  }
  return { ok: true, value: path };
}
