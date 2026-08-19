/**
 * Tests for comment filter module (Issue #914).
 *
 * Migrated from tests/comment-filter.bats.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { prepareQuestionComments } from "../lib/comment_filter.ts";

// --- No prior answers ---

Deno.test("comment filter - returns empty string for no comments", () => {
  const json = JSON.stringify({ comments: [] });
  assertEquals(prepareQuestionComments(json), "");
});

Deno.test("comment filter - returns empty for empty JSON object", () => {
  assertEquals(prepareQuestionComments("{}"), "");
});

Deno.test("comment filter - returns empty for empty string", () => {
  assertEquals(prepareQuestionComments(""), "");
});

Deno.test("comment filter - preserves user comments in full", () => {
  const json = JSON.stringify({
    comments: [
      { body: "Can you explain how this works?", author: { login: "user1" } },
      { body: "I need more details about X.", author: { login: "user2" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertStringIncludes(result, "Can you explain how this works?");
  assertStringIncludes(result, "I need more details about X.");
  assertStringIncludes(result, "[user1]");
  assertStringIncludes(result, "[user2]");
});

// --- Bot answer truncation ---

Deno.test("comment filter - truncates long bot answers", () => {
  const longAnswer = "## Answer\n\n" + "A".repeat(600);
  const json = JSON.stringify({
    comments: [
      { body: longAnswer, author: { login: "bot" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertStringIncludes(result, "[Previous answer truncated");
  assertStringIncludes(result, "characters omitted]");
});

Deno.test("comment filter - does not truncate short bot answers", () => {
  const shortAnswer = "## Answer\n\nShort answer here.";
  const json = JSON.stringify({
    comments: [
      { body: shortAnswer, author: { login: "bot" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertEquals(result.includes("[Previous answer truncated"), false);
  assertStringIncludes(result, "Short answer here.");
});

Deno.test("comment filter - respects custom truncate length", () => {
  const answer = "## Answer\n\n" + "B".repeat(100);
  const json = JSON.stringify({
    comments: [
      { body: answer, author: { login: "bot" } },
    ],
  });
  // With truncate length of 50, the 100+ char answer should be truncated
  const result = prepareQuestionComments(json, 50);
  assertStringIncludes(result, "[Previous answer truncated");
});

// --- Worker operational comment filtering ---

Deno.test("comment filter - filters out claim lock comments", () => {
  const json = JSON.stringify({
    comments: [
      { body: "<!-- CLAIM_LOCK: worker-1 -->", author: { login: "bot" } },
      { body: "Real question here", author: { login: "user1" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertEquals(result.includes("CLAIM_LOCK"), false);
  assertStringIncludes(result, "Real question here");
});

Deno.test("comment filter - filters out failure notice comments", () => {
  const json = JSON.stringify({
    comments: [
      {
        body: "## Automated Processing Failed\n\nSomething went wrong.",
        author: { login: "bot" },
      },
      { body: "User question", author: { login: "user1" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertEquals(result.includes("Automated Processing Failed"), false);
  assertStringIncludes(result, "User question");
});

Deno.test("comment filter - filters out automatic recovery comments", () => {
  const json = JSON.stringify({
    comments: [
      {
        body: "Automatic recovery: issue was stuck.",
        author: { login: "bot" },
      },
      { body: "My question", author: { login: "user1" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertEquals(result.includes("Automatic recovery"), false);
  assertStringIncludes(result, "My question");
});

// --- Mixed comments ---

Deno.test("comment filter - handles mixed user and bot comments", () => {
  const longAnswer = "## Answer\n\n" + "X".repeat(600);
  const json = JSON.stringify({
    comments: [
      { body: "What does this function do?", author: { login: "user1" } },
      { body: longAnswer, author: { login: "bot" } },
      { body: "Can you explain more?", author: { login: "user1" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertStringIncludes(result, "What does this function do?");
  assertStringIncludes(result, "[Previous answer truncated");
  assertStringIncludes(result, "Can you explain more?");
});

// --- Comment separator format ---

Deno.test("comment filter - separates comments with dividers", () => {
  const json = JSON.stringify({
    comments: [
      { body: "First comment", author: { login: "user1" } },
      { body: "Second comment", author: { login: "user2" } },
    ],
  });
  const result = prepareQuestionComments(json);
  assertStringIncludes(result, "---");
});

// --- Invalid JSON handling ---

Deno.test("comment filter - handles invalid JSON gracefully", () => {
  const result = prepareQuestionComments("not valid json");
  assertEquals(result, "");
});
