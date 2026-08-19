/**
 * Tests for title-search PR cache helpers in issue_query.ts (Issue #1795).
 *
 * Covers `fetchPRsForIssueByTitle` and its invalidation companion.
 */

import { assertEquals } from "@std/assert";
import {
  fetchPRsForIssueByTitle,
  invalidatePRsForIssueByTitle,
} from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-cache-title-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("fetchPRsForIssueByTitle - cold cache fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([
        {
          number: 7,
          title: "Fix bug (#42)",
          headRefName: "issue-42",
          baseRefName: "main",
          mergedAt: null,
        },
      ]));
    };
    const prs = await fetchPRsForIssueByTitle("o/r", 42, "open", cache, mockGh);
    assertEquals(prs.length, 1);
    assertEquals(prs[0]?.number, 7);
    assertEquals(prs[0]?.mergedAt, null);
    assertEquals(calls.length, 1);
    const sent = calls[0]!.join(" ");
    assertEquals(sent.includes("--state open"), true);
    assertEquals(
      sent.includes("in:title (#42) OR in:title (Issue #42)"),
      true,
      "should include the standard worker title-search expression",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsForIssueByTitle - warm cache avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        {
          number: 1,
          title: "T",
          headRefName: "h",
          baseRefName: "main",
          mergedAt: null,
        },
      ]));
    };
    await fetchPRsForIssueByTitle("o/r", 99, "closed", cache, mockGh);
    await fetchPRsForIssueByTitle("o/r", 99, "closed", cache, mockGh);
    assertEquals(callCount, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsForIssueByTitle - state and issue number partition the cache", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchPRsForIssueByTitle("o/r", 1, "open", cache, mockGh);
    await fetchPRsForIssueByTitle("o/r", 1, "closed", cache, mockGh);
    await fetchPRsForIssueByTitle("o/r", 2, "open", cache, mockGh);
    assertEquals(
      callCount,
      3,
      "each (issue, state) pair must be a distinct cache entry",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsForIssueByTitle - parse failure returns empty array", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("garbage");
    const prs = await fetchPRsForIssueByTitle("o/r", 5, "open", cache, mockGh);
    assertEquals(prs, []);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchPRsForIssueByTitle - works without cache", async () => {
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        number: 3,
        title: "Closed PR (#3)",
        headRefName: "h",
        baseRefName: "main",
        mergedAt: null,
      },
    ]));
  const prs = await fetchPRsForIssueByTitle(
    "o/r",
    3,
    "closed",
    undefined,
    mockGh,
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.number, 3);
});

Deno.test("fetchPRsForIssueByTitle - exposes mergedAt for closed-not-merged filtering", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify([
        {
          number: 11,
          title: "Closed (#11)",
          headRefName: "h",
          baseRefName: "main",
          mergedAt: null,
        },
        {
          number: 12,
          title: "Merged (#11)",
          headRefName: "h",
          baseRefName: "main",
          mergedAt: "2025-01-01T00:00:00Z",
        },
      ]));
    const prs = await fetchPRsForIssueByTitle(
      "o/r",
      11,
      "closed",
      cache,
      mockGh,
    );
    const notMerged = prs.filter((pr) => !pr.mergedAt);
    assertEquals(notMerged.length, 1);
    assertEquals(notMerged[0]?.number, 11);
  } finally {
    await cleanup();
  }
});

Deno.test("invalidatePRsForIssueByTitle - forces refetch on next read", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchPRsForIssueByTitle("o/r", 7, "open", cache, mockGh);
    await invalidatePRsForIssueByTitle(cache, "o/r", 7, "open");
    await fetchPRsForIssueByTitle("o/r", 7, "open", cache, mockGh);
    assertEquals(callCount, 2);
  } finally {
    await cleanup();
  }
});
