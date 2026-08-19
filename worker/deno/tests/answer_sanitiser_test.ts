/**
 * Tests for answer_sanitiser.ts — Claude output sanitisation (Issue #332, #913).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { sanitiseAnswerOutput } from "../lib/answer_sanitiser.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

// ---------------------------------------------------------------------------
// Clean output — no meta-commentary
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - passes clean answers unchanged", () => {
  const input = "Here is the answer to your question.\n\nIt works like this.";
  assertEquals(sanitiseAnswerOutput(input), input);
});

Deno.test("answer sanitiser - handles empty input", () => {
  assertEquals(sanitiseAnswerOutput(""), "");
});

// ---------------------------------------------------------------------------
// Meta-commentary stripping — "unable to post" variants
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - strips 'unable to post' preamble", () => {
  const input =
    "I'm unable to post the comment directly to the issue.\n\nHere is the actual answer.";
  assertEquals(sanitiseAnswerOutput(input), "Here is the actual answer.");
});

Deno.test("answer sanitiser - strips 'cannot post' preamble", () => {
  const input =
    "I cannot post a comment on this issue.\n\nThe solution is to use X.";
  assertEquals(sanitiseAnswerOutput(input), "The solution is to use X.");
});

Deno.test("answer sanitiser - strips 'can't post' preamble", () => {
  const input = "I can't post this answer as a comment.\n\nThe answer is 42.";
  assertEquals(sanitiseAnswerOutput(input), "The answer is 42.");
});

Deno.test("answer sanitiser - strips 'couldn't post' preamble", () => {
  const input =
    "I couldn't post the response directly.\n\nHere is the content.";
  assertEquals(sanitiseAnswerOutput(input), "Here is the content.");
});

Deno.test("answer sanitiser - strips 'could not post' preamble", () => {
  const input = "I could not post the comment.\n\nThe real answer follows.";
  assertEquals(sanitiseAnswerOutput(input), "The real answer follows.");
});

// ---------------------------------------------------------------------------
// Meta-commentary stripping — permission variants
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - strips 'permission restrictions' preamble", () => {
  const input =
    "Due to permission restrictions I cannot post this answer.\n\nActual content here.";
  assertEquals(sanitiseAnswerOutput(input), "Actual content here.");
});

Deno.test("answer sanitiser - strips 'don't have permission' preamble", () => {
  const input =
    "I don't have permission to post a comment.\n\nThe answer is below.";
  assertEquals(sanitiseAnswerOutput(input), "The answer is below.");
});

Deno.test("answer sanitiser - strips 'do not have permission' preamble", () => {
  const input = "I do not have permission to post a comment.\n\nResult here.";
  assertEquals(sanitiseAnswerOutput(input), "Result here.");
});

// ---------------------------------------------------------------------------
// Separator handling
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - strips horizontal rule separator after preamble", () => {
  const input =
    "I'm unable to post the comment directly.\n\n---\n\nThe real answer.";
  assertEquals(sanitiseAnswerOutput(input), "The real answer.");
});

Deno.test("answer sanitiser - strips === separator after preamble", () => {
  const input =
    "I'm unable to post the comment directly.\n\n===\n\nThe real answer.";
  assertEquals(sanitiseAnswerOutput(input), "The real answer.");
});

Deno.test("answer sanitiser - strips *** separator after preamble", () => {
  const input =
    "I'm unable to post the comment directly.\n\n***\n\nThe real answer.";
  assertEquals(sanitiseAnswerOutput(input), "The real answer.");
});

// ---------------------------------------------------------------------------
// Duplicate "## Answer" header
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - removes duplicate '## Answer' header", () => {
  const input =
    "I'm unable to post the comment.\n\n## Answer\n\nThe real answer.";
  assertEquals(sanitiseAnswerOutput(input), "The real answer.");
});

// ---------------------------------------------------------------------------
// Preserves non-meta-commentary mentions of permissions
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - preserves answer mentioning permissions in context", () => {
  const input =
    "The file permissions should be set to 644.\n\nThis ensures only the owner can write.";
  assertEquals(sanitiseAnswerOutput(input), input);
});

Deno.test("answer sanitiser - preserves answer discussing posting in context", () => {
  const input =
    "You can post comments using the gh CLI.\n\nRun: gh issue comment 123 --body 'text'";
  assertEquals(sanitiseAnswerOutput(input), input);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - handles output that is only meta-commentary", () => {
  const input = "I'm unable to post the comment directly to the issue.";
  assertEquals(sanitiseAnswerOutput(input), "");
});

Deno.test("answer sanitiser - handles multiline meta-commentary preamble", () => {
  const input =
    "I'm unable to post the comment directly.\nLet me share the response here instead.\n\nActual answer content.";
  // The first paragraph includes both lines (non-blank contiguous lines)
  assertEquals(sanitiseAnswerOutput(input), "Actual answer content.");
});

// ---------------------------------------------------------------------------
// Secret redaction (Issue #3195) — the answer is posted to a public issue, so
// any secret shape that reaches the model output must be masked on the way out.
// ---------------------------------------------------------------------------

Deno.test("answer sanitiser - redacts a ghp_ token in a clean answer", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const input = `Here is the value: ${token}`;
  const out = sanitiseAnswerOutput(input);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("answer sanitiser - redacts an sk-ant- key in a clean answer", () => {
  const key = `sk-ant-${"a1B2".repeat(6)}`;
  const input = `The key is ${key} — do not share it.`;
  const out = sanitiseAnswerOutput(input);
  assertEquals(out.includes(key), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("answer sanitiser - redacts a secret after stripping meta-commentary", () => {
  const token = `ghp_${"B".repeat(36)}`;
  const input =
    `I'm unable to post the comment directly.\n\n---\n\nThe token is ${token}.`;
  const out = sanitiseAnswerOutput(input);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("answer sanitiser - leaves secret-free answers unchanged", () => {
  const input = "A perfectly ordinary answer with no secrets in it.";
  assertEquals(sanitiseAnswerOutput(input), input);
});
