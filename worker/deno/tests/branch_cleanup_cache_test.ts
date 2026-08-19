/**
 * Cache-shape tests for branch_cleanup.ts (Issue #1796).
 *
 * Covers the per-branch open/merged cache routing in
 * `findOpenPrNumber` and `cleanupStaleRemoteBranches`. The merged-PR
 * caching in `cleanupMergedPrBranches` is covered by the existing
 * branch_cleanup_test.ts suite.
 */

import { assertEquals } from "@std/assert";
import {
  cleanupStaleRemoteBranches,
  findOpenPrNumber,
} from "../lib/branch_cleanup.ts";
import { IssueCache } from "../lib/issue_cache.ts";

async function makeTempCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "branch-cleanup-cache-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

// =============================================================================
// findOpenPrNumber — per-branch open cache
// =============================================================================

Deno.test("findOpenPrNumber - cache hit on second call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let calls = 0;
    const fn = (_args: string[]): Promise<string> => {
      calls++;
      return Promise.resolve(JSON.stringify([
        {
          number: 5,
          title: "Fix",
          baseRefName: "main",
          headRefName: "issue-5",
        },
      ]));
    };
    const a = await findOpenPrNumber("o/r", "issue-5", fn, cache);
    const b = await findOpenPrNumber("o/r", "issue-5", fn, cache);
    assertEquals(a, "5");
    assertEquals(b, "5");
    assertEquals(calls, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("findOpenPrNumber - empty list cache miss returns null", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let calls = 0;
    const fn = (_args: string[]): Promise<string> => {
      calls++;
      return Promise.resolve("[]");
    };
    const result = await findOpenPrNumber("o/r", "no-pr", fn, cache);
    assertEquals(result, null);
    assertEquals(calls, 1);

    // Empty result is still cached — second call should not re-issue.
    const result2 = await findOpenPrNumber("o/r", "no-pr", fn, cache);
    assertEquals(result2, null);
    assertEquals(calls, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("findOpenPrNumber - distinct branches get distinct cache keys", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const seen: string[] = [];
    const fn = (args: string[]): Promise<string> => {
      const idx = args.indexOf("--head");
      if (idx >= 0) seen.push(args[idx + 1] ?? "");
      return Promise.resolve("[]");
    };
    await findOpenPrNumber("o/r", "branch-a", fn, cache);
    await findOpenPrNumber("o/r", "branch-b", fn, cache);
    await findOpenPrNumber("o/r", "branch-a", fn, cache);
    assertEquals(seen, ["branch-a", "branch-b"]);
  } finally {
    await cleanup();
  }
});

// =============================================================================
// cleanupStaleRemoteBranches — per-branch merged cache
// =============================================================================

Deno.test("cleanupStaleRemoteBranches - per-branch merged lookup uses cache", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let mergedHeadCalls = 0;
    let mergedAuthorCalls = 0;

    const fn = (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");

      // Branch listing — return one issue-* branch.
      if (argsStr.includes("repos/o/r/branches")) {
        return Promise.resolve("issue-orphan\n");
      }

      // Merged PRs by author (used by the cache prefetch). Return empty
      // so the per-branch fallback is exercised.
      if (
        argsStr.includes("--state merged") &&
        argsStr.includes("--author") &&
        !argsStr.includes("--head")
      ) {
        mergedAuthorCalls++;
        return Promise.resolve("[]");
      }

      // Merged PRs by head branch — the per-branch fallback.
      if (argsStr.includes("--state merged") && argsStr.includes("--head")) {
        mergedHeadCalls++;
        return Promise.resolve(JSON.stringify([
          {
            number: 200,
            title: "Old",
            baseRefName: "main",
            headRefName: "issue-orphan",
          },
        ]));
      }

      // Open PRs by branch — returns empty (no blocking open PR).
      // Issue #3931: the deletion chokepoint queries both the head and the
      // base side with `--jq .[0].number`, which prints nothing when there
      // is no match (the array shape belonged to the old cached lookup).
      if (argsStr.includes("--state open")) {
        return Promise.resolve("");
      }

      // GET /git/ref — must succeed so the deletion path runs.
      if (argsStr.includes("/git/ref/heads/")) {
        return Promise.resolve(
          JSON.stringify({ ref: "refs/heads/issue-orphan" }),
        );
      }

      // DELETE the ref — succeeds.
      if (argsStr.includes("-X DELETE")) return Promise.resolve("");

      return Promise.resolve("");
    };

    const result = await cleanupStaleRemoteBranches(
      ["o/r"],
      "bot",
      { ghCommandFn: fn, cache },
    );
    assertEquals(result.ok, true);

    // Repeat to confirm the per-branch merged lookup is cached.
    await cleanupStaleRemoteBranches(
      ["o/r"],
      "bot",
      { ghCommandFn: fn, cache },
    );

    // Issue #1796: both invocations exercise the per-branch fallback
    // since the author-keyed prefetch returned empty. The first call
    // populates the `prs_branch_merged_issue-orphan` cache; the second
    // must reuse it.
    assertEquals(
      mergedHeadCalls,
      1,
      "per-branch merged lookup must be served from cache on second invocation",
    );
    assertEquals(
      mergedAuthorCalls,
      1,
      "author-keyed merged prefetch is cached across invocations too",
    );
  } finally {
    await cleanup();
  }
});
