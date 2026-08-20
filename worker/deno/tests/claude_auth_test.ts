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

Deno.test("claude auth - detects the adjacent 'invalid token' pattern", () => {
  assertEquals(isClaudeAuthError("Error: invalid token"), true);
});

Deno.test("claude auth - detects 'invalid api key' phrasing", () => {
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

// ---------------------------------------------------------------------------
// Issue #45 — the matcher keys on the CLI's own phrasing, not issue prose
// ---------------------------------------------------------------------------

Deno.test("claude auth #45 - bare 'api key' in issue prose is NOT an auth error", () => {
  // The exact false positive that recorded VibeCoder#36 (a redaction issue) as
  // an authentication failure while its PR was open.
  assertEquals(
    isClaudeAuthError(
      "I redacted the bare OpenAI API key sk-... and the tests passed, 0 failed.",
    ),
    false,
  );
});

Deno.test("claude auth #45 - a non-adjacent invalid...token in prose is NOT an auth error", () => {
  assertEquals(
    isClaudeAuthError(
      "The contract rejects an invalid recipient for the token transfer",
    ),
    false,
  );
});

Deno.test("claude auth #45 - genuine CLI auth phrasings still match", () => {
  for (
    const s of [
      "Invalid API key · Please run /login",
      "API key not found",
      "Authentication failed",
      "OAuth token has expired",
      "Not logged in · Run `claude login`",
    ]
  ) {
    assertEquals(isClaudeAuthError(s), true, s);
  }
});

Deno.test("claude auth #45 - discussing tokens/keys without a CLI error phrase does not match", () => {
  for (
    const s of [
      "Add an api key rotation policy to the config",
      "The auth token should be stored in the keychain",
      "Document how to obtain an api key for the service",
    ]
  ) {
    assertEquals(isClaudeAuthError(s), false, s);
  }
});
