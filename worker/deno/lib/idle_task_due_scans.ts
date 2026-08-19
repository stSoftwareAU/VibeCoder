/**
 * Cached overdue-(repo, template) lookup for the idle-task filer (Issue #4009).
 *
 * The cadence policy (#4008) decides *which* pairs are overdue; the freshness
 * report (#3864, #4007) supplies the history it reasons over. This module is
 * the thin, cost-controlled join between them that the filer calls once per
 * idle tick.
 *
 * ## Cost control
 *
 * Reconstructing freshness costs one `gh issue list` per monitored repo, so it
 * must not be paid on every tick. Two measures bound it:
 *
 *   1. **In-process cache with a TTL.** The computed due list is memoised for
 *      {@link DUE_SCAN_CACHE_TTL_MS} (6 h) against the repo set it was built
 *      for. Ticks inside the window pay **zero** `gh` calls. The clock is the
 *      caller's — the filer already injects one — so tests drive expiry without
 *      waiting.
 *   2. **No per-wrapper outcome read.** Cadence needs *dates*, not whether a
 *      scan filed findings, so the closing-comment read (`gh issue view`, one
 *      per pair) is stubbed out. Only the bounded history list per repo remains,
 *      restricted to the important templates.
 *
 * A cached due list going slightly stale is harmless: the filer re-runs every
 * gate (dedup, cooldown, busy, backlog, `shouldFile`) against each pair before
 * filing, so a pair filed five minutes ago is skipped by its own cooldown on the
 * next tick rather than filed twice.
 *
 * Failures stay loud but non-fatal at the *pair* level and are surfaced by the
 * caller: a repo whose history cannot be read is reported as `unknown` by the
 * freshness collector (with a warning) and contributes no due pairs, while a
 * malformed timestamp throws out of {@link computeDueScans} for the filer to
 * log as `bias_none reason=freshness_failed`. Neither is reconciled as "fresh".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  type CadencePolicy,
  computeDueScans,
  DEFAULT_CADENCE_POLICY,
  type DueScan,
} from "./idle_task_cadence.ts";
import { collectIdleTaskFreshness } from "./idle_task_freshness.ts";

/** How long a computed due list is reused before the history is re-read. */
export const DUE_SCAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Options for {@link loadDueScans}. */
export interface LoadDueScansOptions {
  /** Monitored repositories in `owner/repo` form. */
  repos: readonly string[];
  /** Reference instant — the caller owns the clock. */
  now: Date;
  /** Injectable `gh` runner threaded into the freshness reads. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Cadence policy; defaults to {@link DEFAULT_CADENCE_POLICY}. */
  policy?: CadencePolicy;
  /** Warning sink for degraded freshness reads. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

interface DueScanCacheEntry {
  key: string;
  expiresAtMs: number;
  scans: DueScan[];
}

let cache: DueScanCacheEntry | null = null;

/**
 * Drop the memoised due list. Exported for tests — production never needs it,
 * because the TTL already bounds how stale a reading can get.
 */
export function resetDueScanCache(): void {
  cache = null;
}

/** Cache identity: the repo set plus the templates the policy governs. */
function cacheKey(
  repos: readonly string[],
  templates: readonly string[],
): string {
  return `${[...repos].join(",")}|${[...templates].join(",")}`;
}

/**
 * Overdue (repo, template, tier) pairs, most overdue first, memoised for
 * {@link DUE_SCAN_CACHE_TTL_MS}.
 *
 * @throws Error when the cadence computation rejects the history (an
 * unparseable timestamp or an unusable window) — the caller fails open.
 */
export async function loadDueScans(
  opts: LoadDueScansOptions,
): Promise<DueScan[]> {
  const policy = opts.policy ?? DEFAULT_CADENCE_POLICY;
  const templateNames = Object.keys(policy.templates);
  const key = cacheKey(opts.repos, templateNames);
  const nowMs = opts.now.getTime();

  if (cache !== null && cache.key === key && nowMs < cache.expiresAtMs) {
    return cache.scans;
  }

  const report = await collectIdleTaskFreshness({
    repos: opts.repos,
    templateNames,
    ghCommandFn: opts.ghCommandFn,
    // Cadence reasons over dates alone, so the per-wrapper closing-comment
    // read is skipped entirely — that is the `gh issue view` call per pair.
    fetchCloseSummaryFn: () => Promise.resolve(null),
    nowFn: () => opts.now,
    warn: opts.warn,
  });

  const scans = computeDueScans(report.entries, opts.now, policy);
  cache = { key, expiresAtMs: nowMs + DUE_SCAN_CACHE_TTL_MS, scans };
  return scans;
}
