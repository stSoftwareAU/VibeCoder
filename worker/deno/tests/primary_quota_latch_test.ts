/**
 * Tests for the process-wide primary-GraphQL-quota latch (Issue #42).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  clearPrimaryQuotaLatch,
  isPrimaryQuotaLatched,
  isPrimaryRateLimitMessage,
  isQuotaExemptGhCall,
  latchPrimaryQuota,
  primaryQuotaLatchedUntil,
} from "../lib/primary_quota_latch.ts";

function reset() {
  clearPrimaryQuotaLatch();
}

Deno.test("isPrimaryRateLimitMessage - matches the primary-quota variants", () => {
  assert(isPrimaryRateLimitMessage(
    "gh command failed (exit 1): GraphQL: API rate limit already exceeded",
  ));
  assert(isPrimaryRateLimitMessage("API rate limit exceeded for user"));
  assert(isPrimaryRateLimitMessage("rate limit has been exceeded"));
});

Deno.test("isPrimaryRateLimitMessage - ignores secondary limits and 5xx", () => {
  assert(
    !isPrimaryRateLimitMessage(
      "You have exceeded a secondary rate limit",
    ),
  );
  assert(!isPrimaryRateLimitMessage("HTTP 502 Bad Gateway"));
  assert(!isPrimaryRateLimitMessage(""));
});

Deno.test("isQuotaExemptGhCall - only `gh api rate_limit` is exempt", () => {
  assert(isQuotaExemptGhCall(["api", "rate_limit"]));
  assert(isQuotaExemptGhCall(["api", "rate_limit", "--jq", ".resources"]));
  // GraphQL-backed calls are not exempt — they are what the latch stops.
  assert(!isQuotaExemptGhCall(["api", "graphql", "-f", "query=..."]));
  assert(!isQuotaExemptGhCall(["issue", "list", "--repo", "o/r"]));
  assert(!isQuotaExemptGhCall(["pr", "list", "--repo", "o/r"]));
  assert(!isQuotaExemptGhCall(["api", "repos/o/r/labels"]));
});

Deno.test("isPrimaryQuotaLatched - unlatched by default", () => {
  reset();
  assertEquals(isPrimaryQuotaLatched(1000), false);
  assertEquals(primaryQuotaLatchedUntil(), null);
});

Deno.test("latchPrimaryQuota - holds until the reset, then auto-expires", () => {
  reset();
  latchPrimaryQuota(2000, 1000);
  assertEquals(primaryQuotaLatchedUntil(), 2000);
  assertEquals(isPrimaryQuotaLatched(1500), true); // before reset
  assertEquals(isPrimaryQuotaLatched(1999), true); // just before
  // At/after the reset the latch clears itself — a call the instant after
  // the quota returns is allowed straight through.
  assertEquals(isPrimaryQuotaLatched(2000), false);
  assertEquals(primaryQuotaLatchedUntil(), null);
});

Deno.test("latchPrimaryQuota - a later reset wins, an earlier one never shortens", () => {
  reset();
  latchPrimaryQuota(2000, 1000);
  latchPrimaryQuota(1500, 1000); // earlier — must not shorten
  assertEquals(primaryQuotaLatchedUntil(), 2000);
  latchPrimaryQuota(3000, 1000); // later — extends
  assertEquals(primaryQuotaLatchedUntil(), 3000);
});

Deno.test("latchPrimaryQuota - ignores a reset at or before now", () => {
  reset();
  latchPrimaryQuota(1000, 1000); // equal — nothing to latch
  assertEquals(primaryQuotaLatchedUntil(), null);
  latchPrimaryQuota(500, 1000); // past
  assertEquals(primaryQuotaLatchedUntil(), null);
  latchPrimaryQuota(NaN, 1000); // non-finite
  assertEquals(primaryQuotaLatchedUntil(), null);
});

Deno.test("clearPrimaryQuotaLatch - lifts an active latch", () => {
  reset();
  latchPrimaryQuota(9_999_999_999, 1000);
  assert(isPrimaryQuotaLatched(1000));
  clearPrimaryQuotaLatch();
  assertEquals(isPrimaryQuotaLatched(1000), false);
});
