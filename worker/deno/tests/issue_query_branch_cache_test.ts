/**
 * Tests for branch-keyed PR cache helpers in issue_query.ts (Issue #1795).
 *
 * Covers `fetchPRsByBranch` and its invalidation companion. Each test
 * uses a fresh temp-directory-backed `IssueCache` so cold/warm/parse-
 * failure paths can be exercised in isolation.
 */

import { assertEquals } from "@std/assert";
import {
  fetchClosedPRsByBranch,
  fetchPRsByBranch,
  invalidatePRsByBranch,
} from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-cache-branch-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("fetchPRsByBranch - cold cache fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([
        {
          number: 42,
          title: "Fix (#42)",
          baseRefName: "main",
          headRefName: "issue-42",
        },
      ]));
    };

    const prs = await fetchPRsByBranch(
      "o/r",
      "issue-42",
      "open",
      cache,
      mockGh,
    );
    assertEquals(prs.length, 1);
    assertEquals(prs[0]?.number, 42);
    assertEquals(prs[0]?.headRefName, "issue-42");
    // One underlying fetch — de-duplication is observable behaviour.
    // The exact gh flags used to filter (--head/--state) are an
    // implementation detail and are intentionally not asserted here.
    assertEquals(calls.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsByBranch - warm cache avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "T", baseRefName: "main", headRefName: "feat" },
      ]));
    };
    await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    assertEquals(callCount, 1, "second call should be served from cache");
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsByBranch - merged state uses distinct cache key from open", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    await fetchPRsByBranch("o/r", "feat", "merged", cache, mockGh);
    assertEquals(callCount, 2, "different states must not share cache entries");
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsByBranch - returns empty array on parse failure", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");
    const prs = await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    assertEquals(prs, []);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsByBranch - works without cache", async () => {
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      { number: 9, title: "T", baseRefName: "main", headRefName: "x" },
    ]));
  const prs = await fetchPRsByBranch("o/r", "x", "open", undefined, mockGh);
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.number, 9);
});

Deno.test("invalidatePRsByBranch - forces a refetch on next read", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    await invalidatePRsByBranch(cache, "o/r", "feat", "open");
    await fetchPRsByBranch("o/r", "feat", "open", cache, mockGh);
    assertEquals(callCount, 2, "post-invalidate read must hit network again");
  } finally {
    await cleanup();
  }
});

// --- fetchClosedPRsByBranch (Issue #3152) ---

Deno.test("fetchClosedPRsByBranch - parses closed PRs with merge state", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify([
        {
          number: 7,
          title: "Fix (#1)",
          mergedAt: null,
          closedAt: "2026-07-01T00:00:00Z",
        },
        {
          number: 5,
          title: "Fix (#1)",
          mergedAt: "2026-06-01T00:00:00Z",
          closedAt: "2026-06-01T00:00:00Z",
        },
      ]));

    const prs = await fetchClosedPRsByBranch(
      "o/r",
      "issue-1-fix",
      cache,
      mockGh,
    );
    assertEquals(prs.length, 2);
    assertEquals(prs[0]?.mergedAt, null);
    assertEquals(prs[1]?.mergedAt, "2026-06-01T00:00:00Z");
  } finally {
    await cleanup();
  }
});

Deno.test("fetchClosedPRsByBranch - empty branch skips network", async () => {
  let called = false;
  const mockGh = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("[]");
  };
  const prs = await fetchClosedPRsByBranch("o/r", "", undefined, mockGh);
  assertEquals(prs.length, 0);
  assertEquals(called, false);
});

Deno.test("fetchClosedPRsByBranch - returns empty on gh failure", async () => {
  const mockGh = (_args: string[]): Promise<string> => {
    throw new Error("network down");
  };
  const prs = await fetchClosedPRsByBranch(
    "o/r",
    "issue-1-fix",
    undefined,
    mockGh,
  );
  assertEquals(prs.length, 0);
});

Deno.test("fetchClosedPRsByBranch - warm cache avoids second gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchClosedPRsByBranch("o/r", "issue-1-fix", cache, mockGh);
    await fetchClosedPRsByBranch("o/r", "issue-1-fix", cache, mockGh);
    assertEquals(callCount, 1);
  } finally {
    await cleanup();
  }
});
