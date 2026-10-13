/**
 * Closed-PR self-healing guards against milestone rollups (Issue #3476).
 *
 * The self-healing path wrongly closes sub-issues whose work is not on the
 * branch in two ways: it read only the first (unpaginated) page of the
 * timeline, so the latest assignment beyond page 1 was invisible, and it kept
 * every title-search hit, so a milestone sync PR titled `Sync main into
 * milestone/50-foo` closed the issue. These tests pin the corrected behaviour:
 * the whole paginated timeline is read for the latest assignment and the
 * latest reopen, and a milestone sync PR is dropped before any landing read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import { detectAssignedWithClosedPr } from "../lib/stuck_recovery.ts";
import {
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_detection.ts";
import type { TimelineLabelEventJson } from "../lib/validation.ts";

async function makeTempDir(prefix = "src-test-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: ["org/repo"],
  };
}

/**
 * True for the per-issue `gh pr list --search "in:title ..."` lookup, not
 * for the repo-wide closed-PR listing — which also carries `--search`, for
 * update-recency ordering, since Issue #2901.
 */
function isTitleSearchCall(args: string[]): boolean {
  const searchIdx = args.indexOf("--search");
  return searchIdx !== -1 &&
    (args[searchIdx + 1]?.includes("in:title") ?? false);
}

/**
 * Build a base issue payload matching the `issues_all` cache shape.
 */
function buildIssue(num: number, updatedAt: string, opts?: {
  title?: string;
  labels?: Array<{ name: string }>;
}): Record<string, unknown> {
  return {
    number: num,
    title: opts?.title ?? `Issue ${num}`,
    assignees: [{ login: "testuser" }],
    labels: opts?.labels ?? [],
    author: { login: "alice" },
    createdAt: updatedAt,
    updatedAt,
    url: `https://example/${num}`,
    milestone: null,
  };
}

const PER_PAGE = 100;

function assignedEvent(at: string): TimelineLabelEventJson {
  return {
    event: "assigned",
    actor: { login: "testuser" },
    assignee: { login: "testuser" },
    created_at: at,
  };
}

function filler(i: number): TimelineLabelEventJson {
  return {
    event: "commented",
    actor: { login: "VibeCoderST" },
    created_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000)
      .toISOString(),
  };
}

Deno.test("detectAssignedWithClosedPr - reads the latest assignment beyond the first timeline page (Issue #3476)", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];
    const unassigned: number[] = [];

    // 132-event timeline: an early assignment on page 1, then a later one on
    // page 2 (index 130). Page 1 alone would only show the 4 October one.
    const events: TimelineLabelEventJson[] = [
      assignedEvent("2026-10-04T22:49:00Z"),
    ];
    for (let i = 0; events.length < 130; i++) events.push(filler(i));
    events.push(assignedEvent("2026-10-09T06:27:00Z"));

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 5,
          title: "Fix bug (#50)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: "2026-10-05T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-10-05T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "main",
        });
      }
      if (args[0] === "api" && args[1]?.includes("/timeline?per_page=")) {
        const query = new URLSearchParams(args[1].split("?")[1] ?? "");
        const page = Number(query.get("page") ?? "1");
        return JSON.stringify(
          events.slice((page - 1) * PER_PAGE, page * PER_PAGE),
        );
      }
      if (args[0] === "api" && args.includes("--jq")) {
        // The pre-fix unpaginated read: only the 4 October assignment on page 1.
        return "2026-10-04T22:49:00Z";
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "behind" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);
    assertEquals(closed, []);
    assertEquals(unassigned, [50]);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAssignedWithClosedPr - a milestone sync PR does not close the issue (Issue #3476)", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];
    const unassigned: number[] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 900,
          title: "Sync main into milestone/50-foo",
          baseRefName: "milestone/50-foo",
          headRefName: "sync/milestone-50-foo",
          mergedAt: "2026-02-01T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-02-01T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "main",
        });
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "behind" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    assertEquals(closed, []);
    assertEquals(unassigned, []);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAssignedWithClosedPr - a merged PR predating the latest reopen does not close the issue (Issue #3476)", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];
    const unassigned: number[] = [];
    const calls: string[][] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 5,
          title: "Fix bug (#50)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: "2026-10-05T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-10-05T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "main",
        });
      }
      if (args[0] === "api" && args[1]?.includes("/timeline?per_page=")) {
        return JSON.stringify([{
          event: "reopened",
          actor: { login: "nleck" },
          created_at: "2026-10-05T18:00:00Z",
        }]);
      }
      if (args[0] === "api" && args.includes("--jq")) {
        // The pre-fix unpaginated read; empty means "no assignment found".
        return "";
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "behind" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);
    assertEquals(closed, []);
    assertEquals(unassigned, [50]);

    // The reopen guard posts its own "predates the latest reopen" comment
    // (never the ordinary close path's comment) and unassigns through the
    // exact `gh issue edit` argv. Pinned arg-for-arg so a dropped element in
    // either call cannot quietly fall through to the close path.
    const commentCalls = calls.filter((c) => c[1] === "comment");
    assertEquals(commentCalls.length, 1);
    const comment = commentCalls[0]!;
    assertEquals(comment[0], "issue");
    assertEquals(comment[2], "50");
    assertEquals(comment[3], "--repo");
    assertEquals(comment[4], "org/repo");
    assertEquals(comment[5], "--body");
    assertEquals(
      comment[6]?.includes("predates the issue's latest reopen"),
      true,
    );

    const editCalls = calls.filter((c) => c.includes("--remove-assignee"));
    assertEquals(editCalls.length, 1);
    const edit = editCalls[0]!;
    assertEquals(edit[0], "issue");
    assertEquals(edit[1], "edit");
    assertEquals(edit[2], "50");
    assertEquals(edit[3], "--repo");
    assertEquals(edit[4], "org/repo");
    assertEquals(edit[5], "--remove-assignee");
    assertEquals(edit[6], "testuser");

    // The guard mutates state, so the shared issues_all cache is dropped and
    // the per-issue title-search caches it read are invalidated.
    assertEquals(await cache.read("org/repo", "issues_all"), null);
    assertEquals(await cache.read("org/repo", "prs_title_merged_50"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAssignedWithClosedPr - an unreadable timeline closes nothing and unassigns nothing (PR #3640 review)", async () => {
  const cacheDir = await makeTempDir("src-cache-");
  const workDir = await makeTempDir("src-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir);

    const closed: number[] = [];
    const unassigned: number[] = [];

    // Row 3 of the issue: merged 10-05, reopened that evening, re-assigned
    // 10-09. With the timeline unreadable neither guard can fire, so a close
    // here would be the stale-merge close this change exists to stop.
    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(50, "2026-01-01T00:00:00Z")]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("open")
      ) {
        return JSON.stringify([]);
      }
      if (
        args[0] === "pr" && args[1] === "list" &&
        isTitleSearchCall(args) && args.includes("merged")
      ) {
        return JSON.stringify([{
          number: 5,
          title: "Fix bug (#50)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: "2026-10-05T00:00:00Z",
        }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-10-05T00:00:00Z",
          mergeCommit: { oid: "abc123" },
          baseRefName: "main",
        });
      }
      if (args[0] === "api" && args[1]?.includes("/timeline")) {
        throw new Error("HTTP 502: Bad Gateway");
      }
      if (args[0] === "api" && args.join(" ").includes("/compare/")) {
        return JSON.stringify({ status: "behind" });
      }
      if (args[0] === "api" && args.join(" ").includes(".default_branch")) {
        return "main\n";
      }
      if (args[0] === "api") {
        return "2025-01-01T00:00:00Z";
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(parseInt(args[2]!));
      }
      if (
        args[0] === "issue" && args[1] === "edit" &&
        args.includes("--remove-assignee")
      ) {
        unassigned.push(parseInt(args[2]!));
      }
      return "";
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "testuser",
      "planning",
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    assertEquals(closed, []);
    assertEquals(unassigned, []);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
