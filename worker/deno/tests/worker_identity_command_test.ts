/**
 * Tests for the worker identity command.
 *
 * CLI-specific tests only — unit tests for display name resolution,
 * unique ID generation, and footer building logic live in
 * worker_identity_test.ts. Deduplicated as part of Issue #1307.
 *
 * Issue #900: Migrate worker_identity.sh to Deno.
 */

import { assertEquals } from "@std/assert";
import { workerIdentityCommand } from "../commands/worker_identity.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

function createMockConfig(workerName = ""): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
    workerName,
  }) as WorkerConfig;
}

// ---------------------------------------------------------------------------
// CLI-specific: command metadata
// ---------------------------------------------------------------------------

Deno.test("worker-identity command - has correct name", () => {
  assertEquals(workerIdentityCommand.name, "worker-identity");
});

Deno.test("worker-identity command - has a description", () => {
  assertEquals(typeof workerIdentityCommand.description, "string");
  assertEquals(workerIdentityCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command output structure
// ---------------------------------------------------------------------------

Deno.test("worker-identity command - data contains all fields", async () => {
  const config = createMockConfig("Test Worker");
  const result = await workerIdentityCommand.execute(
    { "github-user": "testuser" },
    config,
  );
  const data = result.data as Record<string, unknown>;
  assertEquals(typeof data.displayName, "string");
  assertEquals(typeof data.uniqueId, "string");
  assertEquals(typeof data.footer, "string");
});
