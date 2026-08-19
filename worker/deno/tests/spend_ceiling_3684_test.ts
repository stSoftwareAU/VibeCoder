/**
 * Tests for the daily spend-ceiling production wiring (Issue #3684).
 *
 * Issue #3648 added the pure `checkDailySpendCeiling()` comparison and the
 * `checkSpendCeiling` hook in the run loop, but nothing ever resolved the
 * documented configuration or supplied the hook — so the documented ceiling
 * was inert in production. These tests cover the resolver and the factory
 * that closes that gap.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  createSpendCeilingCheck,
  CREDIT_LOG_DIR_ENV,
  resolveCreditLogDir,
  resolveSpendCeilingUsd,
  SPEND_CEILING_ENV,
  type SpendCeilingAuditEvent,
} from "../lib/spend_ceiling.ts";
import { logInvocation } from "../lib/credit_tracker.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a temp credit log holding a single invocation of a known model. */
async function withCreditLog(
  tokens: { inputTokens: number; outputTokens: number },
  fn: (logDir: string) => Promise<void>,
): Promise<void> {
  const logDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "issue",
      repo: "o/r",
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    });
    await fn(logDir);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// resolveSpendCeilingUsd
// ---------------------------------------------------------------------------

Deno.test("resolveSpendCeilingUsd - unset or blank means disabled", () => {
  assertEquals(resolveSpendCeilingUsd(undefined), 0);
  assertEquals(resolveSpendCeilingUsd(""), 0);
  assertEquals(resolveSpendCeilingUsd("   "), 0);
});

Deno.test("resolveSpendCeilingUsd - parses positive amounts", () => {
  assertEquals(resolveSpendCeilingUsd("50"), 50);
  assertEquals(resolveSpendCeilingUsd("12.5"), 12.5);
  assertEquals(resolveSpendCeilingUsd(" 7 "), 7);
  assertEquals(resolveSpendCeilingUsd("0"), 0);
});

Deno.test("resolveSpendCeilingUsd - a malformed value fails loudly", () => {
  for (const raw of ["abc", "50usd", "NaN", "Infinity", "1,000", "-1"]) {
    assertThrows(
      () => resolveSpendCeilingUsd(raw),
      Error,
      "VIBE_DAILY_SPEND_CEILING_USD",
      `expected ${raw} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// resolveCreditLogDir
// ---------------------------------------------------------------------------

Deno.test("resolveCreditLogDir - defaults to the worker work directory", () => {
  assertEquals(resolveCreditLogDir("/work", undefined), "/work");
  assertEquals(resolveCreditLogDir("/work", "  "), "/work");
});

Deno.test("resolveCreditLogDir - honours an explicit override", () => {
  assertEquals(resolveCreditLogDir("/work", "/var/credit"), "/var/credit");
  assertEquals(resolveCreditLogDir("/work", " /var/credit "), "/var/credit");
});

// ---------------------------------------------------------------------------
// createSpendCeilingCheck
// ---------------------------------------------------------------------------

Deno.test("createSpendCeilingCheck - a non-positive ceiling leaves the hook unwired", () => {
  const noop = () => {};
  assertEquals(
    createSpendCeilingCheck({ logDir: "/tmp", ceilingUsd: 0, logError: noop }),
    undefined,
  );
  assertEquals(
    createSpendCeilingCheck({ logDir: "/tmp", ceilingUsd: -5, logError: noop }),
    undefined,
  );
});

Deno.test("createSpendCeilingCheck - spend under the ceiling does not stop the cycle", async () => {
  await withCreditLog({ inputTokens: 1_000, outputTokens: 1_000 }, async (
    logDir,
  ) => {
    const errors: string[] = [];
    const events: SpendCeilingAuditEvent[] = [];
    const check = createSpendCeilingCheck({
      logDir,
      ceilingUsd: 1_000_000,
      logError: (m) => errors.push(m),
      recordEvent: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    assert(check);

    const result = await check();

    assertEquals(result.exceeded, false);
    assertEquals(errors, []);
    assertEquals(events, []);
  });
});

Deno.test("createSpendCeilingCheck - a breached ceiling stops loudly and audits", async () => {
  await withCreditLog(
    { inputTokens: 50_000_000, outputTokens: 10_000_000 },
    async (logDir) => {
      const events: SpendCeilingAuditEvent[] = [];
      const check = createSpendCeilingCheck({
        logDir,
        ceilingUsd: 1,
        logError: () => {},
        recordEvent: (e) => {
          events.push(e);
          return Promise.resolve();
        },
      });
      assert(check);

      const result = await check();

      assertEquals(result.exceeded, true);
      assertStringIncludes(result.message ?? "", "Daily spend ceiling reached");
      assertEquals(events.length, 1);
      assertEquals(events[0]?.ceilingUsd, 1);
      assert(events[0]!.spentUsd >= 1);
    },
  );
});

Deno.test("createSpendCeilingCheck - an audit-write failure is reported, not swallowed", async () => {
  await withCreditLog(
    { inputTokens: 50_000_000, outputTokens: 10_000_000 },
    async (logDir) => {
      const errors: string[] = [];
      const check = createSpendCeilingCheck({
        logDir,
        ceilingUsd: 1,
        logError: (m) => errors.push(m),
        recordEvent: () => Promise.reject(new Error("disk full")),
      });
      assert(check);

      const result = await check();

      // The stop signal still holds — the audit failure must not mask it.
      assertEquals(result.exceeded, true);
      assert(
        errors.some((m) =>
          m.includes("[SPEND_CEILING]") && m.includes("disk full")
        ),
        `expected a loud audit failure line, got: ${errors.join(" | ")}`,
      );
    },
  );
});

Deno.test("createSpendCeilingCheck - an unreadable log is reported, not silently under-budget", async () => {
  const logDir = await Deno.makeTempDir();
  try {
    // A directory where the day's log file is expected makes the read fail
    // with something other than "not found".
    const today = new Date().toISOString().slice(0, 10);
    await Deno.mkdir(`${logDir}/.credit_log_${today}.json`);

    const errors: string[] = [];
    const check = createSpendCeilingCheck({
      logDir,
      ceilingUsd: 10,
      logError: (m) => errors.push(m),
      recordEvent: () => Promise.resolve(),
    });
    assert(check);

    const result = await check();

    // A monitoring fault must not halt the fleet, but it must never be silent.
    assertEquals(result.exceeded, false);
    assert(
      errors.some((m) => m.includes("[SPEND_CEILING]")),
      `expected a loud check-failure line, got: ${errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
});

Deno.test("createSpendCeilingCheck - a missing log is genuine zero spend", async () => {
  const logDir = await Deno.makeTempDir();
  try {
    const errors: string[] = [];
    const check = createSpendCeilingCheck({
      logDir,
      ceilingUsd: 10,
      logError: (m) => errors.push(m),
      recordEvent: () => Promise.resolve(),
    });
    assert(check);

    assertEquals((await check()).exceeded, false);
    assertEquals(errors, []);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Production wiring — the gap Issue #3684 closes
// ---------------------------------------------------------------------------

/** Run `fn` with the ceiling env vars set, restoring them afterwards. */
async function withCeilingEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const productionOptions = {
  repoDir: "/tmp/test-repo",
  workDir: "/tmp/test-work",
  githubUser: "test-user",
  logger: createLogger({ write: () => {} }),
};

Deno.test("production deps - no ceiling configured leaves the hook unwired", async () => {
  await withCeilingEnv(
    { [SPEND_CEILING_ENV]: undefined, [CREDIT_LOG_DIR_ENV]: undefined },
    async () => {
      const { deps } = await createProductionRunCoreDeps(productionOptions);
      assertEquals(deps.checkSpendCeiling, undefined);
    },
  );
});

Deno.test("production deps - a configured ceiling wires a working check", async () => {
  await withCreditLog(
    { inputTokens: 50_000_000, outputTokens: 10_000_000 },
    async (logDir) => {
      await withCeilingEnv(
        { [SPEND_CEILING_ENV]: "1", [CREDIT_LOG_DIR_ENV]: logDir },
        async () => {
          const { deps } = await createProductionRunCoreDeps(productionOptions);
          assert(deps.checkSpendCeiling, "the hook must be wired");

          const result = await deps.checkSpendCeiling();

          assertEquals(result.exceeded, true);
          assertStringIncludes(
            result.message ?? "",
            "Daily spend ceiling reached",
          );
        },
      );
    },
  );
});

Deno.test("production deps - a malformed ceiling fails loudly at start-up", async () => {
  await withCeilingEnv(
    { [SPEND_CEILING_ENV]: "fifty-dollars", [CREDIT_LOG_DIR_ENV]: undefined },
    async () => {
      let thrown: Error | undefined;
      try {
        await createProductionRunCoreDeps(productionOptions);
      } catch (error) {
        thrown = error as Error;
      }
      assert(thrown, "a malformed ceiling must not be silently ignored");
      assertStringIncludes(thrown.message, SPEND_CEILING_ENV);
    },
  );
});
