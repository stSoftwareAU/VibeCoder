/**
 * Tests for the command registry module.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 *
 * Issue #223: Tests updated to reflect register() and execute() returning
 * Result types instead of throwing. This is a business logic change — the
 * registry now returns Result<void> from register() and
 * Result<CommandResult> from execute() for consistent error handling.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createCommandRegistry } from "../lib/commands.ts";
import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// Mock config for tests
// Note: defaultBranch removed in Issue #140 - now fetched per-repo via GitHub API
function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

// Mock command for tests
function createMockCommand(name: string, result: CommandResult): Command {
  return {
    name,
    description: `Mock command ${name}`,
    execute: async () => result,
  };
}

Deno.test("commands - createCommandRegistry returns empty registry", () => {
  const registry = createCommandRegistry();
  assertEquals(registry.list().length, 0);
});

Deno.test("commands - register adds command to registry", () => {
  const registry = createCommandRegistry();
  const command = createMockCommand("test", { success: true, message: "ok" });

  registry.register(command);

  assertEquals(registry.list().length, 1);
  assertEquals(registry.list()[0], "test");
});

Deno.test("commands - get returns registered command", () => {
  const registry = createCommandRegistry();
  const command = createMockCommand("test", { success: true, message: "ok" });

  registry.register(command);
  const retrieved = registry.get("test");

  assertEquals(retrieved, command);
});

Deno.test("commands - get returns undefined for unknown command", () => {
  const registry = createCommandRegistry();
  const retrieved = registry.get("unknown");
  assertEquals(retrieved, undefined);
});

Deno.test("commands - has returns true for registered command", () => {
  const registry = createCommandRegistry();
  const command = createMockCommand("test", { success: true, message: "ok" });

  registry.register(command);

  assertEquals(registry.has("test"), true);
  assertEquals(registry.has("unknown"), false);
});

Deno.test("commands - execute runs command and returns result", async () => {
  const registry = createCommandRegistry();
  const expectedResult = {
    success: true,
    message: "executed",
    data: { key: "value" },
  };
  const command = createMockCommand("test", expectedResult);

  registry.register(command);
  // Issue #223: execute() returns Result<CommandResult>
  const result = await registry.execute("test", {}, createMockConfig());

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, expectedResult);
  }
});

// Issue #223: execute() returns Result error instead of throwing
Deno.test("commands - execute returns error for unknown command", async () => {
  const registry = createCommandRegistry();

  const result = await registry.execute("unknown", {}, createMockConfig());

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Unknown command");
  }
});

// Issue #223: register() returns Result error instead of throwing
Deno.test("commands - register returns error for duplicate command name", () => {
  const registry = createCommandRegistry();
  const command1 = createMockCommand("test", {
    success: true,
    message: "first",
  });
  const command2 = createMockCommand("test", {
    success: true,
    message: "second",
  });

  registry.register(command1);
  const result = registry.register(command2);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "already registered");
  }
});

Deno.test("commands - describe returns command description", () => {
  const registry = createCommandRegistry();
  const command: Command = {
    name: "test-cmd",
    description: "A test command that does something useful",
    execute: async () => ({ success: true, message: "ok" }),
  };

  registry.register(command);
  const description = registry.describe("test-cmd");

  assertEquals(description, "A test command that does something useful");
});

Deno.test("commands - describe returns undefined for unknown command", () => {
  const registry = createCommandRegistry();
  const description = registry.describe("unknown");
  assertEquals(description, undefined);
});

Deno.test("commands - listWithDescriptions returns all commands with descriptions", () => {
  const registry = createCommandRegistry();
  registry.register({
    name: "cmd1",
    description: "First command",
    execute: async () => ({ success: true, message: "ok" }),
  });
  registry.register({
    name: "cmd2",
    description: "Second command",
    execute: async () => ({ success: true, message: "ok" }),
  });

  const list = registry.listWithDescriptions();

  assertEquals(list.length, 2);
  assertEquals(list[0], { name: "cmd1", description: "First command" });
  assertEquals(list[1], { name: "cmd2", description: "Second command" });
});

// =============================================================================
// Additional edge case tests (Issue #218)
// =============================================================================

Deno.test("commands - execute passes args to command handler", async () => {
  const registry = createCommandRegistry();
  let capturedArgs: Record<string, unknown> = {};

  const command: Command = {
    name: "capture-args",
    description: "Captures arguments",
    execute: async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return { success: true, message: "ok" };
    },
  };

  registry.register(command);
  await registry.execute(
    "capture-args",
    { title: "test", verbose: true },
    createMockConfig(),
  );

  assertEquals(capturedArgs.title, "test");
  assertEquals(capturedArgs.verbose, true);
});

Deno.test("commands - execute passes config to command handler", async () => {
  const registry = createCommandRegistry();
  let capturedConfig: WorkerConfig | undefined;

  const command: Command = {
    name: "capture-config",
    description: "Captures config",
    execute: async (_args: Record<string, unknown>, config: WorkerConfig) => {
      capturedConfig = config;
      return { success: true, message: "ok" };
    },
  };

  registry.register(command);
  const config = createMockConfig();
  await registry.execute("capture-config", {}, config);

  assertEquals(capturedConfig, config);
});

// Issue #223: execute() returns Result error instead of propagating exceptions
Deno.test("commands - execute returns error when command throws", async () => {
  const registry = createCommandRegistry();

  const command: Command = {
    name: "error-cmd",
    description: "Throws an error",
    execute: async () => {
      throw new Error("Command execution failed");
    },
  };

  registry.register(command);

  const result = await registry.execute("error-cmd", {}, createMockConfig());
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "Command execution failed");
  }
});

Deno.test("commands - list returns names in registration order", () => {
  const registry = createCommandRegistry();
  registry.register(
    createMockCommand("charlie", { success: true, message: "c" }),
  );
  registry.register(
    createMockCommand("alpha", { success: true, message: "a" }),
  );
  registry.register(
    createMockCommand("bravo", { success: true, message: "b" }),
  );

  const names = registry.list();
  assertEquals(names, ["charlie", "alpha", "bravo"]);
});

Deno.test("commands - listWithDescriptions returns empty array for empty registry", () => {
  const registry = createCommandRegistry();
  const list = registry.listWithDescriptions();
  assertEquals(list, []);
});

// Issue #223: execute() wraps CommandResult in Result, so unwrap .value first
Deno.test("commands - execute handles command returning failure result", async () => {
  const registry = createCommandRegistry();
  const command = createMockCommand("fail-cmd", {
    success: false,
    message: "Something went wrong",
  });

  registry.register(command);
  const result = await registry.execute("fail-cmd", {}, createMockConfig());

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, false);
    assertEquals(result.value.message, "Something went wrong");
  }
});
