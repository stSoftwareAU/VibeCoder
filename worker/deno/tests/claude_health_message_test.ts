/**
 * Tests for claude_health_message.ts — accurate health-failure summarisation
 * (Issue #1980).
 *
 * Replaces the catch-all "Claude CLI is likely rate-limited or unresponsive"
 * with an evidence-based summary so operators can see the real failure mode.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  STDERR_PREVIEW_MAX,
  STDOUT_PREVIEW_MAX,
  summariseHealthFailure,
} from "../lib/claude_health_message.ts";

Deno.test("summariseHealthFailure - auth error in stderr → category=auth", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    "Error: not logged in. Please run `claude login`.",
  );
  assertEquals(summary.category, "auth");
  assertStringIncludes(summary.message, "login required");
});

Deno.test("summariseHealthFailure - auth error in stdout → category=auth", () => {
  const summary = summariseHealthFailure(
    1,
    "authentication required",
    "",
  );
  assertEquals(summary.category, "auth");
});

Deno.test("summariseHealthFailure - real rate-limit evidence in stderr → category=rate-limit", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    "HTTP 429 — rate limit exceeded, retry after 60s",
  );
  assertEquals(summary.category, "rate-limit");
  assertStringIncludes(summary.message, "rate-limited");
  assertStringIncludes(summary.message, "exit 1");
  assertStringIncludes(summary.message, "429");
});

Deno.test("summariseHealthFailure - bare non-zero exit with stderr → category=stderr (NOT rate-limit)", () => {
  // Issue #1980 regression: a non-zero exit with stderr that does NOT
  // mention rate limiting must NOT be reported as rate-limited.
  const summary = summariseHealthFailure(
    7,
    "",
    "Error: model 'claude-bogus' not found",
  );
  assertEquals(summary.category, "stderr");
  assertStringIncludes(summary.message, "exited 7");
  assertStringIncludes(summary.message, "model 'claude-bogus' not found");
  assert(
    !summary.message.toLowerCase().includes("rate-limited"),
    `unexpected rate-limited claim: ${summary.message}`,
  );
});

Deno.test("summariseHealthFailure - zero exit with empty stdout, empty stderr → category=empty-stdout", () => {
  const summary = summariseHealthFailure(0, "", "");
  assertEquals(summary.category, "empty-stdout");
  assertStringIncludes(summary.message, "exited 0");
  assertStringIncludes(summary.message, "empty stdout");
});

Deno.test("summariseHealthFailure - non-zero exit with both empty → category=empty-stdout", () => {
  const summary = summariseHealthFailure(2, "", "");
  assertEquals(summary.category, "empty-stdout");
  assertStringIncludes(summary.message, "exited 2");
});

Deno.test("summariseHealthFailure - non-zero exit, empty stderr, garbage stdout → category=exit-code", () => {
  const summary = summariseHealthFailure(5, "unexpected gibberish here", "");
  assertEquals(summary.category, "exit-code");
  assertStringIncludes(summary.message, "exited 5");
  assertStringIncludes(summary.message, "gibberish");
});

Deno.test("summariseHealthFailure - truncates stderr preview to STDERR_PREVIEW_MAX", () => {
  const longStderr = "x".repeat(STDERR_PREVIEW_MAX + 200);
  const summary = summariseHealthFailure(1, "", longStderr);
  assert(
    summary.stderrPreview.length <= STDERR_PREVIEW_MAX + 1, // +1 for ellipsis
    `stderrPreview not truncated: ${summary.stderrPreview.length}`,
  );
});

Deno.test("summariseHealthFailure - truncates stdout preview to STDOUT_PREVIEW_MAX", () => {
  const longStdout = "y".repeat(STDOUT_PREVIEW_MAX + 200);
  const summary = summariseHealthFailure(1, longStdout, "boom");
  assert(
    summary.stdoutPreview.length <= STDOUT_PREVIEW_MAX + 1,
    `stdoutPreview not truncated: ${summary.stdoutPreview.length}`,
  );
});

Deno.test("summariseHealthFailure - collapses multi-line stderr to one-line message", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    "Error:\n  the server\n  exploded",
  );
  // Message contains the stderr content on one line (no embedded newlines).
  const messageAfterColon = summary.message.split(":").slice(1).join(":");
  assert(
    !messageAfterColon.includes("\n"),
    `message contains newline: ${summary.message}`,
  );
  assertStringIncludes(summary.message, "the server exploded");
});

Deno.test("summariseHealthFailure - 'retry' alone is NOT primary rate-limit evidence", () => {
  // Issue #1980: only PRIMARY rate-limit markers (rate limit / credit /
  // quota / exceeded / too many requests / 429) should trigger the
  // rate-limit category. A bare "retry" word is the secondary pattern
  // and must not be enough on its own.
  const summary = summariseHealthFailure(
    1,
    "",
    "Operation failed, please retry the command",
  );
  assertEquals(summary.category, "stderr");
  assert(
    !summary.message.toLowerCase().includes("rate-limited"),
    `secondary 'retry' should not trigger rate-limit: ${summary.message}`,
  );
});

// ---------------------------------------------------------------------------
// Subscription usage limit (Issue #4315)
// ---------------------------------------------------------------------------

Deno.test("summariseHealthFailure - a usage-limit refusal on stderr is its own category, not 'stderr' (Issue #4315)", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    "Claude AI usage limit reached|1787040000",
  );
  assertEquals(summary.category, "usage-limit");
  assertStringIncludes(summary.message, "usage limit");
});

Deno.test("summariseHealthFailure - 'hit your limit' is a usage limit, not a weak rate-limit hint (Issue #4315)", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    "You've hit your limit · resets 3am",
  );
  assertEquals(summary.category, "usage-limit");
});
