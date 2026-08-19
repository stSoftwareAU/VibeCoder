/**
 * Tests for answer_sanitiser command (Issue #913).
 *
 * CLI-specific tests only — unit tests for sanitisation logic live in
 * answer_sanitiser_test.ts. Deduplicated as part of Issue #1307.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { answerSanitiserCommand } from "../commands/answer_sanitiser.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

// ---------------------------------------------------------------------------
// CLI-specific: default operation handling
// ---------------------------------------------------------------------------

Deno.test("answer-sanitiser command - defaults to sanitise operation", async () => {
  const result = await answerSanitiserCommand.execute(
    { "raw-output": "I cannot post a comment.\n\nActual content." },
    createMockConfig(),
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "Actual content.");
});

// ---------------------------------------------------------------------------
// CLI-specific: unknown operation error handling
// ---------------------------------------------------------------------------

Deno.test("answer-sanitiser command - returns error for unknown operation", async () => {
  const result = await answerSanitiserCommand.execute(
    { operation: "unknown" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});
