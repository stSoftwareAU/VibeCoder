/**
 * Tests for context_budget.ts — context window budget monitoring (Issue #1327).
 *
 * Covers: token estimation per component, budget breakdown formatting,
 * threshold detection, and daily budget statistics aggregation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  aggregateBudgetStats,
  type BudgetLogEntry,
  type BudgetStats,
  checkContextBudget,
  CONTEXT_BUDGET_DEFAULTS,
  type ContextBudgetResult,
  type ContextComponent,
  estimateComponentTokens,
  formatBudgetBreakdown,
  formatBudgetStats,
  getContextWindowSize,
  logContextBudget,
  MODEL_CONTEXT_WINDOWS,
  readBudgetLog,
} from "../lib/context_budget.ts";

// =============================================================================
// Token estimation tests
// =============================================================================

Deno.test("context_budget - estimateComponentTokens estimates English text at ~4 chars per token", () => {
  const text = "a".repeat(400);
  const result = estimateComponentTokens(text);
  assertEquals(result, 100);
});

Deno.test("context_budget - estimateComponentTokens returns 0 for empty string", () => {
  assertEquals(estimateComponentTokens(""), 0);
});

Deno.test("context_budget - estimateComponentTokens handles short text", () => {
  // "hello" = 5 chars => floor(5/4) = 1
  assertEquals(estimateComponentTokens("hello"), 1);
});

Deno.test("context_budget - estimateComponentTokens handles code-heavy content with lower chars-per-token", () => {
  // Code typically has shorter tokens; the function uses a fixed heuristic
  const code = "function foo() { return bar.baz; }";
  const estimate = estimateComponentTokens(code);
  // 34 chars / 4 = 8 tokens
  assertEquals(estimate, 8);
});

// =============================================================================
// Budget check tests
// =============================================================================

Deno.test("context_budget - checkContextBudget returns ok for small total", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 1000 },
    { name: "dynamic", tokens: 500 },
    { name: "issue", tokens: 300 },
  ];

  const result = checkContextBudget(components, "opus");
  assert(result.ok);
  assertEquals(result.totalTokens, 1800);
  assertEquals(result.contextWindowSize, MODEL_CONTEXT_WINDOWS.opus);
  assert(result.usagePercent < 1);
  assertEquals(result.warning, undefined);
  assertEquals(result.error, undefined);
});

Deno.test("context_budget - checkContextBudget emits warning at 50% threshold", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const halfWindow = Math.floor(windowSize * 0.51);

  const components: ContextComponent[] = [
    { name: "system", tokens: halfWindow },
  ];

  const result = checkContextBudget(components, "opus");
  assert(result.ok);
  assert(result.warning !== undefined);
  assertStringIncludes(result.warning!, "50%");
});

Deno.test("context_budget - checkContextBudget emits error at 80% threshold", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const highUsage = Math.floor(windowSize * 0.81);

  const components: ContextComponent[] = [
    { name: "system", tokens: highUsage },
  ];

  const result = checkContextBudget(components, "opus");
  assert(result.ok);
  assert(result.error !== undefined);
  assertStringIncludes(result.error!, "80%");
});

Deno.test("context_budget - checkContextBudget supports configurable thresholds", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const usage = Math.floor(windowSize * 0.35);

  const components: ContextComponent[] = [
    { name: "system", tokens: usage },
  ];

  const result = checkContextBudget(components, "opus", {
    warningThresholdPercent: 30,
    errorThresholdPercent: 40,
  });
  assert(result.ok);
  assert(result.warning !== undefined);
  assert(result.error === undefined);
});

Deno.test("context_budget - checkContextBudget uses default window for unknown model", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 100 },
  ];

  const result = checkContextBudget(components, "unknown-model-xyz");
  assert(result.ok);
  // Should fall back to default context window
  assertEquals(result.contextWindowSize, MODEL_CONTEXT_WINDOWS.default);
});

Deno.test("context_budget - checkContextBudget works with sonnet model", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 100 },
  ];

  const result = checkContextBudget(components, "sonnet");
  assert(result.ok);
  assertEquals(result.contextWindowSize, MODEL_CONTEXT_WINDOWS.sonnet);
});

Deno.test("context_budget - checkContextBudget works with full model name", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 100 },
  ];

  const result = checkContextBudget(components, "claude-opus-4-6");
  assert(result.ok);
  assertEquals(result.contextWindowSize, MODEL_CONTEXT_WINDOWS.opus);
});

// -----------------------------------------------------------------------
// Hard ceiling (Issue #3713)
// -----------------------------------------------------------------------

Deno.test("context_budget - checkContextBudget blocks at the hard ceiling (Issue #3713)", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const components: ContextComponent[] = [
    { name: "system", tokens: Math.floor(windowSize * 0.96) },
  ];

  const result = checkContextBudget(components, "opus");

  assertEquals(result.ok, false, "usage above the ceiling must not pass");
  assert(result.blockReason !== undefined);
  assertStringIncludes(result.blockReason!, "95%");
  // The error string still fires — the block is additive, not a replacement.
  assert(result.error !== undefined);
});

Deno.test("context_budget - checkContextBudget blocks exactly at the ceiling (Issue #3713)", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 90 },
    { name: "dynamic", tokens: 10 },
  ];

  const result = checkContextBudget(components, "opus", {
    blockThresholdPercent: 0.01,
    // 100 tokens of a 1M window = 0.01% — exactly on the ceiling.
  });

  assertEquals(result.ok, false, "usage equal to the ceiling must block");
});

Deno.test("context_budget - checkContextBudget stays ok just below the ceiling (Issue #3713)", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const components: ContextComponent[] = [
    { name: "system", tokens: Math.floor(windowSize * 0.90) },
  ];

  const result = checkContextBudget(components, "opus");

  assertEquals(result.ok, true);
  assertEquals(result.blockReason, undefined);
  // Still an error-level warning — observability is unchanged below the ceiling.
  assert(result.error !== undefined);
});

Deno.test("context_budget - a zero ceiling disables blocking (Issue #3713)", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const components: ContextComponent[] = [
    { name: "system", tokens: windowSize * 2 },
  ];

  const result = checkContextBudget(components, "opus", {
    blockThresholdPercent: 0,
  });

  assertEquals(result.ok, true, "ceiling of 0 restores warn-only behaviour");
  assertEquals(result.blockReason, undefined);
});

Deno.test("context_budget - checkContextBudget honours a custom ceiling (Issue #3713)", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const components: ContextComponent[] = [
    { name: "system", tokens: Math.floor(windowSize * 0.61) },
  ];

  const result = checkContextBudget(components, "opus", {
    blockThresholdPercent: 60,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.blockReason!, "60%");
});

Deno.test("context_budget - formatBudgetBreakdown marks a blocked result (Issue #3713)", () => {
  const windowSize = MODEL_CONTEXT_WINDOWS["opus"] ?? 200_000;
  const result = checkContextBudget(
    [{ name: "system", tokens: Math.floor(windowSize * 0.99) }],
    "opus",
  );

  assertStringIncludes(
    formatBudgetBreakdown(result),
    "Context budget BLOCKED:",
  );
});

Deno.test("context_budget - getContextWindowSize treats fable as a 1M window (Issue #2619)", () => {
  assertEquals(getContextWindowSize("fable"), 1_000_000);
  assertEquals(getContextWindowSize("claude-fable-5"), 1_000_000);
  assertEquals(MODEL_CONTEXT_WINDOWS.fable, 1_000_000);
});

// =============================================================================
// Format breakdown tests
// =============================================================================

Deno.test("context_budget - formatBudgetBreakdown formats components correctly", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 12450 },
    { name: "dynamic", tokens: 3200 },
    { name: "issue", tokens: 1800 },
  ];

  const result: ContextBudgetResult = {
    ok: true,
    components,
    totalTokens: 17450,
    contextWindowSize: 200000,
    usagePercent: 8.725,
  };

  const formatted = formatBudgetBreakdown(result);
  assertStringIncludes(formatted, "system=12,450");
  assertStringIncludes(formatted, "dynamic=3,200");
  assertStringIncludes(formatted, "issue=1,800");
  assertStringIncludes(formatted, "total=17,450/200,000");
  assertStringIncludes(formatted, "8.7%");
});

Deno.test("context_budget - formatBudgetBreakdown shows warning marker", () => {
  const result: ContextBudgetResult = {
    ok: true,
    components: [{ name: "system", tokens: 110000 }],
    totalTokens: 110000,
    contextWindowSize: 200000,
    usagePercent: 55,
    warning: "Context usage exceeds 50% threshold",
  };

  const formatted = formatBudgetBreakdown(result);
  assertStringIncludes(formatted, "WARNING");
});

Deno.test("context_budget - formatBudgetBreakdown shows error marker", () => {
  const result: ContextBudgetResult = {
    ok: true,
    components: [{ name: "system", tokens: 170000 }],
    totalTokens: 170000,
    contextWindowSize: 200000,
    usagePercent: 85,
    error: "Context usage exceeds 80% threshold",
  };

  const formatted = formatBudgetBreakdown(result);
  assertStringIncludes(formatted, "ERROR");
});

// =============================================================================
// Budget logging tests
// =============================================================================

Deno.test("context_budget - logContextBudget writes entry to log file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const entry: BudgetLogEntry = {
      timestamp: "2026-04-14T12:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [
        { name: "system", tokens: 5000 },
        { name: "issue", tokens: 2000 },
      ],
      totalTokens: 7000,
      contextWindowSize: 200000,
      usagePercent: 3.5,
    };

    await logContextBudget(tmpDir, entry);

    // Verify file was written
    const files: string[] = [];
    for await (const f of Deno.readDir(tmpDir)) {
      if (f.name.includes("context_budget")) files.push(f.name);
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const parsed = JSON.parse(content.trim().split("\n")[0]!);
    assertEquals(parsed.repo, "org/repo");
    assertEquals(parsed.totalTokens, 7000);
    assertEquals(parsed.usagePercent, 3.5);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("context_budget - logContextBudget appends multiple entries", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const baseEntry: BudgetLogEntry = {
      timestamp: "2026-04-14T12:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [{ name: "system", tokens: 5000 }],
      totalTokens: 5000,
      contextWindowSize: 200000,
      usagePercent: 2.5,
    };

    await logContextBudget(tmpDir, baseEntry);
    await logContextBudget(tmpDir, {
      ...baseEntry,
      totalTokens: 8000,
      usagePercent: 4.0,
    });

    const files: string[] = [];
    for await (const f of Deno.readDir(tmpDir)) {
      if (f.name.includes("context_budget")) files.push(f.name);
    }
    assertEquals(files.length, 1);

    const content = await Deno.readTextFile(`${tmpDir}/${files[0]}`);
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Budget statistics aggregation tests
// =============================================================================

Deno.test("context_budget - aggregateBudgetStats computes average and max from entries", () => {
  const entries: BudgetLogEntry[] = [
    {
      timestamp: "2026-04-14T12:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [{ name: "system", tokens: 5000 }],
      totalTokens: 5000,
      contextWindowSize: 200000,
      usagePercent: 2.5,
    },
    {
      timestamp: "2026-04-14T13:00:00.000Z",
      repo: "org/repo",
      phase: "planning",
      model: "opus",
      components: [{ name: "system", tokens: 15000 }],
      totalTokens: 15000,
      contextWindowSize: 200000,
      usagePercent: 7.5,
    },
    {
      timestamp: "2026-04-14T14:00:00.000Z",
      repo: "org/repo2",
      phase: "implementation",
      model: "sonnet",
      components: [{ name: "system", tokens: 10000 }],
      totalTokens: 10000,
      contextWindowSize: 200000,
      usagePercent: 5.0,
    },
  ];

  const stats = aggregateBudgetStats(entries);
  assertEquals(stats.totalInvocations, 3);
  assertEquals(stats.averageTokens, 10000);
  assertEquals(stats.maxTokens, 15000);
  assertEquals(stats.averageUsagePercent, 5.0);
  assertEquals(stats.maxUsagePercent, 7.5);
  assertEquals(stats.warningCount, 0);
  assertEquals(stats.errorCount, 0);
});

Deno.test("context_budget - aggregateBudgetStats counts warnings and errors", () => {
  const entries: BudgetLogEntry[] = [
    {
      timestamp: "2026-04-14T12:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [{ name: "system", tokens: 5000 }],
      totalTokens: 5000,
      contextWindowSize: 200000,
      usagePercent: 2.5,
    },
    {
      timestamp: "2026-04-14T13:00:00.000Z",
      repo: "org/repo",
      phase: "planning",
      model: "opus",
      components: [{ name: "system", tokens: 110000 }],
      totalTokens: 110000,
      contextWindowSize: 200000,
      usagePercent: 55,
      warning: "Exceeds 50%",
    },
    {
      timestamp: "2026-04-14T14:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [{ name: "system", tokens: 170000 }],
      totalTokens: 170000,
      contextWindowSize: 200000,
      usagePercent: 85,
      error: "Exceeds 80%",
    },
  ];

  const stats = aggregateBudgetStats(entries);
  assertEquals(stats.warningCount, 1);
  assertEquals(stats.errorCount, 1);
});

Deno.test("context_budget - aggregateBudgetStats handles empty entries", () => {
  const stats = aggregateBudgetStats([]);
  assertEquals(stats.totalInvocations, 0);
  assertEquals(stats.averageTokens, 0);
  assertEquals(stats.maxTokens, 0);
  assertEquals(stats.averageUsagePercent, 0);
  assertEquals(stats.maxUsagePercent, 0);
});

// =============================================================================
// readBudgetLog tests (Issue #3283)
// =============================================================================

// buildBudgetLogPath is a private helper, so replicate its naming convention
// here to seed a log file that readBudgetLog will pick up for a fixed date.
const TEST_LOG_DATE = "2026-04-14";

function budgetLogPath(logDir: string, date: string): string {
  return `${logDir}/.context_budget_${date}.json`;
}

Deno.test("context_budget - readBudgetLog returns [] when no log file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const entries = await readBudgetLog(tmpDir, TEST_LOG_DATE);
    assertEquals(entries, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("context_budget - readBudgetLog parses valid entries and skips malformed/blank lines", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const first: BudgetLogEntry = {
      timestamp: "2026-04-14T09:00:00.000Z",
      repo: "org/repo",
      phase: "implementation",
      model: "opus",
      components: [{ name: "system", tokens: 5000 }],
      totalTokens: 5000,
      contextWindowSize: 200000,
      usagePercent: 2.5,
    };
    const second: BudgetLogEntry = {
      ...first,
      timestamp: "2026-04-14T10:00:00.000Z",
      totalTokens: 8000,
      usagePercent: 4.0,
    };

    // Valid entry, malformed line, blank line, then another valid entry.
    const content = [
      JSON.stringify(first),
      "{ this is not valid json",
      "",
      JSON.stringify(second),
    ].join("\n") + "\n";
    await Deno.writeTextFile(budgetLogPath(tmpDir, TEST_LOG_DATE), content);

    const entries = await readBudgetLog(tmpDir, TEST_LOG_DATE);

    // Exactly the two valid entries, in order; malformed and blank skipped.
    assertEquals(entries.length, 2);
    assertEquals(entries[0]!.timestamp, first.timestamp);
    assertEquals(entries[0]!.totalTokens, 5000);
    assertEquals(entries[1]!.timestamp, second.timestamp);
    assertEquals(entries[1]!.totalTokens, 8000);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("context_budget - readBudgetLog round-trips entries written by logContextBudget", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const entry: BudgetLogEntry = {
      timestamp: "2026-07-06T12:00:00.000Z",
      repo: "org/repo",
      phase: "planning",
      model: "sonnet",
      components: [{ name: "issue", tokens: 3000 }],
      totalTokens: 3000,
      contextWindowSize: 1_000_000,
      usagePercent: 0.3,
    };
    await logContextBudget(tmpDir, entry);

    // logContextBudget writes under today's date; read it back with no date arg.
    const entries = await readBudgetLog(tmpDir);
    assertEquals(entries.length, 1);
    assertEquals(entries[0]!.repo, "org/repo");
    assertEquals(entries[0]!.totalTokens, 3000);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// formatBudgetStats tests (Issue #3283)
// =============================================================================

Deno.test("context_budget - formatBudgetStats renders the no-invocations sentinel", () => {
  const stats: BudgetStats = {
    totalInvocations: 0,
    averageTokens: 0,
    maxTokens: 0,
    averageUsagePercent: 0,
    maxUsagePercent: 0,
    warningCount: 0,
    errorCount: 0,
  };
  assertEquals(
    formatBudgetStats(stats),
    "Context Budget: No invocations recorded.",
  );
});

Deno.test("context_budget - formatBudgetStats renders figures and warning/error lines", () => {
  const stats: BudgetStats = {
    totalInvocations: 3,
    averageTokens: 12345,
    maxTokens: 54321,
    averageUsagePercent: 6.3,
    maxUsagePercent: 27.5,
    warningCount: 2,
    errorCount: 1,
  };

  const output = formatBudgetStats(stats);

  assertStringIncludes(output, "Context Budget:");
  assertStringIncludes(output, "Invocations:        3");
  // toLocaleString inserts a thousands separator for the token figures.
  assertStringIncludes(
    output,
    `Avg context tokens: ${(12345).toLocaleString()}`,
  );
  assertStringIncludes(
    output,
    `Max context tokens: ${(54321).toLocaleString()}`,
  );
  // toFixed(1) formats the usage percentages.
  assertStringIncludes(output, "Avg usage:          6.3%");
  assertStringIncludes(output, "Max usage:          27.5%");
  assertStringIncludes(output, "Warnings:           2");
  assertStringIncludes(output, "Errors:             1");
});

Deno.test("context_budget - formatBudgetStats omits warning/error lines when counts are zero", () => {
  const stats: BudgetStats = {
    totalInvocations: 1,
    averageTokens: 1000,
    maxTokens: 1000,
    averageUsagePercent: 0.5,
    maxUsagePercent: 0.5,
    warningCount: 0,
    errorCount: 0,
  };

  const output = formatBudgetStats(stats);

  assert(!output.includes("Warnings:"));
  assert(!output.includes("Errors:"));
  assertStringIncludes(output, "Invocations:        1");
});

// =============================================================================
// Default configuration tests
// =============================================================================

Deno.test("context_budget - CONTEXT_BUDGET_DEFAULTS has sensible values", () => {
  assertEquals(CONTEXT_BUDGET_DEFAULTS.warningThresholdPercent, 50);
  assertEquals(CONTEXT_BUDGET_DEFAULTS.errorThresholdPercent, 80);
  assert(
    CONTEXT_BUDGET_DEFAULTS.warningThresholdPercent <
      CONTEXT_BUDGET_DEFAULTS.errorThresholdPercent,
  );
});

Deno.test("context_budget - MODEL_CONTEXT_WINDOWS has entries for known models", () => {
  assert((MODEL_CONTEXT_WINDOWS["opus"] ?? 0) > 0);
  assert((MODEL_CONTEXT_WINDOWS["sonnet"] ?? 0) > 0);
  assert((MODEL_CONTEXT_WINDOWS["haiku"] ?? 0) > 0);
  assert((MODEL_CONTEXT_WINDOWS["default"] ?? 0) > 0);
});

// =============================================================================
// Claude 4.7 context window size verification (Issue #1399)
// =============================================================================

Deno.test("context_budget - Opus context window is 1M tokens (Issue #1399)", () => {
  assertEquals(MODEL_CONTEXT_WINDOWS["opus"], 1_000_000);
});

Deno.test("context_budget - Sonnet context window is 1M tokens (Issue #1399)", () => {
  assertEquals(MODEL_CONTEXT_WINDOWS["sonnet"], 1_000_000);
});

Deno.test("context_budget - Haiku context window remains 200k tokens (Issue #1399)", () => {
  assertEquals(MODEL_CONTEXT_WINDOWS["haiku"], 200_000);
});

Deno.test("context_budget - default context window is 200k tokens (Issue #1399)", () => {
  assertEquals(MODEL_CONTEXT_WINDOWS["default"], 200_000);
});

Deno.test("context_budget - getContextWindowSize returns 1M for claude-opus-4-7 (Issue #1399)", () => {
  assertEquals(getContextWindowSize("claude-opus-4-7"), 1_000_000);
});

// Issue #3560: the "claude-opus-5" id has no version segment after the tier
// (no "-opus-N-M"), so it is matched only by the trailing "-opus" substring
// branch. Pin the 1M window explicitly so a future matcher refactor cannot
// silently regress Opus 5 to the default (smaller) window.
Deno.test("context_budget - getContextWindowSize returns 1M for claude-opus-5 (Issue #3560)", () => {
  assertEquals(getContextWindowSize("claude-opus-5"), 1_000_000);
});

Deno.test("context_budget - getContextWindowSize returns 1M for claude-sonnet-4-6 (Issue #1399)", () => {
  assertEquals(getContextWindowSize("claude-sonnet-4-6"), 1_000_000);
});

Deno.test("context_budget - getContextWindowSize returns 200k for claude-haiku-4-5 (Issue #1399)", () => {
  assertEquals(getContextWindowSize("claude-haiku-4-5"), 200_000);
});

Deno.test("context_budget - checkContextBudget uses 1M window for opus (Issue #1399)", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 250_000 },
  ];
  const result = checkContextBudget(components, "opus");
  assertEquals(result.contextWindowSize, 1_000_000);
  // 250k/1M = 25% — should be under the 50% warning threshold
  assert(
    result.usagePercent < 50,
    "250k tokens in 1M window should be under 50%",
  );
  assertEquals(result.warning, undefined);
  assertEquals(result.error, undefined);
});

Deno.test("context_budget - checkContextBudget uses 1M window for sonnet (Issue #1399)", () => {
  const components: ContextComponent[] = [
    { name: "system", tokens: 250_000 },
  ];
  const result = checkContextBudget(components, "sonnet");
  assertEquals(result.contextWindowSize, 1_000_000);
  assert(
    result.usagePercent < 50,
    "250k tokens in 1M window should be under 50%",
  );
  assertEquals(result.warning, undefined);
});

// =============================================================================
// Estimation correctness for large/many-component inputs
//
// Issue #2434: these previously asserted wall-clock thresholds (`elapsed < 10`),
// which depend on machine speed, CI load, and GC rather than the code under
// test. Replaced with assertions on the function's observable result so they
// stay green regardless of how long the call took on a given box. The <10ms
// heuristic budget (Issue #1327) is documented in context_budget.ts and is a
// benchmark concern, not a unit-gate one.
// =============================================================================

Deno.test("context_budget - estimateComponentTokens returns chars/4 for large text", () => {
  const largeText = "x".repeat(1_000_000); // 1 MB
  const tokens = estimateComponentTokens(largeText);
  // Heuristic is Math.floor(length / 4): 1,000,000 / 4 = 250,000.
  assertEquals(tokens, 250_000);
});

Deno.test("context_budget - checkContextBudget sums many components correctly", () => {
  const components: ContextComponent[] = Array.from({ length: 20 }, (_, i) => ({
    name: `component-${i}`,
    tokens: 1000 * (i + 1),
  }));

  const result = checkContextBudget(components, "opus");
  // Sum of 1000*(1..20) = 1000 * 210 = 210,000 tokens.
  assertEquals(result.totalTokens, 210_000);
  assertEquals(result.contextWindowSize, 1_000_000);
  // 210,000 / 1,000,000 = 21% — under the 50% warning threshold.
  assertEquals(result.usagePercent, 21);
  assertEquals(result.warning, undefined);
  assertEquals(result.error, undefined);
});
