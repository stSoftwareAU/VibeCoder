/**
 * Unit tests for the result-placeholder gate (Issue #3124).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReplyPlaceholderRetryPrompt,
  buildResultPlaceholderGateComment,
  findResultPlaceholders,
  replaceResultPlaceholders,
  retryReplyPlaceholdersOnce,
  validateResultPlaceholders,
} from "../lib/result_placeholder_gate.ts";

Deno.test("findResultPlaceholders - names at most ten distinct tokens", () => {
  const tokens = Array.from(
    { length: 11 },
    (_, i) => `TOKEN_${i}_PLACEHOLDER`,
  );
  assertEquals(findResultPlaceholders(tokens.join(" ")), tokens.slice(0, 10));
});

Deno.test("findResultPlaceholders - a token only past the scan cap is not reported", () => {
  const text = `${"a".repeat(200_000)} LATE_RESULT_PLACEHOLDER`;
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - finds a bare token in prose", () => {
  const text = "- Full `./quality.sh`: QUALITY_RESULT_PLACEHOLDER";
  assertEquals(findResultPlaceholders(text), ["QUALITY_RESULT_PLACEHOLDER"]);
});

Deno.test("findResultPlaceholders - ignores a token fully inside backticks", () => {
  const text = "We discussed `QUALITY_RESULT_PLACEHOLDER` in review.";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - does not match a _PLACEHOLDER_ prefix name", () => {
  const text = "See SECTION_PLACEHOLDER_VALUES for the list.";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - ignores a token inside a fenced code block but catches a bare one outside it", () => {
  const text = [
    "```",
    "echo QUALITY_RESULT_PLACEHOLDER",
    "```",
    "",
    "Result: CI_RESULT_PLACEHOLDER",
  ].join("\n");
  assertEquals(findResultPlaceholders(text), ["CI_RESULT_PLACEHOLDER"]);
});

Deno.test("findResultPlaceholders - distinct tokens in first-seen order", () => {
  const text = "A_PLACEHOLDER then B_PLACEHOLDER then A_PLACEHOLDER again";
  assertEquals(findResultPlaceholders(text), [
    "A_PLACEHOLDER",
    "B_PLACEHOLDER",
  ]);
});

Deno.test("validateResultPlaceholders - valid when clean", () => {
  const result = validateResultPlaceholders("All good, no tokens here.");
  assertEquals(result.valid, true);
  assertEquals(result.tokens, []);
});

Deno.test("validateResultPlaceholders - invalid when a bare token is present", () => {
  const result = validateResultPlaceholders("QUALITY_RESULT_PLACEHOLDER");
  assertEquals(result.valid, false);
  assertEquals(result.tokens, ["QUALITY_RESULT_PLACEHOLDER"]);
});

Deno.test("replaceResultPlaceholders - replaces a bare occurrence", () => {
  const text = "Result: QUALITY_RESULT_PLACEHOLDER";
  assertEquals(
    replaceResultPlaceholders(text, "[result not reported]"),
    "Result: [result not reported]",
  );
});

Deno.test("replaceResultPlaceholders - leaves a backtick-wrapped token untouched", () => {
  const text = "We discussed `QUALITY_RESULT_PLACEHOLDER` in review.";
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
});

Deno.test("buildResultPlaceholderGateComment - names the token(s)", () => {
  const comment = buildResultPlaceholderGateComment([
    "QUALITY_RESULT_PLACEHOLDER",
  ]);
  assertStringIncludes(comment, "QUALITY_RESULT_PLACEHOLDER");
  assertStringIncludes(comment, "placeholder");
});

Deno.test("buildReplyPlaceholderRetryPrompt - names the token(s) and the file", () => {
  const prompt = buildReplyPlaceholderRetryPrompt([
    "QUALITY_RESULT_PLACEHOLDER",
  ]);
  assertStringIncludes(prompt, "QUALITY_RESULT_PLACEHOLDER");
  assertStringIncludes(prompt, ".pr_response_message");
});

Deno.test("retryReplyPlaceholdersOnce - calls runAgent exactly once when a token is present", async () => {
  let runAgentCalls = 0;
  let lastPrompt = "";
  const outcome = await retryReplyPlaceholdersOnce(
    "/fake/.pr_response_message",
    {
      readFile: () => Promise.resolve("Result: QUALITY_RESULT_PLACEHOLDER"),
      runAgent: (prompt) => {
        runAgentCalls++;
        lastPrompt = prompt;
        return Promise.resolve({ ok: true });
      },
    },
  );
  assertEquals(runAgentCalls, 1);
  assertStringIncludes(lastPrompt, "QUALITY_RESULT_PLACEHOLDER");
  assertEquals(outcome.retried, true);
  assertEquals(outcome.tokens, ["QUALITY_RESULT_PLACEHOLDER"]);
});

Deno.test("retryReplyPlaceholdersOnce - does not call runAgent when the file is clean", async () => {
  let runAgentCalls = 0;
  const outcome = await retryReplyPlaceholdersOnce(
    "/fake/.pr_response_message",
    {
      readFile: () => Promise.resolve("All good, nothing to see here."),
      runAgent: () => {
        runAgentCalls++;
        return Promise.resolve({ ok: true });
      },
    },
  );
  assertEquals(runAgentCalls, 0);
  assertEquals(outcome.retried, false);
});

Deno.test("retryReplyPlaceholdersOnce - does not call runAgent when the file is missing", async () => {
  let runAgentCalls = 0;
  const outcome = await retryReplyPlaceholdersOnce(
    "/fake/.pr_response_message",
    {
      readFile: () => Promise.resolve(undefined),
      runAgent: () => {
        runAgentCalls++;
        return Promise.resolve({ ok: true });
      },
    },
  );
  assertEquals(runAgentCalls, 0);
  assertEquals(outcome.retried, false);
});

Deno.test("retryReplyPlaceholdersOnce - one turn only, even if still dirty afterwards (caller does not re-check)", async () => {
  let runAgentCalls = 0;
  const outcome = await retryReplyPlaceholdersOnce(
    "/fake/.pr_response_message",
    {
      readFile: () => Promise.resolve("Result: QUALITY_RESULT_PLACEHOLDER"),
      runAgent: () => {
        runAgentCalls++;
        // The agent fails to fix it — the helper must not loop or retry again.
        return Promise.resolve({ ok: true });
      },
    },
  );
  assertEquals(runAgentCalls, 1);
  assertEquals(outcome.retried, true);

  // A second independent peek at the same (still-dirty) content would retry
  // again — the "one turn only" guarantee is the caller only invoking this
  // helper once per run, not a sticky flag inside the helper. Confirming
  // that a failed runAgent is still reported via the logger and does not
  // throw:
  let errorLogged = false;
  await retryReplyPlaceholdersOnce("/fake/.pr_response_message", {
    readFile: () => Promise.resolve("Result: QUALITY_RESULT_PLACEHOLDER"),
    runAgent: () => Promise.resolve({ ok: false, error: new Error("boom") }),
    logger: {
      warn: () => {},
      error: () => {
        errorLogged = true;
      },
    },
  });
  assertEquals(errorLogged, true);
});
