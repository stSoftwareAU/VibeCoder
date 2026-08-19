/**
 * Iteration-scoped registry that coalesces timeline-batch GraphQL calls
 * across the four candidate collectors (Issue #1783).
 *
 * Each candidate collector — `collect_work_on_candidates`,
 * `collect_low_priority_candidates`, `collect_label_candidates`, and
 * `find_issues_by_label` — wraps its `gh` function via `buildBatchedGh`
 * to pre-fetch label-event timelines for every candidate issue. Pre
 * Low-Priority milestone (commit `b59977a`) the worker had three of
 * these collectors; the addition of the low-priority collector pushed
 * the call count to four, and overlapping issue numbers across the
 * collectors mean the same issue's timeline is fetched multiple times
 * per iteration.
 *
 * `TimelineBatchRegistry` provides a single in-memory map per repo
 * for one main-loop iteration, so a second call covering an
 * already-fetched issue is a no-op (the existing entry is reused).
 * The registry is reset at the iteration boundary alongside
 * `gh_call_metrics`. Cross-iteration data still lives in
 * `TimelineCache` (5-min TTL); the registry sits above the cache as
 * a within-iteration dedupe layer.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";
import {
  fetchTimelineBatch,
  wrapGhWithBatchedTimeline,
} from "./timeline_batch.ts";
import type { TimelineLabelEventJson } from "./validation.ts";

/**
 * Shared accumulator for a single main-loop iteration.
 *
 * The registry is stateful and intentionally mutable — `reset()` must
 * be called at the iteration boundary so events from a previous
 * iteration do not bleed into the next.
 */
export class TimelineBatchRegistry {
  /** Per-repo map of issue number -> labelled-event timeline. */
  private readonly byRepo = new Map<
    string,
    Map<number, TimelineLabelEventJson[]>
  >();

  /** Number of `fetchTimelineBatch` calls actually issued (test/metrics). */
  private graphqlCallCount = 0;

  /**
   * Return a `gh` wrapper that serves timeline calls for `issueNumbers`
   * from a shared per-repo map. On the first call for a given issue
   * number the registry issues a `fetchTimelineBatch`; subsequent calls
   * are served from the existing entry without an extra GraphQL round
   * trip.
   *
   * Falls back to `baseGh` for any issue number not in the map (either
   * because it was not requested or because the GraphQL fetch failed).
   * The contract matches `buildBatchedGh` so callers can be swapped in
   * without other changes.
   */
  async getBatchedGh(
    repo: string,
    issueNumbers: number[],
    baseGh: (args: string[]) => Promise<string> = runGhCommand,
  ): Promise<(args: string[]) => Promise<string>> {
    if (issueNumbers.length === 0) {
      return wrapGhWithBatchedTimeline(baseGh, this.getOrInit(repo));
    }

    const events = this.getOrInit(repo);
    const missing: number[] = [];
    for (const num of issueNumbers) {
      if (!events.has(num)) missing.push(num);
    }

    if (missing.length === 0) {
      return wrapGhWithBatchedTimeline(baseGh, events);
    }

    const result = await fetchTimelineBatch(repo, missing, baseGh);
    if (result.ok) {
      this.graphqlCallCount += result.callCount;
      for (const [num, evts] of result.events) {
        events.set(num, evts);
      }
    }
    // On error, the wrapper falls back to baseGh for unknown numbers,
    // matching the pre-existing buildBatchedGh fallback contract.
    return wrapGhWithBatchedTimeline(baseGh, events);
  }

  /**
   * Drop every accumulated entry. Call at the iteration boundary so
   * the next iteration starts with a clean slate.
   */
  reset(): void {
    this.byRepo.clear();
    this.graphqlCallCount = 0;
  }

  /**
   * Number of `fetchTimelineBatch` calls issued since the last reset.
   * Useful for tests and PR-summary metrics.
   */
  getGraphqlCallCount(): number {
    return this.graphqlCallCount;
  }

  /**
   * Number of issue entries currently held for a repo (test helper).
   */
  size(repo: string): number {
    return this.byRepo.get(repo)?.size ?? 0;
  }

  private getOrInit(
    repo: string,
  ): Map<number, TimelineLabelEventJson[]> {
    let m = this.byRepo.get(repo);
    if (!m) {
      m = new Map();
      this.byRepo.set(repo, m);
    }
    return m;
  }
}
