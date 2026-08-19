/**
 * Tests for claude_auth.ts — Claude CLI authentication verification (Issue #617, #913).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  claudeAuthActionableMessage,
  isClaudeAuthError,
  isClaudeAuthErrorInFile,
} from "../lib/claude_auth.ts";

// ---------------------------------------------------------------------------
// isClaudeAuthError — positive matches
// ---------------------------------------------------------------------------

Deno.test("claude auth - detects 'not logged in' pattern", () => {
  assertEquals(isClaudeAuthError("Error: You are not logged in"), true);
});

Deno.test("claude auth - detects 'please log in' pattern", () => {
  assertEquals(isClaudeAuthError("Please log in first"), true);
});

Deno.test("claude auth - detects 'claude login' pattern", () => {
  assertEquals(isClaudeAuthError("Run claude login to authenticate"), true);
});

Deno.test("claude auth - detects 'authentication required' pattern", () => {
  assertEquals(isClaudeAuthError("Authentication required"), true);
});

Deno.test("claude auth - detects 'session expired' pattern", () => {
  assertEquals(isClaudeAuthError("Your session expired"), true);
});

Deno.test("claude auth - detects 'unauthorized' pattern", () => {
  assertEquals(isClaudeAuthError("HTTP 401 Unauthorized"), true);
});

Deno.test("claude auth - detects 'unauthorised' pattern (Australian English)", () => {
  assertEquals(isClaudeAuthError("Request was unauthorised"), true);
});

Deno.test("claude auth - detects 'invalid token' pattern", () => {
  assertEquals(isClaudeAuthError("Error: invalid authentication token"), true);
});

Deno.test("claude auth - detects 'api key' pattern", () => {
  assertEquals(isClaudeAuthError("Missing or invalid API key"), true);
});

Deno.test("claude auth - case-insensitive matching", () => {
  assertEquals(isClaudeAuthError("NOT LOGGED IN"), true);
  assertEquals(isClaudeAuthError("PLEASE LOG IN"), true);
  assertEquals(isClaudeAuthError("SESSION EXPIRED"), true);
});

// ---------------------------------------------------------------------------
// isClaudeAuthError — negative matches
// ---------------------------------------------------------------------------

Deno.test("claude auth - rejects empty input", () => {
  assertEquals(isClaudeAuthError(""), false);
});

Deno.test("claude auth - rejects rate limit errors", () => {
  assertEquals(isClaudeAuthError("Rate limit exceeded"), false);
});

Deno.test("claude auth - rejects network errors", () => {
  assertEquals(isClaudeAuthError("Network timeout"), false);
});

Deno.test("claude auth - rejects generic errors", () => {
  assertEquals(isClaudeAuthError("Something went wrong"), false);
});

Deno.test("claude auth - rejects timeout errors", () => {
  assertEquals(isClaudeAuthError("Command timed out after 30s"), false);
});

// ---------------------------------------------------------------------------
// isClaudeAuthErrorInFile
// ---------------------------------------------------------------------------

Deno.test("claude auth - isClaudeAuthErrorInFile detects auth error in file", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "Some output\nError: not logged in\n");
    const result = await isClaudeAuthErrorInFile(tempFile);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, true);
    }
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude auth - isClaudeAuthErrorInFile returns false for clean file", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "All good\nNo errors here\n");
    const result = await isClaudeAuthErrorInFile(tempFile);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, false);
    }
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude auth - isClaudeAuthErrorInFile returns false for missing file", async () => {
  const result = await isClaudeAuthErrorInFile("/nonexistent/path/file.txt");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("claude auth - isClaudeAuthErrorInFile only checks last 30 lines", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    // Auth error on line 1, but 50+ clean lines after it
    const lines = ["Error: not logged in"];
    for (let i = 0; i < 50; i++) {
      lines.push(`Clean output line ${i}`);
    }
    await Deno.writeTextFile(tempFile, lines.join("\n"));
    const result = await isClaudeAuthErrorInFile(tempFile);
    assertEquals(result.ok, true);
    if (result.ok) {
      // Auth error is beyond the last 30 lines, should not be detected
      assertEquals(result.value, false);
    }
  } finally {
    await Deno.remove(tempFile);
  }
});

// ---------------------------------------------------------------------------
// claudeAuthActionableMessage
// ---------------------------------------------------------------------------

Deno.test("claude auth - actionable message includes 'claude login'", () => {
  const message = claudeAuthActionableMessage();
  assertEquals(message.includes("claude login"), true);
});

Deno.test("claude auth - actionable message is non-empty", () => {
  const message = claudeAuthActionableMessage();
  assertEquals(message.length > 0, true);
});
