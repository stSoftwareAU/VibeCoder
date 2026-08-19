/**
 * Tests for all-state PR/issue cache helpers in issue_query.ts (Issue #1795).
 *
 * Covers:
 *   - `fetchAllStatePRsByBranch` + invalidation companion
 *   - `fetchAllStateIssuesByMilestone` + invalidation companion
 */

import { assertEquals } from "@std/assert";
import {
  fetchAllStateIssuesByMilestone,
  fetchAllStatePRsByBranch,
  invalidateAllStateIssuesByMilestone,
  invalidateAllStatePRsByBranch,
} from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-cache-all-state-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// fetchAllStatePRsByBranch
// ---------------------------------------------------------------------------

Deno.test("fetchAllStatePRsByBranch - cold cache fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "Summary", headRefName: "milestone/v1" },
        { number: 2, title: "Other branch", headRefName: "feature-x" },
      ]));
    };
    const prs = await fetchAllStatePRsByBranch(
      "o/r",
      "milestone/v1",
      cache,
      mockGh,
    );
    assertEquals(prs.length, 2);
    assertEquals(prs[0]?.headRefName, "milestone/v1");
    assertEquals(calls.length, 1);
    const sent = calls[0]!.join(" ");
    assertEquals(sent.includes("--state all"), true);
    assertEquals(sent.includes("--head milestone/v1"), true);
    assertEquals(sent.includes("--limit 100"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStatePRsByBranch - warm cache avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "T", headRefName: "milestone/v1" },
      ]));
    };
    await fetchAllStatePRsByBranch("o/r", "milestone/v1", cache, mockGh);
    await fetchAllStatePRsByBranch("o/r", "milestone/v1", cache, mockGh);
    assertEquals(callCount, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStatePRsByBranch - parse failure returns empty array", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");
    const prs = await fetchAllStatePRsByBranch(
      "o/r",
      "milestone/v1",
      cache,
      mockGh,
    );
    assertEquals(prs, []);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStatePRsByBranch - works without cache", async () => {
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      { number: 5, title: "T", headRefName: "milestone/v2" },
    ]));
  const prs = await fetchAllStatePRsByBranch(
    "o/r",
    "milestone/v2",
    undefined,
    mockGh,
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.number, 5);
});

Deno.test("invalidateAllStatePRsByBranch - forces refetch", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchAllStatePRsByBranch("o/r", "milestone/v1", cache, mockGh);
    await invalidateAllStatePRsByBranch(cache, "o/r", "milestone/v1");
    await fetchAllStatePRsByBranch("o/r", "milestone/v1", cache, mockGh);
    assertEquals(callCount, 2);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// fetchAllStateIssuesByMilestone
// ---------------------------------------------------------------------------

Deno.test("fetchAllStateIssuesByMilestone - cold cache fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([
        { number: 100, title: "Merge milestone 'v1' to main" },
        { number: 101, title: "Other milestone issue" },
      ]));
    };
    const issues = await fetchAllStateIssuesByMilestone(
      "o/r",
      3,
      cache,
      mockGh,
    );
    assertEquals(issues.length, 2);
    assertEquals(issues[0]?.number, 100);
    assertEquals(calls.length, 1);
    const sent = calls[0]!.join(" ");
    assertEquals(sent.includes("--state all"), true);
    assertEquals(sent.includes("--milestone 3"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStateIssuesByMilestone - warm cache avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "T" },
      ]));
    };
    await fetchAllStateIssuesByMilestone("o/r", 5, cache, mockGh);
    await fetchAllStateIssuesByMilestone("o/r", 5, cache, mockGh);
    assertEquals(callCount, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStateIssuesByMilestone - distinct milestones do not collide", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchAllStateIssuesByMilestone("o/r", 1, cache, mockGh);
    await fetchAllStateIssuesByMilestone("o/r", 2, cache, mockGh);
    assertEquals(callCount, 2);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStateIssuesByMilestone - parse failure returns empty array", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");
    const issues = await fetchAllStateIssuesByMilestone(
      "o/r",
      1,
      cache,
      mockGh,
    );
    assertEquals(issues, []);
  } finally {
    await cleanup();
  }
});

Deno.test("fetchAllStateIssuesByMilestone - works without cache", async () => {
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      { number: 50, title: "Tracking issue" },
    ]));
  const issues = await fetchAllStateIssuesByMilestone(
    "o/r",
    4,
    undefined,
    mockGh,
  );
  assertEquals(issues.length, 1);
  assertEquals(issues[0]?.number, 50);
});

Deno.test("invalidateAllStateIssuesByMilestone - forces refetch", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve("[]");
    };
    await fetchAllStateIssuesByMilestone("o/r", 9, cache, mockGh);
    await invalidateAllStateIssuesByMilestone(cache, "o/r", 9);
    await fetchAllStateIssuesByMilestone("o/r", 9, cache, mockGh);
    assertEquals(callCount, 2);
  } finally {
    await cleanup();
  }
});
