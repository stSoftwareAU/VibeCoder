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
import { createLogger } from "../lib/logger.ts";
import {
  createGitHubIssuesWithPartialFailures,
  isLabelNotFoundError,
} from "../lib/github.ts";
import { routingContext, routingFakeGh } from "./support/routing_fake_gh.ts";
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
    routingContext(["org/repo"]),
    routingFakeGh(mockRunGhCommand),
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
    routingContext(["org/repo"]),
    routingFakeGh(mockRunGhCommand),
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
    routingContext(["org/repo"]),
    routingFakeGh(mockRunGhCommand),
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
    routingContext(["org/repo"]),
    routingFakeGh(mockRunGhCommand),
  );

  assertEquals(result.createdIssues.length, 0);
  assertEquals(result.failures.length, 0);
});

// --- Issue routing wiring (Issue #3691) ---

const VIBE_REPO = "stSoftwareAU/VibeCoder";
const PRODUCT_REPO = "org/product";

const workerImprovement: Improvement = {
  title: "Split worker/deno/lib/issue_worker.ts into phases",
  description:
    "The fleet orchestrator in `worker/deno/lib/issue_worker.ts` is too big.",
  category: "maintainability",
  labels: ["enhancement"],
};

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

Deno.test("github - createGitHubIssuesWithPartialFailures routes a wrong-repo improvement to the owner repo and records the audit", async () => {
  const creates: string[][] = [];
  const gh = routingFakeGh((args) => {
    creates.push(args);
    return `https://github.com/${VIBE_REPO}/issues/77`;
  });

  const result = await createGitHubIssuesWithPartialFailures(
    [workerImprovement],
    PRODUCT_REPO,
    routingContext([PRODUCT_REPO, VIBE_REPO]),
    gh,
  );

  assertEquals(creates.length, 1);
  assertEquals(valueAfter(creates[0]!, "--repo"), VIBE_REPO);
  // Labels are never migrated across repositories.
  assertEquals(creates[0]!.includes("--label"), false);
  assertEquals(result.createdIssues, [77]);
  assertEquals(result.failures, []);
  assertEquals(result.audits.length, 1);
  assertEquals(result.audits[0]!.owner_repository, VIBE_REPO);
  assertEquals(result.audits[0]!.subject_repository, PRODUCT_REPO);
  assertEquals(result.audits[0]!.action, "created");
  assertEquals(result.audits[0]!.labels_not_migrated, ["enhancement"]);
});

Deno.test("github - createGitHubIssuesWithPartialFailures records a permission refusal in failures and logs it at error level", async () => {
  const creates: string[][] = [];
  const gh = routingFakeGh((args) => {
    creates.push(args);
    return `https://github.com/${VIBE_REPO}/issues/1`;
  }, "READ");
  const lines: string[] = [];
  const logger = createLogger({ write: (msg) => lines.push(msg) });

  const result = await createGitHubIssuesWithPartialFailures(
    [workerImprovement],
    PRODUCT_REPO,
    routingContext([PRODUCT_REPO, VIBE_REPO]),
    gh,
    logger,
  );

  assertEquals(creates.length, 0);
  assertEquals(result.createdIssues, []);
  assertEquals(result.audits, []);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.title, workerImprovement.title);
  assertStringIncludes(
    result.failures[0]!.error,
    "viewer permission is 'READ'",
  );
  assertEquals(lines.some((l) => l.includes("ERROR")), true);
});

Deno.test("github - createGitHubIssuesWithPartialFailures dry-run creates nothing but still records the audit", async () => {
  const creates: string[][] = [];
  const gh = routingFakeGh((args) => {
    creates.push(args);
    return `https://github.com/${VIBE_REPO}/issues/1`;
  });

  const result = await createGitHubIssuesWithPartialFailures(
    [workerImprovement],
    PRODUCT_REPO,
    routingContext([PRODUCT_REPO, VIBE_REPO], { dryRun: true }),
    gh,
  );

  assertEquals(creates.length, 0);
  assertEquals(result.createdIssues, []);
  assertEquals(result.failures, []);
  assertEquals(result.audits.length, 1);
  assertEquals(result.audits[0]!.action, "dry-run");
});
