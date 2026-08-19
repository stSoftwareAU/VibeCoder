/**
 * Tests for IssueCache wiring in milestone helpers (Issue #1786).
 *
 * Validates the new shared cache helpers in `issue_query.ts` and the
 * milestone helpers that use them.
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  fetchClosedIssuesByMilestone,
  fetchOpenIssuesByMilestone,
} from "../lib/issue_query.ts";
import { getMilestoneProgress } from "../lib/milestone_progress.ts";
import { checkMilestoneComplete } from "../lib/milestone_completion.ts";

function makeCache(ttlSeconds = 600): { cache: IssueCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "milestone-cache-test-" });
  return { cache: new IssueCache(dir, ttlSeconds), dir };
}

function recordingGh() {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const isIssueList = args[0] === "issue" && args[1] === "list";
    const stateIdx = args.indexOf("--state");
    const state = stateIdx >= 0 ? args[stateIdx + 1] : undefined;
    const hasMilestoneFlag = args.includes("--milestone");

    if (isIssueList && state === "closed" && !hasMilestoneFlag) {
      // Issue #1908: fetchAllClosedIssues batch (no --milestone). Returns
      // closed issues tagged with milestone metadata so callers can filter
      // locally.
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "first", milestone: { title: "v1.0" } },
        { number: 2, title: "second", milestone: { title: "v1.0" } },
      ]));
    }
    if (isIssueList && state === "closed" && hasMilestoneFlag) {
      // Legacy per-milestone closed fetch (pre-#1908 callers).
      return Promise.resolve(JSON.stringify([
        { number: 1, title: "first" },
        { number: 2, title: "second" },
      ]));
    }
    if (isIssueList && !hasMilestoneFlag) {
      // fetchAllIssues (open batch) — return a mix of milestones.
      return Promise.resolve(JSON.stringify([
        {
          number: 3,
          title: "open-A",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "v1.0" },
          author: { login: "alice" },
          url: "u",
        },
        {
          number: 4,
          title: "open-B",
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          milestone: { title: "v2.0" },
          author: { login: "alice" },
          url: "u",
        },
      ]));
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

Deno.test("fetchClosedIssuesByMilestone — cold call hits gh and warm call hits cache", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();
    const r1 = await fetchClosedIssuesByMilestone(
      "owner/repo",
      "v1.0",
      cache,
      gh.fn,
    );
    assertEquals(r1.length, 2);
    const issueListCalls = gh.calls.filter((a) =>
      a[0] === "issue" && a[1] === "list" && a.includes("closed")
    ).length;
    assertEquals(issueListCalls, 1);

    // Warm call serves from cache — no extra gh invocation.
    const r2 = await fetchClosedIssuesByMilestone(
      "owner/repo",
      "v1.0",
      cache,
      gh.fn,
    );
    assertEquals(r2.length, 2);
    const issueListCallsAfter = gh.calls.filter((a) =>
      a[0] === "issue" && a[1] === "list" && a.includes("closed")
    ).length;
    assertEquals(issueListCallsAfter, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchOpenIssuesByMilestone — filters issues_all by milestone title", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();

    const v1 = await fetchOpenIssuesByMilestone(
      "owner/repo",
      "v1.0",
      cache,
      gh.fn,
    );
    assertEquals(v1.map((i) => i.number), [3]);

    // Second call hits the issues_all cache, no extra gh invocation.
    const callsBefore = gh.calls.length;
    const v2 = await fetchOpenIssuesByMilestone(
      "owner/repo",
      "v2.0",
      cache,
      gh.fn,
    );
    assertEquals(v2.map((i) => i.number), [4]);
    assertEquals(gh.calls.length, callsBefore);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("getMilestoneProgress — second call within TTL skips both gh queries", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();

    const r1 = await getMilestoneProgress(
      "owner/repo",
      "v1.0",
      gh.fn,
      cache,
    );
    assertEquals(r1.ok, true);
    if (!r1.ok) throw new Error("unexpected");
    assertEquals(r1.value.closedCount, 2);

    const callsBefore = gh.calls.length;
    const r2 = await getMilestoneProgress(
      "owner/repo",
      "v1.0",
      gh.fn,
      cache,
    );
    assertEquals(r2.ok, true);
    // No extra gh calls — both closed and open paths are cached.
    assertEquals(gh.calls.length, callsBefore);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchClosedIssuesByMilestone — two milestones share the closed batch (Issue #1908)", async () => {
  // Pre-#1908 each milestone got its own `gh issue list --milestone X
  // --state closed` call. With the shared `fetchAllClosedIssues` batch,
  // a second milestone lookup within the TTL window must hit the cache
  // and not re-invoke gh.
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();

    const v1Closed = await fetchClosedIssuesByMilestone(
      "owner/repo",
      "v1.0",
      cache,
      gh.fn,
    );
    assertEquals(v1Closed.map((i) => i.number), [1, 2]);

    const callsBefore = gh.calls.length;

    // A different milestone — must serve from the shared closed batch.
    const v2Closed = await fetchClosedIssuesByMilestone(
      "owner/repo",
      "v2.0",
      cache,
      gh.fn,
    );
    assertEquals(v2Closed.length, 0);
    assertEquals(
      gh.calls.length,
      callsBefore,
      "second milestone must not trigger a new gh call — closed batch is shared",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkMilestoneComplete — uses issues_all cache for the open check", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();
    // First call populates the issues_all cache.
    await checkMilestoneComplete("owner/repo", "v1.0", gh.fn, cache);
    const callsBefore = gh.calls.length;
    // Second call must serve from cache.
    const r = await checkMilestoneComplete("owner/repo", "v1.0", gh.fn, cache);
    assertEquals(r.ok, true);
    assertEquals(gh.calls.length, callsBefore);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
