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

// ---------------------------------------------------------------------------
// Author verification and the head-branch check (Issue #1124)
// ---------------------------------------------------------------------------

Deno.test("fetchPRsForIssueByTitle - asks GitHub who opened the match", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("[]");
  };
  await fetchPRsForIssueByTitle("o/r", 42, "open", undefined, mockGh);
  const json = calls[0]![calls[0]!.indexOf("--json") + 1] ?? "";
  assertEquals(
    json.split(",").includes("author"),
    true,
    "a title match is attacker-writable text; the author is the only " +
      "authenticated part of the row and must be requested",
  );
  assertEquals(
    json.split(",").includes("isCrossRepository"),
    true,
    "the head-branch check needs to know whether the head is in a fork",
  );
});

Deno.test("fetchPRsForIssueByTitle - keeps a PR whose head branch is in the repository", async () => {
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        number: 7,
        title: "Fix bug (#42)",
        headRefName: "issue-42-fix-bug",
        baseRefName: "main",
        mergedAt: null,
        closedAt: null,
        author: { login: "vibe-coder-bot" },
        isCrossRepository: false,
      },
    ]));
  const lines: string[] = [];
  const prs = await fetchPRsForIssueByTitle(
    "o/r",
    42,
    "open",
    undefined,
    mockGh,
    (m) => lines.push(m),
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.author, "vibe-coder-bot");
  assertEquals(prs[0]?.isCrossRepository, false);
  assertEquals(lines, []);
});

Deno.test("fetchPRsForIssueByTitle - drops a fork-headed PR and logs the drop", async () => {
  // Issue #1124: on a public repository anybody may open a PR from a fork
  // with the title `(#42)`. Every consumer reads a match as "the fleet
  // already has this issue in hand" and goes quiet, so a planted title
  // starves the issue. Pushing the head branch into the target repository
  // needs write access, which is what makes the head branch evidence.
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        number: 99,
        title: "Totally legitimate work (#42)",
        headRefName: "issue-42-fix-bug",
        baseRefName: "main",
        mergedAt: null,
        closedAt: null,
        author: { login: "drive-by-account" },
        isCrossRepository: true,
      },
    ]));
  const lines: string[] = [];
  const prs = await fetchPRsForIssueByTitle(
    "o/r",
    42,
    "open",
    undefined,
    mockGh,
    (m) => lines.push(m),
  );
  assertEquals(
    prs,
    [],
    "the fail direction is towards acting: a planted title must leave the " +
      "issue looking un-PR'd so the worker files, never silently skipped",
  );
  assertEquals(lines.length, 1);
  assertEquals(lines[0]?.includes("drive-by-account"), true);
  assertEquals(lines[0]?.includes("fork"), true);
});

Deno.test("fetchPRsForIssueByTitle - a fleet PR still hides behind a fork-headed impostor", async () => {
  // The guard that stops the fix becoming "always act": the genuine
  // same-repository match survives alongside the dropped fork one.
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      {
        number: 99,
        title: "Impostor (#42)",
        headRefName: "issue-42-fix-bug",
        baseRefName: "main",
        mergedAt: null,
        closedAt: null,
        author: { login: "drive-by-account" },
        isCrossRepository: true,
      },
      {
        number: 7,
        title: "Fix bug (#42)",
        headRefName: "issue-42-fix-bug",
        baseRefName: "main",
        mergedAt: null,
        closedAt: null,
        author: { login: "sibling-fleet-host" },
        isCrossRepository: false,
      },
    ]));
  const prs = await fetchPRsForIssueByTitle(
    "o/r",
    42,
    "open",
    undefined,
    mockGh,
    () => {},
  );
  assertEquals(prs.map((pr) => pr.number), [7]);
  assertEquals(
    prs[0]?.author,
    "sibling-fleet-host",
    "a sibling fleet host's PR must still be found — cross-host " +
      "convergence depends on it",
  );
});

Deno.test("fetchPRsForIssueByTitle - a row without the field reads as same-repository", async () => {
  // Cache entries written before #1124 carry neither field. They read as
  // the behaviour they were written under rather than as a new suppression.
  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([
      { number: 5, title: "Old row (#42)", headRefName: "h", baseRefName: "m" },
    ]));
  const prs = await fetchPRsForIssueByTitle(
    "o/r",
    42,
    "open",
    undefined,
    mockGh,
    () => {},
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.author, "");
  assertEquals(prs[0]?.isCrossRepository, false);
});
