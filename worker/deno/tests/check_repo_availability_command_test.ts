/**
 * Tests for the check-repo-availability command (Issue #1309).
 *
 * Tests the parseGhIssueListForAvailability pure function and
 * argument validation for the command.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  buildAvailabilityResult,
  checkRepoAvailabilityCommand,
  parseGhIssueListForAvailability,
} from "../commands/check_repo_availability.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { RepoIssueInfo } from "../lib/repo_availability.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("checkRepoAvailabilityCommand - has correct name", () => {
  assertEquals(checkRepoAvailabilityCommand.name, "check-repo-availability");
});

Deno.test("checkRepoAvailabilityCommand - has description", () => {
  assertEquals(typeof checkRepoAvailabilityCommand.description, "string");
  assertEquals(checkRepoAvailabilityCommand.description.length > 0, true);
});

// ============================================================================
// parseGhIssueListForAvailability — pure function tests
// ============================================================================

Deno.test("parseGhIssueListForAvailability - parses empty array", () => {
  const result = parseGhIssueListForAvailability("[]");
  assertEquals(result, []);
});

Deno.test("parseGhIssueListForAvailability - parses issue with milestone and assignees", () => {
  const json = JSON.stringify([
    {
      number: 42,
      milestone: { title: "v2.0" },
      assignees: [{ login: "alice" }, { login: "bob" }],
    },
  ]);
  const result = parseGhIssueListForAvailability(json);
  assertEquals(result.length, 1);
  const first = result[0]!;
  assertEquals(first.number, 42);
  assertEquals(first.milestone, "v2.0");
  assertEquals(first.assignees, ["alice", "bob"]);
});

Deno.test("parseGhIssueListForAvailability - handles null milestone", () => {
  const json = JSON.stringify([
    {
      number: 10,
      milestone: null,
      assignees: [{ login: "worker" }],
    },
  ]);
  const result = parseGhIssueListForAvailability(json);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.milestone, "");
});

Deno.test("parseGhIssueListForAvailability - handles empty assignees", () => {
  const json = JSON.stringify([
    {
      number: 5,
      milestone: { title: "Sprint 1" },
      assignees: [],
    },
  ]);
  const result = parseGhIssueListForAvailability(json);
  assertEquals(result[0]!.assignees, []);
});

Deno.test("parseGhIssueListForAvailability - handles missing assignees field", () => {
  const json = JSON.stringify([
    { number: 7, milestone: null },
  ]);
  const result = parseGhIssueListForAvailability(json);
  assertEquals(result[0]!.assignees, []);
});

Deno.test("parseGhIssueListForAvailability - handles multiple issues", () => {
  const json = JSON.stringify([
    { number: 1, milestone: null, assignees: [] },
    { number: 2, milestone: { title: "M1" }, assignees: [{ login: "x" }] },
    { number: 3, milestone: null, assignees: [{ login: "y" }, { login: "z" }] },
  ]);
  const result = parseGhIssueListForAvailability(json);
  assertEquals(result.length, 3);
  assertEquals(result[1]!.milestone, "M1");
  assertEquals(result[2]!.assignees.length, 2);
});

Deno.test("parseGhIssueListForAvailability - throws on non-array JSON", () => {
  assertThrows(
    () => parseGhIssueListForAvailability('{"not": "array"}'),
    Error,
    "Expected JSON array",
  );
});

Deno.test("parseGhIssueListForAvailability - throws on invalid JSON", () => {
  assertThrows(
    () => parseGhIssueListForAvailability("not json at all"),
  );
});

// ============================================================================
// Command argument validation
// ============================================================================

Deno.test("checkRepoAvailabilityCommand - fails when repo is missing", async () => {
  const result = await checkRepoAvailabilityCommand.execute(
    { "github-user": "test-user" },
    config,
  );
  assertEquals(result.success, false);
});

Deno.test("checkRepoAvailabilityCommand - fails when github-user is missing", async () => {
  const result = await checkRepoAvailabilityCommand.execute(
    { repo: "owner/repo" },
    config,
  );
  assertEquals(result.success, false);
});

// ============================================================================
// buildAvailabilityResult — resolved nice tier in data + message (Issue #2777)
// ============================================================================

const AVAILABLE_ISSUES: RepoIssueInfo[] = [
  { number: 1, milestone: "Auth", assignees: [] },
];
const BUSY_ISSUES: RepoIssueInfo[] = [
  { number: 1, milestone: "", assignees: ["worker"] },
];

Deno.test("buildAvailabilityResult - surfaces resolved nice in data", () => {
  const repoConfig = { "owner/repo": { nice: 99 } };
  const { data } = buildAvailabilityResult(
    AVAILABLE_ISSUES,
    "owner/repo",
    "worker",
    repoConfig,
  );
  assertEquals(data.nice, 99);
  assertEquals(data.repo, "owner/repo");
});

Deno.test("buildAvailabilityResult - defaults nice to 0 when unconfigured", () => {
  const { data } = buildAvailabilityResult(
    AVAILABLE_ISSUES,
    "owner/repo",
    "worker",
    undefined,
  );
  assertEquals(data.nice, 0);
});

Deno.test("buildAvailabilityResult - negative nice (jumps ahead) appears in data", () => {
  const repoConfig = { "owner/repo": { nice: -1 } };
  const { data } = buildAvailabilityResult(
    AVAILABLE_ISSUES,
    "owner/repo",
    "worker",
    repoConfig,
  );
  assertEquals(data.nice, -1);
});

Deno.test("buildAvailabilityResult - AVAILABLE prefix contract unchanged with nice", () => {
  const repoConfig = { "owner/repo": { nice: 99 } };
  const { message } = buildAvailabilityResult(
    AVAILABLE_ISSUES,
    "owner/repo",
    "worker",
    repoConfig,
  );
  assertEquals(message.startsWith("AVAILABLE:"), true);
  assertEquals(message.endsWith("[nice 99]"), true);
});

Deno.test("buildAvailabilityResult - BUSY prefix contract unchanged with nice", () => {
  const repoConfig = { "owner/repo": { nice: 5 } };
  const { message } = buildAvailabilityResult(
    BUSY_ISSUES,
    "owner/repo",
    "worker",
    repoConfig,
  );
  assertEquals(message.startsWith("BUSY:"), true);
  assertEquals(message.endsWith("[nice 5]"), true);
});
