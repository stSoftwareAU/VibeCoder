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
  type IssuePhaseCounters,
  type PriorFleetTelemetryTotals,
  type PrOutcomeCounters,
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
    // Issue #2347 — the per-host `issue`-phase pilot counters.
    issuePhaseRuns: 0,
    issuePhaseUsd: 0,
    issuePhaseFirstAttemptGatePasses: 0,
    issuePhaseDurationSeconds: 0,
    issuePhaseSplitRuns: 0,
    // Issue #3403 — the per-tier split of the counters above.
    issuePhaseSonnetRuns: 0,
    issuePhaseSonnetUsd: 0,
    issuePhaseHaikuRuns: 0,
    issuePhaseHaikuUsd: 0,
    // Issue #3404 — per-tier PR outcome counters.
    prRejectionsSonnet: 0,
    prRejectionsHaiku: 0,
    ciFixRunsSonnet: 0,
    ciFixRunsHaiku: 0,
    ciFixUsdSonnet: 0,
    ciFixUsdHaiku: 0,
    prFeedbackRunsSonnet: 0,
    prFeedbackRunsHaiku: 0,
    prFeedbackUsdSonnet: 0,
    prFeedbackUsdHaiku: 0,
    mergedPrsSonnet: 0,
    mergedPrsHaiku: 0,
  };
}

/** A persisted counter, or 0 when the file did not carry a usable one. */
function counterFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fill the issue-phase counters a sidecar written before they existed does not
 * carry (Issue #2347), and the per-tier split a sidecar written before that
 * existed does not carry either (Issue #3403).
 *
 * A missing — or unusable — counter reads as zero, so the host's accumulated
 * history survives the upgrade instead of the merge producing `NaN` totals.
 * The schema version deliberately does **not** move for either addition: same
 * reasoning as #2347 — the addition is purely additive, every prior file
 * still loads, and bumping it would make an older worker treat the new file
 * as `future-schema` and drop the very history this preserves.
 *
 * The per-tier split carries one extra rule: older JSON without tier fields
 * loads as all-sonnet. `haiku` reads
 * straight off the stored value (0 when absent), but `sonnet` is read from
 * the stored value only when it is itself a finite number — otherwise it is
 * backfilled as `max(0, issuePhaseRuns − haikuRuns)` (and the USD equivalent)
 * so a legacy file's pre-split runs and spend are attributed to `sonnet`
 * rather than vanishing from both tiers.
 */
function withIssuePhaseCounters<T extends PriorFleetTelemetryTotals>(
  totals: T,
): T & IssuePhaseCounters {
  const issuePhaseRuns = counterFrom(totals.issuePhaseRuns);
  const issuePhaseUsd = counterFrom(totals.issuePhaseUsd);
  const issuePhaseHaikuRuns = counterFrom(totals.issuePhaseHaikuRuns);
  const issuePhaseHaikuUsd = counterFrom(totals.issuePhaseHaikuUsd);
  const storedSonnetRuns = totals.issuePhaseSonnetRuns;
  const storedSonnetUsd = totals.issuePhaseSonnetUsd;
  return {
    ...totals,
    issuePhaseRuns,
    issuePhaseUsd,
    issuePhaseFirstAttemptGatePasses: counterFrom(
      totals.issuePhaseFirstAttemptGatePasses,
    ),
    issuePhaseDurationSeconds: counterFrom(totals.issuePhaseDurationSeconds),
    issuePhaseSplitRuns: counterFrom(totals.issuePhaseSplitRuns),
    issuePhaseSonnetRuns: typeof storedSonnetRuns === "number" &&
        Number.isFinite(storedSonnetRuns)
      ? storedSonnetRuns
      : Math.max(0, issuePhaseRuns - issuePhaseHaikuRuns),
    issuePhaseSonnetUsd: typeof storedSonnetUsd === "number" &&
        Number.isFinite(storedSonnetUsd)
      ? storedSonnetUsd
      : Math.max(0, issuePhaseUsd - issuePhaseHaikuUsd),
    issuePhaseHaikuRuns,
    issuePhaseHaikuUsd,
  };
}

/**
 * Fill the PR outcome counters (Issue #3404) a sidecar written before they
 * existed does not carry. Absent or unusable reads as zero; the schema version
 * does not move, for the same reasons as the issue-phase counters.
 */
function withPrOutcomeCounters<T extends PriorFleetTelemetryTotals>(
  totals: T,
): T & PrOutcomeCounters {
  return {
    ...totals,
    prRejectionsSonnet: counterFrom(totals.prRejectionsSonnet),
    prRejectionsHaiku: counterFrom(totals.prRejectionsHaiku),
    ciFixRunsSonnet: counterFrom(totals.ciFixRunsSonnet),
    ciFixRunsHaiku: counterFrom(totals.ciFixRunsHaiku),
    ciFixUsdSonnet: counterFrom(totals.ciFixUsdSonnet),
    ciFixUsdHaiku: counterFrom(totals.ciFixUsdHaiku),
    prFeedbackRunsSonnet: counterFrom(totals.prFeedbackRunsSonnet),
    prFeedbackRunsHaiku: counterFrom(totals.prFeedbackRunsHaiku),
    prFeedbackUsdSonnet: counterFrom(totals.prFeedbackUsdSonnet),
    prFeedbackUsdHaiku: counterFrom(totals.prFeedbackUsdHaiku),
    mergedPrsSonnet: counterFrom(totals.mergedPrsSonnet),
    mergedPrsHaiku: counterFrom(totals.mergedPrsHaiku),
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

/**
 * Add a run's totals to the prior cumulative totals.
 *
 * `prior` is typed {@link PriorFleetTelemetryTotals} because it comes off disk:
 * a file written before the issue-phase counters existed carries none, and they
 * must read as zero rather than sum to `NaN` (Issue #2347).
 */
export function mergeCumulative(
  prior: PriorFleetTelemetryTotals,
  run: FleetTelemetryTotals,
): FleetTelemetryTotals {
  const priorIssuePhase = withIssuePhaseCounters(prior);
  const priorPrOutcomes = withPrOutcomeCounters(prior);
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
    // Issue #2347 — the per-host `issue`-phase pilot counters.
    issuePhaseRuns: priorIssuePhase.issuePhaseRuns + run.issuePhaseRuns,
    issuePhaseUsd: priorIssuePhase.issuePhaseUsd + run.issuePhaseUsd,
    issuePhaseFirstAttemptGatePasses:
      priorIssuePhase.issuePhaseFirstAttemptGatePasses +
      run.issuePhaseFirstAttemptGatePasses,
    issuePhaseDurationSeconds: priorIssuePhase.issuePhaseDurationSeconds +
      run.issuePhaseDurationSeconds,
    issuePhaseSplitRuns: priorIssuePhase.issuePhaseSplitRuns +
      run.issuePhaseSplitRuns,
    // Issue #3403 — the per-tier split of the counters above.
    issuePhaseSonnetRuns: priorIssuePhase.issuePhaseSonnetRuns +
      run.issuePhaseSonnetRuns,
    issuePhaseSonnetUsd: priorIssuePhase.issuePhaseSonnetUsd +
      run.issuePhaseSonnetUsd,
    issuePhaseHaikuRuns: priorIssuePhase.issuePhaseHaikuRuns +
      run.issuePhaseHaikuRuns,
    issuePhaseHaikuUsd: priorIssuePhase.issuePhaseHaikuUsd +
      run.issuePhaseHaikuUsd,
    // Issue #3404 — per-tier PR outcome counters.
    prRejectionsSonnet: priorPrOutcomes.prRejectionsSonnet +
      run.prRejectionsSonnet,
    prRejectionsHaiku: priorPrOutcomes.prRejectionsHaiku +
      run.prRejectionsHaiku,
    ciFixRunsSonnet: priorPrOutcomes.ciFixRunsSonnet + run.ciFixRunsSonnet,
    ciFixRunsHaiku: priorPrOutcomes.ciFixRunsHaiku + run.ciFixRunsHaiku,
    ciFixUsdSonnet: priorPrOutcomes.ciFixUsdSonnet + run.ciFixUsdSonnet,
    ciFixUsdHaiku: priorPrOutcomes.ciFixUsdHaiku + run.ciFixUsdHaiku,
    prFeedbackRunsSonnet: priorPrOutcomes.prFeedbackRunsSonnet +
      run.prFeedbackRunsSonnet,
    prFeedbackRunsHaiku: priorPrOutcomes.prFeedbackRunsHaiku +
      run.prFeedbackRunsHaiku,
    prFeedbackUsdSonnet: priorPrOutcomes.prFeedbackUsdSonnet +
      run.prFeedbackUsdSonnet,
    prFeedbackUsdHaiku: priorPrOutcomes.prFeedbackUsdHaiku +
      run.prFeedbackUsdHaiku,
    mergedPrsSonnet: priorPrOutcomes.mergedPrsSonnet + run.mergedPrsSonnet,
    mergedPrsHaiku: priorPrOutcomes.mergedPrsHaiku + run.mergedPrsHaiku,
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
  // Issue #2347: a file written before the issue-phase counters existed loads
  // with them at zero, so every reader sees numbers rather than `undefined`
  // typed as a number. `run` is normalised only when the file carries one —
  // the cumulative totals are what a later run merges onto, and rejecting a
  // file for a missing `run` would throw away the very history this preserves.
  // Issue #3403: a file written before the per-tier split existed loads its
  // runs and spend as `sonnet`, so it loads rather than failing.
  return {
    ...parsed,
    ...(parsed.run
      ? { run: withPrOutcomeCounters(withIssuePhaseCounters(parsed.run)) }
      : {}),
    cumulative: withPrOutcomeCounters(
      withIssuePhaseCounters(parsed.cumulative),
    ),
  };
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
