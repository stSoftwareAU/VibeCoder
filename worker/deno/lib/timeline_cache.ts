/**
 * File-backed TTL cache for issue-timeline label events (Issue #1673).
 *
 * Wraps `IssueCache` with a dedicated cache directory and shorter
 * default TTL (5 minutes) to cache the parsed `TimelineLabelEventJson[]`
 * arrays returned by `gh api repos/{repo}/issues/{N}/timeline`.
 *
 * Used by `wasLabelAddedByAllowedAuthor` and `getLabelLastAddInfo` to
 * collapse the per-issue N+1 timeline call pattern that dominates a
 * scan when many candidate issues fail the fast-path author check.
 *
 * Worker-initiated label changes invalidate the corresponding entry
 * via `invalidateTimelineCache` so the next read sees fresh data.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { IssueCache } from "./issue_cache.ts";
import { defaultLogger } from "./logger.ts";
import {
  cacheDirUserSuffix,
  ensurePrivateDir,
  verifyPrivateDir,
} from "./private_cache_dir.ts";
import type { TimelineLabelEventJson } from "./validation.ts";

/**
 * Internal cache-entry shape (Issue #3296).
 *
 * The timeline can be written by two different readers that disagree on
 * how much of it they fetched:
 *
 * - `fetchTimelineWithCache` reads only page 1 (the oldest 100 events) and
 *   writes a **partial** entry (`complete: false`).
 * - `wasLabelAddedByAllowedAuthor` paginates the REST timeline to exhaustion
 *   and writes a **complete** entry (`complete: true`).
 *
 * The reserved-label trust gate must never treat a partial (truncated)
 * timeline as authoritative — on a busy issue (>100 timeline events) the
 * genuinely most-recent `labeled` event falls beyond page 1, so a truncated
 * slice can hide an untrusted re-add behind a stale trusted add. The
 * `complete` flag lets the trust gate distinguish the two and re-paginate
 * when only a partial entry is cached (Issue #3296, reinstating the
 * Issue #3200 hardening on the cache-hit path).
 */
interface StoredTimeline {
  events: TimelineLabelEventJson[];
  complete: boolean;
}

/** Type guard for the current wrapper cache-entry format. */
function isStoredTimeline(value: unknown): value is StoredTimeline {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as StoredTimeline).events) &&
    typeof (value as StoredTimeline).complete === "boolean"
  );
}

/**
 * Cache key suffix for the timeline of a single issue.
 *
 * The full key passed to `IssueCache` is `<issueNumber>#timeline`. The
 * repo and issue number together identify the timeline; the suffix
 * disambiguates from other per-repo entries the cache may hold.
 */
function timelineKey(issueNumber: number): string {
  return `${issueNumber}#timeline`;
}

/**
 * Default cache directory for timeline entries.
 *
 * Kept distinct from the general issue cache so its shorter TTL does
 * not affect (or get overridden by) entries written through the
 * default `IssueCache` instance.
 *
 * Issue #3709: the path carries a per-account suffix so two users on a shared
 * host never share one directory under a world-writable `TMPDIR`, and the
 * directory itself is created `0700` and ownership-checked before use (see
 * {@link TimelineCache.dirIsPrivate}).
 */
function defaultTimelineCacheDir(): string {
  const tmpDir = Deno.env.get("TMPDIR") ?? "/tmp";
  return `${tmpDir}/vibe-timeline-cache-deno-${cacheDirUserSuffix()}`;
}

/**
 * File-backed TTL cache for timeline label events.
 *
 * Thin wrapper around `IssueCache` so the same hit/miss telemetry
 * counters in `gh_call_metrics.ts` apply. The cache stores the
 * parsed `TimelineLabelEventJson[]` array (not the raw JSON string)
 * so consumers do not re-parse on every hit.
 */
export class TimelineCache {
  private readonly inner: IssueCache;
  private readonly cacheDir: string;
  /** Memoised result of the one-off directory ownership check. */
  private privateDirCheck: Promise<boolean> | null = null;

  /**
   * @param ttlSeconds - Cache TTL in seconds (default 300 = 5 minutes).
   * @param cacheDir - Optional directory override (defaults to a dedicated
   *   subdirectory under TMPDIR).
   */
  constructor(ttlSeconds = 300, cacheDir?: string) {
    this.cacheDir = cacheDir ?? defaultTimelineCacheDir();
    this.inner = new IssueCache(this.cacheDir, ttlSeconds);
  }

  /**
   * Whether the backing directory is worker-private (Issue #3709).
   *
   * Creates it `0700` when absent, then checks ownership and permission bits.
   * A directory another account could have written to is not usable — every
   * read and write is skipped and the worker falls back to a live API call,
   * so tampered-with cache content can never reach a caller. The failure is
   * logged loudly rather than swallowed; the check runs once per instance.
   */
  private dirIsPrivate(): Promise<boolean> {
    this.privateDirCheck ??= (async () => {
      try {
        await ensurePrivateDir(this.cacheDir);
      } catch {
        // Creation failure is reported by the verification below.
      }
      const trust = await verifyPrivateDir(this.cacheDir);
      if (!trust.trusted) {
        defaultLogger.warn(
          "Timeline cache directory is not worker-private — cache disabled " +
            "(Issue #3709)",
          { cacheDir: this.cacheDir, reason: trust.reason ?? "unknown" },
        );
      }
      return trust.trusted;
    })();
    return this.privateDirCheck;
  }

  /**
   * Read the raw stored entry, normalising legacy bare-array entries.
   *
   * A pre-#3296 cache entry is a bare `TimelineLabelEventJson[]` with no
   * completeness marker; treat it as **partial** so the trust gate
   * re-paginates rather than trusting a possibly-truncated slice. Any
   * other unexpected shape is a miss.
   */
  private async readStored(
    repo: string,
    issueNumber: number,
  ): Promise<StoredTimeline | null> {
    if (!await this.dirIsPrivate()) return null;
    const raw = await this.inner.read<unknown>(repo, timelineKey(issueNumber));
    if (raw === null) return null;
    if (isStoredTimeline(raw)) return raw;
    if (Array.isArray(raw)) {
      return { events: raw as TimelineLabelEventJson[], complete: false };
    }
    return null;
  }

  /**
   * Read cached timeline events for the given issue.
   *
   * Returns null on miss, expiry, or cache-read error so callers can
   * fall back to the API. Cache hit/miss/expired metrics are recorded
   * by the underlying `IssueCache`.
   *
   * Returns the events regardless of whether the cached timeline is
   * complete — best-effort callers (last-add / last-remove info) accept a
   * partial timeline. The reserved-label trust gate must instead use
   * {@link readComplete}.
   */
  async read(
    repo: string,
    issueNumber: number,
  ): Promise<TimelineLabelEventJson[] | null> {
    const stored = await this.readStored(repo, issueNumber);
    return stored === null ? null : stored.events;
  }

  /**
   * Read cached timeline events **only** when the cached entry is a fully
   * paginated (complete) timeline (Issue #3296).
   *
   * Returns null on miss, expiry, or a **partial** (page-1-only) entry, so
   * the reserved-label trust gate falls through to its own paginated read
   * instead of honouring a possibly-truncated slice — reinstating the
   * Issue #3200 hardening on the cache-hit path.
   */
  async readComplete(
    repo: string,
    issueNumber: number,
  ): Promise<TimelineLabelEventJson[] | null> {
    const stored = await this.readStored(repo, issueNumber);
    if (stored === null || !stored.complete) return null;
    return stored.events;
  }

  /**
   * Write the parsed timeline events for the given issue to the cache.
   *
   * @param complete - `true` only when `events` is a fully paginated
   *   timeline (every page read to exhaustion). Defaults to `false` so a
   *   caller that fetched only page 1 is never mistaken for authoritative
   *   by the trust gate.
   */
  async write(
    repo: string,
    issueNumber: number,
    events: TimelineLabelEventJson[],
    complete = false,
  ): Promise<void> {
    if (!await this.dirIsPrivate()) return;
    const stored: StoredTimeline = { events, complete };
    await this.inner.write(repo, timelineKey(issueNumber), stored);
  }

  /**
   * Invalidate a single issue's cached timeline.
   *
   * Call this whenever the worker mutates the issue's labels
   * (add/remove) so the next consumer sees the fresh state.
   */
  async invalidate(repo: string, issueNumber: number): Promise<void> {
    await this.inner.invalidate(repo, timelineKey(issueNumber));
  }
}

/**
 * Best-effort invalidation helper: removes the cached timeline for a
 * single issue. Safe to call when no cache is configured — does
 * nothing if `cache` is undefined or the entry is absent.
 *
 * Use after worker-initiated label add/remove operations.
 */
export async function invalidateTimelineCache(
  repo: string,
  issueNumber: number,
  cache?: TimelineCache,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.invalidate(repo, issueNumber);
  } catch {
    // Best-effort — failure must not block the caller.
  }
}
