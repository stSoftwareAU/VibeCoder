/**
 * Tests for deno_bridge.sh business logic migration (Issue #1123).
 *
 * Covers the new Deno command operations that replace embedded shell logic:
 *   - gh-wrapper: is-rate-limit-active, trip-rate-limit operations
 *   - branch-cleanup: check-branch-has-open-pr operation
 *   - assess-clarity: check-too-complex operation
 *   - gh_auth: isGhAuthError pattern matching
 *   - github_status: selectGhStatusEmoji, buildGhStatusMessage
 *   - gh_wrapper: circuit breaker state transitions and rate limit timing
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type GhWrapperConfig,
  isRateLimitActive,
  resetRateLimitBreaker,
  tripRateLimitBreaker,
} from "../lib/gh_wrapper.ts";
import { findOpenPrNumber } from "../lib/branch_cleanup.ts";
import { isGhAuthError } from "../lib/gh_auth.ts";
import {
  buildGhStatusMessage,
  selectGhStatusEmoji,
} from "../lib/github_status.ts";

// =============================================================================
// Rate Limit Circuit Breaker — State Transitions (Issue #1123)
// =============================================================================

Deno.test("deno_bridge migration - rate limit breaker starts inactive", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    const active = await isRateLimitActive(config);
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - trip activates the breaker", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    const fresh = await tripRateLimitBreaker(config);
    assertEquals(fresh, true);

    const active = await isRateLimitActive(config);
    assertEquals(active, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - second trip returns not fresh", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    await tripRateLimitBreaker(config);
    const fresh = await tripRateLimitBreaker(config);
    assertEquals(fresh, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - reset deactivates the breaker", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    await tripRateLimitBreaker(config);
    assertEquals(await isRateLimitActive(config), true);

    await resetRateLimitBreaker(config);
    assertEquals(await isRateLimitActive(config), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - breaker auto-resets after cooldown", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = {
    rateLimitFlagDir: tmpDir,
    rateLimitCooldown: 1, // 1 second cooldown
  };

  try {
    // Write a backdated timestamp (10 seconds ago)
    const flagPath = `${tmpDir}/.gh_rate_limit_active`;
    const oldTime = Math.floor(Date.now() / 1000) - 10;
    await Deno.writeTextFile(flagPath, String(oldTime));

    // Should auto-reset since cooldown (1s) has elapsed
    const active = await isRateLimitActive(config);
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - breaker stays active within cooldown", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = {
    rateLimitFlagDir: tmpDir,
    rateLimitCooldown: 600, // 10 minutes
  };

  try {
    await tripRateLimitBreaker(config);
    const active = await isRateLimitActive(config);
    assertEquals(active, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deno_bridge migration - invalid flag file content treated as inactive", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    const flagPath = `${tmpDir}/.gh_rate_limit_active`;
    await Deno.writeTextFile(flagPath, "not-a-number");

    const active = await isRateLimitActive(config);
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Branch Cleanup — Open PR Check (Issue #1123)
// =============================================================================

Deno.test("deno_bridge migration - findOpenPrNumber returns PR number when found", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args.includes("pr") && args.includes("list")) {
      return "42";
    }
    return "";
  };

  const result = await findOpenPrNumber("owner/repo", "feature-branch", mockGh);
  assertEquals(result, "42");
});

Deno.test("deno_bridge migration - findOpenPrNumber returns null when no PR", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return "";
  };

  const result = await findOpenPrNumber("owner/repo", "feature-branch", mockGh);
  assertEquals(result, null);
});

Deno.test("deno_bridge migration - findOpenPrNumber returns null on error", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await findOpenPrNumber("owner/repo", "feature-branch", mockGh);
  assertEquals(result, null);
});

// =============================================================================
// Auth Error Detection — Pattern Matching (Issue #1123)
// =============================================================================

Deno.test("deno_bridge migration - isGhAuthError detects 401 in mixed output", () => {
  assertEquals(isGhAuthError("HTTP 401: Unauthorized for url"), true);
});

Deno.test("deno_bridge migration - isGhAuthError detects authentication case-insensitively", () => {
  assertEquals(isGhAuthError("AUTHENTICATION required"), true);
  assertEquals(isGhAuthError("Authentication Failed"), true);
});

Deno.test("deno_bridge migration - isGhAuthError detects credential keyword", () => {
  assertEquals(isGhAuthError("bad credential provided"), true);
});

Deno.test("deno_bridge migration - isGhAuthError rejects unrelated errors", () => {
  assertEquals(isGhAuthError("HTTP 500 Internal Server Error"), false);
  assertEquals(isGhAuthError("network timeout"), false);
  assertEquals(isGhAuthError("repository not found"), false);
});

Deno.test("deno_bridge migration - isGhAuthError handles empty and blank input", () => {
  assertEquals(isGhAuthError(""), false);
  assertEquals(isGhAuthError("   "), false);
});

// =============================================================================
// GitHub Status — Emoji Selection (Issue #1123)
// =============================================================================

Deno.test("deno_bridge migration - selectGhStatusEmoji maps all known states", () => {
  assertEquals(selectGhStatusEmoji("working"), ":hammer_and_wrench:");
  assertEquals(selectGhStatusEmoji("idle"), ":zzz:");
  assertEquals(selectGhStatusEmoji("success"), ":white_check_mark:");
  assertEquals(selectGhStatusEmoji("failure"), ":face_with_thermometer:");
});

Deno.test("deno_bridge migration - selectGhStatusEmoji defaults to robot for unknown", () => {
  assertEquals(selectGhStatusEmoji("unknown_state"), ":robot:");
  assertEquals(selectGhStatusEmoji(""), ":robot:");
});

// =============================================================================
// GitHub Status — Message Formatting (Issue #1123)
// =============================================================================

Deno.test("deno_bridge migration - buildGhStatusMessage for working with full context", () => {
  const msg = buildGhStatusMessage("working", "org/repo", "123", "Fix the bug");
  assertEquals(msg, "Working on org/repo#123: Fix the bug");
});

Deno.test("deno_bridge migration - buildGhStatusMessage for working without context", () => {
  assertEquals(buildGhStatusMessage("working"), "Working on something...");
});

Deno.test("deno_bridge migration - buildGhStatusMessage for idle ignores context", () => {
  assertEquals(
    buildGhStatusMessage("idle", "repo", "1"),
    "Idle - waiting for work",
  );
});

Deno.test("deno_bridge migration - buildGhStatusMessage for success with context", () => {
  const msg = buildGhStatusMessage("success", "org/repo", "99", "Add feature");
  assertEquals(msg, "Completed org/repo#99: Add feature");
});

Deno.test("deno_bridge migration - buildGhStatusMessage for failure with context", () => {
  const msg = buildGhStatusMessage("failure", "org/repo", "77");
  assertEquals(msg, "Struggling with org/repo#77");
});

Deno.test("deno_bridge migration - buildGhStatusMessage truncates to 80 characters", () => {
  const longTitle =
    "A very long issue title that exceeds the maximum allowed length for status messages which is eighty";
  const msg = buildGhStatusMessage("working", "owner/repo", "42", longTitle);
  assertEquals(msg.length, 80);
  assertEquals(msg.endsWith("..."), true);
});

Deno.test("deno_bridge migration - buildGhStatusMessage preserves short messages", () => {
  const msg = buildGhStatusMessage("working", "o/r", "1", "Short");
  assertEquals(msg, "Working on o/r#1: Short");
  assertEquals(msg.length < 80, true);
});

Deno.test("deno_bridge migration - buildGhStatusMessage defaults to Vibe Coding for unknown state", () => {
  assertEquals(buildGhStatusMessage("custom"), "Vibe Coding");
});
