/**
 * Tests for the execute-claude-phase command entry point (Issue #1227).
 *
 * Validates argument parsing, required argument validation, and that
 * the command is registered in the default registry.
 *
 * Uses Australian English throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultRegistry } from "../mod.ts";
import { executeClaudePhaseCommand } from "../commands/execute_claude_phase.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// =============================================================================
// Command registration
// =============================================================================

Deno.test("execute-claude-phase command is registered in the default registry", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("execute-claude-phase"), true);
});

Deno.test("execute-claude-phase command has correct name", () => {
  assertEquals(executeClaudePhaseCommand.name, "execute-claude-phase");
});

Deno.test("execute-claude-phase command has a description", () => {
  assertEquals(typeof executeClaudePhaseCommand.description, "string");
  assertEquals(executeClaudePhaseCommand.description.length > 0, true);
});

// =============================================================================
// Argument validation
// =============================================================================

Deno.test("execute-claude-phase rejects missing --repo", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await executeClaudePhaseCommand.execute(
    { "issue-number": 42, "branch-name": "fix", "base-branch": "main" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--repo");
});

Deno.test("execute-claude-phase rejects missing --issue-number", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await executeClaudePhaseCommand.execute(
    { repo: "owner/repo", "branch-name": "fix", "base-branch": "main" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--issue-number");
});

Deno.test("execute-claude-phase rejects missing --branch-name", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await executeClaudePhaseCommand.execute(
    { repo: "owner/repo", "issue-number": 42, "base-branch": "main" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--branch-name");
});

Deno.test("execute-claude-phase rejects missing --base-branch", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await executeClaudePhaseCommand.execute(
    { repo: "owner/repo", "issue-number": 42, "branch-name": "fix" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--base-branch");
});
