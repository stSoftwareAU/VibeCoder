/**
 * Per-host scan cursor (Issue #2427).
 *
 * Persists the priority level that was in flight when the priority-dispatch
 * loop last advanced, so a rate-limit pause that resumes — or a quick worker
 * restart — can re-enter the dispatch near where it stopped instead of always
 * restarting at Priority 1 (PR feedback) and burning the freshly-refreshed
 * GraphQL quota on the earlier priorities before reaching Priority 2 issue
 * scanning.
 *
 * Design (per Issue #2427):
 *   - **What to persist:** the priority level + repo index in flight, written
 *     atomically to a small JSON file in `WORK_DIR`
 *     (`scan_cursor_<hostname>.json`). Schema:
 *     `{ priority: number, repoIndex: number, savedAt: <epoch seconds> }`.
 *   - **When to read:** when the dispatch loop (re)starts. If the cursor is
 *     younger than {@link CURSOR_STALENESS_SECONDS}, resume from
 *     `cursor.priority`; otherwise start at Priority 1.
 *   - **Staleness guard:** a cursor older than {@link CURSOR_STALENESS_SECONDS}
 *     is treated as absent, so a stale snapshot left behind by a SIGTERM or
 *     crash never causes a wrong resume.
 *   - **Multi-host safety:** the filename embeds the hostname (not the PID), so
 *     two workers on different hosts can't trample each other and the cursor
 *     survives a worker restart on the same host.
 *
 * The file is tiny (well under 200 bytes) and written tempfile-then-rename so a
 * hostile crash mid-write cannot truncate the live cursor.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { getHostname } from "./worker_identity.ts";
import { atomicWrite } from "./file_utils.ts";

/**
 * Maximum age (seconds) of a cursor that is still trusted for resume. A cursor
 * at or beyond this age is ignored — the dispatch starts at Priority 1.
 */
export const CURSOR_STALENESS_SECONDS = 60;

/** Persisted scan-cursor snapshot. */
export interface ScanCursor {
  /** Priority level that was in flight (1, 1.5, …, 2). */
  priority: number;
  /** Repo index in flight within that priority (0-based; best-effort). */
  repoIndex: number;
  /** Unix timestamp (seconds) when the cursor was written. */
  savedAt: number;
}

/** A cursor without its `savedAt` stamp — the writer stamps it at write time. */
export type ScanCursorInput = Omit<ScanCursor, "savedAt">;

/** Default seconds-resolution clock. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sanitise a hostname for safe use in a filename. Hostnames are normally
 * `[A-Za-z0-9.-]`, but an unexpected character (or a fully-qualified name with
 * a slash from an env-var fallback) must never escape the cursor file out of
 * `WORK_DIR`. Any character outside the allowlist becomes `_`.
 */
function sanitiseHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

/**
 * Return the path to the per-host scan-cursor file inside `workDir`.
 *
 * @param workDir - Worker working directory holding worker state files
 * @param hostname - Host identity (defaults to {@link getHostname})
 */
export function scanCursorPath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/scan_cursor_${sanitiseHostname(hostname)}.json`;
}

/**
 * Write the scan cursor atomically (write-to-tmp then rename).
 *
 * @param path - Cursor file path (see {@link scanCursorPath})
 * @param cursor - Priority + repo index to persist; `savedAt` is stamped here
 * @param nowFn - Injectable seconds clock for testing
 */
export async function writeScanCursor(
  path: string,
  cursor: ScanCursorInput,
  nowFn: () => number = nowSeconds,
): Promise<Result<void>> {
  const snapshot: ScanCursor = {
    priority: cursor.priority,
    repoIndex: cursor.repoIndex,
    savedAt: nowFn(),
  };
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(snapshot),
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(`Failed to write scan cursor: ${result.error.message}`),
  };
}

/**
 * Reset the cursor to the start-of-cycle position `{ priority: 1, repoIndex: 0 }`.
 * Called after a successful issue claim so the next cycle starts normally.
 */
export function resetScanCursor(
  path: string,
  nowFn: () => number = nowSeconds,
): Promise<Result<void>> {
  return writeScanCursor(path, { priority: 1, repoIndex: 0 }, nowFn);
}

/**
 * Read the scan cursor. Returns `null` when the file is missing, unreadable,
 * truncated/corrupt, or fails schema validation — callers treat any of these
 * as "no cursor" and start at Priority 1.
 */
export async function readScanCursor(path: string): Promise<ScanCursor | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as Partial<ScanCursor>;
    if (
      typeof parsed.priority !== "number" ||
      !Number.isFinite(parsed.priority) ||
      typeof parsed.repoIndex !== "number" ||
      !Number.isFinite(parsed.repoIndex) ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt)
    ) {
      return null;
    }
    return {
      priority: parsed.priority,
      repoIndex: parsed.repoIndex,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a cursor is fresh enough to trust for resume.
 *
 * Fresh ⇔ age strictly below `maxAgeSeconds`. A future-stamped cursor (clock
 * skew, negative age) is treated as fresh.
 */
export function isCursorFresh(
  cursor: ScanCursor,
  now: number = nowSeconds(),
  maxAgeSeconds: number = CURSOR_STALENESS_SECONDS,
): boolean {
  return now - cursor.savedAt < maxAgeSeconds;
}

/**
 * Resolve the priority the dispatch loop should resume from.
 *
 * Returns `cursor.priority` when the cursor is present and fresh; otherwise
 * `1` (start at the top of the priority table, as today).
 */
export function resolveStartPriority(
  cursor: ScanCursor | null,
  now: number = nowSeconds(),
  maxAgeSeconds: number = CURSOR_STALENESS_SECONDS,
): number {
  if (cursor !== null && isCursorFresh(cursor, now, maxAgeSeconds)) {
    return cursor.priority;
  }
  return 1;
}
