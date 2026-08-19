/**
 * Tests for milestone-aware repo availability check.
 *
 * Design principle under test: A PR targeting the default branch must not
 * block issues in milestones. Milestones are independent work streams.
 * A repo is only "fully busy" when every work stream has assigned work.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  checkRepoAvailability,
  formatAvailabilityMessage,
  type RepoIssueInfo,
} from "../lib/repo_availability.ts";
import { parseGhIssueListForAvailability } from "../commands/check_repo_availability.ts";

const USER = "worker-bot";

// =============================================================================
// checkRepoAvailability — pure logic tests
// =============================================================================

Deno.test("repo_availability - empty repo (no issues) is available", () => {
  const result = checkRepoAvailability([], USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, []);
  assertEquals(result.occupiedStreams, []);
  assertEquals(result.totalStreams, 0);
});

Deno.test("repo_availability - single non-milestone issue, unassigned", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: [] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, [""]);
  assertEquals(result.occupiedStreams, []);
});

Deno.test("repo_availability - single non-milestone issue assigned to user is busy", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: [USER] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, false);
  assertEquals(result.availableStreams, []);
  assertEquals(result.occupiedStreams, [""]);
  assertEquals(result.totalStreams, 1);
});

Deno.test("repo_availability - KEY FIX: non-milestone assigned but milestone issues available", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: [USER] },
    { number: 20, milestone: "Auth Rewrite", assignees: [] },
    { number: 30, milestone: "Auth Rewrite", assignees: [] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, ["Auth Rewrite"]);
  assertEquals(result.occupiedStreams, [""]);
  assertEquals(result.totalStreams, 2);
});

Deno.test("repo_availability - multiple milestones, one occupied one available", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "Auth", assignees: [USER] },
    { number: 20, milestone: "API", assignees: [] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, ["API"]);
  assertEquals(result.occupiedStreams, ["Auth"]);
});

Deno.test("repo_availability - all streams occupied is busy", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: [USER] },
    { number: 20, milestone: "Auth", assignees: [USER] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, false);
  assertEquals(result.availableStreams, []);
  assertEquals(result.occupiedStreams.length, 2);
  assertEquals(result.totalStreams, 2);
});

Deno.test("repo_availability - issue assigned to different user does not occupy stream", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: ["other-user"] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, [""]);
  assertEquals(result.occupiedStreams, []);
});

Deno.test("repo_availability - multiple assignees including queried user counts as occupied", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: ["other-user", USER] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, false);
  assertEquals(result.occupiedStreams, [""]);
});

Deno.test("repo_availability - same milestone one assigned one unassigned still has available work", () => {
  // Having one assigned issue should not block other unassigned issues
  // in the same stream — the worker can pick up the unassigned one.
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "Auth", assignees: [USER] },
    { number: 20, milestone: "Auth", assignees: [] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams, ["Auth"]);
  assertEquals(result.totalStreams, 1);
});

Deno.test("repo_availability - case-insensitive username comparison", () => {
  const issues: RepoIssueInfo[] = [
    { number: 10, milestone: "", assignees: ["Worker-Bot"] },
  ];
  const result = checkRepoAvailability(issues, "worker-bot");
  assertEquals(result.hasAvailableWork, false);
  assertEquals(result.occupiedStreams, [""]);
});

Deno.test("repo_availability - three milestones plus non-milestone, mixed occupancy", () => {
  const issues: RepoIssueInfo[] = [
    { number: 1, milestone: "", assignees: [USER] },
    { number: 2, milestone: "Alpha", assignees: [] },
    { number: 3, milestone: "Beta", assignees: [USER] },
    { number: 4, milestone: "Gamma", assignees: [] },
  ];
  const result = checkRepoAvailability(issues, USER);
  assertEquals(result.hasAvailableWork, true);
  assertEquals(result.availableStreams.sort(), ["Alpha", "Gamma"]);
  assertEquals(result.occupiedStreams.sort(), ["", "Beta"]);
  assertEquals(result.totalStreams, 4);
});

// =============================================================================
// formatAvailabilityMessage tests
// =============================================================================

Deno.test("repo_availability - format message starts with AVAILABLE when work exists", () => {
  const result = checkRepoAvailability(
    [{ number: 1, milestone: "Auth", assignees: [] }],
    USER,
  );
  const msg = formatAvailabilityMessage("owner/repo", result);
  assertEquals(msg.startsWith("AVAILABLE:"), true);
});

Deno.test("repo_availability - format message starts with BUSY when all occupied", () => {
  const result = checkRepoAvailability(
    [{ number: 1, milestone: "", assignees: [USER] }],
    USER,
  );
  const msg = formatAvailabilityMessage("owner/repo", result);
  assertEquals(msg.startsWith("BUSY:"), true);
});

Deno.test("repo_availability - format message starts with AVAILABLE for empty repo", () => {
  const result = checkRepoAvailability([], USER);
  const msg = formatAvailabilityMessage("owner/repo", result);
  assertEquals(msg.startsWith("AVAILABLE:"), true);
});

Deno.test("repo_availability - appends nice tier suffix when supplied (Issue #2777)", () => {
  const result = checkRepoAvailability(
    [{ number: 1, milestone: "Auth", assignees: [] }],
    USER,
  );
  const msg = formatAvailabilityMessage("owner/repo", result, 99);
  // Prefix contract intact and nice tier surfaced.
  assertEquals(msg.startsWith("AVAILABLE:"), true);
  assertEquals(msg.endsWith("[nice 99]"), true);
});

Deno.test("repo_availability - nice suffix keeps BUSY prefix intact (Issue #2777)", () => {
  const result = checkRepoAvailability(
    [{ number: 1, milestone: "", assignees: [USER] }],
    USER,
  );
  const msg = formatAvailabilityMessage("owner/repo", result, -1);
  assertEquals(msg.startsWith("BUSY:"), true);
  assertEquals(msg.endsWith("[nice -1]"), true);
});

Deno.test("repo_availability - nice suffix on empty repo (Issue #2777)", () => {
  const result = checkRepoAvailability([], USER);
  const msg = formatAvailabilityMessage("owner/repo", result, 0);
  assertEquals(msg.startsWith("AVAILABLE:"), true);
  assertEquals(msg.endsWith("[nice 0]"), true);
});

Deno.test("repo_availability - no nice suffix when omitted (Issue #2777)", () => {
  const result = checkRepoAvailability(
    [{ number: 1, milestone: "Auth", assignees: [] }],
    USER,
  );
  const msg = formatAvailabilityMessage("owner/repo", result);
  assertEquals(msg.includes("[nice"), false);
});

// =============================================================================
// parseGhIssueListForAvailability tests
// =============================================================================

Deno.test("repo_availability - parse gh issue list JSON with milestones", () => {
  const json = JSON.stringify([
    {
      number: 10,
      milestone: { title: "Auth Rewrite" },
      assignees: [{ login: "worker-bot" }],
    },
    {
      number: 20,
      milestone: null,
      assignees: [],
    },
  ]);
  const issues = parseGhIssueListForAvailability(json);
  assertEquals(issues.length, 2);
  assertEquals(issues[0]!.number, 10);
  assertEquals(issues[0]!.milestone, "Auth Rewrite");
  assertEquals(issues[0]!.assignees, ["worker-bot"]);
  assertEquals(issues[1]!.number, 20);
  assertEquals(issues[1]!.milestone, "");
  assertEquals(issues[1]!.assignees, []);
});

Deno.test("repo_availability - parse gh issue list JSON with empty array", () => {
  const issues = parseGhIssueListForAvailability("[]");
  assertEquals(issues.length, 0);
});
