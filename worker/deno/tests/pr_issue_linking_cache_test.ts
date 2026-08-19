/**
 * Cache-shape tests for pr_issue_linking.ts (Issue #1796).
 *
 * Covers cache hit, cache miss, and post-mutation invalidation for the
 * helpers that were refactored to use the narrow per-branch and
 * per-issue cache helpers from #1795.
 */

import { assertEquals } from "@std/assert";
import {
  closeDuplicatePrs,
  findExistingPrForBranch,
  findExistingPrForIssue,
} from "../lib/pr_issue_linking.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "pr-link-cache-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

// =============================================================================
// findExistingPrForBranch — narrow per-branch cache
// =============================================================================

Deno.test("findExistingPrForBranch - cold cache calls gh, warm cache reuses", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const fn = (_args: string[]): Promise<string> => {
      callCount++;
      return Promise.resolve(JSON.stringify([
        { number: 7, title: "Fix", baseRefName: "main", headRefName: "fix-7" },
      ]));
    };
    const a = await findExistingPrForBranch("o/r", "fix-7", fn, cache);
    const b = await findExistingPrForBranch("o/r", "fix-7", fn, cache);
    assertEquals(a.ok, true);
    assertEquals(b.ok, true);
    if (a.ok) assertEquals(a.value, "https://github.com/o/r/pull/7");
    assertEquals(callCount, 1, "second call must be served from cache");
  } finally {
    await cleanup();
  }
});

Deno.test("findExistingPrForBranch - distinct branches do not share cache key", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const seenBranches: string[] = [];
    const fn = (args: string[]): Promise<string> => {
      const idx = args.indexOf("--head");
      if (idx >= 0) seenBranches.push(args[idx + 1] ?? "");
      return Promise.resolve("[]");
    };
    await findExistingPrForBranch("o/r", "branch-a", fn, cache);
    await findExistingPrForBranch("o/r", "branch-b", fn, cache);
    assertEquals(seenBranches, ["branch-a", "branch-b"]);
  } finally {
    await cleanup();
  }
});

// =============================================================================
// findExistingPrForIssue — title-search cache
// =============================================================================

Deno.test("findExistingPrForIssue - cache hit on second open lookup", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let openCalls = 0;
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.includes("--state open")) {
        openCalls++;
        return Promise.resolve(JSON.stringify([
          {
            number: 21,
            title: "Fix (#42)",
            baseRefName: "main",
            headRefName: "issue-42",
            mergedAt: null,
            closedAt: null,
          },
        ]));
      }
      // merged + closed states return empty (not exercised by this test)
      return Promise.resolve("[]");
    };
    const a = await findExistingPrForIssue("o/r", 42, fn, undefined, cache);
    const b = await findExistingPrForIssue("o/r", 42, fn, undefined, cache);
    assertEquals(a.ok, true);
    assertEquals(b.ok, true);
    if (a.ok) assertEquals(a.value, "https://github.com/o/r/pull/21");
    assertEquals(openCalls, 1, "open-state cache must be reused");
  } finally {
    await cleanup();
  }
});

Deno.test("findExistingPrForIssue - merged PR returned when no open match", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.includes("--state open")) return Promise.resolve("[]");
      if (argsStr.includes("--state merged")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 50,
            title: "Done (#42)",
            baseRefName: "main",
            headRefName: "issue-42",
            mergedAt: "2026-04-01T00:00:00Z",
            closedAt: "2026-04-01T00:00:00Z",
          },
        ]));
      }
      return Promise.resolve("[]");
    };
    const result = await findExistingPrForIssue(
      "o/r",
      42,
      fn,
      undefined,
      cache,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, "https://github.com/o/r/pull/50");
  } finally {
    await cleanup();
  }
});

Deno.test("findExistingPrForIssue - closed PR outside cooldown is ignored", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.includes("--state closed")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 9,
            title: "Old (#42)",
            baseRefName: "main",
            headRefName: "issue-42",
            mergedAt: null,
            closedAt: "1970-01-01T00:00:00Z",
          },
        ]));
      }
      return Promise.resolve("[]");
    };
    const result = await findExistingPrForIssue(
      "o/r",
      42,
      fn,
      1000, // 1 second cooldown
      cache,
    );
    assertEquals(result.ok, false);
  } finally {
    await cleanup();
  }
});

Deno.test("findExistingPrForIssue - closed PR inside cooldown blocks", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.includes("--state closed")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 9,
            title: "Recent (#42)",
            baseRefName: "main",
            headRefName: "issue-42",
            mergedAt: null,
            closedAt: recent,
          },
        ]));
      }
      return Promise.resolve("[]");
    };
    const result = await findExistingPrForIssue(
      "o/r",
      42,
      fn,
      3_600_000, // 1 hour cooldown
      cache,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, "https://github.com/o/r/pull/9");
  } finally {
    await cleanup();
  }
});

// =============================================================================
// closeDuplicatePrs — invalidation
// =============================================================================

Deno.test("closeDuplicatePrs - invalidates per-branch open cache after close", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let listCalls = 0;
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.startsWith("pr list")) {
        listCalls++;
        return Promise.resolve(JSON.stringify([
          {
            number: 100,
            title: "Keep",
            baseRefName: "main",
            headRefName: "fix-branch",
          },
          {
            number: 101,
            title: "Dup",
            baseRefName: "main",
            headRefName: "fix-branch",
          },
        ]));
      }
      if (argsStr.startsWith("pr close")) return Promise.resolve("");
      return Promise.resolve("");
    };

    // Pre-populate the per-branch cache to verify invalidation after close.
    const closed = await closeDuplicatePrs(
      "o/r",
      "fix-branch",
      "https://github.com/o/r/pull/100",
      fn,
      cache,
    );
    assertEquals(closed, 1);
    assertEquals(listCalls, 1);

    const cached = await cache.read<unknown[]>(
      "o/r",
      "prs_branch_open_fix-branch",
    );
    assertEquals(cached, null, "per-branch cache must be invalidated");
  } finally {
    await cleanup();
  }
});

Deno.test("closeDuplicatePrs - no invalidation when nothing was closed", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.startsWith("pr list")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 100,
            title: "Keep",
            baseRefName: "main",
            headRefName: "fix-branch",
          },
        ]));
      }
      return Promise.resolve("");
    };

    const closed = await closeDuplicatePrs(
      "o/r",
      "fix-branch",
      "https://github.com/o/r/pull/100",
      fn,
      cache,
    );
    assertEquals(closed, 0);

    // The lookup populated the cache — when no close occurred the
    // cache must remain valid for subsequent reads.
    const cached = await cache.read<unknown[]>(
      "o/r",
      "prs_branch_open_fix-branch",
    );
    assertEquals(Array.isArray(cached), true);
  } finally {
    await cleanup();
  }
});
