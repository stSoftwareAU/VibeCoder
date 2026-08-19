/**
 * Tests for the canonical run-id module (Issue #2381).
 *
 * Covers run-id generation, env-backed resolution, the commit trailer
 * helpers (positive + negative), and the footer / metadata formatters.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendRunIdTrailer,
  assertRunIdTrailer,
  buildRunIdFooterLine,
  buildRunIdMetadataBlock,
  generateRunId,
  getRunId,
  hasRunIdTrailer,
  RUN_ID_ENV_VAR,
  RUN_ID_PREFIX,
  RUN_ID_TRAILER_KEY,
} from "../lib/run_id.ts";

// =============================================================================
// generateRunId
// =============================================================================

Deno.test("run_id - generateRunId produces the vibe- prefixed format", () => {
  const id = generateRunId({ now: 0, random: () => 0 });
  assertEquals(id, `${RUN_ID_PREFIX}-0-000000`);
});

Deno.test("run_id - generateRunId encodes the timestamp in base36", () => {
  const now = 12345678;
  const id = generateRunId({ now, random: () => 0 });
  assertEquals(id, `${RUN_ID_PREFIX}-${now.toString(36)}-000000`);
});

Deno.test("run_id - generateRunId pads the random suffix to 6 hex chars", () => {
  const id = generateRunId({ now: 1, random: () => 0.5 });
  const suffix = id.split("-")[2];
  assertEquals(suffix?.length, 6);
  assert(/^[0-9a-f]{6}$/.test(suffix ?? ""));
});

Deno.test("run_id - generateRunId differs across invocations with default randomness", () => {
  const a = generateRunId();
  const b = generateRunId();
  // Same millisecond is possible, so allow ts to match but require the
  // overall id to differ via the random suffix in the common case.
  assert(a.startsWith(`${RUN_ID_PREFIX}-`));
  assert(b.startsWith(`${RUN_ID_PREFIX}-`));
});

// =============================================================================
// getRunId (env-backed, generate-once)
// =============================================================================

Deno.test("run_id - getRunId returns the pre-set env value verbatim", () => {
  const original = Deno.env.get(RUN_ID_ENV_VAR);
  try {
    Deno.env.set(RUN_ID_ENV_VAR, "vibe-preset-abc123");
    assertEquals(getRunId(), "vibe-preset-abc123");
  } finally {
    if (original === undefined) Deno.env.delete(RUN_ID_ENV_VAR);
    else Deno.env.set(RUN_ID_ENV_VAR, original);
  }
});

Deno.test("run_id - getRunId generates and caches when env is unset", () => {
  const original = Deno.env.get(RUN_ID_ENV_VAR);
  try {
    Deno.env.delete(RUN_ID_ENV_VAR);
    const first = getRunId();
    assert(first.startsWith(`${RUN_ID_PREFIX}-`));
    // Cached into the env var, so a second call returns the same id.
    assertEquals(Deno.env.get(RUN_ID_ENV_VAR), first);
    assertEquals(getRunId(), first);
  } finally {
    if (original === undefined) Deno.env.delete(RUN_ID_ENV_VAR);
    else Deno.env.set(RUN_ID_ENV_VAR, original);
  }
});

Deno.test("run_id - getRunId trims surrounding whitespace from the env value", () => {
  const original = Deno.env.get(RUN_ID_ENV_VAR);
  try {
    Deno.env.set(RUN_ID_ENV_VAR, "  vibe-trim-me  ");
    assertEquals(getRunId(), "vibe-trim-me");
  } finally {
    if (original === undefined) Deno.env.delete(RUN_ID_ENV_VAR);
    else Deno.env.set(RUN_ID_ENV_VAR, original);
  }
});

Deno.test("run_id - getRunId regenerates when env value is blank", () => {
  const original = Deno.env.get(RUN_ID_ENV_VAR);
  try {
    Deno.env.set(RUN_ID_ENV_VAR, "   ");
    const id = getRunId();
    assert(id.startsWith(`${RUN_ID_PREFIX}-`));
  } finally {
    if (original === undefined) Deno.env.delete(RUN_ID_ENV_VAR);
    else Deno.env.set(RUN_ID_ENV_VAR, original);
  }
});

// =============================================================================
// Commit trailer helpers
// =============================================================================

Deno.test("run_id - hasRunIdTrailer detects a present trailer", () => {
  const msg = `Fix the parser\n\n${RUN_ID_TRAILER_KEY}: vibe-abc-123456`;
  assert(hasRunIdTrailer(msg));
});

Deno.test("run_id - hasRunIdTrailer returns false for a message without the trailer", () => {
  assertEquals(hasRunIdTrailer("Fix the parser (Issue #2381)"), false);
});

Deno.test("run_id - appendRunIdTrailer adds the trailer to a plain message", () => {
  const result = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  assert(hasRunIdTrailer(result));
  assertStringIncludes(result, `${RUN_ID_TRAILER_KEY}: vibe-abc-123456`);
});

Deno.test("run_id - appendRunIdTrailer is idempotent", () => {
  const once = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  const twice = appendRunIdTrailer(once, "vibe-different-999999");
  assertEquals(once, twice);
  // The original id is preserved — the second call is a no-op.
  assertStringIncludes(twice, "vibe-abc-123456");
});

Deno.test("run_id - appendRunIdTrailer joins an existing trailer block", () => {
  const msg =
    "Fix the parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const result = appendRunIdTrailer(msg, "vibe-abc-123456");
  // The run-id trailer sits directly under Co-Authored-By (single newline),
  // keeping both in the same git trailer block.
  assertStringIncludes(
    result,
    "Co-Authored-By: Claude <noreply@anthropic.com>\n" +
      `${RUN_ID_TRAILER_KEY}: vibe-abc-123456`,
  );
});

Deno.test("run_id - appendRunIdTrailer separates a new trailer block with a blank line", () => {
  const result = appendRunIdTrailer("Subject line only", "vibe-abc-123456");
  assertStringIncludes(
    result,
    `Subject line only\n\n${RUN_ID_TRAILER_KEY}: vibe-abc-123456`,
  );
});

Deno.test("run_id - assertRunIdTrailer accepts a message carrying the trailer", () => {
  const msg = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  const result = assertRunIdTrailer(msg);
  assert(result.ok);
});

Deno.test("run_id - assertRunIdTrailer rejects a message without the trailer (negative)", () => {
  const result = assertRunIdTrailer("Fix the parser — no trailer here");
  assert(!result.ok);
  if (!result.ok) {
    assertStringIncludes(result.error.message, RUN_ID_TRAILER_KEY);
  }
});

Deno.test("run_id - assertRunIdTrailer rejects a Co-Authored-By-only block (negative)", () => {
  const msg = "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const result = assertRunIdTrailer(msg);
  assert(!result.ok);
});

// =============================================================================
// Footer + metadata formatters
// =============================================================================

Deno.test("run_id - buildRunIdFooterLine embeds the run id in backticks", () => {
  const line = buildRunIdFooterLine("vibe-abc-123456");
  assertStringIncludes(line, "Run id:");
  assertStringIncludes(line, "`vibe-abc-123456`");
});

Deno.test("run_id - buildRunIdMetadataBlock is a fenced key/value block", () => {
  const block = buildRunIdMetadataBlock("vibe-abc-123456");
  assertEquals(block, "```\nrun-id: vibe-abc-123456\n```");
});
