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
 */ import { spawnGh } from "./gh_spawn.ts";
import { formatRateLimitReset } from "./rate_limit_signal.ts";
/** The free query — `rateLimit` alone is not charged against the quota. */ export const GRAPHQL_QUOTA_PROBE_QUERY = "{ rateLimit { limit remaining used resetAt } }";
/**
 * The probe's `gh` arguments. `--include` prints the response status line
 * and headers ahead of the body, which is where the truthful numbers live.
 */ export const GRAPHQL_QUOTA_PROBE_ARGS = [
  "api",
  "--include",
  "graphql",
  "-f",
  `query=${GRAPHQL_QUOTA_PROBE_QUERY}`
];
/** Whether `args` is the probe (a test runner answering `gh` needs to know). */ export function isGraphqlQuotaProbe(args) {
  return args.length === GRAPHQL_QUOTA_PROBE_ARGS.length && args.every((arg, i)=>arg === GRAPHQL_QUOTA_PROBE_ARGS[i]);
}
/** Split `--include` output into its header lines and body. */ function splitHeadersAndBody(stdout) {
  if (!/^HTTP\//i.test(stdout)) return {
    headers: [],
    body: stdout
  };
  const boundary = stdout.search(/\r?\n\r?\n/);
  if (boundary < 0) {
    return {
      headers: stdout.split(/\r?\n/),
      body: ""
    };
  }
  const headerBlock = stdout.slice(0, boundary);
  const body = stdout.slice(boundary).replace(/^\r?\n\r?\n/, "");
  return {
    headers: headerBlock.split(/\r?\n/),
    body
  };
}
/** Lower-cased header name → value, last occurrence wins. */ function headerMap(lines) {
  const map = new Map();
  for (const line of lines){
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return map;
}
function finiteInt(value) {
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
 */ export function parseGraphqlQuotaProbe(stdout) {
  const { headers, body } = splitHeadersAndBody(stdout);
  const map = headerMap(headers);
  const resource = map.get("x-ratelimit-resource");
  if (resource !== undefined && resource.toLowerCase() !== "graphql") {
    return {
      ok: false,
      error: new Error(`GraphQL quota probe answered for the "${resource}" bucket, not graphql`)
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
        ...retryAfter !== undefined && retryAfter > 0 ? {
          retryAfterSeconds: retryAfter
        } : {}
      }
    };
  }
  try {
    const parsed = JSON.parse(body);
    const rate = parsed.data?.rateLimit;
    const resetMs = rate?.resetAt ? Date.parse(rate.resetAt) : Number.NaN;
    if (rate && typeof rate.limit === "number" && typeof rate.remaining === "number" && Number.isFinite(resetMs)) {
      return {
        ok: true,
        value: {
          limit: rate.limit,
          remaining: rate.remaining,
          used: typeof rate.used === "number" ? rate.used : Math.max(0, rate.limit - rate.remaining),
          reset: Math.floor(resetMs / 1000),
          source: "body"
        }
      };
    }
  } catch  {
  // Fall through to the single failure below.
  }
  return {
    ok: false,
    error: new Error("GraphQL quota probe returned neither X-Ratelimit headers nor a rateLimit body")
  };
}
/**
 * Ask GitHub for the account's GraphQL quota.
 *
 * Deliberately bypasses the `gh` chokepoint: the probe is free, must run
 * while the primary-quota latch is set (it is how the latch learns the real
 * reset), and must not count as a call in the telemetry it exists to
 * correct. A non-zero exit is not a failure — once the quota is gone GitHub
 * answers the probe with the same headers and an error body, and `gh` exits
 * non-zero on that body — only unparseable output is.
 */ export async function probeGraphqlQuota(// The probe is what lifts the latch, so it must run while latched (#1485).
spawn = (args)=>spawnGh(args, {
    bypassQuotaLatch: true
  })) {
  let result;
  try {
    result = await spawn(GRAPHQL_QUOTA_PROBE_ARGS);
  } catch (err) {
    return {
      ok: false,
      error: new Error(`GraphQL quota probe could not run: ${err instanceof Error ? err.message : String(err)}`)
    };
  }
  const parsed = parseGraphqlQuotaProbe(result.stdout);
  if (parsed.ok) return parsed;
  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    ok: false,
    error: new Error(`${parsed.error.message}${detail ? ` (exit ${result.code}: ${detail.slice(0, 200)})` : ""}`)
  };
}
/**
 * Render a reading in the shape of `gh api rate_limit`, so the pre-flight
 * gate's existing parser and file cache keep working unchanged while the
 * numbers underneath become the truthful ones.
 */ export function toRateLimitDocument(reading) {
  return JSON.stringify({
    resources: {
      graphql: {
        limit: reading.limit,
        used: reading.used,
        remaining: reading.remaining,
        reset: reading.reset
      }
    }
  });
}
/**
 * Points the account spent between two readings.
 *
 * Within one window that is the difference in `used`; once the window has
 * turned over it is everything spent so far in the new one. Never negative.
 */ export function graphqlSpendBetween(before, after) {
  if (after.reset !== before.reset) return Math.max(0, after.used);
  return Math.max(0, after.used - before.used);
}
/**
 * One operator-facing line for the per-cycle telemetry.
 *
 * Says out loud that the spend is the account's, not this host's — the
 * `gh-calls:` line beside it counts only this process, and the gap between
 * the two is the sibling hosts sharing the account.
 */ export function formatGraphqlQuotaLine(reading, nowSeconds, spentSinceLast) {
  const spent = spentSinceLast === undefined ? "" : ` spent-since-last-cycle=${spentSinceLast} (every consumer of this GitHub account, not just this host)`;
  return `graphql-quota: used=${reading.used}/${reading.limit} remaining=${reading.remaining} window-reopens ${formatRateLimitReset(reading.reset, nowSeconds)}${spent}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ncmFwaHFsX3F1b3RhX3Byb2JlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVHJ1dGhmdWwgR3JhcGhRTCBxdW90YSBwcm9iZSAoSXNzdWUgIzE0NTYpLlxuICpcbiAqIEV2ZXJ5IHF1b3RhIGRlY2lzaW9uIHRoZSB3b3JrZXIgbWFrZXMg4oCUIHRoZSBwcmUtZmxpZ2h0IGdhdGUsIHRoZVxuICogcHJpbWFyeS1xdW90YSBsYXRjaCwgdGhlIG1pZC1sb29wIHBhdXNlIOKAlCB1c2VkIHRvIHJlYWQgYGdoIGFwaSByYXRlX2xpbWl0YCxcbiAqIHRoZSBSRVNUIHZpZXcgb2YgdGhlIGJ1Y2tldHMuIFRoYXQgZG9jdW1lbnQgaGFzIGJlZW4gb2JzZXJ2ZWQgcmVwb3J0aW5nIHRoZVxuICogR3JhcGhRTCBidWNrZXQgYXMgdW50b3VjaGVkIChgdXNlZDogMGAsIHJlc2V0IGV4YWN0bHkgb25lIGhvdXIgb3V0KSBhdCB0aGVcbiAqIHZlcnkgbW9tZW50IHRoZSBzYW1lIHRva2VuJ3MgR3JhcGhRTCByZXNwb25zZXMgY2FycmllZFxuICogYFgtUmF0ZWxpbWl0LVVzZWQ6IDExMDRgIGFuZCBhIHJlc2V0IGVpZ2h0ZWVuIG1pbnV0ZXMgYXdheS4gRmVkIHRoYXQgdmlldyxcbiAqIHRoZSB3b3JrZXIgbGF0Y2hlZCBmb3IgYSBmbGF0IGhvdXIgb24gZXZlcnkgZXhoYXVzdGlvbiwgcmVzdW1lZCBibGluZCBpbnRvIGFcbiAqIHdpbmRvdyB0aGF0IHNpYmxpbmcgaG9zdHMgb24gdGhlIHNhbWUgYWNjb3VudCB3ZXJlIGFscmVhZHkgZHJhaW5pbmcsIGFuZFxuICogd2FzIHJlamVjdGVkIGFnYWluIHdpdGhpbiBhIG1pbnV0ZSDigJQgaG91ciBhZnRlciBob3VyLCBhdCAxMDAlIGlkbGUuXG4gKlxuICogVGhlIHJlc3BvbnNlIGhlYWRlcnMgb24gYSBHcmFwaFFMIGNhbGwgYXJlIHRoZSBidWNrZXQncyBvd24gYWNjb3VudGluZywgYW5kXG4gKiBhIHF1ZXJ5IHRoYXQgYXNrcyBvbmx5IGZvciBgcmF0ZUxpbWl0YCBpcyBub3QgY2hhcmdlZC4gU28gdGhlIHByb2JlIGlzXG4gKiBgZ2ggYXBpIC0taW5jbHVkZSBncmFwaHFsYCBmb3IgYHsgcmF0ZUxpbWl0IHsg4oCmIH0gfWAsIHJlYWQgZnJvbSB0aGUgaGVhZGVyc1xuICogZmlyc3Qg4oCUIEdpdEh1YiBzdGlsbCBzZW5kcyB0aGVtIG9uIHRoZSAyMDAtd2l0aC1lcnJvcnMgYm9keSBpdCByZXR1cm5zIG9uY2VcbiAqIHRoZSBxdW90YSBpcyBnb25lIOKAlCBhbmQgZnJvbSB0aGUgSlNPTiBib2R5IHNlY29uZC5cbiAqXG4gKiBUaGUgbnVtYmVycyBhcmUgcGVyICphY2NvdW50Kiwgbm90IHBlciBob3N0OiBgdXNlZGAgY2xpbWJzIHdoZW4gYSBzaWJsaW5nXG4gKiBob3N0IG9uIHRoZSBzYW1lIEdpdEh1YiBhY2NvdW50IHNwZW5kcywgd2hpY2ggaXMgZXhhY3RseSB3aHkgYSBob3N0IGhhcyB0b1xuICogYXNrIEdpdEh1YiByYXRoZXIgdGhhbiB0cnVzdCBpdHMgb3duIGJvb2trZWVwaW5nLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEdoU3Bhd25SZXN1bHQsIHNwYXduR2ggfSBmcm9tIFwiLi9naF9zcGF3bi50c1wiO1xuaW1wb3J0IHsgZm9ybWF0UmF0ZUxpbWl0UmVzZXQgfSBmcm9tIFwiLi9yYXRlX2xpbWl0X3NpZ25hbC50c1wiO1xuXG4vKiogT25lIHJlYWRpbmcgb2YgdGhlIGFjY291bnQncyBHcmFwaFFMIHByaW1hcnkgcXVvdGEuICovXG5leHBvcnQgaW50ZXJmYWNlIEdyYXBocWxRdW90YVJlYWRpbmcge1xuICAvKiogUG9pbnRzIHBlciB3aW5kb3cgKDUwMDAgZm9yIGEgdXNlciB0b2tlbikuICovXG4gIGxpbWl0OiBudW1iZXI7XG4gIC8qKiBQb2ludHMgbGVmdCBpbiB0aGUgY3VycmVudCB3aW5kb3cuICovXG4gIHJlbWFpbmluZzogbnVtYmVyO1xuICAvKiogUG9pbnRzIHNwZW50IGluIHRoZSBjdXJyZW50IHdpbmRvdywgYnkgZXZlcnkgY29uc3VtZXIgb2YgdGhlIGFjY291bnQuICovXG4gIHVzZWQ6IG51bWJlcjtcbiAgLyoqIFVuaXggc2Vjb25kcyB3aGVuIHRoZSB3aW5kb3cgcmVvcGVucy4gKi9cbiAgcmVzZXQ6IG51bWJlcjtcbiAgLyoqIFdoZXJlIHRoZSBudW1iZXJzIGNhbWUgZnJvbS4gKi9cbiAgc291cmNlOiBcImhlYWRlcnNcIiB8IFwiYm9keVwiO1xuICAvKipcbiAgICogR2l0SHViJ3MgYHJldHJ5LWFmdGVyYCwgaW4gc2Vjb25kcywgd2hlbiB0aGUgcmVzcG9uc2UgY2FycmllZCBvbmUg4oCUIGFcbiAgICogc2Vjb25kYXJ5IChidXJzdCkgbGltaXQgbmFtZXMgaXRzIG93biBjb29sLWRvd24gdGhpcyB3YXkuXG4gICAqL1xuICByZXRyeUFmdGVyU2Vjb25kcz86IG51bWJlcjtcbn1cblxuLyoqIFRoZSBmcmVlIHF1ZXJ5IOKAlCBgcmF0ZUxpbWl0YCBhbG9uZSBpcyBub3QgY2hhcmdlZCBhZ2FpbnN0IHRoZSBxdW90YS4gKi9cbmV4cG9ydCBjb25zdCBHUkFQSFFMX1FVT1RBX1BST0JFX1FVRVJZID1cbiAgXCJ7IHJhdGVMaW1pdCB7IGxpbWl0IHJlbWFpbmluZyB1c2VkIHJlc2V0QXQgfSB9XCI7XG5cbi8qKlxuICogVGhlIHByb2JlJ3MgYGdoYCBhcmd1bWVudHMuIGAtLWluY2x1ZGVgIHByaW50cyB0aGUgcmVzcG9uc2Ugc3RhdHVzIGxpbmVcbiAqIGFuZCBoZWFkZXJzIGFoZWFkIG9mIHRoZSBib2R5LCB3aGljaCBpcyB3aGVyZSB0aGUgdHJ1dGhmdWwgbnVtYmVycyBsaXZlLlxuICovXG5leHBvcnQgY29uc3QgR1JBUEhRTF9RVU9UQV9QUk9CRV9BUkdTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJhcGlcIixcbiAgXCItLWluY2x1ZGVcIixcbiAgXCJncmFwaHFsXCIsXG4gIFwiLWZcIixcbiAgYHF1ZXJ5PSR7R1JBUEhRTF9RVU9UQV9QUk9CRV9RVUVSWX1gLFxuXTtcblxuLyoqIFdoZXRoZXIgYGFyZ3NgIGlzIHRoZSBwcm9iZSAoYSB0ZXN0IHJ1bm5lciBhbnN3ZXJpbmcgYGdoYCBuZWVkcyB0byBrbm93KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0dyYXBocWxRdW90YVByb2JlKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIHJldHVybiBhcmdzLmxlbmd0aCA9PT0gR1JBUEhRTF9RVU9UQV9QUk9CRV9BUkdTLmxlbmd0aCAmJlxuICAgIGFyZ3MuZXZlcnkoKGFyZywgaSkgPT4gYXJnID09PSBHUkFQSFFMX1FVT1RBX1BST0JFX0FSR1NbaV0pO1xufVxuXG4vKiogU3BsaXQgYC0taW5jbHVkZWAgb3V0cHV0IGludG8gaXRzIGhlYWRlciBsaW5lcyBhbmQgYm9keS4gKi9cbmZ1bmN0aW9uIHNwbGl0SGVhZGVyc0FuZEJvZHkoXG4gIHN0ZG91dDogc3RyaW5nLFxuKTogeyBoZWFkZXJzOiBzdHJpbmdbXTsgYm9keTogc3RyaW5nIH0ge1xuICBpZiAoIS9eSFRUUFxcLy9pLnRlc3Qoc3Rkb3V0KSkgcmV0dXJuIHsgaGVhZGVyczogW10sIGJvZHk6IHN0ZG91dCB9O1xuICBjb25zdCBib3VuZGFyeSA9IHN0ZG91dC5zZWFyY2goL1xccj9cXG5cXHI/XFxuLyk7XG4gIGlmIChib3VuZGFyeSA8IDApIHtcbiAgICByZXR1cm4geyBoZWFkZXJzOiBzdGRvdXQuc3BsaXQoL1xccj9cXG4vKSwgYm9keTogXCJcIiB9O1xuICB9XG4gIGNvbnN0IGhlYWRlckJsb2NrID0gc3Rkb3V0LnNsaWNlKDAsIGJvdW5kYXJ5KTtcbiAgY29uc3QgYm9keSA9IHN0ZG91dC5zbGljZShib3VuZGFyeSkucmVwbGFjZSgvXlxccj9cXG5cXHI/XFxuLywgXCJcIik7XG4gIHJldHVybiB7IGhlYWRlcnM6IGhlYWRlckJsb2NrLnNwbGl0KC9cXHI/XFxuLyksIGJvZHkgfTtcbn1cblxuLyoqIExvd2VyLWNhc2VkIGhlYWRlciBuYW1lIOKGkiB2YWx1ZSwgbGFzdCBvY2N1cnJlbmNlIHdpbnMuICovXG5mdW5jdGlvbiBoZWFkZXJNYXAobGluZXM6IHJlYWRvbmx5IHN0cmluZ1tdKTogTWFwPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBpZiAoY29sb24gPD0gMCkgY29udGludWU7XG4gICAgbWFwLnNldChcbiAgICAgIGxpbmUuc2xpY2UoMCwgY29sb24pLnRyaW0oKS50b0xvd2VyQ2FzZSgpLFxuICAgICAgbGluZS5zbGljZShjb2xvbiArIDEpLnRyaW0oKSxcbiAgICApO1xuICB9XG4gIHJldHVybiBtYXA7XG59XG5cbmZ1bmN0aW9uIGZpbml0ZUludCh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQodmFsdWUsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IG4gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUGFyc2UgYSBwcm9iZSByZXNwb25zZSDigJQgdGhlIGAtLWluY2x1ZGVgIG91dHB1dCBvZiBgZ2ggYXBpIGdyYXBocWxgLlxuICpcbiAqIEhlYWRlcnMgd2luOiB0aGV5IGFyZSBhdXRob3JpdGF0aXZlIGFuZCBwcmVzZW50IGV2ZW4gd2hlbiBHaXRIdWIgcmVqZWN0c1xuICogdGhlIHF1ZXJ5IGZvciB3YW50IG9mIHF1b3RhLiBUaGUgSlNPTiBib2R5J3MgYHJhdGVMaW1pdGAgb2JqZWN0IGlzIHRoZVxuICogZmFsbGJhY2sgZm9yIG91dHB1dCB0aGF0IGFycml2ZWQgd2l0aG91dCBoZWFkZXJzLiBBIGhlYWRlciBibG9jayBuYW1pbmcgYVxuICogcmVzb3VyY2Ugb3RoZXIgdGhhbiBgZ3JhcGhxbGAgaXMgcmVmdXNlZCByYXRoZXIgdGhhbiBtaXNyZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHcmFwaHFsUXVvdGFQcm9iZShcbiAgc3Rkb3V0OiBzdHJpbmcsXG4pOiBSZXN1bHQ8R3JhcGhxbFF1b3RhUmVhZGluZz4ge1xuICBjb25zdCB7IGhlYWRlcnMsIGJvZHkgfSA9IHNwbGl0SGVhZGVyc0FuZEJvZHkoc3Rkb3V0KTtcbiAgY29uc3QgbWFwID0gaGVhZGVyTWFwKGhlYWRlcnMpO1xuXG4gIGNvbnN0IHJlc291cmNlID0gbWFwLmdldChcIngtcmF0ZWxpbWl0LXJlc291cmNlXCIpO1xuICBpZiAocmVzb3VyY2UgIT09IHVuZGVmaW5lZCAmJiByZXNvdXJjZS50b0xvd2VyQ2FzZSgpICE9PSBcImdyYXBocWxcIikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgR3JhcGhRTCBxdW90YSBwcm9iZSBhbnN3ZXJlZCBmb3IgdGhlIFwiJHtyZXNvdXJjZX1cIiBidWNrZXQsIG5vdCBncmFwaHFsYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGxpbWl0ID0gZmluaXRlSW50KG1hcC5nZXQoXCJ4LXJhdGVsaW1pdC1saW1pdFwiKSk7XG4gIGNvbnN0IHJlbWFpbmluZyA9IGZpbml0ZUludChtYXAuZ2V0KFwieC1yYXRlbGltaXQtcmVtYWluaW5nXCIpKTtcbiAgY29uc3QgcmVzZXQgPSBmaW5pdGVJbnQobWFwLmdldChcIngtcmF0ZWxpbWl0LXJlc2V0XCIpKTtcbiAgY29uc3QgdXNlZEhlYWRlciA9IGZpbml0ZUludChtYXAuZ2V0KFwieC1yYXRlbGltaXQtdXNlZFwiKSk7XG4gIGNvbnN0IHJldHJ5QWZ0ZXIgPSBmaW5pdGVJbnQobWFwLmdldChcInJldHJ5LWFmdGVyXCIpKTtcbiAgaWYgKGxpbWl0ICE9PSB1bmRlZmluZWQgJiYgcmVtYWluaW5nICE9PSB1bmRlZmluZWQgJiYgcmVzZXQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGxpbWl0LFxuICAgICAgICByZW1haW5pbmcsXG4gICAgICAgIHVzZWQ6IHVzZWRIZWFkZXIgPz8gTWF0aC5tYXgoMCwgbGltaXQgLSByZW1haW5pbmcpLFxuICAgICAgICByZXNldCxcbiAgICAgICAgc291cmNlOiBcImhlYWRlcnNcIixcbiAgICAgICAgLi4uKHJldHJ5QWZ0ZXIgIT09IHVuZGVmaW5lZCAmJiByZXRyeUFmdGVyID4gMFxuICAgICAgICAgID8geyByZXRyeUFmdGVyU2Vjb25kczogcmV0cnlBZnRlciB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoYm9keSkgYXMge1xuICAgICAgZGF0YT86IHtcbiAgICAgICAgcmF0ZUxpbWl0Pzoge1xuICAgICAgICAgIGxpbWl0PzogbnVtYmVyO1xuICAgICAgICAgIHJlbWFpbmluZz86IG51bWJlcjtcbiAgICAgICAgICB1c2VkPzogbnVtYmVyO1xuICAgICAgICAgIHJlc2V0QXQ/OiBzdHJpbmc7XG4gICAgICAgIH0gfCBudWxsO1xuICAgICAgfTtcbiAgICB9O1xuICAgIGNvbnN0IHJhdGUgPSBwYXJzZWQuZGF0YT8ucmF0ZUxpbWl0O1xuICAgIGNvbnN0IHJlc2V0TXMgPSByYXRlPy5yZXNldEF0ID8gRGF0ZS5wYXJzZShyYXRlLnJlc2V0QXQpIDogTnVtYmVyLk5hTjtcbiAgICBpZiAoXG4gICAgICByYXRlICYmXG4gICAgICB0eXBlb2YgcmF0ZS5saW1pdCA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgdHlwZW9mIHJhdGUucmVtYWluaW5nID09PSBcIm51bWJlclwiICYmXG4gICAgICBOdW1iZXIuaXNGaW5pdGUocmVzZXRNcylcbiAgICApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIGxpbWl0OiByYXRlLmxpbWl0LFxuICAgICAgICAgIHJlbWFpbmluZzogcmF0ZS5yZW1haW5pbmcsXG4gICAgICAgICAgdXNlZDogdHlwZW9mIHJhdGUudXNlZCA9PT0gXCJudW1iZXJcIlxuICAgICAgICAgICAgPyByYXRlLnVzZWRcbiAgICAgICAgICAgIDogTWF0aC5tYXgoMCwgcmF0ZS5saW1pdCAtIHJhdGUucmVtYWluaW5nKSxcbiAgICAgICAgICByZXNldDogTWF0aC5mbG9vcihyZXNldE1zIC8gMTAwMCksXG4gICAgICAgICAgc291cmNlOiBcImJvZHlcIixcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBGYWxsIHRocm91Z2ggdG8gdGhlIHNpbmdsZSBmYWlsdXJlIGJlbG93LlxuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBcIkdyYXBoUUwgcXVvdGEgcHJvYmUgcmV0dXJuZWQgbmVpdGhlciBYLVJhdGVsaW1pdCBoZWFkZXJzIG5vciBhIHJhdGVMaW1pdCBib2R5XCIsXG4gICAgKSxcbiAgfTtcbn1cblxuLyoqIFRoZSBzdWJwcm9jZXNzIHJ1bm5lciB0aGUgcHJvYmUgdXNlcyDigJQgaW5qZWN0YWJsZSBmb3IgdGVzdHMuICovXG5leHBvcnQgdHlwZSBHcmFwaHFsUXVvdGFQcm9iZVNwYXduID0gKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbikgPT4gUHJvbWlzZTxHaFNwYXduUmVzdWx0PjtcblxuLyoqXG4gKiBBc2sgR2l0SHViIGZvciB0aGUgYWNjb3VudCdzIEdyYXBoUUwgcXVvdGEuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGJ5cGFzc2VzIHRoZSBgZ2hgIGNob2tlcG9pbnQ6IHRoZSBwcm9iZSBpcyBmcmVlLCBtdXN0IHJ1blxuICogd2hpbGUgdGhlIHByaW1hcnktcXVvdGEgbGF0Y2ggaXMgc2V0IChpdCBpcyBob3cgdGhlIGxhdGNoIGxlYXJucyB0aGUgcmVhbFxuICogcmVzZXQpLCBhbmQgbXVzdCBub3QgY291bnQgYXMgYSBjYWxsIGluIHRoZSB0ZWxlbWV0cnkgaXQgZXhpc3RzIHRvXG4gKiBjb3JyZWN0LiBBIG5vbi16ZXJvIGV4aXQgaXMgbm90IGEgZmFpbHVyZSDigJQgb25jZSB0aGUgcXVvdGEgaXMgZ29uZSBHaXRIdWJcbiAqIGFuc3dlcnMgdGhlIHByb2JlIHdpdGggdGhlIHNhbWUgaGVhZGVycyBhbmQgYW4gZXJyb3IgYm9keSwgYW5kIGBnaGAgZXhpdHNcbiAqIG5vbi16ZXJvIG9uIHRoYXQgYm9keSDigJQgb25seSB1bnBhcnNlYWJsZSBvdXRwdXQgaXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZUdyYXBocWxRdW90YShcbiAgLy8gVGhlIHByb2JlIGlzIHdoYXQgbGlmdHMgdGhlIGxhdGNoLCBzbyBpdCBtdXN0IHJ1biB3aGlsZSBsYXRjaGVkICgjMTQ4NSkuXG4gIHNwYXduOiBHcmFwaHFsUXVvdGFQcm9iZVNwYXduID0gKGFyZ3MpID0+XG4gICAgc3Bhd25HaChhcmdzLCB7IGJ5cGFzc1F1b3RhTGF0Y2g6IHRydWUgfSksXG4pOiBQcm9taXNlPFJlc3VsdDxHcmFwaHFsUXVvdGFSZWFkaW5nPj4ge1xuICBsZXQgcmVzdWx0OiBHaFNwYXduUmVzdWx0O1xuICB0cnkge1xuICAgIHJlc3VsdCA9IGF3YWl0IHNwYXduKEdSQVBIUUxfUVVPVEFfUFJPQkVfQVJHUyk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgR3JhcGhRTCBxdW90YSBwcm9iZSBjb3VsZCBub3QgcnVuOiAke1xuICAgICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBwYXJzZWQgPSBwYXJzZUdyYXBocWxRdW90YVByb2JlKHJlc3VsdC5zdGRvdXQpO1xuICBpZiAocGFyc2VkLm9rKSByZXR1cm4gcGFyc2VkO1xuICBjb25zdCBkZXRhaWwgPSByZXN1bHQuc3RkZXJyLnRyaW0oKSB8fCByZXN1bHQuc3Rkb3V0LnRyaW0oKTtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGAke3BhcnNlZC5lcnJvci5tZXNzYWdlfSR7XG4gICAgICAgIGRldGFpbCA/IGAgKGV4aXQgJHtyZXN1bHQuY29kZX06ICR7ZGV0YWlsLnNsaWNlKDAsIDIwMCl9KWAgOiBcIlwiXG4gICAgICB9YCxcbiAgICApLFxuICB9O1xufVxuXG4vKipcbiAqIFJlbmRlciBhIHJlYWRpbmcgaW4gdGhlIHNoYXBlIG9mIGBnaCBhcGkgcmF0ZV9saW1pdGAsIHNvIHRoZSBwcmUtZmxpZ2h0XG4gKiBnYXRlJ3MgZXhpc3RpbmcgcGFyc2VyIGFuZCBmaWxlIGNhY2hlIGtlZXAgd29ya2luZyB1bmNoYW5nZWQgd2hpbGUgdGhlXG4gKiBudW1iZXJzIHVuZGVybmVhdGggYmVjb21lIHRoZSB0cnV0aGZ1bCBvbmVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdG9SYXRlTGltaXREb2N1bWVudChyZWFkaW5nOiBHcmFwaHFsUXVvdGFSZWFkaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXNvdXJjZXM6IHtcbiAgICAgIGdyYXBocWw6IHtcbiAgICAgICAgbGltaXQ6IHJlYWRpbmcubGltaXQsXG4gICAgICAgIHVzZWQ6IHJlYWRpbmcudXNlZCxcbiAgICAgICAgcmVtYWluaW5nOiByZWFkaW5nLnJlbWFpbmluZyxcbiAgICAgICAgcmVzZXQ6IHJlYWRpbmcucmVzZXQsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xufVxuXG4vKipcbiAqIFBvaW50cyB0aGUgYWNjb3VudCBzcGVudCBiZXR3ZWVuIHR3byByZWFkaW5ncy5cbiAqXG4gKiBXaXRoaW4gb25lIHdpbmRvdyB0aGF0IGlzIHRoZSBkaWZmZXJlbmNlIGluIGB1c2VkYDsgb25jZSB0aGUgd2luZG93IGhhc1xuICogdHVybmVkIG92ZXIgaXQgaXMgZXZlcnl0aGluZyBzcGVudCBzbyBmYXIgaW4gdGhlIG5ldyBvbmUuIE5ldmVyIG5lZ2F0aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3JhcGhxbFNwZW5kQmV0d2VlbihcbiAgYmVmb3JlOiBHcmFwaHFsUXVvdGFSZWFkaW5nLFxuICBhZnRlcjogR3JhcGhxbFF1b3RhUmVhZGluZyxcbik6IG51bWJlciB7XG4gIGlmIChhZnRlci5yZXNldCAhPT0gYmVmb3JlLnJlc2V0KSByZXR1cm4gTWF0aC5tYXgoMCwgYWZ0ZXIudXNlZCk7XG4gIHJldHVybiBNYXRoLm1heCgwLCBhZnRlci51c2VkIC0gYmVmb3JlLnVzZWQpO1xufVxuXG4vKipcbiAqIE9uZSBvcGVyYXRvci1mYWNpbmcgbGluZSBmb3IgdGhlIHBlci1jeWNsZSB0ZWxlbWV0cnkuXG4gKlxuICogU2F5cyBvdXQgbG91ZCB0aGF0IHRoZSBzcGVuZCBpcyB0aGUgYWNjb3VudCdzLCBub3QgdGhpcyBob3N0J3Mg4oCUIHRoZVxuICogYGdoLWNhbGxzOmAgbGluZSBiZXNpZGUgaXQgY291bnRzIG9ubHkgdGhpcyBwcm9jZXNzLCBhbmQgdGhlIGdhcCBiZXR3ZWVuXG4gKiB0aGUgdHdvIGlzIHRoZSBzaWJsaW5nIGhvc3RzIHNoYXJpbmcgdGhlIGFjY291bnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRHcmFwaHFsUXVvdGFMaW5lKFxuICByZWFkaW5nOiBHcmFwaHFsUXVvdGFSZWFkaW5nLFxuICBub3dTZWNvbmRzOiBudW1iZXIsXG4gIHNwZW50U2luY2VMYXN0PzogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc3BlbnQgPSBzcGVudFNpbmNlTGFzdCA9PT0gdW5kZWZpbmVkXG4gICAgPyBcIlwiXG4gICAgOiBgIHNwZW50LXNpbmNlLWxhc3QtY3ljbGU9JHtzcGVudFNpbmNlTGFzdH0gKGV2ZXJ5IGNvbnN1bWVyIG9mIHRoaXMgR2l0SHViIGFjY291bnQsIG5vdCBqdXN0IHRoaXMgaG9zdClgO1xuICByZXR1cm4gYGdyYXBocWwtcXVvdGE6IHVzZWQ9JHtyZWFkaW5nLnVzZWR9LyR7cmVhZGluZy5saW1pdH0gcmVtYWluaW5nPSR7cmVhZGluZy5yZW1haW5pbmd9IHdpbmRvdy1yZW9wZW5zICR7XG4gICAgZm9ybWF0UmF0ZUxpbWl0UmVzZXQocmVhZGluZy5yZXNldCwgbm93U2Vjb25kcylcbiAgfSR7c3BlbnR9YDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBR0QsU0FBNkIsT0FBTyxRQUFRLGdCQUFnQjtBQUM1RCxTQUFTLG9CQUFvQixRQUFRLHlCQUF5QjtBQXFCOUQseUVBQXlFLEdBQ3pFLE9BQU8sTUFBTSw0QkFDWCxpREFBaUQ7QUFFbkQ7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLDJCQUE4QztFQUN6RDtFQUNBO0VBQ0E7RUFDQTtFQUNBLENBQUMsTUFBTSxFQUFFLDJCQUEyQjtDQUNyQyxDQUFDO0FBRUYsOEVBQThFLEdBQzlFLE9BQU8sU0FBUyxvQkFBb0IsSUFBdUI7RUFDekQsT0FBTyxLQUFLLE1BQU0sS0FBSyx5QkFBeUIsTUFBTSxJQUNwRCxLQUFLLEtBQUssQ0FBQyxDQUFDLEtBQUssSUFBTSxRQUFRLHdCQUF3QixDQUFDLEVBQUU7QUFDOUQ7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
// denoCacheMetadata=14142412702591395838,2033364885222577950