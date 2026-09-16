/**
 * Cache key prefixes for the dependency fetcher's per-issue entries
 * (Issue #1818).
 *
 * A leaf module so both the fetcher (`issue_finder_common.ts`) and the close
 * chokepoint that invalidates its entries (`issue_close_notifier.ts`) read one
 * definition. The notifier sits under `gh_spawn.ts`, which the finder's own
 * import graph reaches, so it cannot import the finder directly — before this
 * module the prefix was simply written out twice, and bumping one spelling
 * left a close invalidating a key nothing wrote (Issue #2173).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Cache key prefix for a referenced issue's state.
 *
 * Bumped to `v2` by Issue #2173: the payload now carries `milestone`, and a
 * `v1` entry without it would read as "no milestone" and silently *release* a
 * dependant the cross-milestone hold should keep blocking.
 */
export const ISSUE_STATE_CACHE_PREFIX = "issue_state_v2_";

/** Cache key prefix for a referenced issue's body. */
export const ISSUE_BODY_CACHE_PREFIX = "issue_body_v1_";

/** Cache key prefix for a referenced issue's sub-issue numbers. */
export const ISSUE_SUB_ISSUES_CACHE_PREFIX = "issue_sub_issues_v1_";
