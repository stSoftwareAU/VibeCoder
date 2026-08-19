/**
 * Tests for error handling behaviour in catch blocks (Issue #1169, #1306).
 *
 * Verifies that previously-silent catch blocks now handle errors gracefully
 * by returning appropriate values — tests observable outcomes, not logging.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { recoverExistingPr } from "../lib/git_push.ts";
import {
  captureFileTail,
  CRASH_NOTIFICATION_DEFAULTS,
  type CrashNotificationConfig,
  shouldRateLimitNotification,
} from "../lib/crash_notification.ts";
import { parseIssueDataJson } from "../lib/issue_data.ts";

// ---------------------------------------------------------------------------
// git_push.ts — recoverExistingPr handles PR body update failure gracefully
// ---------------------------------------------------------------------------

Deno.test("git push - recoverExistingPr returns ok when PR body update fails", async () => {
  const ghFail = async (_args: string[]): Promise<string> => {
    throw new Error("API rate limit exceeded");
  };

  const result = await recoverExistingPr(
    "org/repo",
    42,
    "https://github.com/org/repo/pull/99",
    "Updated body content",
    ghFail,
  );
  assertEquals(result.ok, true);
});

Deno.test("git push - recoverExistingPr returns ok when no body provided", async () => {
  const result = await recoverExistingPr(
    "org/repo",
    42,
    "https://github.com/org/repo/pull/99",
    undefined,
  );
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// crash_notification.ts — captureFileTail returns empty string for errors
// ---------------------------------------------------------------------------

Deno.test("crash notification - captureFileTail returns empty for unreadable file", async () => {
  const result = await captureFileTail(
    "/nonexistent/path/to/file.log",
    50,
    10000,
  );
  assertEquals(result, "");
});

Deno.test("crash notification - captureFileTail returns empty for empty path", async () => {
  const result = await captureFileTail("", 50, 10000);
  assertEquals(result, "");
});

// ---------------------------------------------------------------------------
// crash_notification.ts — shouldRateLimitNotification handles missing state
// ---------------------------------------------------------------------------

Deno.test("crash notification - shouldRateLimitNotification returns false on missing state dir", async () => {
  const config: CrashNotificationConfig = {
    workerName: "test-worker",
    cooldownSeconds: CRASH_NOTIFICATION_DEFAULTS.cooldownSeconds,
    logTailMaxBytes: CRASH_NOTIFICATION_DEFAULTS.logTailMaxBytes,
    stateDir: "/nonexistent/state/dir",
  };

  const result = await shouldRateLimitNotification(config);
  assertEquals(result, false);
});

// ---------------------------------------------------------------------------
// issue_data.ts — parseIssueDataJson handles invalid input gracefully
// ---------------------------------------------------------------------------

Deno.test("issue data - parseIssueDataJson returns empty defaults on invalid JSON", () => {
  const result = parseIssueDataJson("not valid json at all");
  assertEquals(result.body, "");
  assertEquals(result.labels.length, 0);
});

Deno.test("issue data - parseIssueDataJson parses valid JSON correctly", () => {
  const result = parseIssueDataJson(JSON.stringify({
    body: "test body",
    labels: [{ name: "bug" }],
    comments: [],
    state: "OPEN",
  }));
  assertEquals(result.body, "test body");
});

Deno.test("issue data - parseIssueDataJson returns empty defaults on empty input", () => {
  const result = parseIssueDataJson("");
  assertEquals(result.body, "");
});
