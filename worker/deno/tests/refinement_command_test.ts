/**
 * Tests for the refinement-processor command operations (Issue #1119).
 *
 * CLI-specific tests only — unit tests for response parsing, prompt
 * building, and refinement processing logic live in
 * refinement_processor_test.ts. Deduplicated as part of Issue #1307.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { refinementProcessorCommand } from "../commands/refinement_processor.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

// ============================================================================
// CLI-specific: command metadata
// ============================================================================

Deno.test("refinement-processor command - has correct name", () => {
  assertEquals(refinementProcessorCommand.name, "refinement-processor");
});

// ============================================================================
// CLI-specific: argument validation
// ============================================================================

Deno.test("refinement-processor command - process-refinement rejects missing repo", async () => {
  const config = makeConfig();
  const result = await refinementProcessorCommand.execute(
    {
      operation: "process-refinement",
      "issue-number": 42,
      "github-user": "testbot",
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("refinement-processor command - process-refinement rejects missing issue-number", async () => {
  const config = makeConfig();
  const result = await refinementProcessorCommand.execute(
    {
      operation: "process-refinement",
      repo: "org/repo",
      "github-user": "testbot",
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("refinement-processor command - process-refinement rejects missing github-user", async () => {
  const config = makeConfig();
  // Ensure GITHUB_USER env var is not set for this test
  const originalUser = Deno.env.get("GITHUB_USER");
  try {
    Deno.env.delete("GITHUB_USER");
    const result = await refinementProcessorCommand.execute(
      {
        operation: "process-refinement",
        repo: "org/repo",
        "issue-number": 42,
      },
      config,
    );
    assertEquals(result.success, false);
    assertEquals(result.message.includes("Missing required"), true);
  } finally {
    if (originalUser !== undefined) {
      Deno.env.set("GITHUB_USER", originalUser);
    }
  }
});

// ============================================================================
// CLI-specific: unknown operation error handling
// ============================================================================

Deno.test("refinement-processor command - unknown operation returns error", async () => {
  const config = makeConfig();
  const result = await refinementProcessorCommand.execute(
    { operation: "nonexistent" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Unknown operation"), true);
  assertEquals(result.message.includes("process-refinement"), true);
});
