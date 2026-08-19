/**
 * Tests for partial_answer.ts — Partial answer posting on timeout (Issue #661, #913).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPartialAnswerBody,
  postPartialAnswer,
} from "../lib/partial_answer.ts";

// ---------------------------------------------------------------------------
// buildPartialAnswerBody
// ---------------------------------------------------------------------------

Deno.test("partial answer - buildPartialAnswerBody includes disclaimer header", () => {
  const body = buildPartialAnswerBody("Some answer", "question");
  assertStringIncludes(body, "## Partial Answer (Timed Out)");
});

Deno.test("partial answer - buildPartialAnswerBody includes the sanitised output", () => {
  const body = buildPartialAnswerBody("The actual answer content", "question");
  assertStringIncludes(body, "The actual answer content");
});

Deno.test("partial answer - buildPartialAnswerBody includes question label", () => {
  const body = buildPartialAnswerBody("Content", "my-question");
  assertStringIncludes(body, "`my-question`");
});

Deno.test("partial answer - buildPartialAnswerBody includes worker footer when provided", () => {
  const body = buildPartialAnswerBody(
    "Content",
    "question",
    "\n\n---\nWorker: test-worker",
  );
  assertStringIncludes(body, "Worker: test-worker");
});

Deno.test("partial answer - buildPartialAnswerBody omits footer when not provided", () => {
  const body = buildPartialAnswerBody("Content", "question");
  assertEquals(body.includes("Worker:"), false);
});

// ---------------------------------------------------------------------------
// postPartialAnswer — empty/meta-commentary output
// ---------------------------------------------------------------------------

Deno.test("partial answer - returns false for empty output", async () => {
  const result = await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("partial answer - returns false for meta-commentary only output", async () => {
  const result = await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "I'm unable to post the comment directly to the issue.",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

// ---------------------------------------------------------------------------
// postPartialAnswer — successful posting (mock gh)
// ---------------------------------------------------------------------------

Deno.test("partial answer - posts partial answer via gh command", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };

  const result = await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "Here is a partial answer to the question.",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }

  // Verify gh was called with correct arguments
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![0], "issue");
  assertEquals(calls[0]![1], "comment");
  assertEquals(calls[0]![2], "42");
  assertEquals(calls[0]![3], "--repo");
  assertEquals(calls[0]![4], "owner/repo");
  assertEquals(calls[0]![5], "--body");
  assertStringIncludes(calls[0]![6]!, "Partial Answer (Timed Out)");
  assertStringIncludes(
    calls[0]![6]!,
    "Here is a partial answer to the question.",
  );
});

Deno.test("partial answer - sanitises meta-commentary before posting", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };

  await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "I'm unable to post the comment.\n\nThe real answer here.",
    ghCommandFn: mockGh,
  });

  // The posted body should contain the sanitised content, not the meta-commentary
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0]![6]!, "The real answer here.");
  assertEquals(calls[0]![6]!.includes("unable to post"), false);
});

// ---------------------------------------------------------------------------
// postPartialAnswer — gh failure handling
// ---------------------------------------------------------------------------

Deno.test("partial answer - handles gh command failure gracefully", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("gh command failed");
  };

  const result = await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "Some real answer content.",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

// ---------------------------------------------------------------------------
// postPartialAnswer — custom question label
// ---------------------------------------------------------------------------

Deno.test("partial answer - uses custom question label", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };

  await postPartialAnswer({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "testuser",
    claudeOutput: "Partial answer content.",
    questionLabel: "custom-question",
    ghCommandFn: mockGh,
  });

  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0]![6]!, "`custom-question`");
});
