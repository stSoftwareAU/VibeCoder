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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createGitHubIssuesWithPartialFailures,
  isLabelNotFoundError,
} from "../lib/github.ts";
import type { Improvement } from "../commands/suggest_improvements.ts";
import { fakeStore, routingFakeGh } from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const GRQ = "stSoftwareAU/GRQ";
/** A worker change: the router files it in VibeCoder (Issue #3745). */
const WORKER_NOTE = "`worker/deno/lib/foo.ts` needs work.";
const ROUTING = {
  routingContext: { vibeCoderRepo: VIBE, productRepos: [GRQ] },
  dryRun: false,
};

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
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement"],
    },
    {
      title: "Improvement 2",
      description: WORKER_NOTE,
      category: "security",
      labels: ["enhancement"],
    },
  ];
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    VIBE,
    { ...ROUTING, ghCommandFn: gh.ghCommandFn },
  );

  assertEquals(result.createdIssues, [1, 2]);
  assertEquals(result.failures.length, 0);
});

Deno.test("github - createGitHubIssuesWithPartialFailures continues after failure", async () => {
  const improvements: Improvement[] = [
    {
      title: "Improvement 1",
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement"],
    },
    {
      title: "Will Fail",
      description: WORKER_NOTE,
      category: "security",
      labels: ["enhancement"],
    },
    {
      title: "Improvement 3",
      description: WORKER_NOTE,
      category: "resilience",
      labels: ["enhancement"],
    },
  ];
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }), {
    failWhen: (args) =>
      args[0] === "issue" && args[1] === "create" && args.includes("Will Fail")
        ? new Error("HTTP 500 Internal Server Error")
        : undefined,
  });

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    VIBE,
    { ...ROUTING, ghCommandFn: gh.ghCommandFn },
  );

  assertEquals(result.createdIssues, [1, 2]);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.title, "Will Fail");
  assertStringIncludes(
    result.failures[0]!.error,
    "HTTP 500 Internal Server Error",
  );
  assertStringIncludes(result.failures[0]!.error, 'step "create"');
});

Deno.test("github - createGitHubIssuesWithPartialFailures handles all failures", async () => {
  const improvements: Improvement[] = [
    {
      title: "Improvement 1",
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement"],
    },
  ];

  const mockRunGhCommand = async (_args: string[]): Promise<string> => {
    throw new Error("HTTP 503 Service Unavailable");
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    VIBE,
    { ...ROUTING, ghCommandFn: mockRunGhCommand },
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
    VIBE,
    { ...ROUTING, ghCommandFn: mockRunGhCommand },
  );

  assertEquals(result.createdIssues.length, 0);
  assertEquals(result.failures.length, 0);
});
