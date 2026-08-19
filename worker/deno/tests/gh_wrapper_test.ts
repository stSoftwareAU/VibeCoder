/**
 * Tests for gh_wrapper.ts — GitHub CLI wrapper with timeout and circuit breaker.
 *
 * Issue #905: Migrate gh_wrapper.sh to Deno TypeScript.
 * Covers: safeGhCommand, isGhTimeout, isRateLimitActive,
 *         tripRateLimitBreaker, resetRateLimitBreaker.
 *
 * Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type GhWrapperConfig,
  isGhTimeout,
  isRateLimitActive,
  RATE_LIMIT_EXIT_CODE,
  resetRateLimitBreaker,
  safeGhCommand,
  TIMEOUT_EXIT_CODE,
  tripRateLimitBreaker,
} from "../lib/gh_wrapper.ts";

// =============================================================================
// isGhTimeout — Exit Code Classification
// =============================================================================

Deno.test("gh_wrapper - isGhTimeout returns true for exit code 124", () => {
  assertEquals(isGhTimeout(124), true);
});

Deno.test("gh_wrapper - isGhTimeout returns false for exit code 0", () => {
  assertEquals(isGhTimeout(0), false);
});

Deno.test("gh_wrapper - isGhTimeout returns false for exit code 1", () => {
  assertEquals(isGhTimeout(1), false);
});

Deno.test("gh_wrapper - isGhTimeout returns false for exit code 223", () => {
  assertEquals(isGhTimeout(223), false);
});

// =============================================================================
// safeGhCommand — Basic Functionality (with mock command runner)
// =============================================================================

Deno.test("gh_wrapper - safeGhCommand passes through stdout on success", async () => {
  const result = await safeGhCommand(
    ["issue", "list", "--repo", "test/repo"],
    {},
    async () => ({ code: 0, stdout: "mock-output\n", stderr: "" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.stdout, "mock-output\n");
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.rateLimited, false);
    assertEquals(result.value.circuitBroken, false);
  }
});

Deno.test("gh_wrapper - safeGhCommand returns non-zero exit code on failure", async () => {
  const result = await safeGhCommand(
    ["issue", "list"],
    {},
    async () => ({ code: 1, stdout: "", stderr: "HTTP 404" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, 1);
  }
});

// =============================================================================
// safeGhCommand — Timeout Behaviour
// =============================================================================

Deno.test("gh_wrapper - safeGhCommand returns exit code 124 on timeout", async () => {
  const result = await safeGhCommand(
    ["issue", "list"],
    { ghCommandTimeout: 1 },
    async () => ({ code: TIMEOUT_EXIT_CODE, stdout: "", stderr: "" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
    assertEquals(result.value.timedOut, true);
  }
});

Deno.test("gh_wrapper - safeGhCommand handles AbortError as timeout", async () => {
  const result = await safeGhCommand(
    ["issue", "list"],
    { ghCommandTimeout: 1 },
    async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
    assertEquals(result.value.timedOut, true);
  }
});

// =============================================================================
// safeGhCommand — Timeout Configuration
// =============================================================================

Deno.test("gh_wrapper - safeGhCommand passes timeout value to runner", async () => {
  let receivedTimeout = 0;

  await safeGhCommand(
    ["issue", "list"],
    { ghCommandTimeout: 45 },
    async (_args, timeoutMs) => {
      receivedTimeout = timeoutMs;
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  assertEquals(receivedTimeout, 45000); // 45 seconds in ms
});

Deno.test("gh_wrapper - safeGhCommand uses clone timeout for repo clone", async () => {
  let receivedTimeout = 0;

  await safeGhCommand(
    ["repo", "clone", "owner/repo"],
    { ghCloneTimeout: 900 },
    async (_args, timeoutMs) => {
      receivedTimeout = timeoutMs;
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  assertEquals(receivedTimeout, 900000); // 900 seconds in ms
});

Deno.test("gh_wrapper - safeGhCommand defaults to 60 seconds", async () => {
  let receivedTimeout = 0;

  await safeGhCommand(
    ["issue", "list"],
    {},
    async (_args, timeoutMs) => {
      receivedTimeout = timeoutMs;
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  assertEquals(receivedTimeout, 60000); // 60 seconds in ms
});

// =============================================================================
// Rate Limit Circuit Breaker
// =============================================================================

Deno.test("gh_wrapper - safeGhCommand trips circuit breaker on rate limit", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    const result = await safeGhCommand(
      ["issue", "list"],
      config,
      async () => ({
        code: RATE_LIMIT_EXIT_CODE,
        stdout: "",
        stderr: "rate limit exceeded",
      }),
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.exitCode, RATE_LIMIT_EXIT_CODE);
      assertEquals(result.value.rateLimited, true);
    }

    // Verify the flag file was created
    const active = await isRateLimitActive(config);
    assertEquals(active, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("gh_wrapper - safeGhCommand short-circuits when circuit breaker active", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = {
    rateLimitFlagDir: tmpDir,
    rateLimitCooldown: 300,
  };
  let ghCalled = false;

  try {
    // Trip the breaker
    await tripRateLimitBreaker(config);

    const result = await safeGhCommand(
      ["issue", "list"],
      config,
      async () => {
        ghCalled = true;
        return { code: 0, stdout: "should-not-reach", stderr: "" };
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.exitCode, RATE_LIMIT_EXIT_CODE);
      assertEquals(result.value.circuitBroken, true);
      assertEquals(result.value.stdout, "");
    }
    assertEquals(ghCalled, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("gh_wrapper - resetRateLimitBreaker clears the flag file", async () => {
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

Deno.test("gh_wrapper - safeGhCommand works normally after circuit breaker reset", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = { rateLimitFlagDir: tmpDir };

  try {
    // Trip and reset
    await tripRateLimitBreaker(config);
    await resetRateLimitBreaker(config);

    const result = await safeGhCommand(
      ["issue", "list"],
      config,
      async () => ({ code: 0, stdout: "mock-output", stderr: "" }),
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.stdout, "mock-output");
      assertEquals(result.value.exitCode, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("gh_wrapper - circuit breaker auto-resets after cooldown expires", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = {
    rateLimitFlagDir: tmpDir,
    rateLimitCooldown: 5,
  };

  try {
    // Write a backdated timestamp to simulate expired cooldown
    const flagPath = `${tmpDir}/.gh_rate_limit_active`;
    const oldTime = Math.floor(Date.now() / 1000) - 10;
    await Deno.writeTextFile(flagPath, String(oldTime));

    // Should not be active since cooldown has expired
    const active = await isRateLimitActive(config);
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("gh_wrapper - circuit breaker remains active before cooldown expires", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: GhWrapperConfig = {
    rateLimitFlagDir: tmpDir,
    rateLimitCooldown: 300,
  };

  try {
    await tripRateLimitBreaker(config);
    const active = await isRateLimitActive(config);
    assertEquals(active, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Constants
// =============================================================================

Deno.test("gh_wrapper - RATE_LIMIT_EXIT_CODE is 223", () => {
  assertEquals(RATE_LIMIT_EXIT_CODE, 223);
});

Deno.test("gh_wrapper - TIMEOUT_EXIT_CODE is 124", () => {
  assertEquals(TIMEOUT_EXIT_CODE, 124);
});
