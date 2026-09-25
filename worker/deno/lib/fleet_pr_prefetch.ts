/**
 * Cross-repo prefetch of the fleet's open-PR listings (Issue #1486).
 *
 * Three passes asked GitHub the same question once per repo **and** once per
 * author - the open-PR duplicate guard (`prs_${author}`), the PR-maintenance
 * listing (`prs_maint_${author}`) and the human-invitation listing
 * (`prs_invited_${author}`). At 19 repos times (2 fleet authors + 3
 * authorised commenters) that is ~130 GraphQL-backed `gh pr list` calls per
 * cold cycle.
 *
 * This runs {@link searchOpenFleetPrs} **once per owner** and writes the
 * answer into the very cache entries those listings already read, so each
 * consumer is served from cache without changing a single call site. The
 * per-repo path stays exactly where it was: a cache miss, a `forceRefresh`
 * read-after-write re-check, or an owner whose search failed all fall through
 * to `gh pr list` as before.
 *
 * ```mermaid
 * flowchart LR
 *     P["prefetchFleetOpenPrs<br/>1 search per owner"] --> C[(IssueCache)]
 *     C --> G["open-PR guard<br/>prs_author"]
 *     C --> M["PR maintenance<br/>prs_maint_author"]
 *     C --> I["invitation lookup<br/>prs_invited_author"]
 *     G -.miss / forceRefresh.-> L["gh pr list --repo --author"]
 *     M -.miss.-> L
 *     I -.miss.-> L
 * ```
 *
 * Only **open** PRs are prefetched. The closed/merged half cannot be served
 * from one cross-repo query without weakening the duplicate guard: the search
 * API caps a result set at 1,000 matches and this fleet already has ~8,500
 * closed PRs, while `fetchRecentlyClosedPRsForFleet` treats a merged PR as a
 * permanent skip regardless of age. A windowed search would silently drop
 * older merged PRs, so that path keeps its per-repo listing.
 *
 * **What "no PRs" means here.** A monitored repo the search did not mention
 * is cached as an empty listing - that is the whole saving, since learning a
 * quiet repo is quiet must not cost a call. It rests on the search covering
 * every repo of the owner it names, which is why the duplicate guard is not
 * left resting on it: `claimIssue` re-checks the repo it is about to claim
 * **live**, with `forceRefresh` bypassing this cache entirely (Issue #3150),
 * so a discovery-time answer that was stale or blind cannot by itself open a
 * duplicate PR.
 *
 * **When the search fails (Issue #2662).** Falling back to the per-repo
 * listings multiplied calls at exactly the moment the budget was gone: one
 * failed search became `repos x authors` GraphQL listings, and the fleet shares
 * two accounts across four hosts, so every host stalled. A failed search now
 * reuses the owner's last good result while it is younger than
 * {@link PREFETCH_REUSE_WINDOW_SECONDS}, filling only entries that are
 * missing. With no usable result an ordinary failure still falls back per
 * repo - each listing is cached, so at most once per repo per cache window -
 * but a **rate-limited** search never does: it is reported in
 * `ownersRateLimited` and the caller waits for the quota instead.
 *
 * ```mermaid
 * flowchart TD
 *     S{search ok?} -- yes --> W[write entries, marker, last good]
 *     S -- no --> L{last good younger<br/>than the window?}
 *     L -- yes --> R[fill missing entries<br/>from last good]
 *     L -- no --> Q{rate limited?}
 *     Q -- yes --> H[report; the cycle waits<br/>for the quota]
 *     Q -- no --> F[per-repo listings,<br/>cached per window]
 * ```
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { IssueCache } from "./issue_cache.ts";
import {
  type FleetPrSearchResult,
  type FleetSearchPr,
  normaliseLogins,
  searchOpenFleetPrs,
} from "./fleet_pr_search.ts";
import { isPrimaryRateLimitMessage } from "./primary_quota_latch.ts";

/**
 * How long an owner's last good search result may stand in for a failed
 * search (Issue #2662), in seconds.
 *
 * One hour - GitHub's primary GraphQL quota window. A search refused for the
 * quota is refused until the window resets, so a result from inside the last
 * hour bridges the whole outage; anything older is not trusted, and the owner
 * falls back to the per-repo path (or, rate-limited, waits). Longer than the
 * 600 s listing cache on purpose: the search only runs once that cache and
 * its marker have expired, so a window equal to it would never reuse
 * anything. Staleness is bounded by the consumers' own live checks - the
 * claim re-lists its repo live (Issue #3150) and the auto-merge sweep re-reads
 * each PR's state before acting (Issue #1774).
 */
export const PREFETCH_REUSE_WINDOW_SECONDS = 3600;

/** Options for {@link prefetchFleetOpenPrs}. */
export interface FleetPrPrefetchOptions {
  /** Monitored repositories in "owner/repo" format. */
  repos: readonly string[];
  /**
   * Logins the open-PR duplicate guard lists (`resolveFleetAuthors`), whose
   * `prs_${login}` entry this populates.
   */
  guardAuthors: readonly string[];
  /**
   * Logins the PR-maintenance scans list
   * (`resolveFleetMaintenanceAuthorSet`), whose `prs_maint_${login}` entry
   * this populates. Defaults to none.
   */
  maintenanceAuthors?: readonly string[];
  /**
   * Trusted human logins the invitation lookup lists (`allowed_authors`
   * minus the maintenance set), whose `prs_invited_${login}` entry this
   * populates. Defaults to none.
   */
  invitationAuthors?: readonly string[];
  /** The per-cycle cache the listings read. */
  cache: IssueCache;
  /** Function to run gh commands. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Comments and reviews fetched per PR. A PR with more than this is not
   * served to the invitation listing from here - see {@link
   * prefetchFleetOpenPrs}. Defaults to the search module's own page size.
   */
  conversationSize?: number;
  /** Optional log sink; failures are always reported through it. */
  log?: (message: string) => void;
  /** Clock in epoch milliseconds (default `Date.now`), for tests. */
  now?: () => number;
  /** Injectable search, for tests. */
  searchFn?: (
    options: Parameters<typeof searchOpenFleetPrs>[0],
  ) => Promise<FleetPrSearchResult>;
}

/** What one prefetch pass did. */
export interface FleetPrPrefetchResult {
  /** Owners whose search succeeded and populated the cache. */
  ownersServed: string[];
  /**
   * Owners skipped because a previous pass's entries are still inside the
   * cache TTL, so this cycle needs no search at all.
   */
  ownersFresh: string[];
  /** Owners left on the per-repo path, each with the reason. */
  ownersSkipped: { owner: string; reason: string }[];
  /**
   * Owners whose search failed but whose last good result, younger than
   * {@link PREFETCH_REUSE_WINDOW_SECONDS}, filled the missing entries
   * (Issue #2662).
   */
  ownersReused: { owner: string; reason: string; ageSeconds: number }[];
  /**
   * Owners whose search was refused by the primary rate limit with no usable
   * last good result (Issue #2662). Nothing was written and they are **not**
   * on the per-repo path in spirit: the caller should wait for the quota
   * rather than let every consumer list per repo.
   */
  ownersRateLimited: { owner: string; reason: string }[];
  /** `gh api graphql` calls issued. */
  searchCalls: number;
  /** Cache entries written (repo x author x listing). */
  entriesWritten: number;
  /** Per-repo `gh pr list` calls this pass makes unnecessary. */
  listingsAvoided: number;
}

/** The `prs_${author}` entry shape (`fetchOpenPRsByUser`). */
function toOpenPrEntry(pr: FleetSearchPr, author: string) {
  return {
    number: pr.number,
    title: pr.title,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    // Issue #1800 / #2662: the auto-merge sweep reads this entry and skips a
    // draft; served from here without it, a draft looked ready to arm.
    isDraft: pr.isDraft,
    author,
  };
}

/** The `prs_maint_${author}` entry shape (`PR_MAINTENANCE_LIST_FIELDS`). */
function toMaintenanceEntry(pr: FleetSearchPr) {
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    autoMergeRequest: pr.autoMergeRequest,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: { login: pr.author },
    mergeable: pr.mergeable,
  };
}

/** The `prs_invited_${author}` entry shape (`INVITATION_CACHE_FIELDS`). */
function toInvitationEntry(pr: FleetSearchPr) {
  return {
    ...toMaintenanceEntry(pr),
    labels: pr.labels.map((name) => ({ name })),
    comments: pr.comments,
    reviews: pr.reviews,
  };
}

/**
 * Cache key of the per-owner freshness marker (Issue #1486).
 *
 * Written after a successful prefetch and read before the next one, so a
 * warm cycle inside the cache TTL costs no search at all. It expires with
 * the entries it stands for, and an entry invalidated in the meantime simply
 * misses and falls back to its per-repo listing.
 */
const PREFETCH_MARKER_KEY = "prs_prefetch";

/**
 * Cache key of the owner's last good search result (Issue #2662), read with
 * {@link PREFETCH_REUSE_WINDOW_SECONDS} as its TTL. The age is checked again
 * against `fetchedAt` so the window is the prefetch's rule, not the cache's.
 */
const LAST_GOOD_KEY = "prs_prefetch_last_good";

/** The {@link LAST_GOOD_KEY} payload. */
interface LastGoodPrefetch {
  v: 1;
  /** Epoch seconds the search succeeded. */
  fetchedAt: number;
  prs: FleetSearchPr[];
}

function isLastGoodPrefetch(value: unknown): value is LastGoodPrefetch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && typeof record.fetchedAt === "number" &&
    Array.isArray(record.prs);
}

/**
 * The pseudo-repo the owner's freshness marker is filed under.
 *
 * `IssueCache` keys everything by repo, and the marker is owner-scoped; the
 * leading underscore cannot collide with a real repository slug.
 */
function sentinelRepo(owner: string): string {
  return `${owner}/_fleet-pr-prefetch`;
}

/** Owner half of an "owner/repo" slug, or `""` when malformed. */
function ownerOf(repo: string): string {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return "";
  return repo.slice(0, slash);
}

/** The author sets each consumer reads, already normalised. */
interface ConsumerAuthors {
  guard: string[];
  maintenance: string[];
  invitation: string[];
}

/**
 * Project one owner's search result into the consumers' cache entries.
 *
 * `reuse` marks a stale result standing in for a failed search (Issue #2662):
 * it fills only entries that are currently missing - a live listing written
 * since (a claim-time `forceRefresh`, a per-repo fallback) is newer and wins -
 * and it never serves the invitation listing, which admits a human's PR only
 * on a current reading of its conversation and so fails closed to its own
 * per-repo path.
 *
 * @returns Entries written.
 */
async function writeOwnerEntries(
  repos: readonly string[],
  prs: readonly FleetSearchPr[],
  authors: ConsumerAuthors,
  options: FleetPrPrefetchOptions,
  reuse: boolean,
): Promise<number> {
  // Index the owner's PRs by repo (lower-cased) and author (lower-cased).
  const byRepoAuthor = new Map<string, FleetSearchPr[]>();
  for (const pr of prs) {
    const key = `${pr.repo.toLowerCase()} ${pr.author.toLowerCase()}`;
    const bucket = byRepoAuthor.get(key);
    if (bucket === undefined) byRepoAuthor.set(key, [pr]);
    else bucket.push(pr);
  }

  let written = 0;
  const write = async (repo: string, key: string, data: unknown) => {
    if (reuse && await options.cache.read<unknown>(repo, key) !== null) return;
    await options.cache.write(repo, key, data);
    written++;
  };

  for (const repo of repos) {
    const repoKey = repo.toLowerCase();
    // A repo with no matching PR is written as an empty listing - the
    // point of the prefetch is that no consumer needs a call to learn it.
    const prsFor = (author: string) =>
      byRepoAuthor.get(`${repoKey} ${author.toLowerCase()}`) ?? [];
    for (const author of authors.guard) {
      await write(
        repo,
        `prs_${author}`,
        prsFor(author).map((pr) => toOpenPrEntry(pr, author)),
      );
    }
    for (const author of authors.maintenance) {
      await write(
        repo,
        `prs_maint_${author}`,
        prsFor(author).map(toMaintenanceEntry),
      );
    }
    if (reuse) continue;
    for (const author of authors.invitation) {
      const authorPrs = prsFor(author);
      // The invitation predicate reads every label, comment and review, so
      // a PR whose conversation did not fit one page must not be served
      // from here - the per-repo listing pages it properly.
      if (authorPrs.some((pr) => pr.detailTruncated)) {
        options.log?.(
          `[fleet-pr-prefetch] ${repo}: invitation listing for ` +
            `${author} left to the per-repo path - a PR's labels, ` +
            `comments or reviews exceeded one page`,
        );
        continue;
      }
      await write(
        repo,
        `prs_invited_${author}`,
        authorPrs.map(toInvitationEntry),
      );
    }
  }
  return written;
}

/**
 * The owner's last good search result, when it is younger than
 * {@link PREFETCH_REUSE_WINDOW_SECONDS}; otherwise `null`.
 */
async function readLastGood(
  owner: string,
  cache: IssueCache,
  nowSeconds: number,
): Promise<{ prs: FleetSearchPr[]; ageSeconds: number } | null> {
  const entry = await cache.read<unknown>(sentinelRepo(owner), LAST_GOOD_KEY, {
    ttlSeconds: PREFETCH_REUSE_WINDOW_SECONDS,
  });
  if (!isLastGoodPrefetch(entry)) return null;
  const ageSeconds = nowSeconds - entry.fetchedAt;
  if (ageSeconds < 0 || ageSeconds >= PREFETCH_REUSE_WINDOW_SECONDS) {
    return null;
  }
  return { prs: entry.prs, ageSeconds };
}

/**
 * Prefetch every monitored repo's open-PR listings with one search per owner.
 *
 * A failed search for an owner reuses its last good result while that is
 * younger than {@link PREFETCH_REUSE_WINDOW_SECONDS} (Issue #2662). Failing
 * that, an ordinary failure leaves the owner's repos untouched so the
 * per-repo listings run exactly as they did before - the saving is forfeited,
 * never the correctness - while a rate-limited one is reported in
 * `ownersRateLimited` for the caller to wait on. Every outcome is logged.
 *
 * @param options - Repos, author sets, cache and gh runner.
 * @returns What was served, what was skipped, and the calls involved.
 */
export async function prefetchFleetOpenPrs(
  options: FleetPrPrefetchOptions,
): Promise<FleetPrPrefetchResult> {
  const search = options.searchFn ?? searchOpenFleetPrs;
  const nowMs = options.now ?? Date.now;
  // Each consumer's own author set, kept separate: the duplicate guard, the
  // maintenance scans and the invitation lookup resolve different sets, and
  // collapsing them here would populate an entry no consumer reads (or, worse,
  // leave one it does read empty).
  const authors: ConsumerAuthors = {
    guard: normaliseLogins(options.guardAuthors),
    maintenance: normaliseLogins(options.maintenanceAuthors),
    invitation: normaliseLogins(options.invitationAuthors),
  };
  const searchAuthors = normaliseLogins([
    ...authors.guard,
    ...authors.maintenance,
    ...authors.invitation,
  ]);
  const result: FleetPrPrefetchResult = {
    ownersServed: [],
    ownersFresh: [],
    ownersSkipped: [],
    ownersReused: [],
    ownersRateLimited: [],
    searchCalls: 0,
    entriesWritten: 0,
    listingsAvoided: 0,
  };
  if (searchAuthors.length === 0) return result;

  // Group the monitored repos by owner, keeping the configured slug.
  const byOwner = new Map<string, string[]>();
  for (const repo of options.repos) {
    if (typeof repo !== "string") continue;
    const slug = repo.trim();
    const owner = ownerOf(slug);
    if (owner === "") continue;
    const key = owner.toLowerCase();
    const repos = byOwner.get(key);
    if (repos === undefined) byOwner.set(key, [slug]);
    else if (!repos.includes(slug)) repos.push(slug);
  }

  for (const repos of byOwner.values()) {
    const owner = ownerOf(repos[0] ?? "");
    // A previous pass inside the cache TTL already wrote every entry this
    // one would, so searching again would spend a call to overwrite live
    // data with the same answer (Issue #1486). The marker expires with the
    // entries it stands for.
    const marker = sentinelRepo(owner);
    if (await options.cache.read<unknown>(marker, PREFETCH_MARKER_KEY)) {
      result.ownersFresh.push(owner);
      continue;
    }
    const outcome = await search({
      owner,
      authors: searchAuthors,
      ghCommandFn: options.ghCommandFn,
      ...(options.conversationSize === undefined
        ? {}
        : { conversationSize: options.conversationSize }),
    });
    result.searchCalls += outcome.calls;
    const nowSeconds = Math.floor(nowMs() / 1000);
    if (!outcome.ok) {
      const reason = outcome.reason;
      // Issue #2662: the last good result, not `repos x authors` listings.
      // No marker is written, so the next pass searches again.
      const lastGood = await readLastGood(owner, options.cache, nowSeconds);
      if (lastGood !== null) {
        const written = await writeOwnerEntries(
          repos,
          lastGood.prs,
          authors,
          options,
          true,
        );
        result.entriesWritten += written;
        result.listingsAvoided += written;
        result.ownersReused.push({
          owner,
          reason,
          ageSeconds: lastGood.ageSeconds,
        });
        options.log?.(
          `[fleet-pr-prefetch] ${owner}: cross-repo search unusable ` +
            `(${reason}) - reusing the last good result from ` +
            `${lastGood.ageSeconds}s ago (window ` +
            `${PREFETCH_REUSE_WINDOW_SECONDS}s, ${written} entries filled)`,
        );
        continue;
      }
      if (isPrimaryRateLimitMessage(reason)) {
        result.ownersRateLimited.push({ owner, reason });
        options.log?.(
          `[fleet-pr-prefetch] ${owner}: cross-repo search rate-limited ` +
            `(${reason}) and no result inside the ` +
            `${PREFETCH_REUSE_WINDOW_SECONDS}s window - no per-repo listings; ` +
            `the cycle waits for the quota`,
        );
        continue;
      }
      result.ownersSkipped.push({ owner, reason });
      options.log?.(
        `[fleet-pr-prefetch] ${owner}: cross-repo search unusable ` +
          `(${reason}) - falling back to per-repo listings`,
      );
      continue;
    }

    const written = await writeOwnerEntries(
      repos,
      outcome.prs,
      authors,
      options,
      false,
    );
    result.entriesWritten += written;
    result.listingsAvoided += written;
    const lastGood: LastGoodPrefetch = {
      v: 1,
      fetchedAt: nowSeconds,
      prs: outcome.prs,
    };
    await options.cache.write(marker, LAST_GOOD_KEY, lastGood);
    await options.cache.write(marker, PREFETCH_MARKER_KEY, {
      owner,
      repos: repos.length,
    });
    result.ownersServed.push(owner);
  }

  return result;
}
