/**
 * Tests for {@link clampIdleTaskBody} (Issue #3634).
 *
 * Covers:
 *   - under-limit bodies pass through byte-for-byte;
 *   - an over-limit body is clamped to GitHub's 65,536-character ceiling;
 *   - the head (carrying each template's body fingerprint) survives;
 *   - the attribution footer + run-id block tail survives;
 *   - the drop is announced loudly in the body, never silently;
 *   - a pathological body with no footer still clamps under the limit.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  clampIdleTaskBody,
  GITHUB_ISSUE_BODY_MAX_CHARS,
  IDLE_TASK_BODY_TRUNCATION_MARKER,
} from "../lib/idle_task_body_limit.ts";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";

/** Build a body of `length` characters that starts with a fingerprint heading. */
function bodyOfLength(length: number, heading = "## Security Scan"): string {
  const head = `${heading}\n\n`;
  const filler = "lorem ipsum dolor sit amet\n";
  let out = head;
  while (out.length < length) out += filler;
  return out.slice(0, length);
}

Deno.test("clampIdleTaskBody - under-limit body passes through unchanged", () => {
  const body = appendIdleTaskAttribution(bodyOfLength(2_000), {
    template: "security-scan",
    runId: "vibe-test-0001",
  });

  const result = clampIdleTaskBody(body);

  assertEquals(result.truncated, false);
  assertEquals(result.droppedChars, 0);
  assertEquals(result.body, body);
});

Deno.test("clampIdleTaskBody - over-limit body is clamped under GitHub's ceiling", () => {
  const body = appendIdleTaskAttribution(bodyOfLength(84_454), {
    template: "security-scan",
    runId: "vibe-test-0002",
  });
  assert(body.length > GITHUB_ISSUE_BODY_MAX_CHARS);

  const result = clampIdleTaskBody(body);

  assertEquals(result.truncated, true);
  assert(
    result.body.length <= GITHUB_ISSUE_BODY_MAX_CHARS,
    `clamped body is ${result.body.length} characters, over the limit`,
  );
  assertEquals(result.originalLength, body.length);
  assert(
    result.droppedChars > 0,
    "a truncated body must report how many characters were dropped",
  );
});

Deno.test("clampIdleTaskBody - keeps the fingerprint head and the attribution tail", () => {
  const runId = "vibe-test-0003";
  const body = appendIdleTaskAttribution(bodyOfLength(84_454), {
    template: "security-scan",
    runId,
  });

  const result = clampIdleTaskBody(body);

  // Head: the fingerprint heading templates dispatch on.
  assertStringIncludes(result.body, "## Security Scan");
  // Tail: the visible attribution footer and the machine-readable run id.
  assertStringIncludes(result.body, "🏷️ Filed by idle-task template:");
  assertStringIncludes(result.body, `run-id: ${runId}`);
});

Deno.test("clampIdleTaskBody - announces the drop loudly in the body", () => {
  const body = appendIdleTaskAttribution(bodyOfLength(84_454), {
    template: "security-scan",
    runId: "vibe-test-0004",
  });

  const result = clampIdleTaskBody(body);

  assertStringIncludes(result.body, IDLE_TASK_BODY_TRUNCATION_MARKER);
  assertStringIncludes(result.body, String(result.droppedChars));
});

Deno.test("clampIdleTaskBody - clamps a footerless body under the limit", () => {
  const body = bodyOfLength(200_000, "## Dead-Code Sweep");

  const result = clampIdleTaskBody(body);

  assertEquals(result.truncated, true);
  assert(result.body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
  assertStringIncludes(result.body, "## Dead-Code Sweep");
  assertStringIncludes(result.body, IDLE_TASK_BODY_TRUNCATION_MARKER);
});

Deno.test("clampIdleTaskBody - honours a caller-supplied limit", () => {
  const body = appendIdleTaskAttribution(bodyOfLength(5_000), {
    template: "dead-code",
    runId: "vibe-test-0005",
  });

  const result = clampIdleTaskBody(body, { maxChars: 1_000 });

  assertEquals(result.truncated, true);
  assert(result.body.length <= 1_000);
});

Deno.test("clampIdleTaskBody - rejects a non-positive limit rather than failing quietly", () => {
  let threw = false;
  try {
    clampIdleTaskBody("body", { maxChars: 0 });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "maxChars");
  }
  assert(threw, "expected clampIdleTaskBody to throw on a non-positive limit");
});
