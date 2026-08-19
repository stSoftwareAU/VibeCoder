/**
 * Per-worker credit usage tracking and daily spend logging (Issue #1074).
 *
 * Logs each Claude invocation with metadata (worker name, phase, repo,
 * model, timestamp) and provides summarisation and log rotation.
 *
 * Log files are stored as newline-delimited JSON (one entry per line)
 * with the naming convention `.credit_log_YYYY-MM-DD.json`.
 *
 * Design: file-append only, no API calls, negligible overhead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  type CostBreakdown,
  estimateCostWithUpperBound,
  type TokenUsage,
} from "./token_usage.ts";
import {
  aggregateBudgetStats,
  type BudgetStats,
  formatBudgetStats,
  readBudgetLog,
} from "./context_budget.ts";
import {
  type CacheHitRate,
  cacheHitRateWarning,
  computeCacheHitRate,
  formatCacheHitRate,
} from "./prompt_cache_telemetry.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for credit log file names. */
export const LOG_FILE_PREFIX = ".credit_log_";

/** Suffix for credit log file names. */
export const LOG_FILE_SUFFIX = ".json";

/** Default number of days to retain credit logs. */
export const DEFAULT_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Claude invocation log entry. */
export interface InvocationEntry {
  /** Worker name (e.g., "worker-1"). */
  workerName: string;
  /** Phase of execution (e.g., "planning", "implementation"). */
  phase: string;
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Model identifier (e.g., "claude-sonnet-4-6"). */
  model: string;
  /** ISO 8601 timestamp of the invocation. */
  timestamp: string;
  /** Original model before fallback, if a fallback occurred (Issue #1114). */
  fallbackFrom?: string;
  /** Effort level used for this invocation (e.g. "high", "max") (Issue #2392). */
  effort?: string;
  /**
   * Coding-agent provider that was billed (Issue #4109).
   *
   * A Quorum run bills several vendors from one worker process, so the entry
   * records which agent produced it. Absent on entries written before the
   * per-invocation seam existed.
   */
  provider?: string;
  /** Input tokens consumed (Issue #1260). */
  inputTokens?: number;
  /** Output tokens generated (Issue #1260). */
  outputTokens?: number;
  /** Tokens written to prompt cache (Issue #1260). */
  cacheCreationTokens?: number;
  /** Tokens read from prompt cache (Issue #1260). */
  cacheReadTokens?: number;
}

/** Options for logging an invocation. */
export interface LogInvocationOptions {
  /** Directory to store credit log files. */
  logDir: string;
  /** Worker name. */
  workerName: string;
  /** Phase name. */
  phase: string;
  /** Repository identifier. */
  repo: string;
  /** Model used. */
  model: string;
  /** Original model before fallback, if a fallback occurred (Issue #1114). */
  fallbackFrom?: string;
  /** Effort level used for this invocation (e.g. "high", "max") (Issue #2392). */
  effort?: string;
  /** Coding-agent provider that was billed (Issue #4109). */
  provider?: string;
  /** Token usage from this invocation (Issue #1260). */
  tokenUsage?: TokenUsage;
}

/** Options for retrieving a daily summary. */
export interface SummaryOptions {
  /** Directory containing credit log files. */
  logDir: string;
  /** Date in YYYY-MM-DD format (defaults to today). */
  date?: string;
}

/** Daily credit usage summary. */
export interface DailySummary {
  /** Date in YYYY-MM-DD format. */
  date: string;
  /** Total number of invocations. */
  totalInvocations: number;
  /** Invocation count by worker name. */
  byWorker: Record<string, number>;
  /** Invocation count by phase. */
  byPhase: Record<string, number>;
  /** Invocation count by model. */
  byModel: Record<string, number>;
  /** Fallback count by transition (e.g., "opus→sonnet": 5) (Issue #1114). */
  byFallback: Record<string, number>;
  /** Total token usage across all invocations (Issue #1260). */
  totalTokens: TokenUsage;
  /** Token usage breakdown by phase (Issue #1260). */
  tokensByPhase: Record<string, TokenUsage>;
  /** Token usage breakdown by model (Issue #1260). */
  tokensByModel: Record<string, TokenUsage>;
  /** Estimated cost breakdown by model (Issue #1260). */
  estimatedCostByModel: Record<string, CostBreakdown>;
  /**
   * Estimated cost breakdown by phase (Issue #2392).
   *
   * Each entry is summed from the per-invocation costs of that phase, so a
   * phase that spans multiple models (e.g. an Opus run that fell back to
   * Sonnet) accumulates the correct blended cost. Optional for backwards
   * compatibility with summary objects built before #2392.
   */
  estimatedCostByPhase?: Record<string, CostBreakdown>;
  /**
   * Distinct "model (effort)" combinations used by each phase (Issue #2392).
   *
   * Surfaces which model and effort level each phase actually ran with, so
   * the cost of a phase can be tied back to its configuration. Optional for
   * backwards compatibility.
   */
  modelEffortByPhase?: Record<string, string[]>;
  /** Total estimated cost in USD (Issue #1260). */
  totalEstimatedCost: number;
  /**
   * Model ids with no pricing entry, sorted (Issue #3870).
   *
   * Their tokens are charged at the conservative upper bound rather than
   * dropped, so {@link totalEstimatedCost} over-estimates instead of silently
   * under-reporting. A non-empty list means the pricing table needs a new row.
   */
  unpricedModels: string[];
  /** Tokens billed under an unpriced model id (Issue #3870). */
  unpricedTokens: TokenUsage;
  /** Upper-bound USD included in {@link totalEstimatedCost} (Issue #3870). */
  unpricedEstimatedCost: number;
  /**
   * Log lines that could not be parsed and were skipped (Issue #3870).
   *
   * The write side is a bare append, so a torn line is reachable. Counting
   * them makes log corruption observable instead of a silent undercount.
   */
  malformedLogLines: number;
  /** Context window budget statistics (Issue #1327). */
  contextBudget?: BudgetStats;
  /**
   * Anthropic prompt-cache hit rate for the day (Issue #4282).
   *
   * Computed from {@link totalTokens}: the share of prompt tokens served from
   * the server-side cache rather than charged as fresh input. A day whose rate
   * drops below {@link CACHE_HIT_RATE_FLOOR} has almost certainly gained a
   * volatile token in the stable prompt prefix, and {@link formatSummary} says
   * so rather than leaving the extra spend to be noticed on the bill.
   */
  promptCacheHitRate?: CacheHitRate;
}

/** Options for log cleanup. */
export interface CleanupOptions {
  /** Directory containing credit log files. */
  logDir: string;
  /** Number of days to retain (default: 7). */
  retentionDays?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the log file path for a given date. */
function buildLogPath(logDir: string, date: string): string {
  return `${logDir}/${LOG_FILE_PREFIX}${date}${LOG_FILE_SUFFIX}`;
}

/** Get today's date as YYYY-MM-DD. */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a date string from a credit log filename.
 * Returns the date portion or null if the filename doesn't match.
 */
function parseDateFromFilename(filename: string): string | null {
  if (
    !filename.startsWith(LOG_FILE_PREFIX) || !filename.endsWith(LOG_FILE_SUFFIX)
  ) {
    return null;
  }
  const dateStr = filename.slice(
    LOG_FILE_PREFIX.length,
    filename.length - LOG_FILE_SUFFIX.length,
  );
  // Basic validation: must be YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  return dateStr;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Log a Claude invocation to the daily credit log.
 *
 * Appends a single JSON line to the day's log file. Creates the log
 * directory and file if they do not exist.
 *
 * @param options - Invocation details to log
 */
export async function logInvocation(
  options: LogInvocationOptions,
): Promise<void> {
  const {
    logDir,
    workerName,
    phase,
    repo,
    model,
    fallbackFrom,
    effort,
    provider,
    tokenUsage,
  } = options;

  // Ensure directory exists
  await Deno.mkdir(logDir, { recursive: true });

  const entry: InvocationEntry = {
    workerName,
    phase,
    repo,
    model,
    timestamp: new Date().toISOString(),
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(effort ? { effort } : {}),
    ...(provider ? { provider } : {}),
    ...(tokenUsage
      ? {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        cacheCreationTokens: tokenUsage.cacheCreationTokens,
        cacheReadTokens: tokenUsage.cacheReadTokens,
      }
      : {}),
  };

  const logPath = buildLogPath(logDir, todayString());
  const line = JSON.stringify(entry) + "\n";

  // Append-only write — negligible overhead
  await Deno.writeTextFile(logPath, line, { append: true });
}

/**
 * Generate a daily summary of credit usage.
 *
 * Reads the log file for the given date and aggregates invocation
 * counts by worker, phase, and model.
 *
 * @param options - Summary options
 * @returns Result with the daily summary or error if no log exists
 */
export async function getDailySummary(
  options: SummaryOptions,
): Promise<Result<DailySummary>> {
  const date = options.date ?? todayString();
  const logPath = buildLogPath(options.logDir, date);

  let content: string;
  try {
    content = await Deno.readTextFile(logPath);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: false,
        error: new Error(`No credit log found for ${date}`),
      };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to read credit log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  const zeroTokens = (): TokenUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });

  const addTokens = (target: TokenUsage, entry: InvocationEntry): void => {
    target.inputTokens += entry.inputTokens ?? 0;
    target.outputTokens += entry.outputTokens ?? 0;
    target.cacheCreationTokens += entry.cacheCreationTokens ?? 0;
    target.cacheReadTokens += entry.cacheReadTokens ?? 0;
  };

  const summary: DailySummary = {
    date,
    totalInvocations: 0,
    byWorker: {},
    byPhase: {},
    byModel: {},
    byFallback: {},
    totalTokens: zeroTokens(),
    tokensByPhase: {},
    tokensByModel: {},
    estimatedCostByModel: {},
    estimatedCostByPhase: {},
    modelEffortByPhase: {},
    totalEstimatedCost: 0,
    unpricedModels: [],
    unpricedTokens: zeroTokens(),
    unpricedEstimatedCost: 0,
    malformedLogLines: 0,
  };

  const addCost = (target: CostBreakdown, cost: CostBreakdown): void => {
    target.inputCost += cost.inputCost;
    target.outputCost += cost.outputCost;
    target.cacheWriteCost += cost.cacheWriteCost;
    target.cacheReadCost += cost.cacheReadCost;
    target.totalCost += cost.totalCost;
  };

  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry: InvocationEntry = JSON.parse(line);
      summary.totalInvocations++;
      summary.byWorker[entry.workerName] =
        (summary.byWorker[entry.workerName] ?? 0) + 1;
      summary.byPhase[entry.phase] = (summary.byPhase[entry.phase] ?? 0) + 1;
      summary.byModel[entry.model] = (summary.byModel[entry.model] ?? 0) + 1;
      if (entry.fallbackFrom) {
        const transition = `${entry.fallbackFrom}\u2192${entry.model}`;
        summary.byFallback[transition] = (summary.byFallback[transition] ?? 0) +
          1;
      }

      // Aggregate token usage (Issue #1260)
      addTokens(summary.totalTokens, entry);

      if (!summary.tokensByPhase[entry.phase]) {
        summary.tokensByPhase[entry.phase] = zeroTokens();
      }
      addTokens(summary.tokensByPhase[entry.phase]!, entry);

      if (!summary.tokensByModel[entry.model]) {
        summary.tokensByModel[entry.model] = zeroTokens();
      }
      addTokens(summary.tokensByModel[entry.model]!, entry);

      // Per-phase model+effort visibility (Issue #2392). A phase may run
      // several model/effort combinations across retries and fallbacks; track
      // the distinct set so the run summary shows what each phase actually used.
      const combo = entry.effort
        ? `${entry.model} (${entry.effort})`
        : entry.model;
      const combos = (summary.modelEffortByPhase![entry.phase] ??= []);
      if (!combos.includes(combo)) combos.push(combo);

      // Per-phase cost (Issue #2392). Cost is linear in tokens for a fixed
      // model, so summing per-invocation costs gives the correct blended cost
      // even when a phase spans multiple models.
      // An unpriced model id is charged at the conservative upper bound
      // (Issue #3870) so a phase never reads as free.
      const entryCost = estimateCostWithUpperBound({
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        cacheReadTokens: entry.cacheReadTokens ?? 0,
      }, entry.model).cost;
      if (!summary.estimatedCostByPhase![entry.phase]) {
        summary.estimatedCostByPhase![entry.phase] = {
          inputCost: 0,
          outputCost: 0,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          totalCost: 0,
        };
      }
      addCost(summary.estimatedCostByPhase![entry.phase]!, entryCost);
    } catch {
      // Skip malformed lines — do not crash on corrupted data — but count
      // them so log corruption is observable rather than a silent undercount
      // (Issue #3870).
      summary.malformedLogLines++;
      continue;
    }
  }

  // Compute estimated costs by model (Issue #1260). An id with no pricing row
  // is charged at the upper bound and recorded separately (Issue #3870): the
  // ceiling must never measure less than the run actually cost.
  for (const [model, tokens] of Object.entries(summary.tokensByModel)) {
    const { cost, priced } = estimateCostWithUpperBound(tokens, model);
    summary.estimatedCostByModel[model] = cost;
    summary.totalEstimatedCost += cost.totalCost;
    if (!priced) {
      summary.unpricedModels.push(model);
      summary.unpricedTokens.inputTokens += tokens.inputTokens;
      summary.unpricedTokens.outputTokens += tokens.outputTokens;
      summary.unpricedTokens.cacheCreationTokens += tokens.cacheCreationTokens;
      summary.unpricedTokens.cacheReadTokens += tokens.cacheReadTokens;
      summary.unpricedEstimatedCost += cost.totalCost;
    }
  }
  summary.unpricedModels.sort();

  // Prompt-cache effectiveness for the day (Issue #4282) — derived from the
  // tokens already summed, so it costs nothing extra to report.
  summary.promptCacheHitRate = computeCacheHitRate(summary.totalTokens);

  // Load context budget statistics (Issue #1327) — best-effort, non-blocking
  try {
    const budgetEntries = await readBudgetLog(options.logDir, date);
    if (budgetEntries.length > 0) {
      summary.contextBudget = aggregateBudgetStats(budgetEntries);
    }
  } catch {
    // Budget stats are informational — never fail the summary
  }

  return { ok: true, value: summary };
}

/**
 * Default daily spend ceiling in USD. `0` disables the ceiling so existing
 * deployments keep their current behaviour until an operator opts in.
 */
export const DEFAULT_DAILY_SPEND_CEILING_USD = 0;

/** Options for {@link checkDailySpendCeiling}. */
export interface SpendCeilingOptions {
  /** Directory containing credit log files. */
  logDir: string;
  /** Ceiling in USD. Values `<= 0` disable the check. */
  ceilingUsd: number;
  /** Date in YYYY-MM-DD format (defaults to today). */
  date?: string;
  /** Restrict the total to a single worker name (defaults to all workers). */
  workerName?: string;
}

/** Outcome of a daily spend ceiling check. */
export interface SpendCeilingResult {
  /** Whether the ceiling is configured at all (`ceilingUsd > 0`). */
  enabled: boolean;
  /** Whether today's estimated spend has reached the ceiling. */
  exceeded: boolean;
  /** Estimated spend in USD for the day. */
  spentUsd: number;
  /** The ceiling that was applied, in USD. */
  ceilingUsd: number;
  /**
   * Portion of {@link spentUsd} charged at the unpriced upper bound (#3870).
   *
   * Greater than zero means the day's log contains a model id the pricing
   * table does not know, so the figure is an over-estimate — never a silent
   * `$0`, which is what let real spend run past the ceiling.
   */
  unpricedSpendUsd: number;
  /** The unpriced model ids contributing to {@link unpricedSpendUsd}. */
  unpricedModels: string[];
  /** Human-readable explanation, present when {@link exceeded} is true. */
  message?: string;
}

/**
 * Check today's estimated model spend against a daily ceiling (Issue #3648).
 *
 * The credit log was append-only: it recorded every invocation's cost but was
 * never compared against a threshold, and `context_budget.ts` is explicitly
 * informational (`ok: true` always). Backpressure was wall-clock alone, so a
 * persistently failing issue could bill unbounded model spend. This is the
 * missing comparison — the caller turns `exceeded` into a stop signal.
 *
 * A missing or unreadable log is **not** treated as "under the ceiling by
 * default" in a way that hides a fault: `getDailySummary` failing for any
 * reason other than "no log yet" propagates as an error so the caller can fail
 * loud rather than silently continue spending.
 *
 * @param options - Ceiling configuration
 * @returns The check outcome, or an error when the log could not be read
 */
export async function checkDailySpendCeiling(
  options: SpendCeilingOptions,
): Promise<Result<SpendCeilingResult>> {
  const { logDir, ceilingUsd, date, workerName } = options;

  if (ceilingUsd <= 0) {
    return {
      ok: true,
      value: {
        enabled: false,
        exceeded: false,
        spentUsd: 0,
        ceilingUsd,
        unpricedSpendUsd: 0,
        unpricedModels: [],
      },
    };
  }

  const resolvedDate = date ?? todayString();
  const summaryResult = await getDailySummary({ logDir, date: resolvedDate });

  if (!summaryResult.ok) {
    // No log for today simply means nothing has been billed yet — that is a
    // genuine zero, not a swallowed failure. Any other read error propagates.
    if (summaryResult.error.message.startsWith("No credit log found")) {
      return {
        ok: true,
        value: {
          enabled: true,
          exceeded: false,
          spentUsd: 0,
          ceilingUsd,
          unpricedSpendUsd: 0,
          unpricedModels: [],
        },
      };
    }
    return summaryResult;
  }

  const summary = summaryResult.value;
  const share = workerName === undefined ? 1 : workerShare(summary, workerName);
  const spentUsd = summary.totalEstimatedCost * share;
  const unpricedSpendUsd = summary.unpricedEstimatedCost * share;

  const exceeded = spentUsd >= ceilingUsd;
  // Unpriced spend is an upper bound, not an invoice — say so in the message
  // so an operator seeing a breach knows which model ids need a pricing row
  // (Issue #3870).
  const unpricedNote = unpricedSpendUsd > 0
    ? ` Includes $${
      unpricedSpendUsd.toFixed(2)
    } charged at the unpriced upper bound for ${
      summary.unpricedModels.join(", ")
    }.`
    : "";
  return {
    ok: true,
    value: {
      enabled: true,
      exceeded,
      spentUsd,
      ceilingUsd,
      unpricedSpendUsd,
      unpricedModels: [...summary.unpricedModels],
      message: exceeded
        ? `Daily spend ceiling reached: estimated $${
          spentUsd.toFixed(2)
        } billed on ${resolvedDate} against a ceiling of $${
          ceilingUsd.toFixed(2)
        }.${unpricedNote}`
        : undefined,
    },
  };
}

/**
 * Fraction of the day's spend attributable to one worker.
 *
 * The summary aggregates cost by model and by phase, not by worker, so the
 * worker's share is apportioned by its invocation count. This is an estimate
 * — good enough for a ceiling, and always `<=` the whole-fleet total. The
 * same fraction applies to the unpriced portion (Issue #3870).
 */
function workerShare(
  summary: DailySummary,
  workerName: string,
): number {
  if (summary.totalInvocations === 0) return 0;
  return (summary.byWorker[workerName] ?? 0) / summary.totalInvocations;
}

/**
 * Clean up credit log files older than the retention period.
 *
 * Scans the log directory for files matching the credit log naming
 * convention and removes those older than `retentionDays`.
 *
 * @param options - Cleanup options
 * @returns Result with the number of files removed
 */
export async function cleanupOldLogs(
  options: CleanupOptions,
): Promise<Result<number>> {
  const { logDir, retentionDays = DEFAULT_RETENTION_DAYS } = options;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  let removedCount = 0;

  try {
    for await (const entry of Deno.readDir(logDir)) {
      if (!entry.isFile) continue;

      const dateStr = parseDateFromFilename(entry.name);
      if (!dateStr) continue;

      // String comparison works for YYYY-MM-DD format
      if (dateStr < cutoffStr) {
        await Deno.remove(`${logDir}/${entry.name}`);
        removedCount++;
      }
    }
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      // Directory doesn't exist — nothing to clean up
      return { ok: true, value: 0 };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to clean up credit logs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  return { ok: true, value: removedCount };
}

/**
 * Format a daily summary as a human-readable string.
 *
 * @param summary - The daily summary to format
 * @returns Formatted multi-line string
 */
export function formatSummary(summary: DailySummary): string {
  const lines: string[] = [];

  lines.push(`Credit Usage Summary for ${summary.date}`);
  lines.push(`${"=".repeat(45)}`);
  lines.push(`Total invocations: ${summary.totalInvocations}`);
  lines.push("");

  lines.push("By Worker:");
  for (const [worker, count] of Object.entries(summary.byWorker).sort()) {
    lines.push(`  ${worker.padEnd(25)} ${count}`);
  }
  lines.push("");

  lines.push("By Phase:");
  for (const [phase, count] of Object.entries(summary.byPhase).sort()) {
    lines.push(`  ${phase.padEnd(25)} ${count}`);
  }
  lines.push("");

  lines.push("By Model:");
  for (const [model, count] of Object.entries(summary.byModel).sort()) {
    lines.push(`  ${model.padEnd(25)} ${count}`);
  }

  const fallbackEntries = Object.entries(summary.byFallback);
  if (fallbackEntries.length > 0) {
    lines.push("");
    lines.push("Model Fallbacks:");
    for (const [transition, count] of fallbackEntries.sort()) {
      lines.push(`  ${transition.padEnd(45)} ${count}`);
    }
  }

  // Token usage section (Issue #1260)
  const hasTokens = summary.totalTokens.inputTokens > 0 ||
    summary.totalTokens.outputTokens > 0;

  if (hasTokens) {
    lines.push("");
    lines.push("Token Usage:");
    lines.push(
      `  Input tokens:          ${summary.totalTokens.inputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Output tokens:         ${summary.totalTokens.outputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Cache creation tokens: ${summary.totalTokens.cacheCreationTokens.toLocaleString()}`,
    );
    lines.push(
      `  Cache read tokens:     ${summary.totalTokens.cacheReadTokens.toLocaleString()}`,
    );

    // Prompt-cache effectiveness, with a loud line when it has regressed
    // (Issue #4282).
    const cacheRate = summary.promptCacheHitRate ??
      computeCacheHitRate(summary.totalTokens);
    lines.push(
      `  Prompt cache hit rate: ${formatCacheHitRate(cacheRate)}`,
    );
    const warning = cacheHitRateWarning(cacheRate, summary.date);
    if (warning) lines.push(`  ⚠️  ${warning}`);

    // Per-phase token breakdown, annotated with the model+effort each phase
    // used (Issue #2392).
    const phaseEntries = Object.entries(summary.tokensByPhase);
    if (phaseEntries.length > 0) {
      lines.push("");
      lines.push("Tokens by Phase:");
      for (const [phase, tokens] of phaseEntries.sort()) {
        const total = tokens.inputTokens + tokens.outputTokens;
        const combos = summary.modelEffortByPhase?.[phase];
        const comboSuffix = combos && combos.length > 0
          ? ` [${combos.join(", ")}]`
          : "";
        lines.push(
          `  ${
            phase.padEnd(25)
          } ${total.toLocaleString()} (in: ${tokens.inputTokens.toLocaleString()}, out: ${tokens.outputTokens.toLocaleString()})${comboSuffix}`,
        );
      }
    }

    // Per-model token breakdown
    const modelTokenEntries = Object.entries(summary.tokensByModel);
    if (modelTokenEntries.length > 0) {
      lines.push("");
      lines.push("Tokens by Model:");
      for (const [model, tokens] of modelTokenEntries.sort()) {
        const total = tokens.inputTokens + tokens.outputTokens;
        lines.push(
          `  ${
            model.padEnd(25)
          } ${total.toLocaleString()} (in: ${tokens.inputTokens.toLocaleString()}, out: ${tokens.outputTokens.toLocaleString()})`,
        );
      }
    }

    // Cost estimation
    const costEntries = Object.entries(summary.estimatedCostByModel);
    if (costEntries.length > 0) {
      lines.push("");
      lines.push("Estimated Cost (USD):");
      for (const [model, cost] of costEntries.sort()) {
        lines.push(
          `  ${model.padEnd(25)} $${cost.totalCost.toFixed(4)} (in: $${
            cost.inputCost.toFixed(4)
          }, out: $${cost.outputCost.toFixed(4)}, cache-w: $${
            cost.cacheWriteCost.toFixed(4)
          }, cache-r: $${cost.cacheReadCost.toFixed(4)})`,
        );
      }
      lines.push(
        `  ${"TOTAL".padEnd(25)} $${summary.totalEstimatedCost.toFixed(4)}`,
      );
    }

    // Per-phase cost breakdown (Issue #2392) — surfaces the cost of each phase
    // so it can be tuned independently of which model served it.
    const phaseCostEntries = Object.entries(summary.estimatedCostByPhase ?? {});
    if (phaseCostEntries.length > 0) {
      lines.push("");
      lines.push("Estimated Cost by Phase (USD):");
      for (const [phase, cost] of phaseCostEntries.sort()) {
        lines.push(
          `  ${phase.padEnd(25)} $${cost.totalCost.toFixed(4)} (in: $${
            cost.inputCost.toFixed(4)
          }, out: $${cost.outputCost.toFixed(4)}, cache-w: $${
            cost.cacheWriteCost.toFixed(4)
          }, cache-r: $${cost.cacheReadCost.toFixed(4)})`,
        );
      }
    }
  }

  // Data-quality warnings (Issue #3870) — an unpriced model id or a torn log
  // line means the total is an estimate over corrupted or unknown input, and
  // must be visible rather than folded silently into the figures above.
  if (summary.unpricedModels.length > 0) {
    lines.push("");
    lines.push(
      `Unpriced models (charged at the upper bound, so the total is an ` +
        `over-estimate): ${summary.unpricedModels.join(", ")}`,
    );
    lines.push(
      `  Unpriced tokens: in ${summary.unpricedTokens.inputTokens.toLocaleString()}, out ${summary.unpricedTokens.outputTokens.toLocaleString()} — $${
        summary.unpricedEstimatedCost.toFixed(4)
      }`,
    );
  }

  if (summary.malformedLogLines > 0) {
    lines.push("");
    lines.push(
      `WARNING: ${summary.malformedLogLines} malformed log line(s) skipped — ` +
        `their spend is NOT counted in the totals above.`,
    );
  }

  // Context budget section (Issue #1327)
  if (summary.contextBudget) {
    lines.push("");
    lines.push(formatBudgetStats(summary.contextBudget));
  }

  return lines.join("\n");
}
