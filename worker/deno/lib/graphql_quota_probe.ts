/**
 * Truthful GraphQL quota probe (Issue #1456).
 *
 * Every quota decision the worker makes — the pre-flight gate, the
 * primary-quota latch, the mid-loop pause — used to read `gh api rate_limit`,
 * the REST view of the buckets. That document has been observed reporting the
 * GraphQL bucket as untouched (`used: 0`, reset exactly one hour out) at the
 * very moment the same token's GraphQL responses carried
 * `X-Ratelimit-Used: 1104` and a reset eighteen minutes away. Fed that view,
 * the worker latched for a flat hour on every exhaustion, resumed blind into a
 * window that sibling hosts on the same account were already draining, and
 * was rejected again within a minute — hour after hour, at 100% idle.
 *
 * The response headers on a GraphQL call are the bucket's own accounting, and
 * a query that asks only for `rateLimit` is not charged. So the probe is
 * `gh api --include graphql` for `{ rateLimit { … } }`, read from the headers
 * first — GitHub still sends them on the 200-with-errors body it returns once
 * the quota is gone — and from the JSON body second.
 *
 * The numbers are per *account*, not per host: `used` climbs when a sibling
 * host on the same GitHub account spends, which is exactly why a host has to
 * ask GitHub rather than trust its own bookkeeping.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { type GhSpawnResult, spawnGh } from "./gh_spawn.ts";
import { formatRateLimitReset } from "./rate_limit_signal.ts";

/** One reading of the account's GraphQL primary quota. */
export interface GraphqlQuotaReading {
  /** Points per window (5000 for a user token). */
  limit: number;
  /** Points left in the current window. */
  remaining: number;
  /** Points spent in the current window, by every consumer of the account. */
  used: number;
  /** Unix seconds when the window reopens. */
  reset: number;
  /** Where the numbers came from. */
  source: "headers" | "body";
  /**
   * GitHub's `retry-after`, in seconds, when the response carried one — a
   * secondary (burst) limit names its own cool-down this way.
   */
  retryAfterSeconds?: number;
}

/** The free query — `rateLimit` alone is not charged against the quota. */
export const GRAPHQL_QUOTA_PROBE_QUERY =
  "{ rateLimit { limit remaining used resetAt } }";

/**
 * The probe's `gh` arguments. `--include` prints the response status line
 * and headers ahead of the body, which is where the truthful numbers live.
 */
export const GRAPHQL_QUOTA_PROBE_ARGS: readonly string[] = [
  "api",
  "--include",
  "graphql",
  "-f",
  `query=${GRAPHQL_QUOTA_PROBE_QUERY}`,
];

/** Whether `args` is the probe (a test runner answering `gh` needs to know). */
export function isGraphqlQuotaProbe(args: readonly string[]): boolean {
  return args.length === GRAPHQL_QUOTA_PROBE_ARGS.length &&
    args.every((arg, i) => arg === GRAPHQL_QUOTA_PROBE_ARGS[i]);
}

/** Split `--include` output into its header lines and body. */
function splitHeadersAndBody(
  stdout: string,
): { headers: string[]; body: string } {
  if (!/^HTTP\//i.test(stdout)) return { headers: [], body: stdout };
  const boundary = stdout.search(/\r?\n\r?\n/);
  if (boundary < 0) {
    return { headers: stdout.split(/\r?\n/), body: "" };
  }
  const headerBlock = stdout.slice(0, boundary);
  const body = stdout.slice(boundary).replace(/^\r?\n\r?\n/, "");
  return { headers: headerBlock.split(/\r?\n/), body };
}

/** Lower-cased header name → value, last occurrence wins. */
function headerMap(lines: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    map.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return map;
}

function finiteInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a probe response — the `--include` output of `gh api graphql`.
 *
 * Headers win: they are authoritative and present even when GitHub rejects
 * the query for want of quota. The JSON body's `rateLimit` object is the
 * fallback for output that arrived without headers. A header block naming a
 * resource other than `graphql` is refused rather than misread.
 */
export function parseGraphqlQuotaProbe(
  stdout: string,
): Result<GraphqlQuotaReading> {
  const { headers, body } = splitHeadersAndBody(stdout);
  const map = headerMap(headers);

  const resource = map.get("x-ratelimit-resource");
  if (resource !== undefined && resource.toLowerCase() !== "graphql") {
    return {
      ok: false,
      error: new Error(
        `GraphQL quota probe answered for the "${resource}" bucket, not graphql`,
      ),
    };
  }

  const limit = finiteInt(map.get("x-ratelimit-limit"));
  const remaining = finiteInt(map.get("x-ratelimit-remaining"));
  const reset = finiteInt(map.get("x-ratelimit-reset"));
  const usedHeader = finiteInt(map.get("x-ratelimit-used"));
  const retryAfter = finiteInt(map.get("retry-after"));
  if (limit !== undefined && remaining !== undefined && reset !== undefined) {
    return {
      ok: true,
      value: {
        limit,
        remaining,
        used: usedHeader ?? Math.max(0, limit - remaining),
        reset,
        source: "headers",
        ...(retryAfter !== undefined && retryAfter > 0
          ? { retryAfterSeconds: retryAfter }
          : {}),
      },
    };
  }

  try {
    const parsed = JSON.parse(body) as {
      data?: {
        rateLimit?: {
          limit?: number;
          remaining?: number;
          used?: number;
          resetAt?: string;
        } | null;
      };
    };
    const rate = parsed.data?.rateLimit;
    const resetMs = rate?.resetAt ? Date.parse(rate.resetAt) : Number.NaN;
    if (
      rate &&
      typeof rate.limit === "number" &&
      typeof rate.remaining === "number" &&
      Number.isFinite(resetMs)
    ) {
      return {
        ok: true,
        value: {
          limit: rate.limit,
          remaining: rate.remaining,
          used: typeof rate.used === "number"
            ? rate.used
            : Math.max(0, rate.limit - rate.remaining),
          reset: Math.floor(resetMs / 1000),
          source: "body",
        },
      };
    }
  } catch {
    // Fall through to the single failure below.
  }
  return {
    ok: false,
    error: new Error(
      "GraphQL quota probe returned neither X-Ratelimit headers nor a rateLimit body",
    ),
  };
}

/** The subprocess runner the probe uses — injectable for tests. */
export type GraphqlQuotaProbeSpawn = (
  args: readonly string[],
) => Promise<GhSpawnResult>;

/**
 * Ask GitHub for the account's GraphQL quota.
 *
 * Deliberately bypasses the `gh` chokepoint: the probe is free, must run
 * while the primary-quota latch is set (it is how the latch learns the real
 * reset), and must not count as a call in the telemetry it exists to
 * correct. A non-zero exit is not a failure — once the quota is gone GitHub
 * answers the probe with the same headers and an error body, and `gh` exits
 * non-zero on that body — only unparseable output is.
 */
export async function probeGraphqlQuota(
  // The probe is what lifts the latch, so it must run while latched (#1485).
  spawn: GraphqlQuotaProbeSpawn = (args) =>
    spawnGh(args, { bypassQuotaLatch: true }),
): Promise<Result<GraphqlQuotaReading>> {
  let result: GhSpawnResult;
  try {
    result = await spawn(GRAPHQL_QUOTA_PROBE_ARGS);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `GraphQL quota probe could not run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
  const parsed = parseGraphqlQuotaProbe(result.stdout);
  if (parsed.ok) return parsed;
  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    ok: false,
    error: new Error(
      `${parsed.error.message}${
        detail ? ` (exit ${result.code}: ${detail.slice(0, 200)})` : ""
      }`,
    ),
  };
}

/**
 * Render a reading in the shape of `gh api rate_limit`, so the pre-flight
 * gate's existing parser and file cache keep working unchanged while the
 * numbers underneath become the truthful ones.
 */
export function toRateLimitDocument(reading: GraphqlQuotaReading): string {
  return JSON.stringify({
    resources: {
      graphql: {
        limit: reading.limit,
        used: reading.used,
        remaining: reading.remaining,
        reset: reading.reset,
      },
    },
  });
}

/**
 * Points the account spent between two readings.
 *
 * Within one window that is the difference in `used`; once the window has
 * turned over it is everything spent so far in the new one. Never negative.
 */
export function graphqlSpendBetween(
  before: GraphqlQuotaReading,
  after: GraphqlQuotaReading,
): number {
  if (after.reset !== before.reset) return Math.max(0, after.used);
  return Math.max(0, after.used - before.used);
}

/**
 * One operator-facing line for the per-cycle telemetry.
 *
 * Says out loud that the spend is the account's, not this host's — the
 * `gh-calls:` line beside it counts only this process, and the gap between
 * the two is the sibling hosts sharing the account.
 */
export function formatGraphqlQuotaLine(
  reading: GraphqlQuotaReading,
  nowSeconds: number,
  spentSinceLast?: number,
): string {
  const spent = spentSinceLast === undefined
    ? ""
    : ` spent-since-last-cycle=${spentSinceLast} (every consumer of this GitHub account, not just this host)`;
  return `graphql-quota: used=${reading.used}/${reading.limit} remaining=${reading.remaining} window-reopens ${
    formatRateLimitReset(reading.reset, nowSeconds)
  }${spent}`;
}
