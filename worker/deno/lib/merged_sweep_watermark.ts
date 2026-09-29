/**
 * Per-repo merged-PR sweep watermarks (Issue #4255).
 *
 * `cleanupMergedPrBranches` re-assessed the same last-30 merged PRs per
 * repo on every cycle — up to 28 × 30 × 2 GraphQL `pr list` calls to
 * delete, typically, zero branches. The watermark persists the highest
 * merged-PR number already swept per repo so the next cycle only looks at
 * PRs above it; on a quiet repo the sweep then costs one list call.
 *
 * Same shape as the per-host scan cursor (#2427): a small JSON file in
 * `WORK_DIR`, written tempfile-then-rename so a crash mid-write cannot
 * truncate the live file. A missing or corrupt file reads as empty — the
 * sweep just pays the full cost once and re-persists.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import { defaultLogger } from "./logger.ts";

/** Highest merged-PR number already swept, keyed by "owner/repo". */
export type SweepWatermarks = Record<string, number>;

/** Resolve the watermark file path for a work directory. */
export function mergedSweepWatermarkPath(workDir: string): string {
  return `${workDir}/merged_sweep_watermarks.json`;
}

/**
 * Watermark file for the Close-Issues-for-Merged-PRs reconciler
 * (Issue #4256). A separate file from the branch-cleanup sweep: the two
 * passes advance independently — a branch can be swept while its issue
 * reconciliation is still held back, and vice versa.
 */
export function mergedReconcileWatermarkPath(workDir: string): string {
  return `${workDir}/merged_reconcile_watermarks.json`;
}

/**
 * Watermark file for the merged-PR issue sweep (Issue #1477). Its own file,
 * for the same reason as the reconciler's: the three merged-PR passes
 * advance independently, each holding back on what it alone left undone.
 */
export function mergedIssueSweepWatermarkPath(workDir: string): string {
  return `${workDir}/merged_issue_sweep_watermarks.json`;
}

/** Load watermarks; a missing or corrupt file reads as empty. */
export async function loadSweepWatermarks(
  path: string,
): Promise<SweepWatermarks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const marks: SweepWatermarks = {};
      for (const [repo, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          marks[repo] = value;
        }
      }
      return marks;
    }
  } catch {
    // Missing or corrupt — start fresh; the sweep re-persists.
  }
  return {};
}

/** Persist watermarks atomically. Failures are the caller's to ignore. */
export async function saveSweepWatermarks(
  path: string,
  marks: SweepWatermarks,
): Promise<void> {
  await atomicWrite({
    targetFile: path,
    content: JSON.stringify(marks, null, 2) + "\n",
  });
}

// ---------------------------------------------------------------------------
// v2: merge-order-independent processed set (Issue #2828).
//
// A number watermark skips every PR `<= mark`, so a lower-numbered PR that
// merges after a higher-numbered one is never processed. The v2 store records
// the exact set of processed PR numbers per repo instead, pruned to the
// fetched merged-PR window so the file stays bounded.
// ---------------------------------------------------------------------------

/** v2 on-disk and in-memory shape: processed PR numbers per "owner/repo". */
export interface ProcessedSweepState {
  version: 2;
  repos: Record<string, { processed: number[] }>;
}

/** A fresh, empty v2 state. */
export function emptyProcessedSweepState(): ProcessedSweepState {
  return { version: 2, repos: {} };
}

function isPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalise(numbers: readonly number[]): number[] {
  return [...new Set(numbers.filter(isPrNumber))].sort((a, b) => a - b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a v2 document; `undefined` when its shape is not a valid v2. */
function parseV2(
  parsed: Record<string, unknown>,
  path: string,
  logger: Pick<Logger, "warn">,
): ProcessedSweepState | undefined {
  if (!isPlainObject(parsed.repos)) return undefined;
  const entries: [string, { processed: number[] }][] = [];
  for (const [repo, entry] of Object.entries(parsed.repos)) {
    if (!isPlainObject(entry) || !Array.isArray(entry.processed)) {
      return undefined;
    }
    const invalid = entry.processed.filter((n) => !isPrNumber(n));
    if (invalid.length > 0) {
      logger.warn(
        `Merged-PR sweep state ${path}: dropped ${invalid.length} invalid PR number(s) for ${repo}`,
      );
    }
    entries.push([repo, { processed: normalise(entry.processed) }]);
  }
  // fromEntries defines own properties, so a "__proto__" key cannot re-parent.
  return { version: 2, repos: Object.fromEntries(entries) };
}

/**
 * Load the v2 processed set. A missing file or a legacy v1 number map reads
 * as empty, so the first run after deploy re-examines the whole window (the
 * catch-up). A corrupt file also reads as empty, and is logged as a warning.
 */
export async function loadProcessedSweepState(
  path: string,
  logger: Pick<Logger, "warn"> = defaultLogger,
): Promise<ProcessedSweepState> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return emptyProcessedSweepState();
    }
    logger.warn(
      `Merged-PR sweep state ${path} unreadable (${
        errorMessage(error)
      }); starting from empty`,
    );
    return emptyProcessedSweepState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn(
      `Merged-PR sweep state ${path} is not valid JSON (${
        errorMessage(error)
      }); starting from empty`,
    );
    return emptyProcessedSweepState();
  }

  if (isPlainObject(parsed)) {
    // Legacy v1 `Record<string, number>` — no `version` key. Empty on purpose.
    if (!("version" in parsed)) return emptyProcessedSweepState();
    if (parsed.version === 2) {
      const state = parseV2(parsed, path, logger);
      if (state) return state;
    }
  }
  logger.warn(
    `Merged-PR sweep state ${path} has an unrecognised shape; starting from empty`,
  );
  return emptyProcessedSweepState();
}

/** Persist the v2 processed set atomically. Errors propagate to the caller. */
export async function saveProcessedSweepState(
  path: string,
  state: ProcessedSweepState,
): Promise<void> {
  await atomicWrite({
    targetFile: path,
    content: JSON.stringify(state, null, 2) + "\n",
  });
}

/** `repo`'s processed numbers, or `undefined` when the repo has none recorded. */
function processedFor(
  state: ProcessedSweepState,
  repo: string,
): number[] | undefined {
  return Object.hasOwn(state.repos, repo)
    ? state.repos[repo]?.processed
    : undefined;
}

/** Whether `prNumber` has already been processed for `repo`. */
export function isProcessed(
  state: ProcessedSweepState,
  repo: string,
  prNumber: number,
): boolean {
  return processedFor(state, repo)?.includes(prNumber) ?? false;
}

/** Return a new state with `prNumber` recorded as processed for `repo`. */
export function markProcessed(
  state: ProcessedSweepState,
  repo: string,
  prNumber: number,
): ProcessedSweepState {
  if (!isPrNumber(prNumber)) {
    throw new RangeError(`Invalid PR number for ${repo}: ${prNumber}`);
  }
  const current = processedFor(state, repo) ?? [];
  return {
    version: 2,
    repos: {
      ...state.repos,
      [repo]: { processed: normalise([...current, prNumber]) },
    },
  };
}

/**
 * Return a new state keeping only `repo`'s numbers still present in the
 * fetched merged-PR window, so the stored set stays bounded by the window.
 * Call it only after a successful fetch — a partial window forgets PRs.
 */
export function pruneToWindow(
  state: ProcessedSweepState,
  repo: string,
  windowPrNumbers: readonly number[],
): ProcessedSweepState {
  const current = processedFor(state, repo);
  if (!current) return state;
  const window = new Set(windowPrNumbers);
  return {
    version: 2,
    repos: {
      ...state.repos,
      [repo]: {
        processed: current.filter((n) => window.has(n)),
      },
    },
  };
}
