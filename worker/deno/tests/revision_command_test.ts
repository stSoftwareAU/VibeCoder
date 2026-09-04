/**
 * Tests for the revision-processor command operations (Issue #1119).
 *
 * Tests the command-level wiring for the process-revision operation,
 * verifying argument validation and delegation to the library function.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertExists } from "@std/assert";
import { revisionProcessorCommand } from "../commands/revision_processor.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import { emptyEnv } from "./support/env_lookup.ts";

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

// ============================================================================
// Command argument validation
// ============================================================================

Deno.test("revision-processor command - parse-response operation still works", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    {
      operation: "parse-response",
      output: JSON.stringify({
        update_title: false,
        new_title: "",
        update_body: true,
        new_body: "Revised body",
        summary: "Applied reviewer corrections",
      }),
    },
    config,
  );
  assertEquals(result.success, true);
  const data = result.data;
  assertExists(data);
  assertEquals(data.bodyUpdated, true);
  assertEquals(data.summary, "Applied reviewer corrections");
});

Deno.test("revision-processor command - build-prompt operation still works", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    {
      operation: "build-prompt",
      title: "Test revision title",
      body: "Test revision body",
      feedback: "Review feedback text",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message.includes("Test revision title"), true);
  assertEquals(result.message.includes("Review feedback text"), true);
});

Deno.test("revision-processor command - process-revision rejects missing repo", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    {
      operation: "process-revision",
      "issue-number": 42,
      "github-user": "testbot",
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("revision-processor command - process-revision rejects missing issue-number", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    {
      operation: "process-revision",
      repo: "org/repo",
      "github-user": "testbot",
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

// The acting login reaches the command as its third parameter (Issue #965),
// so this test states an empty environment instead of deleting `GITHUB_USER`
// from the process — a write that races every other test sharing the
// process. The command resolves the login through
// `resolveActingGithubUser`, whose own suite
// (`tests/acting_github_user_test.ts`) pins the accepting direction with a
// login absent from every real environment; here the only observable is the
// rejection, because accepting one sends the command on to GitHub.
Deno.test("revision-processor command - process-revision rejects missing github-user", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    {
      operation: "process-revision",
      repo: "org/repo",
      "issue-number": 42,
    },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("revision-processor command - unknown operation returns error", async () => {
  const config = makeConfig();
  const result = await revisionProcessorCommand.execute(
    { operation: "nonexistent" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Unknown operation"), true);
  assertEquals(result.message.includes("process-revision"), true);
});

Deno.test("revision-processor command - has correct name", () => {
  assertEquals(revisionProcessorCommand.name, "revision-processor");
});
