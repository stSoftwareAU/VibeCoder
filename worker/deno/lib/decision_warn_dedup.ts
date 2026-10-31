/**
 * Once-per-decision warning suppression (Issue #4495).
 *
 * A "Not closing" decision for an issue/PR pair was logged at WARNING on every
 * cycle, even when nothing about it had changed — about 380 identical lines a
 * day. A repeated identical decision is not actionable, so it is warned once
 * when it first applies or when its inputs change, and logged at DEBUG after
 * that.
 *
 * A worker process lasts about an hour and every start re-runs the merged-PR
 * sweep, so an in-memory map alone would warn once per process — the same
 * repeat rate. The last signature per key is therefore also kept in a small
 * JSON file on the work volume (see {@link configureDecisionWarnStore}),
 * loaded when the store is configured and rewritten when a signature changes.
 * With no store configured (a test, a caller with no volume) the map is
 * process-lifetime only.
 *
 * Entries not seen for {@link DECISION_MAX_AGE_MS} are dropped, so the file
 * stays bounded once an issue closes and its pair stops being re-checked.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { defaultLogger } from "./logger.ts";

/** File name of the persisted signatures, inside the work directory. */
export const DECISION_WARN_STORE_FILE = "decision_warn_signatures.json";

/** An entry not seen for this long is dropped (7 days). */
export const DECISION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** An unchanged sighting re-stamps its entry when the stamp is this old (1 day). */
export const DECISION_REFRESH_MS = 24 * 60 * 60 * 1000;

/** One recorded decision: its signature and when that was last persisted. */
interface DecisionEntry {
  signature: string;
  seenAt: number;
}

/** The last signature recorded for each decision key. */
const entries = new Map<string, DecisionEntry>();

/** The persisted store, or undefined while signatures live in memory only. */
let storePath: string | undefined;
let nowFn: () => number = Date.now;

/** Resolve the signature file for a work directory. */
export function decisionWarnStorePath(workDir: string): string {
  return `${workDir.replace(/\/+$/, "")}/${DECISION_WARN_STORE_FILE}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntry(value: unknown): value is DecisionEntry {
  if (typeof value !== "object" || value === null) return false;
  const { signature, seenAt } = value as Record<string, unknown>;
  return typeof signature === "string" && typeof seenAt === "number" &&
    Number.isFinite(seenAt);
}

/** Drop every entry not seen within {@link DECISION_MAX_AGE_MS}. */
function pruneStale(): void {
  const cutoff = nowFn() - DECISION_MAX_AGE_MS;
  for (const [key, entry] of entries) {
    if (entry.seenAt < cutoff) entries.delete(key);
  }
}

/** Read the persisted entries into memory. A fault is logged and reads empty. */
function loadStore(path: string): void {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    defaultLogger.warn(
      `Decision-warning store ${path} unreadable (${
        errorMessage(error)
      }); starting from empty (Issue #4495)`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(text) as { decisions?: unknown };
    const decisions = parsed?.decisions;
    if (
      typeof decisions !== "object" || decisions === null ||
      Array.isArray(decisions)
    ) {
      throw new Error("missing `decisions` object");
    }
    for (const [key, value] of Object.entries(decisions)) {
      if (isEntry(value)) {
        entries.set(key, { signature: value.signature, seenAt: value.seenAt });
      }
    }
  } catch (error) {
    entries.clear();
    defaultLogger.warn(
      `Decision-warning store ${path} is not a valid store (${
        errorMessage(error)
      }); starting from empty (Issue #4495)`,
    );
  }
}

/** Persist the entries tempfile-then-rename. A fault is logged, never thrown. */
function saveStore(path: string): void {
  pruneStale();
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const decisions = Object.fromEntries(entries);
    Deno.writeTextFileSync(
      temp,
      JSON.stringify({ version: 1, decisions }, null, 2) + "\n",
      { createNew: true, mode: 0o600 },
    );
    Deno.renameSync(temp, path);
  } catch (error) {
    try {
      Deno.removeSync(temp);
    } catch {
      // The temp file was never created; nothing to clean up.
    }
    defaultLogger.warn(
      `Decision-warning store ${path} could not be written (${
        errorMessage(error)
      }); repeats will warn again after a restart (Issue #4495)`,
    );
  }
}

/**
 * Keep decision signatures in `workDir` so they survive a worker restart.
 *
 * Call once at start-up, before the first decision is logged. Signatures
 * already in memory are kept; the persisted ones are merged beneath them.
 * The directory is passed in rather than read from `WORK_DIR`, so a suite
 * that never calls this cannot touch the live fleet's file (Issue #1177).
 *
 * @param workDir - The work volume root, or undefined for memory only.
 * @param now - Clock seam; defaults to `Date.now`.
 */
export function configureDecisionWarnStore(
  workDir: string | undefined,
  now: () => number = Date.now,
): void {
  nowFn = now;
  const dir = workDir?.trim();
  storePath = dir ? decisionWarnStorePath(dir) : undefined;
  if (!storePath) return;
  const inMemory = new Map(entries);
  entries.clear();
  loadStore(storePath);
  pruneStale();
  for (const [key, entry] of inMemory) entries.set(key, entry);
}

/**
 * Whether a decision should be logged at WARNING.
 *
 * Returns true when no signature is recorded for `key`, or when the recorded
 * signature differs from `signature` — and records `signature` in either case.
 * Returns false when the recorded signature is identical.
 *
 * @param key - Identifies the decision, e.g. one issue/PR pair.
 * @param signature - The inputs that make the decision what it is.
 * @returns true when the decision is new or changed since it was last recorded.
 */
export function shouldWarnDecision(key: string, signature: string): boolean {
  const now = nowFn();
  const recorded = entries.get(key);
  if (recorded?.signature === signature) {
    // Re-stamp now and then so a pair still being re-checked is not aged out.
    if (now - recorded.seenAt >= DECISION_REFRESH_MS) {
      recorded.seenAt = now;
      if (storePath) saveStore(storePath);
    }
    return false;
  }
  entries.set(key, { signature, seenAt: now });
  if (storePath) saveStore(storePath);
  return true;
}

/**
 * Clear all recorded decision signatures and detach the persisted store, as a
 * fresh process would find them. Exported for tests.
 */
export function resetDecisionWarnings(): void {
  entries.clear();
  storePath = undefined;
  nowFn = Date.now;
}
