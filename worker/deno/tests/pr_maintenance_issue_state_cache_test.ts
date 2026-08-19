/**
 * Tests for the cached open-issue lookups added in Issue #1808.
 *
 * Covers two `pr_maintenance.ts` call sites that previously fired one
 * `gh issue view` call per PR:
 *
 *   - `closeIssuesForMergedPrs` (per-PR `--json state`)
 *   - `ensureAutoMergeOnOpenPrs` → `checkIssueHasLabel` (per-PR
 *     `--json labels`)
 *
 * Each test asserts both the behavioural outcome (issue closed,
 * auto-merge skipped, etc.) and the call-volume reduction (zero
 * per-issue `gh issue view` calls on the warm path).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";
import {
  type AutoMergeOptions,
  closeIssuesForMergedPrs,
  type CloseIssuesOptions,
  ensureAutoMergeOnOpenPrs,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import type { Logger } from "../types.ts";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

async function makeTempCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "pr-maint-cache-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

function makeBaseScanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): PrScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn,
  };
}

/**
 * Build a tracking gh command function that records every invocation
 * keyed by the joined args. Useful for asserting call volume.
 */
function makeTrackingGh(
  responses: (args: string[]) => string,
): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
  countMatching: (predicate: (args: string[]) => boolean) => number;
} {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push([...args]);
    return await Promise.resolve(responses(args));
  };
  return {
    fn,
    calls,
    countMatching: (predicate) => calls.filter(predicate).length,
  };
}

const isIssueViewCall = (args: string[]) =>
  args[0] === "issue" && args[1] === "view";

// =============================================================================
// closeIssuesForMergedPrs — Site 1
// =============================================================================

Deno.test(
  "closeIssuesForMergedPrs - cache hit: zero per-issue 'gh issue view' calls for N merged PRs",
  async () => {
    const { cache, cleanup } = await makeTempCache();
    try {
      // 3 merged PRs whose linked issues are still open. Without the
      // cache, this fires 3 `gh issue view --json state` calls. With
      // the cache (issues_all populated), it should fire zero.
      const allOpenIssues = [
        {
          number: 50,
          title: "A",
          labels: [],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
        {
          number: 51,
          title: "B",
          labels: [],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
        {
          number: 52,
          title: "C",
          labels: [],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
      ];
      await cache.write("org/repo", "issues_all", allOpenIssues);

      const closedIssues: string[] = [];
      const tracking = makeTrackingGh((args) => {
        const key = args.join(" ");
        if (key.includes("pr list")) {
          return JSON.stringify([
            { number: 100, title: "Fix login (Issue #50)" },
            { number: 101, title: "Fix logout (Issue #51)" },
            { number: 102, title: "Fix forgot (Issue #52)" },
          ]);
        }
        if (args[0] === "issue" && args[1] === "close") {
          closedIssues.push(args[2]!);
          return "";
        }
        return "[]";
      });

      const options: CloseIssuesOptions = {
        verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
        ...makeBaseScanOptions(tracking.fn),
        extractIssueNumber: (title: string) => {
          const m = title.match(/Issue #(\d+)/);
          return m ? m[1]! : null;
        },
        cache,
      };

      const result = await closeIssuesForMergedPrs(options);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.closedCount, 3);
      }
      assertEquals(
        closedIssues.sort(),
        ["50", "51", "52"],
      );
      // Critical: zero per-issue `gh issue view` calls on the warm path.
      assertEquals(
        tracking.countMatching(isIssueViewCall),
        0,
        "warm cache path must not call `gh issue view`",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "closeIssuesForMergedPrs - missing-from-map: closed issues are skipped without REST fallback",
  async () => {
    const { cache, cleanup } = await makeTempCache();
    try {
      // Pre-populate `issues_all` with NO issues — the linked issue
      // (#42) is therefore treated as already closed and no `gh issue
      // close` call should fire. Crucially, no per-issue `gh issue
      // view --json state` call should fire either.
      await cache.write("org/repo", "issues_all", []);

      const tracking = makeTrackingGh((args) => {
        const key = args.join(" ");
        if (key.includes("pr list")) {
          return JSON.stringify([
            { number: 100, title: "Fix (Issue #42)" },
          ]);
        }
        return "[]";
      });

      const options: CloseIssuesOptions = {
        verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
        ...makeBaseScanOptions(tracking.fn),
        extractIssueNumber: (title: string) => {
          const m = title.match(/Issue #(\d+)/);
          return m ? m[1]! : null;
        },
        cache,
      };

      const result = await closeIssuesForMergedPrs(options);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.closedCount, 0);
      }
      assertEquals(tracking.countMatching(isIssueViewCall), 0);
      // `issue close` must not fire either.
      assertEquals(
        tracking.calls.some((a) => a[0] === "issue" && a[1] === "close"),
        false,
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "closeIssuesForMergedPrs - invalidates issues_all after a closure",
  async () => {
    const { cache, cleanup } = await makeTempCache();
    try {
      const allOpenIssues = [
        {
          number: 50,
          title: "A",
          labels: [],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
      ];
      await cache.write("org/repo", "issues_all", allOpenIssues);

      const fn = async (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("pr list")) {
          return JSON.stringify([
            { number: 100, title: "Fix (Issue #50)" },
          ]);
        }
        return "";
      };

      const options: CloseIssuesOptions = {
        verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
        ...makeBaseScanOptions(fn),
        extractIssueNumber: (title: string) => {
          const m = title.match(/Issue #(\d+)/);
          return m ? m[1]! : null;
        },
        cache,
      };

      const result = await closeIssuesForMergedPrs(options);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.closedCount, 1);
      }
      const cached = await cache.read<unknown>("org/repo", "issues_all");
      assertEquals(
        cached,
        null,
        "issues_all cache must be invalidated after closure",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "closeIssuesForMergedPrs - no cache: falls back to per-issue REST (preserves existing behaviour)",
  async () => {
    const tracking = makeTrackingGh((args) => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return JSON.stringify([
          { number: 100, title: "Fix (Issue #50)" },
        ]);
      }
      if (args[0] === "issue" && args[1] === "view") {
        return "OPEN";
      }
      return "";
    });

    const options: CloseIssuesOptions = {
      verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
      ...makeBaseScanOptions(tracking.fn),
      extractIssueNumber: (title: string) => {
        const m = title.match(/Issue #(\d+)/);
        return m ? m[1]! : null;
      },
    };

    const result = await closeIssuesForMergedPrs(options);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.closedCount, 1);
    }
    // Without a cache, the per-issue REST call still fires — that is
    // the intended fallback path.
    assertEquals(tracking.countMatching(isIssueViewCall), 1);
  },
);

// =============================================================================
// ensureAutoMergeOnOpenPrs — Site 2 (checkIssueHasLabel)
// =============================================================================

Deno.test(
  "ensureAutoMergeOnOpenPrs - cache hit: zero per-issue 'gh issue view' label calls",
  async () => {
    const { cache, cleanup } = await makeTempCache();
    try {
      // Two PRs: the issue linked to PR 10 has the needs-screenshot
      // label, the issue linked to PR 11 does not. With the cache
      // pre-populated, no per-issue `gh issue view --json labels`
      // call should fire.
      const allOpenIssues = [
        {
          number: 60,
          title: "A",
          labels: ["needs-screenshot", "enhancement"],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
        {
          number: 61,
          title: "B",
          labels: ["enhancement"],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
      ];
      await cache.write("org/repo", "issues_all", allOpenIssues);

      const enabledPrs: number[] = [];
      const tracking = makeTrackingGh((args) => {
        const key = args.join(" ");
        if (key.includes("pr list")) {
          return JSON.stringify([
            { number: 10, headRefName: "issue-60-fix", autoMergeRequest: null },
            { number: 11, headRefName: "issue-61-fix", autoMergeRequest: null },
          ]);
        }
        return "[]";
      });

      const options: AutoMergeOptions = {
        ...makeBaseScanOptions(tracking.fn),
        getRepoConfig: () => "",
        enableAutoMergeFn: async (_repo: string, prNumber: number) => {
          enabledPrs.push(prNumber);
          return await Promise.resolve({ result: "enabled", message: "" });
        },
        cache,
      };

      const result = await ensureAutoMergeOnOpenPrs(options);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.enabledCount, 1);
        assertEquals(result.value.skippedCount, 1);
      }
      assertEquals(enabledPrs, [11]);
      assertEquals(
        tracking.countMatching(isIssueViewCall),
        0,
        "warm cache path must not call `gh issue view`",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "ensureAutoMergeOnOpenPrs - issue absent from cache map treated as no label",
  async () => {
    const { cache, cleanup } = await makeTempCache();
    try {
      // PR's linked issue (#999) is closed/missing — not in the open
      // list. Auto-merge must still proceed (closed issues cannot
      // carry the needs-screenshot label).
      const allOpenIssues = [
        {
          number: 60,
          title: "A",
          labels: [],
          assignees: [],
          author: "",
          url: "",
          createdAt: "",
          milestone: "",
        },
      ];
      await cache.write("org/repo", "issues_all", allOpenIssues);

      const enabledPrs: number[] = [];
      const tracking = makeTrackingGh((args) => {
        const key = args.join(" ");
        if (key.includes("pr list")) {
          return JSON.stringify([
            {
              number: 10,
              headRefName: "issue-999-fix",
              autoMergeRequest: null,
            },
          ]);
        }
        return "[]";
      });

      const options: AutoMergeOptions = {
        ...makeBaseScanOptions(tracking.fn),
        getRepoConfig: () => "",
        enableAutoMergeFn: async (_repo: string, prNumber: number) => {
          enabledPrs.push(prNumber);
          return await Promise.resolve({ result: "enabled", message: "" });
        },
        cache,
      };

      const result = await ensureAutoMergeOnOpenPrs(options);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.enabledCount, 1);
      }
      assertEquals(enabledPrs, [10]);
      assertEquals(tracking.countMatching(isIssueViewCall), 0);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "ensureAutoMergeOnOpenPrs - no cache: falls back to per-issue REST (preserves existing behaviour)",
  async () => {
    const tracking = makeTrackingGh((args) => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return JSON.stringify([
          { number: 10, headRefName: "issue-42-fix", autoMergeRequest: null },
        ]);
      }
      if (args[0] === "issue" && args[1] === "view") {
        return "needs-screenshot,enhancement";
      }
      return "[]";
    });

    const options: AutoMergeOptions = {
      ...makeBaseScanOptions(tracking.fn),
      getRepoConfig: () => "",
      enableAutoMergeFn: async () =>
        await Promise.resolve({ result: "enabled", message: "" }),
    };

    const result = await ensureAutoMergeOnOpenPrs(options);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.enabledCount, 0);
      assertEquals(result.value.skippedCount, 1);
    }
    // Without a cache, the per-issue REST call still fires.
    assertEquals(tracking.countMatching(isIssueViewCall), 1);
  },
);
