/**
 * Cache wiring tests for issue_lifecycle.ts (Issue #1798).
 *
 * Verifies that the merged-PR title-search in
 * `handlePrClosedAfterCreation` resolves through `IssueCache` (cache
 * hit/miss) when no `githubUser` is supplied, and that mutation paths
 * (`ensureIssueClosedIfPrMerged`, `unassignAfterPrCreated`,
 * `handlePrClosedAfterCreation`) invalidate the iteration-scoped
 * `issues_all` and per-issue `prs_title_${state}_${issueNumber}` cache
 * keys.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  ensureIssueClosedIfPrMerged,
  handlePrClosedAfterCreation,
  unassignAfterPrCreated,
} from "../lib/issue_lifecycle.ts";
import type { Logger } from "../types.ts";

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

async function makeTempDir(prefix = "lifecycle-cache-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

// ============================================================================
// handlePrClosedAfterCreation — title-search via fetchPRsForIssueByTitle
// ============================================================================

Deno.test("issue_lifecycle cache - handlePrClosedAfterCreation routes title search through prs_title_merged cache when no githubUser", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let mergedSearchCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "CLOSED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        argsStr.includes("--state merged")
      ) {
        mergedSearchCalls++;
        return JSON.stringify([
          {
            number: 99,
            title: "Resolved (#42)",
            baseRefName: "main",
            headRefName: "issue-42",
            mergedAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }
      return "";
    };

    const result = await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.actionTaken, true);
      assertEquals(result.value.reason.includes("another PR was merged"), true);
    }

    // The merged-state title search must have been issued and cached
    // under the per-issue title-search key.
    assertEquals(mergedSearchCalls, 1);

    // After mutation, the cache key must be invalidated.
    const cached = await cache.read("owner/repo", "prs_title_merged_42");
    assertEquals(
      cached,
      null,
      "post-mutation invalidation must drop prs_title_merged_42",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("issue_lifecycle cache - handlePrClosedAfterCreation reuses prs_title_merged cache between calls (no githubUser)", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let mergedSearchCalls = 0;
    let prViewCalls = 0;

    const ghFn = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") {
        prViewCalls++;
        // First call: PR is CLOSED; otherwise still CLOSED.
        return JSON.stringify({ state: "CLOSED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        argsStr.includes("--state merged")
      ) {
        mergedSearchCalls++;
        // No merged PR matches — falls through to retry path
        return JSON.stringify([]);
      }
      return "";
    };

    // First call populates the cache.
    await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    // After unassign mutation the cache is invalidated, so repeat lookup
    // refetches. Pre-populate the cache directly to verify the read path
    // honours it.
    await cache.write("owner/repo", "prs_title_merged_42", []);
    const before = mergedSearchCalls;

    await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );

    assertEquals(
      mergedSearchCalls,
      before,
      "second call must hit prs_title_merged_42 cache and skip gh search",
    );
    assertEquals(
      prViewCalls >= 2,
      true,
      "pr view is not cached and runs each call",
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

// ============================================================================
// ensureIssueClosedIfPrMerged — post-mutation invalidation
// ============================================================================

Deno.test("issue_lifecycle cache - ensureIssueClosedIfPrMerged invalidates issues_all and prs_title_*_N after closing", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    // Pre-populate the caches so we can verify they get dropped.
    await cache.write("owner/repo", "issues_all", [{ number: 1 }]);
    await cache.write("owner/repo", "prs_title_open_42", []);
    await cache.write("owner/repo", "prs_title_merged_42", []);
    await cache.write("owner/repo", "prs_title_closed_42", []);

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "MERGED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN", milestone: null });
      }
      return "";
    };

    const result = await ensureIssueClosedIfPrMerged(
      "owner/repo",
      42,
      100,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.closed, true);

    assertEquals(await cache.read("owner/repo", "issues_all"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_open_42"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_merged_42"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_closed_42"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("issue_lifecycle cache - ensureIssueClosedIfPrMerged leaves caches intact when PR not merged", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    await cache.write("owner/repo", "issues_all", [{ number: 1 }]);

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      return "";
    };

    const result = await ensureIssueClosedIfPrMerged(
      "owner/repo",
      42,
      100,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    assertEquals(result.ok, true);

    // No mutation took place → caches untouched.
    const cached = await cache.read("owner/repo", "issues_all");
    assertEquals(Array.isArray(cached), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

// ============================================================================
// unassignAfterPrCreated — post-mutation invalidation
// ============================================================================

Deno.test("issue_lifecycle cache - unassignAfterPrCreated invalidates issues_all and prs_title_*_N", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    await cache.write("owner/repo", "issues_all", [{ number: 1 }]);
    await cache.write("owner/repo", "prs_title_open_77", []);
    await cache.write("owner/repo", "prs_title_merged_77", []);
    await cache.write("owner/repo", "prs_title_closed_77", []);

    const ghFn = async (_args: string[]): Promise<string> => "";

    const result = await unassignAfterPrCreated(
      "owner/repo",
      77,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    assertEquals(result.ok, true);

    assertEquals(await cache.read("owner/repo", "issues_all"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_open_77"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_merged_77"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_closed_77"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("issue_lifecycle cache - unassignAfterPrCreated leaves caches intact on gh failure", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    await cache.write("owner/repo", "issues_all", [{ number: 1 }]);

    const ghFn = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("gh: not found"));

    const result = await unassignAfterPrCreated(
      "owner/repo",
      77,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    assertEquals(result.ok, false);

    // Mutation failed → caches must NOT be invalidated.
    const cached = await cache.read("owner/repo", "issues_all");
    assertEquals(Array.isArray(cached), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

// ============================================================================
// handlePrClosedAfterCreation — post-mutation invalidation
// ============================================================================

Deno.test("issue_lifecycle cache - handlePrClosedAfterCreation invalidates caches when no merged PR (retry path)", async () => {
  const cacheDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);

    await cache.write("owner/repo", "issues_all", [{ number: 1 }]);
    await cache.write("owner/repo", "prs_title_open_42", []);
    await cache.write("owner/repo", "prs_title_merged_42", []);
    await cache.write("owner/repo", "prs_title_closed_42", []);

    const ghFn = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ state: "CLOSED" });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "OPEN" });
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        argsStr.includes("--state merged")
      ) {
        return JSON.stringify([]);
      }
      return "";
    };

    const result = await handlePrClosedAfterCreation(
      "owner/repo",
      42,
      50,
      "bot",
      {
        ghCommandFn: ghFn,
        logger: makeLogger(),
        cache,
        verifyMergeLandedFn: alwaysLanded, // Issue #4396
      },
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.actionTaken, true);

    assertEquals(await cache.read("owner/repo", "issues_all"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_open_42"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_merged_42"), null);
    assertEquals(await cache.read("owner/repo", "prs_title_closed_42"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
