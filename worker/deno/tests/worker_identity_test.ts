/**
 * Tests for the worker identity module.
 *
 * Migrated from tests/worker-name-config.bats (Issue #900).
 * Issue #436: Worker name in issue comments and PR descriptions.
 * Issue #604: Unique worker ID for multi-worker claim tie-breaking.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildWorkerFooter,
  getHostname,
  getWorkerDisplayName,
  getWorkerUniqueId,
} from "../lib/worker_identity.ts";

// =============================================================================
// getWorkerDisplayName
// =============================================================================

Deno.test("worker_identity - getWorkerDisplayName returns workerName when set", () => {
  const result = getWorkerDisplayName({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback-user",
  });
  assertEquals(result, "Vibe Coder Alpha");
});

Deno.test("worker_identity - getWorkerDisplayName returns githubUser when workerName is empty", () => {
  const result = getWorkerDisplayName({
    workerName: "",
    githubUser: "my-github-user",
  });
  assertEquals(result, "my-github-user");
});

Deno.test("worker_identity - getWorkerDisplayName handles spaces in workerName", () => {
  const result = getWorkerDisplayName({
    workerName: "worker macbook 1",
    githubUser: "fallback",
  });
  assertEquals(result, "worker macbook 1");
});

// =============================================================================
// getHostname (Issue #1058)
// =============================================================================

Deno.test("worker_identity - getHostname returns a non-empty string", () => {
  const result = getHostname();
  assertEquals(typeof result, "string");
  assertEquals(result.length > 0, true);
});

Deno.test("worker_identity - getHostname does not return unknown-host when system is available", () => {
  // When running with appropriate permissions, the hostname should resolve
  // to a real machine name, not the fallback value.
  const result = getHostname();
  assertEquals(
    result !== "unknown-host",
    true,
    `Expected real hostname but got "${result}"`,
  );
});

Deno.test("worker_identity - getHostname returns consistent results on repeated calls", () => {
  const first = getHostname();
  const second = getHostname();
  assertEquals(first, second);
});

// =============================================================================
// getWorkerUniqueId
// =============================================================================

Deno.test("worker_identity - getWorkerUniqueId includes workerName and hostname", () => {
  const result = getWorkerUniqueId("Vibe Coder Alpha");
  // Format: "workerName@hostname"
  assertEquals(result.startsWith("Vibe Coder Alpha@"), true);
  assertEquals(result.length > "Vibe Coder Alpha@".length, true);
});

Deno.test("worker_identity - getWorkerUniqueId includes hostname when workerName is empty", () => {
  const result = getWorkerUniqueId("");
  // Format: "hostname-pid" — should contain a dash separating hostname and pid
  assertEquals(result.length > 0, true);
  assertEquals(result.includes("-"), true);
});

Deno.test("worker_identity - getWorkerUniqueId never returns empty string", () => {
  const result = getWorkerUniqueId("");
  assertEquals(typeof result, "string");
  assertEquals(result.length > 0, true);
});

Deno.test("worker_identity - getWorkerUniqueId differentiates same name on different hosts", () => {
  const result = getWorkerUniqueId("shared-worker");
  assertEquals(result.startsWith("shared-worker@"), true);
  const hostname = result.slice("shared-worker@".length);
  assertEquals(hostname.length > 0, true);
});

Deno.test("worker_identity - getWorkerUniqueId does not contain unknown-host", () => {
  const result = getWorkerUniqueId("test-worker");
  assertEquals(
    result.includes("unknown-host"),
    false,
    `Expected real hostname in unique ID but got "${result}"`,
  );
});

// =============================================================================
// buildWorkerFooter
// =============================================================================

Deno.test("worker_identity - buildWorkerFooter includes worker name when set", () => {
  const result = buildWorkerFooter({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback-user",
  });
  assertStringIncludes(result, "Vibe Coder Alpha");
});

Deno.test("worker_identity - buildWorkerFooter includes github username when workerName is empty", () => {
  const result = buildWorkerFooter({
    workerName: "",
    githubUser: "my-github-user",
  });
  assertStringIncludes(result, "my-github-user");
});

Deno.test("worker_identity - buildWorkerFooter contains Processed by prefix", () => {
  const result = buildWorkerFooter({
    workerName: "Test Worker",
    githubUser: "fallback",
  });
  assertStringIncludes(result, "Processed by:");
});

Deno.test("worker_identity - buildWorkerFooter produces consistent format", () => {
  const result = buildWorkerFooter({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback",
  });
  const expected = "\n---\n\n🤖 Processed by: Vibe Coder Alpha";
  assertEquals(result, expected);
});

Deno.test("worker_identity - buildWorkerFooter includes separator line", () => {
  const result = buildWorkerFooter({
    workerName: "Test",
    githubUser: "fallback",
  });
  assertStringIncludes(result, "---");
});

Deno.test("worker_identity - buildWorkerFooter adds the run-id line when runId is set (Issue #2381)", () => {
  const result = buildWorkerFooter({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback",
    runId: "vibe-abc-123456",
  });
  assertStringIncludes(result, "Processed by: Vibe Coder Alpha");
  assertStringIncludes(result, "Run id: `vibe-abc-123456`");
});

Deno.test("worker_identity - buildWorkerFooter omits the run-id line when runId is absent", () => {
  const result = buildWorkerFooter({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback",
  });
  assertEquals(result.includes("Run id:"), false);
});

Deno.test("worker_identity - buildWorkerFooter omits the run-id line for a blank runId", () => {
  const result = buildWorkerFooter({
    workerName: "Vibe Coder Alpha",
    githubUser: "fallback",
    runId: "   ",
  });
  assertEquals(result.includes("Run id:"), false);
});
