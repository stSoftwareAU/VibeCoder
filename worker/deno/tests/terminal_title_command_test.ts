/**
 * Tests for the terminal title command.
 *
 * CLI-specific tests only — unit tests for title building, window title
 * setting/resetting, and issue/PR formatting logic live in
 * terminal_title_test.ts. Deduplicated as part of Issue #1307.
 *
 * Issue #900: Migrate terminal_title.sh to Deno.
 */

import { assertEquals } from "@std/assert";
import { terminalTitleCommand } from "../commands/terminal_title.ts";
import type { WorkerConfig } from "../types.ts";
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
  const original = Deno.env.get("SET_WINDOW_TITLE");
  Deno.env.set("SET_WINDOW_TITLE", "false");
  try {
    const result = await terminalTitleCommand.execute(
      { action: "set", title: "Test" },
      createMockConfig(),
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(typeof data.title, "string");
    assertEquals(typeof data.sequence, "string");
    assertEquals(typeof data.enabled, "boolean");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SET_WINDOW_TITLE", original);
    } else {
      Deno.env.delete("SET_WINDOW_TITLE");
    }
  }
});
