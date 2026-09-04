/**
 * Tests for the terminal title command.
 *
 * CLI-specific tests only — unit tests for title building, window title
 * setting/resetting, and issue/PR formatting logic live in
 * terminal_title_test.ts. Deduplicated as part of Issue #1307.
 *
 * Issue #900: Migrate terminal_title.sh to Deno.
 */

import { assertEquals, assertExists } from "@std/assert";
import { terminalTitleCommand } from "../commands/terminal_title.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

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

// ---------------------------------------------------------------------------
// CLI-specific: command metadata
// ---------------------------------------------------------------------------

Deno.test("terminal-title command - has correct name", () => {
  assertEquals(terminalTitleCommand.name, "terminal-title");
});

Deno.test("terminal-title command - has a description", () => {
  assertEquals(typeof terminalTitleCommand.description, "string");
  assertEquals(terminalTitleCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command output structure
// ---------------------------------------------------------------------------

Deno.test("terminal-title command - data contains all fields", async () => {
  const result = await terminalTitleCommand.execute(
    { action: "set", title: "Test" },
    createMockConfig(),
    envFrom({ SET_WINDOW_TITLE: "false" }),
  );
  const data = result.data;
  assertExists(data);
  assertEquals(typeof data.title, "string");
  assertEquals(typeof data.sequence, "string");
  assertEquals(typeof data.enabled, "boolean");
});

// ---------------------------------------------------------------------------
// CLI-specific: the SET_WINDOW_TITLE seam (Issue #965)
//
// The flag reaches the command as its third parameter, so these tests state
// it instead of writing it into the process — a write that races every other
// test sharing the process. Both directions are asserted: whichever way the
// host's own `SET_WINDOW_TITLE` happens to be set, a code path that fell
// back to `Deno.env.get` fails one of them.
// ---------------------------------------------------------------------------

Deno.test("terminal-title command - the injected SET_WINDOW_TITLE enables the title", async () => {
  const result = await terminalTitleCommand.execute(
    { action: "set", title: "Working on #965" },
    createMockConfig(),
    envFrom({ SET_WINDOW_TITLE: "true" }),
  );
  const data = result.data;
  assertExists(data);
  assertEquals(data.enabled, true);
  assertEquals(data.title, "Working on #965");
  assertEquals(data.sequence.includes("Working on #965"), true);
  assertEquals(result.message, "Title set: Working on #965");
});

Deno.test("terminal-title command - an empty environment disables the title", async () => {
  const result = await terminalTitleCommand.execute(
    { action: "set", title: "Working on #965" },
    createMockConfig(),
    emptyEnv,
  );
  const data = result.data;
  assertExists(data);
  assertEquals(data.enabled, false);
  assertEquals(data.sequence, "");
  assertEquals(result.message, "Title setting disabled");
});
