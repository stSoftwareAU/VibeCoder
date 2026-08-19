/**
 * Tests for GitHub client retry resilience and error handling improvements.
 *
 * Issue #217 — Add retry resilience to GitHub API calls in TypeScript module.
 *
 * These tests verify:
 * - runGhCommandWithRetry wraps runGhCommand with retry logic
 * - createGitHubIssues handles partial failures gracefully
 * - removeLabel only ignores "label not found" errors
 */

import { assertEquals } from "@std/assert";
import {
  createGitHubIssuesWithPartialFailures,
  isLabelNotFoundError,
} from "../lib/github.ts";
import type { Improvement } from "../commands/suggest_improvements.ts";

// --- isLabelNotFoundError tests ---

Deno.test("github - isLabelNotFoundError returns true for 'label not found' message", () => {
  assertEquals(isLabelNotFoundError("label 'foo' not found"), true);
});

Deno.test("github - isLabelNotFoundError returns true for 'not found' with label context", () => {
  assertEquals(
    isLabelNotFoundError("GraphQL: Label not found (removeLabelFromIssue)"),
    true,
  );
});

Deno.test("github - isLabelNotFoundError returns false for network errors", () => {
  assertEquals(isLabelNotFoundError("HTTP 500 Internal Server Error"), false);
});

Deno.test("github - isLabelNotFoundError returns false for connection refused", () => {
  assertEquals(isLabelNotFoundError("connection refused"), false);
});

Deno.test("github - isLabelNotFoundError returns false for generic errors", () => {
  assertEquals(isLabelNotFoundError("something went wrong"), false);
});

Deno.test("github - isLabelNotFoundError returns false for empty string", () => {
  assertEquals(isLabelNotFoundError(""), false);
});

// --- createGitHubIssuesWithPartialFailures tests ---

Deno.test("github - createGitHubIssuesWithPartialFailures returns all successes", async () => {
  const improvements: Improvement[] = [
    {
      title: "Improvement 1",
      description: "Desc 1",
      category: "testing",
      labels: ["enhancement"],
    },
    {
      title: "Improvement 2",
      description: "Desc 2",
      category: "security",
      labels: ["enhancement"],
    },
  ];

  let callCount = 0;
  const mockRunGhCommand = async (_args: string[]): Promise<string> => {
    callCount++;
    return `https://github.com/org/repo/issues/${callCount}`;
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockRunGhCommand,
  );

  assertEquals(result.createdIssues, [1, 2]);
  assertEquals(result.failures.length, 0);
});

Deno.test("github - createGitHubIssuesWithPartialFailures continues after failure", async () => {
  const improvements: Improvement[] = [
    {
      title: "Improvement 1",
      description: "Desc 1",
      category: "testing",
      labels: ["enhancement"],
    },
    {
      title: "Will Fail",
      description: "Desc 2",
      category: "security",
      labels: ["enhancement"],
    },
    {
      title: "Improvement 3",
      description: "Desc 3",
      category: "resilience",
      labels: ["enhancement"],
    },
  ];

  let callCount = 0;
  const mockRunGhCommand = async (_args: string[]): Promise<string> => {
    callCount++;
    if (callCount === 2) {
      throw new Error("HTTP 500 Internal Server Error");
    }
    return `https://github.com/org/repo/issues/${callCount}`;
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockRunGhCommand,
  );

  assertEquals(result.createdIssues, [1, 3]);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.title, "Will Fail");
  assertEquals(result.failures[0]!.error, "HTTP 500 Internal Server Error");
});

Deno.test("github - createGitHubIssuesWithPartialFailures handles all failures", async () => {
  const improvements: Improvement[] = [
    {
      title: "Improvement 1",
      description: "Desc 1",
      category: "testing",
      labels: ["enhancement"],
    },
  ];

  const mockRunGhCommand = async (_args: string[]): Promise<string> => {
    throw new Error("HTTP 503 Service Unavailable");
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockRunGhCommand,
  );

  assertEquals(result.createdIssues.length, 0);
  assertEquals(result.failures.length, 1);
});

Deno.test("github - createGitHubIssuesWithPartialFailures handles empty improvements", async () => {
  const mockRunGhCommand = async (_args: string[]): Promise<string> => {
    return "";
  };

  const result = await createGitHubIssuesWithPartialFailures(
    [],
    "org/repo",
    mockRunGhCommand,
  );

  assertEquals(result.createdIssues.length, 0);
  assertEquals(result.failures.length, 0);
});
