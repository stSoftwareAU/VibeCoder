/**
 * Tests for question clarification module (Issue #914).
 *
 * Migrated from tests/question-clarification.bats.
 *
 * Issue #2031: the clarification handoff label is now `needs-human`
 * (replacing the retired `needs-clarification` label).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectQuestionClarificationRequest,
  extractClarificationBody,
  postQuestionClarification,
} from "../lib/question_clarification.ts";

// --- detectQuestionClarificationRequest tests ---

Deno.test("question clarification - detects clarification header at start", () => {
  const output = "## Clarification Needed\n\nPlease provide more context.";
  assertEquals(detectQuestionClarificationRequest(output), true);
});

Deno.test("question clarification - detects with leading whitespace", () => {
  const output = "  \n\n## Clarification Needed\n\nDetails needed.";
  assertEquals(detectQuestionClarificationRequest(output), true);
});

Deno.test("question clarification - detects with leading blank lines", () => {
  const output = "\n\n\n## Clarification Needed\n\nMore info please.";
  assertEquals(detectQuestionClarificationRequest(output), true);
});

Deno.test("question clarification - rejects normal answers", () => {
  const output = "## Answer\n\nHere is the answer to your question.";
  assertEquals(detectQuestionClarificationRequest(output), false);
});

Deno.test("question clarification - rejects empty output", () => {
  assertEquals(detectQuestionClarificationRequest(""), false);
});

Deno.test("question clarification - rejects mid-output clarification header", () => {
  const output =
    "Some text first.\n\n## Clarification Needed\n\nThis should not match.";
  assertEquals(detectQuestionClarificationRequest(output), false);
});

Deno.test("question clarification - rejects whitespace-only output", () => {
  assertEquals(detectQuestionClarificationRequest("   \n  \n  "), false);
});

// --- extractClarificationBody tests ---

Deno.test("question clarification - extracts body from clarification output", () => {
  const output =
    "## Clarification Needed\n\nWhat is the expected behaviour?\nPlease describe the input format.";
  const body = extractClarificationBody(output);
  assertStringIncludes(body, "What is the expected behaviour?");
  assertStringIncludes(body, "Please describe the input format.");
});

Deno.test("question clarification - strips header and leading blank lines", () => {
  const output = "\n\n## Clarification Needed\n\n\nThe body starts here.";
  const body = extractClarificationBody(output);
  assertEquals(body.startsWith("The body starts here."), true);
});

Deno.test("question clarification - handles header with no body", () => {
  const output = "## Clarification Needed";
  const body = extractClarificationBody(output);
  assertEquals(body, "");
});

// --- postQuestionClarification tests ---

Deno.test("question clarification - posts comment with clarification body", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  const result = await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Please clarify X.",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  // Four independent side effects: post comment, remove question label, add
  // needs-human, remove assignee. The order in which they are issued is an
  // implementation detail — assert on the observable effect, not its position
  // in the calls array (Issue #2552).
  assertEquals(calls.length, 4);

  // A comment was posted on issue 42.
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert(commentCall, "expected a comment to be posted");
  assertEquals(commentCall[2], "42");
});

Deno.test("question clarification - removes question label", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Need clarification.",
    ghCommandFn: mockGh,
  });

  // The question label was removed (order-independent — Issue #2552).
  const removeLabelCall = calls.find((c) => c.includes("--remove-label"));
  assert(removeLabelCall, "expected the question label to be removed");
  assertEquals(removeLabelCall.includes("question"), true);
});

Deno.test("question clarification - adds needs-human label (Issue #2031)", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Clarify please.",
    ghCommandFn: mockGh,
  });

  // The needs-human label was added via the REST API (Issue #976), found by
  // its observable shape rather than its position (Issue #2552).
  const addLabelCall = calls.find(
    (c) => c[0] === "api" && c.join(" ").includes("/labels"),
  );
  assert(addLabelCall, "expected needs-human label to be added via REST API");
  assertEquals(
    addLabelCall.join(" ").includes("repos/owner/repo/issues/42/labels"),
    true,
  );
  assertEquals(addLabelCall.join(" ").includes("needs-human"), true);
});

Deno.test("question clarification - does NOT add the retired needs-clarification label (Issue #2031)", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Clarify please.",
    ghCommandFn: mockGh,
  });

  // No call should mention "needs-clarification" anywhere.
  const joined = calls.map((c) => c.join(" ")).join("\n");
  assertEquals(joined.includes("needs-clarification"), false);
});

Deno.test("question clarification - unassigns the worker", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Clarify.",
    ghCommandFn: mockGh,
  });

  // The worker was unassigned (order-independent — Issue #2552).
  const unassignCall = calls.find((c) => c.includes("--remove-assignee"));
  assert(unassignCall, "expected the worker to be unassigned");
  assertEquals(unassignCall.includes("worker-bot"), true);
});

Deno.test("question clarification - includes worker footer when provided", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Need details.",
    workerFooter: "\n\n---\n*Powered by Vibe Coder*",
    ghCommandFn: mockGh,
  });

  // The comment body should contain the footer (found by shape — Issue #2552).
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert(commentCall, "expected a comment to be posted");
  const bodyIdx = commentCall.indexOf("--body");
  const body = commentCall[bodyIdx + 1]!;
  assertStringIncludes(body, "Powered by Vibe Coder");
});

Deno.test("question clarification - uses custom labels", async () => {
  const calls: string[][] = [];
  const mockGh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("");
  };

  await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Details needed.",
    questionLabel: "custom-question",
    needsHumanLabel: "custom-needs-human",
    ghCommandFn: mockGh,
  });

  // The custom question label was removed (order-independent — Issue #2552).
  const removeLabelCall = calls.find((c) => c.includes("--remove-label"));
  assert(removeLabelCall, "expected the custom question label to be removed");
  assertEquals(removeLabelCall.includes("custom-question"), true);

  // The custom needs-human label was added via the REST API (Issue #976).
  const addLabelCall = calls.find(
    (c) => c[0] === "api" && c.join(" ").includes("/labels"),
  );
  assert(addLabelCall, "expected the custom needs-human label to be added");
  assertEquals(
    addLabelCall.join(" ").includes("repos/owner/repo/issues/42/labels"),
    true,
  );
  assertEquals(addLabelCall.join(" ").includes("custom-needs-human"), true);
});

Deno.test("question clarification - returns error when comment posting fails", async () => {
  const mockGh = (_args: string[]): Promise<string> => {
    return Promise.reject(new Error("gh command failed"));
  };

  const result = await postQuestionClarification({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    clarificationBody: "Please clarify.",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Failed to post clarification comment",
    );
  }
});
