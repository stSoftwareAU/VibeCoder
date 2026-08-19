/**
 * Tests for credit-summary command (Issue #1074).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { creditSummaryCommand } from "../commands/credit_summary.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { InvocationEntry } from "../lib/credit_tracker.ts";
import { LOG_FILE_PREFIX, LOG_FILE_SUFFIX } from "../lib/credit_tracker.ts";

const defaultConfig = buildDefaultWorkerConfig();

Deno.test("credit-summary - returns error when log-dir is missing", async () => {
  const result = await creditSummaryCommand.execute({}, defaultConfig);
  assertEquals(result.success, false);
  assert(result.message.includes("--log-dir"));
});

Deno.test("credit-summary - returns summary for valid log file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "sonnet",
        timestamp: new Date().toISOString(),
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "opus",
        timestamp: new Date().toISOString(),
      },
    ];
    await Deno.writeTextFile(
      logFile,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = await creditSummaryCommand.execute(
      { "log-dir": tmpDir },
      defaultConfig,
    );
    assertEquals(result.success, true);
    assert(result.message.includes("Total invocations: 2"));
    assert(result.message.includes("w1"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit-summary - returns error for missing log file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await creditSummaryCommand.execute(
      { "log-dir": tmpDir, date: "2020-01-01" },
      defaultConfig,
    );
    assertEquals(result.success, false);
    assert(result.message.includes("No credit log"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit-summary - displays fallback statistics", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-6",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-opus-4-6",
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-6",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-opus-4-6",
      },
      {
        workerName: "w2",
        phase: "planning",
        repo: "org/r2",
        model: "claude-haiku-4-5",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-sonnet-4-6",
      },
    ];
    await Deno.writeTextFile(
      logFile,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = await creditSummaryCommand.execute(
      { "log-dir": tmpDir },
      defaultConfig,
    );
    assertEquals(result.success, true);
    assert(result.message.includes("Model Fallbacks:"));
    assert(result.message.includes("claude-opus-4-6\u2192claude-sonnet-4-6"));
    assert(result.message.includes("claude-sonnet-4-6\u2192claude-haiku-4-5"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit-summary - no fallback section when no fallbacks occurred", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "sonnet",
        timestamp: new Date().toISOString(),
      },
    ];
    await Deno.writeTextFile(
      logFile,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = await creditSummaryCommand.execute(
      { "log-dir": tmpDir },
      defaultConfig,
    );
    assertEquals(result.success, true);
    assert(!result.message.includes("Model Fallbacks:"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit-summary - cleanup removes old logs", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Create an old log and today's log
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const entry = JSON.stringify({
      workerName: "w1",
      phase: "p",
      repo: "r",
      model: "m",
      timestamp: new Date().toISOString(),
    });
    await Deno.writeTextFile(
      `${tmpDir}/${LOG_FILE_PREFIX}${oldDateStr}${LOG_FILE_SUFFIX}`,
      entry + "\n",
    );
    await Deno.writeTextFile(
      `${tmpDir}/${LOG_FILE_PREFIX}${todayStr}${LOG_FILE_SUFFIX}`,
      entry + "\n",
    );

    const result = await creditSummaryCommand.execute(
      { "log-dir": tmpDir, cleanup: true },
      defaultConfig,
    );
    assertEquals(result.success, true);
    assert(result.message.includes("Cleaned up 1 old log file(s)"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
