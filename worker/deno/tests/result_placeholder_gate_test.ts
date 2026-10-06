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
import { assertLinearGrowth } from "./support/growth.ts";

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

Deno.test("findResultPlaceholders - a list-item fence is code, and replace leaves it unchanged", () => {
  const text = [
    "- Step one:",
    "",
    "  ```ts",
    "  const x = REDACTION_PLACEHOLDER;",
    "  ```",
    "",
  ].join("\n");
  assertEquals(findResultPlaceholders(text), []);
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
});

Deno.test("findResultPlaceholders - a longer fence is not closed by a shorter one inside it", () => {
  const text = [
    "````",
    "```",
    "X_PLACEHOLDER",
    "```",
    "````",
    "",
  ].join("\n");
  assertEquals(findResultPlaceholders(text), []);
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
});

Deno.test("findResultPlaceholders - a bare token after a wrapped code span is reported", () => {
  const text =
    "- One test (`runClaudeWithRetry - a SIGKILLed agent's\n  surviving descendant`): QUALITY_RESULT_PLACEHOLDER, and `deno lint` passes.\n";
  assertEquals(findResultPlaceholders(text), ["QUALITY_RESULT_PLACEHOLDER"]);
  assertEquals(
    replaceResultPlaceholders(text, "[result not reported]"),
    "- One test (`runClaudeWithRetry - a SIGKILLed agent's\n  surviving descendant`): [result not reported], and `deno lint` passes.\n",
  );
});

Deno.test("findResultPlaceholders - a backtick-quoted token after a wrapped span is not reported", () => {
  const text =
    "- Test `readPrResponseMessage - a\n  bare token` is green and `REDACTION_PLACEHOLDER` stays quoted.\n";
  assertEquals(findResultPlaceholders(text), []);
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
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

// ---------------------------------------------------------------------------
// Widened suffix set and structural backstop (Issue #3248)
// ---------------------------------------------------------------------------

Deno.test("findResultPlaceholders - the GRQ#5164 escape (bare GATE_OUTCOME_PENDING on a quality.sh result line) is caught", () => {
  const text = "- `./quality.sh < /dev/null` on the head: GATE_OUTCOME_PENDING";
  assertEquals(findResultPlaceholders(text), ["GATE_OUTCOME_PENDING"]);
  assertEquals(
    replaceResultPlaceholders(text, "[result not reported]"),
    "- `./quality.sh < /dev/null` on the head: [result not reported]",
  );
});

Deno.test("findResultPlaceholders - the _TBD, _TODO and _PENDING suffixes are reported in prose", () => {
  assertEquals(findResultPlaceholders("Still CI_RESULT_TBD for now."), [
    "CI_RESULT_TBD",
  ]);
  assertEquals(findResultPlaceholders("Still GATE_RESULT_TODO for now."), [
    "GATE_RESULT_TODO",
  ]);
  assertEquals(findResultPlaceholders("Still LINT_OUTCOME_PENDING for now."), [
    "LINT_OUTCOME_PENDING",
  ]);
});

Deno.test("findResultPlaceholders - the structural backstop catches a bare identifier on a deno test result line", () => {
  const text = "- `deno test tests/foo_test.ts`: QUALITY_GATE_OUTCOME";
  assertEquals(findResultPlaceholders(text), ["QUALITY_GATE_OUTCOME"]);
});

Deno.test("findResultPlaceholders - the structural backstop keeps a trailing full stop on replace", () => {
  const text = "- `cargo test`: RESULT_HERE.";
  assertEquals(findResultPlaceholders(text), ["RESULT_HERE"]);
  assertEquals(
    replaceResultPlaceholders(text, "[result not reported]"),
    "- `cargo test`: [result not reported].",
  );
});

Deno.test("findResultPlaceholders - a backstop identifier also ending in _PENDING is reported once", () => {
  const text = "- `deno test`: QUALITY_GATE_PENDING";
  assertEquals(findResultPlaceholders(text), ["QUALITY_GATE_PENDING"]);
});

Deno.test("findResultPlaceholders - a bare identifier inside an inline code span is not flagged", () => {
  const text = "- `deno test`: `SYNC_PENDING`";
  assertEquals(findResultPlaceholders(text), []);
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
});

Deno.test("findResultPlaceholders - a bare identifier inside a fenced block is not flagged", () => {
  const text = [
    "```",
    "- `cargo test`: SYNC_PENDING",
    "```",
    "",
  ].join("\n");
  assertEquals(findResultPlaceholders(text), []);
  assertEquals(replaceResultPlaceholders(text, "[result not reported]"), text);
});

Deno.test("findResultPlaceholders - a suffix followed by a word character does not match in prose", () => {
  const text = "See SYNC_PENDING_COUNT for the tally.";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - a result with no underscore (PASSED) is not flagged", () => {
  const text = "- `./quality.sh`: PASSED";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - a line with no gate command is not flagged", () => {
  const text = "- Label applied: NEEDS_HUMAN";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - an identifier that is not the line's result is not flagged", () => {
  const text = "- `deno test`: passed; the MAX_SCAN_CHARS cap is unchanged.";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - a non-result line naming a constant is not flagged", () => {
  const text = "- Raised MAX_SCAN_CHARS: 200000";
  assertEquals(findResultPlaceholders(text), []);
});

Deno.test("findResultPlaceholders - a result inside backticks is not flagged even with a gate command on the line", () => {
  const text = "- `./quality.sh`: `GATE_OUTCOME`";
  assertEquals(findResultPlaceholders(text), []);
});

// ---------------------------------------------------------------------------
// Hostile-input growth (Issue #3248)
// ---------------------------------------------------------------------------

Deno.test("GATE_COMMAND_RE - a long whitespace run that never completes a known command scales linearly", () => {
  const build = (chars: number) => `deno${" ".repeat(chars)}x: A_B`;
  const result = assertLinearGrowth(
    "GATE_COMMAND_RE whitespace run",
    build,
    (input) => findResultPlaceholders(input),
    { baseChars: 25_000 },
  );
  assertEquals(result, []);
});

Deno.test("BARE_IDENTIFIER_RE - a long repeated underscore group that never full-matches scales linearly", () => {
  const build = (chars: number) =>
    `- \`./quality.sh\`: A${"_A".repeat(Math.floor(chars / 2))}!`;
  const result = assertLinearGrowth(
    "BARE_IDENTIFIER_RE repeated underscore group",
    build,
    (input) => findResultPlaceholders(input),
    { baseChars: 25_000 },
  );
  assertEquals(result, []);
});

Deno.test("BARE_IDENTIFIER_RE - a long run of letters that never full-matches scales linearly", () => {
  const build = (chars: number) => `- \`./quality.sh\`: ${"A".repeat(chars)}!`;
  const result = assertLinearGrowth(
    "BARE_IDENTIFIER_RE long letter run",
    build,
    (input) => findResultPlaceholders(input),
    { baseChars: 25_000 },
  );
  assertEquals(result, []);
});

Deno.test("PLACEHOLDER_TOKEN_RE - a long run of letters before a near-miss suffix scales linearly", () => {
  const build = (chars: number) => `${"A".repeat(chars)}_PENDINGX`;
  const result = assertLinearGrowth(
    "PLACEHOLDER_TOKEN_RE long letter run",
    build,
    (input) => findResultPlaceholders(input),
    { baseChars: 25_000 },
  );
  assertEquals(result, []);
});
