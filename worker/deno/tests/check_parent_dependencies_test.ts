/**
 * Tests for the check-parent-deps command (Issue #484).
 *
 * Tests the command handler and the gh CLI-backed IssueFetcher.
 * GitHub API responses are mocked to enable deterministic testing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkParentDepsCommand,
  createGhIssueFetcher,
} from "../commands/check_parent_dependencies.ts";
import { checkParentBlocked } from "../lib/issue_dependencies.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

// =============================================================================
// createGhIssueFetcher tests
// =============================================================================

Deno.test("createGhIssueFetcher - getIssueState parses gh output", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ number: 42, state: "OPEN", title: "Test issue" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const state = await fetcher.getIssueState("owner/repo", 42);

  assertEquals(state.number, 42);
  assertEquals(state.state, "OPEN");
  assertEquals(state.title, "Test issue");
});

Deno.test("createGhIssueFetcher - getIssueState handles CLOSED", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ number: 10, state: "CLOSED", title: "Done" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const state = await fetcher.getIssueState("owner/repo", 10);

  assertEquals(state.state, "CLOSED");
});

Deno.test("createGhIssueFetcher - getIssueBody parses body", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ body: "Issue body content" });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const body = await fetcher.getIssueBody("owner/repo", 42);

  assertEquals(body, "Issue body content");
});

Deno.test("createGhIssueFetcher - getIssueBody handles null body", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return JSON.stringify({ body: null });
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const body = await fetcher.getIssueBody("owner/repo", 42);

  assertEquals(body, "");
});

Deno.test("createGhIssueFetcher - getSubIssues returns empty on failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const fetcher = createGhIssueFetcher(mockGh);
  const subs = await fetcher.getSubIssues("owner/repo", 42);

  assertEquals(subs, []);
});

// =============================================================================
// SEC-1218-F1 (Issue #1218) — sub-issues come from the native endpoint, never
// the timeline.
//
// A `cross-referenced` timeline event is created by anyone who writes `#123`
// in a comment, so treating those numbers as sub-issues let an unauthenticated
// commenter fabricate a child and block the parent. Fail direction: these tests
// go RED against the timeline-based fetcher (it returns the forged number) and
// GREEN once the fetcher reads `repos/{repo}/issues/{n}/sub_issues`.
// =============================================================================

/** Record every gh argv so a test can assert which endpoint was queried. */
function createRecordingGh(
  responses: { subIssues?: string; timeline?: string },
): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const path = args[1] ?? "";
    if (path.includes("/sub_issues")) {
      return Promise.resolve(responses.subIssues ?? "[]");
    }
    if (path.endsWith("/timeline")) {
      return Promise.resolve(responses.timeline ?? "[]");
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

Deno.test("createGhIssueFetcher - getSubIssues ignores forged cross-referenced timeline events", async () => {
  // The victim issue has no real sub-issues; a commenter has cross-referenced
  // it from an unrelated issue, which is what the timeline would report.
  const { gh, calls } = createRecordingGh({
    subIssues: "[]",
    timeline: JSON.stringify([999]),
  });

  const fetcher = createGhIssueFetcher(gh);
  const subs = await fetcher.getSubIssues("owner/repo", 42);

  assertEquals(subs, []);
  // The timeline must not be consulted at all — a fetcher that reads it is
  // trusting attacker-writable data.
  assertEquals(
    calls.some((args) => args.some((a) => a.includes("/timeline"))),
    false,
  );
  assertEquals(
    calls.some((args) => args.some((a) => a.includes("/sub_issues"))),
    true,
  );
  // The child set must not be truncated to the REST default page of 30 — a
  // child that falls off the end reads as "not blocked", which is the wrong
  // direction for a guard.
  assertEquals(
    calls.some((args) => args.some((a) => a.includes("per_page=100"))),
    true,
  );
});

Deno.test("createGhIssueFetcher - getSubIssues returns genuine native sub-issues", async () => {
  const { gh } = createRecordingGh({
    subIssues: JSON.stringify([
      { number: 7, title: "child" },
      { number: 8, title: "child" },
      { title: "malformed entry with no number" },
    ]),
  });

  const fetcher = createGhIssueFetcher(gh);
  const subs = await fetcher.getSubIssues("owner/repo", 42);

  assertEquals(subs, [7, 8]);
});

Deno.test("checkParentBlocked - a forged cross-reference does not block the parent", async () => {
  // End-to-end over the real dependency resolver: the only "child" on offer is
  // a cross-reference to an issue in another repo, which does not resolve here
  // and would therefore be counted as open (issue_dependencies.ts fails closed).
  const { gh } = createRecordingGh({
    subIssues: "[]",
    timeline: JSON.stringify([999]),
  });
  const recordingGh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args[2] === "999") {
        return Promise.reject(new Error("Could not resolve to an Issue"));
      }
      // The parent's own body carries no task-list references.
      return Promise.resolve(JSON.stringify({ body: "No children here." }));
    }
    return gh(args);
  };

  const fetcher = createGhIssueFetcher(recordingGh);
  const result = await checkParentBlocked(fetcher, "owner/repo", 42);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isBlocked, false);
  assertEquals(result.value.openChildren, []);
  assertEquals(result.value.totalChildren, 0);
});

// =============================================================================
// checkParentDepsCommand tests
// =============================================================================

Deno.test("checkParentDepsCommand - returns error for missing repo", async () => {
  const config = createMockConfig();
  const result = await checkParentDepsCommand.execute(
    { issue: 42 },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "repo");
});

Deno.test("checkParentDepsCommand - returns error for missing issue", async () => {
  const config = createMockConfig();
  const result = await checkParentDepsCommand.execute(
    { repo: "owner/repo" },
    config,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "issue");
});

Deno.test("checkParentDepsCommand - has correct name and description", () => {
  assertEquals(checkParentDepsCommand.name, "check-parent-deps");
  assertStringIncludes(checkParentDepsCommand.description, "sub-issues");
});
