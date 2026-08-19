/**
 * Tests for the per-iteration comment cache (Issue #1841).
 *
 * Behaviour:
 * - First read for a (repo, issue) pair invokes the fetcher (miss).
 * - Subsequent reads within TTL return the cached value (hit).
 * - Explicit invalidation forces the next read to refetch.
 * - TTL expiry causes the next read to refetch.
 * - Disjoint (repo, issue) keys are stored independently.
 */

import { assertEquals } from "@std/assert";
import {
  clearCommentCache,
  getCachedComments,
  getCommentCacheStats,
  invalidateComments,
} from "../lib/comment_cache.ts";
import type { GitHubComment } from "../types.ts";

function comment(id: number, body: string): GitHubComment {
  return {
    id,
    body,
    author: "tester",
    createdAt: "2024-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

function makeFetcher(items: GitHubComment[]): {
  fn: () => Promise<GitHubComment[]>;
  calls: { count: number };
} {
  const calls = { count: 0 };
  return {
    fn: () => {
      calls.count++;
      return Promise.resolve(items);
    },
    calls,
  };
}

Deno.test("comment_cache - hit: two sequential reads produce one fetch", async () => {
  clearCommentCache();
  const { fn, calls } = makeFetcher([comment(1, "hello")]);

  const first = await getCachedComments("org/repo", 42, fn);
  const second = await getCachedComments("org/repo", 42, fn);

  assertEquals(calls.count, 1);
  assertEquals(first.length, 1);
  assertEquals(second.length, 1);
  assertEquals(second[0]!.body, "hello");
});

Deno.test("comment_cache - miss after invalidation forces refetch", async () => {
  clearCommentCache();
  const { fn, calls } = makeFetcher([comment(1, "hello")]);

  await getCachedComments("org/repo", 42, fn);
  assertEquals(calls.count, 1);

  invalidateComments("org/repo", 42);

  await getCachedComments("org/repo", 42, fn);
  assertEquals(calls.count, 2);
});

Deno.test("comment_cache - TTL expiry triggers refetch", async () => {
  clearCommentCache();
  const { fn, calls } = makeFetcher([comment(1, "hello")]);

  // First read populates cache at t=1000.
  let now = 1000;
  const clock = () => now;

  await getCachedComments("org/repo", 42, fn, { ttlSeconds: 60, now: clock });
  assertEquals(calls.count, 1);

  // Within TTL — hit.
  now = 1050;
  await getCachedComments("org/repo", 42, fn, { ttlSeconds: 60, now: clock });
  assertEquals(calls.count, 1);

  // Past TTL — miss, refetch.
  now = 1061;
  await getCachedComments("org/repo", 42, fn, { ttlSeconds: 60, now: clock });
  assertEquals(calls.count, 2);
});

Deno.test("comment_cache - disjoint keys stay separate", async () => {
  clearCommentCache();
  const a = makeFetcher([comment(1, "A")]);
  const b = makeFetcher([comment(2, "B")]);
  const c = makeFetcher([comment(3, "C")]);

  const fromA = await getCachedComments("org/repo", 1, a.fn);
  const fromB = await getCachedComments("org/repo", 2, b.fn);
  const fromC = await getCachedComments("other/repo", 1, c.fn);

  assertEquals(a.calls.count, 1);
  assertEquals(b.calls.count, 1);
  assertEquals(c.calls.count, 1);
  assertEquals(fromA[0]!.body, "A");
  assertEquals(fromB[0]!.body, "B");
  assertEquals(fromC[0]!.body, "C");

  // Re-read each — no further fetches.
  await getCachedComments("org/repo", 1, a.fn);
  await getCachedComments("org/repo", 2, b.fn);
  await getCachedComments("other/repo", 1, c.fn);
  assertEquals(a.calls.count, 1);
  assertEquals(b.calls.count, 1);
  assertEquals(c.calls.count, 1);
});

Deno.test("comment_cache - invalidate is scoped to a single (repo, issue) pair", async () => {
  clearCommentCache();
  const a = makeFetcher([comment(1, "A")]);
  const b = makeFetcher([comment(2, "B")]);

  await getCachedComments("org/repo", 1, a.fn);
  await getCachedComments("org/repo", 2, b.fn);
  assertEquals(a.calls.count, 1);
  assertEquals(b.calls.count, 1);

  invalidateComments("org/repo", 1);

  await getCachedComments("org/repo", 1, a.fn); // miss — refetch
  await getCachedComments("org/repo", 2, b.fn); // hit — no refetch
  assertEquals(a.calls.count, 2);
  assertEquals(b.calls.count, 1);
});

Deno.test("comment_cache - stats track hits and misses", async () => {
  clearCommentCache();
  const { fn } = makeFetcher([comment(1, "x")]);

  await getCachedComments("org/repo", 1, fn); // miss
  await getCachedComments("org/repo", 1, fn); // hit
  await getCachedComments("org/repo", 1, fn); // hit
  await getCachedComments("org/repo", 2, fn); // miss

  const stats = getCommentCacheStats();
  assertEquals(stats.hits, 2);
  assertEquals(stats.misses, 2);
});

Deno.test("comment_cache - stats reflect TTL-expired entries as misses", async () => {
  clearCommentCache();
  const { fn } = makeFetcher([comment(1, "x")]);

  let now = 1000;
  const clock = () => now;

  await getCachedComments("org/repo", 1, fn, { ttlSeconds: 60, now: clock }); // miss
  now = 2000;
  await getCachedComments("org/repo", 1, fn, { ttlSeconds: 60, now: clock }); // expired -> miss

  const stats = getCommentCacheStats();
  assertEquals(stats.hits, 0);
  assertEquals(stats.misses, 2);
});

Deno.test("comment_cache - clearCommentCache resets state", async () => {
  clearCommentCache();
  const { fn, calls } = makeFetcher([comment(1, "x")]);

  await getCachedComments("org/repo", 1, fn);
  assertEquals(calls.count, 1);

  clearCommentCache();

  await getCachedComments("org/repo", 1, fn);
  assertEquals(calls.count, 2);

  const stats = getCommentCacheStats();
  // After last clear, only the post-clear miss remains.
  assertEquals(stats.misses, 1);
  assertEquals(stats.hits, 0);
});
