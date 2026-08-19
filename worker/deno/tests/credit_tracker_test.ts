/**
 * Tests for credit_tracker.ts — per-worker credit usage tracking (Issue #1074).
 *
 * Covers: logging invocations, summarisation, log rotation/cleanup.
 * Uses Australian English throughout.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  cleanupOldLogs,
  DEFAULT_RETENTION_DAYS,
  formatSummary,
  getDailySummary,
  type InvocationEntry,
  LOG_FILE_PREFIX,
  LOG_FILE_SUFFIX,
  logInvocation,
} from "../lib/credit_tracker.ts";

// =============================================================================
// logInvocation tests
// =============================================================================

Deno.test("credit_tracker - logInvocation writes entry to daily log file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "planning",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
    });

    // Find the log file
    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1);

    // Read and verify the entry
    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const entries: InvocationEntry[] = JSON.parse(
      `[${content.trim().split("\n").join(",")}]`,
    );
    assertEquals(entries.length, 1);
    const first = entries[0]!;
    assertEquals(first.workerName, "worker-1");
    assertEquals(first.phase, "planning");
    assertEquals(first.repo, "org/repo1");
    assertEquals(first.model, "claude-sonnet-4-7");
    assert(typeof first.timestamp === "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - logInvocation appends multiple entries", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "planning",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
    });
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-2",
      phase: "implementation",
      repo: "org/repo2",
      model: "claude-opus-4-7",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - logInvocation creates log directory if missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  const nestedDir = `${tmpDir}/nested/logs`;
  try {
    await logInvocation({
      logDir: nestedDir,
      workerName: "worker-1",
      phase: "health",
      repo: "org/repo1",
      model: "claude-haiku-4-7",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(nestedDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// getDailySummary tests
// =============================================================================

Deno.test("credit_tracker - getDailySummary returns correct totals by worker", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "worker-1",
        phase: "planning",
        repo: "org/r1",
        model: "sonnet",
        timestamp: new Date().toISOString(),
      },
      {
        workerName: "worker-1",
        phase: "implementation",
        repo: "org/r1",
        model: "opus",
        timestamp: new Date().toISOString(),
      },
      {
        workerName: "worker-2",
        phase: "planning",
        repo: "org/r2",
        model: "sonnet",
        timestamp: new Date().toISOString(),
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;

    assertEquals(summary.date, today);
    assertEquals(summary.totalInvocations, 3);
    assertEquals(summary.byWorker["worker-1"], 2);
    assertEquals(summary.byWorker["worker-2"], 1);
    assertEquals(summary.byPhase["planning"], 2);
    assertEquals(summary.byPhase["implementation"], 1);
    assertEquals(summary.byModel["sonnet"], 2);
    assertEquals(summary.byModel["opus"], 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary returns error for missing log file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await getDailySummary({
      logDir: tmpDir,
      date: "2025-01-01",
    });
    assert(!result.ok);
    assert(result.error.message.includes("No credit log"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary defaults to today", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entry: InvocationEntry = {
      workerName: "w1",
      phase: "health",
      repo: "org/r",
      model: "haiku",
      timestamp: new Date().toISOString(),
    };
    await Deno.writeTextFile(logFile, JSON.stringify(entry) + "\n");

    const result = await getDailySummary({ logDir: tmpDir });
    assert(result.ok);
    assertEquals(result.value.totalInvocations, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary skips malformed lines gracefully", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const validEntry: InvocationEntry = {
      workerName: "w1",
      phase: "planning",
      repo: "org/r",
      model: "sonnet",
      timestamp: new Date().toISOString(),
    };
    const content = JSON.stringify(validEntry) + "\n" + "not-valid-json\n" +
      "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    assertEquals(result.value.totalInvocations, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// cleanupOldLogs tests
// =============================================================================

Deno.test("credit_tracker - cleanupOldLogs removes logs older than retention", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Create an old log (10 days ago) and a recent log (today)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    await Deno.writeTextFile(
      `${tmpDir}/${LOG_FILE_PREFIX}${oldDateStr}${LOG_FILE_SUFFIX}`,
      '{"workerName":"w1","phase":"p","repo":"r","model":"m","timestamp":"t"}\n',
    );
    await Deno.writeTextFile(
      `${tmpDir}/${LOG_FILE_PREFIX}${todayStr}${LOG_FILE_SUFFIX}`,
      '{"workerName":"w1","phase":"p","repo":"r","model":"m","timestamp":"t"}\n',
    );

    const result = await cleanupOldLogs({ logDir: tmpDir, retentionDays: 7 });
    assert(result.ok);
    assertEquals(result.value, 1); // 1 file removed

    // Verify today's file still exists
    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      files.push(entry.name);
    }
    assertEquals(files.length, 1);
    assert(files[0]!.includes(todayStr));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - cleanupOldLogs keeps recent logs", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    await Deno.writeTextFile(
      `${tmpDir}/${LOG_FILE_PREFIX}${yesterdayStr}${LOG_FILE_SUFFIX}`,
      '{"workerName":"w1","phase":"p","repo":"r","model":"m","timestamp":"t"}\n',
    );

    const result = await cleanupOldLogs({ logDir: tmpDir, retentionDays: 7 });
    assert(result.ok);
    assertEquals(result.value, 0); // Nothing removed
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - cleanupOldLogs ignores non-credit-log files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Create a non-credit-log file with an old-looking name
    await Deno.writeTextFile(`${tmpDir}/other-file.json`, "{}");
    await Deno.writeTextFile(`${tmpDir}/worker.log`, "log data");

    const result = await cleanupOldLogs({ logDir: tmpDir, retentionDays: 7 });
    assert(result.ok);
    assertEquals(result.value, 0);

    // Both files should still exist
    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      files.push(entry.name);
    }
    assertEquals(files.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - cleanupOldLogs handles missing directory", async () => {
  const result = await cleanupOldLogs({
    logDir: "/tmp/nonexistent-credit-log-dir-1074",
    retentionDays: 7,
  });
  assert(result.ok);
  assertEquals(result.value, 0);
});

// =============================================================================
// Constants tests
// =============================================================================

Deno.test("credit_tracker - DEFAULT_RETENTION_DAYS is 7", () => {
  assertEquals(DEFAULT_RETENTION_DAYS, 7);
});

Deno.test("credit_tracker - LOG_FILE_PREFIX and SUFFIX form valid pattern", () => {
  assertEquals(LOG_FILE_PREFIX, ".credit_log_");
  assertEquals(LOG_FILE_SUFFIX, ".json");
});

// =============================================================================
// Model fallback tracking tests (Issue #1114)
// =============================================================================

Deno.test("credit_tracker - logInvocation records fallbackFrom when provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
      fallbackFrom: "claude-opus-4-7",
    });

    // Find and read the log file
    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const entries: InvocationEntry[] = JSON.parse(
      `[${content.trim().split("\n").join(",")}]`,
    );
    assertEquals(entries.length, 1);
    assertEquals(entries[0]!.fallbackFrom, "claude-opus-4-7");
    assertEquals(entries[0]!.model, "claude-sonnet-4-7");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - logInvocation omits fallbackFrom when not provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "planning",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed = JSON.parse(content.trim());
    assertEquals(parsed.fallbackFrom, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary includes fallback counts", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-opus-4-7",
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-opus-4-7",
      },
      {
        workerName: "w2",
        phase: "planning",
        repo: "org/r2",
        model: "claude-haiku-4-7",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-sonnet-4-7",
      },
      {
        workerName: "w2",
        phase: "planning",
        repo: "org/r2",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;

    assertEquals(summary.totalInvocations, 4);
    // Check fallback counts
    assertEquals(
      summary.byFallback["claude-opus-4-7\u2192claude-sonnet-4-7"],
      2,
    );
    assertEquals(
      summary.byFallback["claude-sonnet-4-7\u2192claude-haiku-4-7"],
      1,
    );
    // Non-fallback entry should not appear in byFallback
    assertEquals(Object.keys(summary.byFallback).length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary returns empty byFallback when no fallbacks", async () => {
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
        workerName: "w2",
        phase: "implementation",
        repo: "org/r2",
        model: "opus",
        timestamp: new Date().toISOString(),
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    assertEquals(Object.keys(result.value.byFallback).length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - formatSummary includes fallback statistics", () => {
  const summary = {
    date: "2026-04-10",
    totalInvocations: 5,
    byWorker: { "worker-1": 5 },
    byPhase: { "implementation": 5 },
    byModel: { "claude-sonnet-4-7": 3, "claude-haiku-4-7": 2 },
    byFallback: {
      "claude-opus-4-7\u2192claude-sonnet-4-7": 3,
      "claude-sonnet-4-7\u2192claude-haiku-4-7": 2,
    },
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    tokensByPhase: {},
    tokensByModel: {},
    estimatedCostByModel: {},
    totalEstimatedCost: 0,
    // Issue #3870 fields — a hand-built summary is a clean day: no unpriced
    // model ids and no torn log lines.
    unpricedModels: [],
    unpricedTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const output = formatSummary(summary);
  assert(output.includes("Model Fallbacks:"));
  assert(output.includes("claude-opus-4-7\u2192claude-sonnet-4-7"));
  assert(output.includes("3"));
  assert(output.includes("claude-sonnet-4-7\u2192claude-haiku-4-7"));
  assert(output.includes("2"));
});

Deno.test("credit_tracker - formatSummary omits fallback section when empty", () => {
  const summary = {
    date: "2026-04-10",
    totalInvocations: 2,
    byWorker: { "worker-1": 2 },
    byPhase: { "planning": 2 },
    byModel: { "sonnet": 2 },
    byFallback: {},
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    tokensByPhase: {},
    tokensByModel: {},
    estimatedCostByModel: {},
    totalEstimatedCost: 0,
    // Issue #3870 fields — a hand-built summary is a clean day: no unpriced
    // model ids and no torn log lines.
    unpricedModels: [],
    unpricedTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const output = formatSummary(summary);
  assert(!output.includes("Model Fallbacks:"));
});

// =============================================================================
// Token usage tracking tests (Issue #1260)
// =============================================================================

Deno.test("credit_tracker - logInvocation records token usage when provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
      tokenUsage: {
        inputTokens: 5000,
        outputTokens: 1200,
        cacheCreationTokens: 300,
        cacheReadTokens: 2000,
      },
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed: InvocationEntry = JSON.parse(content.trim());
    assertEquals(parsed.inputTokens, 5000);
    assertEquals(parsed.outputTokens, 1200);
    assertEquals(parsed.cacheCreationTokens, 300);
    assertEquals(parsed.cacheReadTokens, 2000);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - logInvocation omits token fields when not provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "planning",
      repo: "org/repo1",
      model: "claude-sonnet-4-7",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed = JSON.parse(content.trim());
    assertEquals(parsed.inputTokens, undefined);
    assertEquals(parsed.outputTokens, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary aggregates token usage by phase", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 500,
      },
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 2000,
        outputTokens: 300,
        cacheCreationTokens: 0,
        cacheReadTokens: 1000,
      },
      {
        workerName: "w2",
        phase: "implementation",
        repo: "org/r2",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 5000,
        outputTokens: 1000,
        cacheCreationTokens: 100,
        cacheReadTokens: 3000,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;

    // Total tokens
    assertEquals(summary.totalTokens.inputTokens, 8000);
    assertEquals(summary.totalTokens.outputTokens, 1500);
    assertEquals(summary.totalTokens.cacheCreationTokens, 150);
    assertEquals(summary.totalTokens.cacheReadTokens, 4500);

    // By phase
    assertEquals(summary.tokensByPhase["planning"]!.inputTokens, 3000);
    assertEquals(summary.tokensByPhase["planning"]!.outputTokens, 500);
    assertEquals(summary.tokensByPhase["implementation"]!.inputTokens, 5000);
    assertEquals(summary.tokensByPhase["implementation"]!.outputTokens, 1000);

    // By model
    assertEquals(summary.tokensByModel["claude-sonnet-4-7"]!.inputTokens, 3000);
    assertEquals(summary.tokensByModel["claude-opus-4-7"]!.inputTokens, 5000);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary computes estimated costs", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;

    // Sonnet pricing: $3/Minput, $15/Moutput
    const sonnetCost = summary.estimatedCostByModel["claude-sonnet-4-7"];
    assert(sonnetCost !== undefined);
    assertAlmostEquals(sonnetCost.inputCost, 3.0, 0.001);
    assertAlmostEquals(sonnetCost.outputCost, 1.5, 0.001);
    assertAlmostEquals(summary.totalEstimatedCost, 4.5, 0.001);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary handles entries without token data", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    // Legacy entries without token fields
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "sonnet",
        timestamp: new Date().toISOString(),
      },
      {
        workerName: "w2",
        phase: "implementation",
        repo: "org/r2",
        model: "opus",
        timestamp: new Date().toISOString(),
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    assertEquals(result.value.totalTokens.inputTokens, 0);
    assertEquals(result.value.totalTokens.outputTokens, 0);
    assertEquals(result.value.totalInvocations, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - formatSummary includes token usage section", () => {
  const summary = {
    date: "2026-04-13",
    totalInvocations: 3,
    byWorker: { "worker-1": 3 },
    byPhase: { "planning": 2, "implementation": 1 },
    byModel: { "claude-sonnet-4-7": 2, "claude-opus-4-7": 1 },
    byFallback: {},
    totalTokens: {
      inputTokens: 8000,
      outputTokens: 1500,
      cacheCreationTokens: 150,
      cacheReadTokens: 4500,
    },
    tokensByPhase: {
      "planning": {
        inputTokens: 3000,
        outputTokens: 500,
        cacheCreationTokens: 50,
        cacheReadTokens: 1500,
      },
      "implementation": {
        inputTokens: 5000,
        outputTokens: 1000,
        cacheCreationTokens: 100,
        cacheReadTokens: 3000,
      },
    },
    tokensByModel: {
      "claude-sonnet-4-7": {
        inputTokens: 3000,
        outputTokens: 500,
        cacheCreationTokens: 50,
        cacheReadTokens: 1500,
      },
      "claude-opus-4-7": {
        inputTokens: 5000,
        outputTokens: 1000,
        cacheCreationTokens: 100,
        cacheReadTokens: 3000,
      },
    },
    estimatedCostByModel: {
      "claude-sonnet-4-7": {
        inputCost: 0.009,
        outputCost: 0.0075,
        cacheWriteCost: 0.0002,
        cacheReadCost: 0.00045,
        totalCost: 0.01715,
      },
      "claude-opus-4-7": {
        inputCost: 0.075,
        outputCost: 0.075,
        cacheWriteCost: 0.001875,
        cacheReadCost: 0.0045,
        totalCost: 0.15638,
      },
    },
    totalEstimatedCost: 0.17353,
    // Issue #3870 fields — a hand-built summary is a clean day: no unpriced
    // model ids and no torn log lines.
    unpricedModels: [],
    unpricedTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const output = formatSummary(summary);
  assert(output.includes("Token Usage:"));
  assert(output.includes("Input tokens:"));
  assert(output.includes("8,000"));
  assert(output.includes("Tokens by Phase:"));
  assert(output.includes("planning"));
  assert(output.includes("Tokens by Model:"));
  assert(output.includes("Estimated Cost (USD):"));
  assert(output.includes("TOTAL"));
});

Deno.test("credit_tracker - formatSummary omits token section when no tokens", () => {
  const summary = {
    date: "2026-04-13",
    totalInvocations: 1,
    byWorker: { "worker-1": 1 },
    byPhase: { "planning": 1 },
    byModel: { "sonnet": 1 },
    byFallback: {},
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    tokensByPhase: {},
    tokensByModel: {},
    estimatedCostByModel: {},
    totalEstimatedCost: 0,
    // Issue #3870 fields — a hand-built summary is a clean day: no unpriced
    // model ids and no torn log lines.
    unpricedModels: [],
    unpricedTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const output = formatSummary(summary);
  assert(!output.includes("Token Usage:"));
  assert(!output.includes("Estimated Cost"));
});

// =============================================================================
// Per-phase cost + effort accounting tests (Issue #2392)
// =============================================================================

Deno.test("credit_tracker - logInvocation records effort when provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "implementation",
      repo: "org/repo1",
      model: "claude-opus-4-7",
      effort: "high",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed: InvocationEntry = JSON.parse(content.trim());
    assertEquals(parsed.effort, "high");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - logInvocation omits effort when not provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await logInvocation({
      logDir: tmpDir,
      workerName: "worker-1",
      phase: "planning",
      repo: "org/repo1",
      model: "claude-opus-4-7",
    });

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (
        entry.name.startsWith(LOG_FILE_PREFIX) &&
        entry.name.endsWith(LOG_FILE_SUFFIX)
      ) {
        files.push(entry.name);
      }
    }
    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed = JSON.parse(content.trim());
    assertEquals(parsed.effort, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary computes per-phase cost against MODEL_PRICING", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    // Single Opus 4.7 invocation; modern pricing is $5/Min, $25/Mout,
    // $6.25/Mcache-write, $0.50/Mcache-read.
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        effort: "high",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 200_000,
        cacheReadTokens: 400_000,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const phaseCost = result.value.estimatedCostByPhase!["implementation"];
    assert(phaseCost !== undefined);
    assertAlmostEquals(phaseCost.inputCost, 5.0, 0.0001);
    assertAlmostEquals(phaseCost.outputCost, 2.5, 0.0001);
    assertAlmostEquals(phaseCost.cacheWriteCost, 1.25, 0.0001);
    assertAlmostEquals(phaseCost.cacheReadCost, 0.2, 0.0001);
    assertAlmostEquals(phaseCost.totalCost, 8.95, 0.0001);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - per-phase cost blends across models on fallback", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    // One phase that ran Opus then fell back to Sonnet. Opus output 1M = $25;
    // Sonnet output 1M = $15. Blended phase cost = $40.
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        fallbackFrom: "claude-opus-4-7",
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;
    assertAlmostEquals(
      summary.estimatedCostByPhase!["implementation"]!.totalCost,
      40.0,
      0.0001,
    );
    // Per-phase total must equal the overall total (no double counting).
    assertAlmostEquals(
      summary.estimatedCostByPhase!["implementation"]!.totalCost,
      summary.totalEstimatedCost,
      0.0001,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - per-phase cost sums to total across phases", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const summary = result.value;
    const phaseSum = Object.values(summary.estimatedCostByPhase!)
      .reduce((acc, c) => acc + c.totalCost, 0);
    assertAlmostEquals(phaseSum, summary.totalEstimatedCost, 0.0001);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - cache read/write tokens are priced per-phase", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    // Sonnet cache rates: $3.75/Mwrite, $0.30/Mread. No input/output tokens.
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const phaseCost = result.value.estimatedCostByPhase!["implementation"]!;
    assertAlmostEquals(phaseCost.cacheWriteCost, 3.75, 0.0001);
    assertAlmostEquals(phaseCost.cacheReadCost, 0.30, 0.0001);
    assertAlmostEquals(phaseCost.totalCost, 4.05, 0.0001);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - getDailySummary records distinct model+effort per phase", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${tmpDir}/${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`;
    const entries: InvocationEntry[] = [
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        effort: "high",
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
        effort: "high",
      },
      {
        workerName: "w1",
        phase: "implementation",
        repo: "org/r1",
        model: "claude-sonnet-4-7",
        timestamp: new Date().toISOString(),
        effort: "medium",
      },
      {
        workerName: "w1",
        phase: "planning",
        repo: "org/r1",
        model: "claude-opus-4-7",
        timestamp: new Date().toISOString(),
      },
    ];
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(logFile, content);

    const result = await getDailySummary({ logDir: tmpDir, date: today });
    assert(result.ok);
    const byPhase = result.value.modelEffortByPhase!;
    // Implementation ran two distinct model+effort combos (duplicate suppressed).
    assertEquals(byPhase["implementation"]!.length, 2);
    assert(byPhase["implementation"]!.includes("claude-opus-4-7 (high)"));
    assert(byPhase["implementation"]!.includes("claude-sonnet-4-7 (medium)"));
    // Planning had no effort recorded — falls back to the bare model name.
    assertEquals(byPhase["planning"], ["claude-opus-4-7"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("credit_tracker - formatSummary includes per-phase cost and model+effort", () => {
  const summary = {
    date: "2026-05-29",
    totalInvocations: 1,
    byWorker: { "worker-1": 1 },
    byPhase: { "implementation": 1 },
    byModel: { "claude-opus-4-7": 1 },
    byFallback: {},
    totalTokens: {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    tokensByPhase: {
      "implementation": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    },
    tokensByModel: {
      "claude-opus-4-7": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    },
    estimatedCostByModel: {
      "claude-opus-4-7": {
        inputCost: 5,
        outputCost: 2.5,
        cacheWriteCost: 0,
        cacheReadCost: 0,
        totalCost: 7.5,
      },
    },
    estimatedCostByPhase: {
      "implementation": {
        inputCost: 5,
        outputCost: 2.5,
        cacheWriteCost: 0,
        cacheReadCost: 0,
        totalCost: 7.5,
      },
    },
    modelEffortByPhase: {
      "implementation": ["claude-opus-4-7 (high)"],
    },
    totalEstimatedCost: 7.5,
    // Issue #3870 fields — a hand-built summary is a clean day: no unpriced
    // model ids and no torn log lines.
    unpricedModels: [],
    unpricedTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const output = formatSummary(summary);
  assert(output.includes("Estimated Cost by Phase (USD):"));
  assert(output.includes("claude-opus-4-7 (high)"));
  assert(output.includes("$7.5000"));
});
