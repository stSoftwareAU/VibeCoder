/**
 * Tests for github_status.ts — GitHub user status management.
 *
 * Issue #905: Migrate github_status.sh to Deno TypeScript.
 * Covers: selectGhStatusEmoji, buildGhStatusMessage, setGhUserStatus,
 *         clearGhUserStatus, checkGhStatusAvailable.
 *
 * Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  buildGhStatusMessage,
  checkGhStatusAvailable,
  clearGhUserStatus,
  selectGhStatusEmoji,
  setGhUserStatus,
} from "../lib/github_status.ts";

// =============================================================================
// selectGhStatusEmoji — Emoji Selection
// =============================================================================

Deno.test("github_status - selectGhStatusEmoji returns hammer for working", () => {
  assertEquals(selectGhStatusEmoji("working"), ":hammer_and_wrench:");
});

Deno.test("github_status - selectGhStatusEmoji returns zzz for idle", () => {
  assertEquals(selectGhStatusEmoji("idle"), ":zzz:");
});

Deno.test("github_status - selectGhStatusEmoji returns check for success", () => {
  assertEquals(selectGhStatusEmoji("success"), ":white_check_mark:");
});

Deno.test("github_status - selectGhStatusEmoji returns thermometer for failure", () => {
  assertEquals(selectGhStatusEmoji("failure"), ":face_with_thermometer:");
});

Deno.test("github_status - selectGhStatusEmoji returns robot for unknown state", () => {
  assertEquals(selectGhStatusEmoji("unknown"), ":robot:");
});

// =============================================================================
// buildGhStatusMessage — Message Building
// =============================================================================

Deno.test("github_status - buildGhStatusMessage for working with repo and number", () => {
  const msg = buildGhStatusMessage("working", "owner/repo", "42", "Fix bug");
  assertEquals(msg, "Working on owner/repo#42: Fix bug");
});

Deno.test("github_status - buildGhStatusMessage for working without details", () => {
  const msg = buildGhStatusMessage("working");
  assertEquals(msg, "Working on something...");
});

Deno.test("github_status - buildGhStatusMessage for idle", () => {
  const msg = buildGhStatusMessage("idle");
  assertEquals(msg, "Idle - waiting for work");
});

Deno.test("github_status - buildGhStatusMessage for success with repo and number", () => {
  const msg = buildGhStatusMessage("success", "owner/repo", "42", "Fix bug");
  assertEquals(msg, "Completed owner/repo#42: Fix bug");
});

Deno.test("github_status - buildGhStatusMessage for success without details", () => {
  const msg = buildGhStatusMessage("success");
  assertEquals(msg, "Just completed some work!");
});

Deno.test("github_status - buildGhStatusMessage for failure with repo and number", () => {
  const msg = buildGhStatusMessage("failure", "owner/repo", "42", "Fix bug");
  assertEquals(msg, "Struggling with owner/repo#42: Fix bug");
});

Deno.test("github_status - buildGhStatusMessage for failure without details", () => {
  const msg = buildGhStatusMessage("failure");
  assertEquals(msg, "Hit a snag on recent work");
});

Deno.test("github_status - buildGhStatusMessage for unknown state", () => {
  const msg = buildGhStatusMessage("other");
  assertEquals(msg, "Vibe Coding");
});

Deno.test("github_status - buildGhStatusMessage truncates long messages to 80 chars", () => {
  const longTitle = "A".repeat(100);
  const msg = buildGhStatusMessage("working", "owner/repo", "42", longTitle);
  assertEquals(msg.length, 80);
  assertEquals(msg.endsWith("..."), true);
});

Deno.test("github_status - buildGhStatusMessage working without title", () => {
  const msg = buildGhStatusMessage("working", "owner/repo", "42");
  assertEquals(msg, "Working on owner/repo#42");
});

// =============================================================================
// setGhUserStatus — Status Update
// =============================================================================

Deno.test("github_status - setGhUserStatus does nothing when disabled", async () => {
  const result = await setGhUserStatus("working", {
    updateGhUserStatus: false,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, false);
    assertEquals(result.value.message, "GitHub status updates disabled");
  }
});

Deno.test("github_status - setGhUserStatus calls GraphQL when enabled", async () => {
  let calledQuery = "";
  let calledVars: Record<string, string> = {};

  const result = await setGhUserStatus(
    "working",
    {
      updateGhUserStatus: true,
      repo: "owner/repo",
      number: "42",
      title: "Fix bug",
    },
    async (query, variables) => {
      calledQuery = query;
      calledVars = variables;
    },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, true);
    assertEquals(result.value.succeeded, true);
    assertEquals(result.value.emoji, ":hammer_and_wrench:");
    assertEquals(result.value.statusText, "Working on owner/repo#42: Fix bug");
  }

  assertEquals(calledQuery.includes("changeUserStatus"), true);
  assertEquals(calledVars["emoji"], ":hammer_and_wrench:");
  assertEquals(calledVars["message"], "Working on owner/repo#42: Fix bug");
  assertEquals(calledVars["busy"], "true");
});

Deno.test("github_status - setGhUserStatus sets busy=false for non-working states", async () => {
  let calledVars: Record<string, string> = {};

  await setGhUserStatus(
    "idle",
    { updateGhUserStatus: true },
    async (_query, variables) => {
      calledVars = variables;
    },
  );

  assertEquals(calledVars["busy"], "false");
});

Deno.test("github_status - setGhUserStatus handles GraphQL failure gracefully", async () => {
  const result = await setGhUserStatus(
    "working",
    { updateGhUserStatus: true },
    async () => {
      throw new Error("GraphQL failed");
    },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, true);
    assertEquals(result.value.succeeded, false);
    assertEquals(
      result.value.message.includes("Failed to update"),
      true,
    );
  }
});

// =============================================================================
// clearGhUserStatus — Status Clear
// =============================================================================

Deno.test("github_status - clearGhUserStatus does nothing when disabled", async () => {
  const result = await clearGhUserStatus(false);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, false);
  }
});

Deno.test("github_status - clearGhUserStatus calls GraphQL when enabled", async () => {
  let called = false;

  const result = await clearGhUserStatus(true, async () => {
    called = true;
  });

  assertEquals(called, true);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, true);
    assertEquals(result.value.succeeded, true);
  }
});

Deno.test("github_status - clearGhUserStatus handles failure gracefully", async () => {
  const result = await clearGhUserStatus(true, async () => {
    throw new Error("failed");
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.attempted, true);
    assertEquals(result.value.succeeded, false);
  }
});

// =============================================================================
// checkGhStatusAvailable — Feature Availability
// =============================================================================

Deno.test("github_status - checkGhStatusAvailable returns false when disabled", async () => {
  const available = await checkGhStatusAvailable(false);
  assertEquals(available, false);
});

Deno.test("github_status - checkGhStatusAvailable returns true when gh auth has user scope", async () => {
  const available = await checkGhStatusAvailable(
    true,
    async () => ({
      code: 0,
      output: "Logged in, token scopes: 'repo', 'user', 'workflow'",
    }),
  );
  assertEquals(available, true);
});

Deno.test("github_status - checkGhStatusAvailable returns false when user scope missing", async () => {
  const available = await checkGhStatusAvailable(
    true,
    async () => ({
      code: 0,
      output: "Logged in, token scopes: 'repo', 'workflow'",
    }),
  );
  assertEquals(available, false);
});

Deno.test("github_status - checkGhStatusAvailable returns false when gh auth fails", async () => {
  const available = await checkGhStatusAvailable(
    true,
    async () => ({ code: 1, output: "not logged in" }),
  );
  assertEquals(available, false);
});

Deno.test("github_status - checkGhStatusAvailable returns false when command throws", async () => {
  const available = await checkGhStatusAvailable(
    true,
    async () => {
      throw new Error("command not found");
    },
  );
  assertEquals(available, false);
});
