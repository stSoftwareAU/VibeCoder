/**
 * Tests for the Result-returning registry methods (Issue #223).
 *
 * Following TDD: These tests define the expected behaviour for
 * register() and execute() returning Result types instead of throwing.
 */

import { assertEquals } from "@std/assert";
import { createCommandRegistry } from "../lib/commands.ts";
import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

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

function createMockCommand(name: string, result: CommandResult): Command {
  return {
    name,
    description: `Mock command ${name}`,
    execute: async () => result,
  };
}

// =============================================================================
// register() — Returns Result instead of throwing
// =============================================================================

Deno.test("registry Result - register returns ok for new command", () => {
  const registry = createCommandRegistry();
  const command = createMockCommand("test", { success: true, message: "ok" });

  const result: Result<void> = registry.register(command);

  assertEquals(result.ok, true);
});

Deno.test("registry Result - register returns error for duplicate command", () => {
  const registry = createCommandRegistry();
  const cmd1 = createMockCommand("test", { success: true, message: "first" });
  const cmd2 = createMockCommand("test", { success: true, message: "second" });

  registry.register(cmd1);
  const result: Result<void> = registry.register(cmd2);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("already registered"), true);
  }
});

Deno.test("registry Result - register error includes command name", () => {
  const registry = createCommandRegistry();
  const cmd1 = createMockCommand("my-cmd", { success: true, message: "first" });
  const cmd2 = createMockCommand("my-cmd", {
    success: true,
    message: "second",
  });

  registry.register(cmd1);
  const result = registry.register(cmd2);

  if (!result.ok) {
    assertEquals(result.error.message.includes("my-cmd"), true);
  }
});

// =============================================================================
// execute() — Returns Result instead of throwing
// =============================================================================

Deno.test("registry Result - execute returns ok with command result", async () => {
  const registry = createCommandRegistry();
  const expectedResult = {
    success: true,
    message: "executed",
    data: { key: "value" },
  };
  const command = createMockCommand("test", expectedResult);

  registry.register(command);
  const result: Result<CommandResult> = await registry.execute(
    "test",
    {},
    createMockConfig(),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, expectedResult);
  }
});

Deno.test("registry Result - execute returns error for unknown command", async () => {
  const registry = createCommandRegistry();

  const result: Result<CommandResult> = await registry.execute(
    "unknown",
    {},
    createMockConfig(),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Unknown command"), true);
  }
});

Deno.test("registry Result - execute error includes command name", async () => {
  const registry = createCommandRegistry();

  const result = await registry.execute("nonexistent", {}, createMockConfig());

  if (!result.ok) {
    assertEquals(result.error.message.includes("nonexistent"), true);
  }
});

Deno.test("registry Result - execute returns error when command throws", async () => {
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

Deno.test("registry Result - execute passes args to command handler", async () => {
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
  const result = await registry.execute(
    "capture-args",
    { title: "test", verbose: true },
    createMockConfig(),
  );

  assertEquals(result.ok, true);
  assertEquals(capturedArgs.title, "test");
  assertEquals(capturedArgs.verbose, true);
});

Deno.test("registry Result - execute passes config to command handler", async () => {
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
  const result = await registry.execute("capture-config", {}, config);

  assertEquals(result.ok, true);
  assertEquals(capturedConfig, config);
});

Deno.test("registry Result - execute handles command returning failure result", async () => {
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
