/**
 * Tests for the session persistence allowlist (Issue #3663).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { isAllowedSessionPath } from "../lib/session_file_policy.ts";

// --- Allowed session state ---

Deno.test("session_file_policy - allows top-level session data files", () => {
  assertEquals(isAllowedSessionPath("session.json", "file"), true);
  assertEquals(isAllowedSessionPath("projects.json", "file"), true);
  assertEquals(isAllowedSessionPath("history.jsonl", "file"), true);
  assertEquals(isAllowedSessionPath("session-42.json", "file"), true);
});

Deno.test("session_file_policy - allows session directories and their data", () => {
  assertEquals(isAllowedSessionPath("projects", "directory"), true);
  assertEquals(isAllowedSessionPath("projects/proj.json", "file"), true);
  assertEquals(
    isAllowedSessionPath("projects/-Users-worker-repo", "directory"),
    true,
  );
  assertEquals(
    isAllowedSessionPath(
      "projects/-Users-worker-repo/transcript.jsonl",
      "file",
    ),
    true,
  );
  assertEquals(isAllowedSessionPath("todos/todo-1.json", "file"), true);
});

// --- Blocked execution and configuration surfaces ---

Deno.test("session_file_policy - blocks settings files that carry hooks", () => {
  assertEquals(isAllowedSessionPath("settings.json", "file"), false);
  assertEquals(isAllowedSessionPath("settings.local.json", "file"), false);
  assertEquals(isAllowedSessionPath("projects/settings.json", "file"), false);
});

Deno.test("session_file_policy - blocks executable and instruction directories", () => {
  assertEquals(isAllowedSessionPath("hooks", "directory"), false);
  assertEquals(isAllowedSessionPath("agents", "directory"), false);
  assertEquals(isAllowedSessionPath("commands", "directory"), false);
  assertEquals(isAllowedSessionPath("skills", "directory"), false);
  assertEquals(isAllowedSessionPath("shell-snapshots", "directory"), false);
});

Deno.test("session_file_policy - blocks executable and non-data file types", () => {
  assertEquals(isAllowedSessionPath("projects/run.sh", "file"), false);
  assertEquals(isAllowedSessionPath("projects/tool.ts", "file"), false);
  assertEquals(isAllowedSessionPath("projects/notes.md", "file"), false);
  assertEquals(isAllowedSessionPath("config.json", "file"), false);
  assertEquals(isAllowedSessionPath("mcp.json", "file"), false);
});

Deno.test("session_file_policy - blocks hidden entries and path traversal", () => {
  assertEquals(isAllowedSessionPath(".env", "file"), false);
  assertEquals(isAllowedSessionPath("projects/.env", "file"), false);
  assertEquals(isAllowedSessionPath("../settings.json", "file"), false);
  assertEquals(isAllowedSessionPath("projects/../../evil.json", "file"), false);
  assertEquals(isAllowedSessionPath("", "file"), false);
  assertEquals(isAllowedSessionPath("/etc/passwd", "file"), false);
});
