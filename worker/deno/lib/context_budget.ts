/**
 * Context window budget monitoring and observability (Issue #1327).
 *
 * Estimates token counts for each prompt component, compares against model
 * context window sizes, and emits warnings when thresholds are exceeded.
 * Budget data is logged for daily summary integration with the credit tracker.
 *
 * Design: lightweight heuristic estimation (chars / 4), no external
 * dependencies, negligible performance overhead (< 10ms for any input).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known context window sizes by model tier (tokens).
 *
 * As of Claude 4.7, Fable, Opus and Sonnet have 1M-token context windows.
 * Haiku retains the 200k context window (Issue #1399).
 * Fable 5 is the top tier above Opus (Issue #2619).
 * The `default` entry (200k) is used when the model is unrecognised —
 * conservative to avoid over-estimating capacity for unknown models.
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  fable: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
  default: 200_000,
} as const;

/**
 * Default budget monitoring thresholds.
 */
export const CONTEXT_BUDGET_DEFAULTS = {
  /** Emit a warning when context usage exceeds this percentage. */
  warningThresholdPercent: 50,
  /** Emit an error when context usage exceeds this percentage. */
  errorThresholdPercent: 80,
  /**
   * Hard ceiling (Issue #3713). At or above this percentage the check
   * returns `ok: false` and the caller must stop rather than send a prompt
   * that the model would truncate. Set to `0` to disable the ceiling.
   */
  blockThresholdPercent: 95,
} as const;

/**
 * Characters-per-token heuristic for English text.
 * Matches the constant in claude_executor.ts for consistency.
 */
const CHARS_PER_TOKEN = 4;

/** Prefix for context budget log file names. */
const BUDGET_LOG_PREFIX = ".context_budget_";

/** Suffix for context budget log file names. */
const BUDGET_LOG_SUFFIX = ".json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single prompt component with its estimated token count. */
export interface ContextComponent {
  /** Component name (e.g., "system", "dynamic", "issue", "custom_instructions"). */
  name: string;
  /** Estimated token count. */
  tokens: number;
}

/** Result of a context budget check. */
export interface ContextBudgetResult {
  /**
   * Whether the budget check passed. `false` means the hard ceiling was
   * reached and the caller MUST stop (Issue #3713) — warnings and errors
   * below the ceiling remain informational and leave this `true`.
   */
  ok: boolean;
  /** Individual component breakdowns. */
  components: ContextComponent[];
  /** Sum of all component token estimates. */
  totalTokens: number;
  /** Model's context window size in tokens. */
  contextWindowSize: number;
  /** Usage as a percentage of the context window. */
  usagePercent: number;
  /** Warning message when usage exceeds the warning threshold. */
  warning?: string;
  /** Error message when usage exceeds the error threshold. */
  error?: string;
  /**
   * Why the phase was blocked. Set only when `ok` is `false` (Issue #3713).
   */
  blockReason?: string;
}

/** Configurable threshold overrides. */
export interface BudgetThresholds {
  /** Warning threshold as a percentage (default: 50). */
  warningThresholdPercent?: number;
  /** Error threshold as a percentage (default: 80). */
  errorThresholdPercent?: number;
  /**
   * Hard ceiling as a percentage (default: 95, Issue #3713). Values `<= 0`
   * disable the ceiling and restore purely observational behaviour.
   */
  blockThresholdPercent?: number;
}

/** A single budget log entry for daily aggregation. */
export interface BudgetLogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Execution phase (e.g., "implementation", "planning"). */
  phase: string;
  /** Model tier used. */
  model: string;
  /** Component breakdowns. */
  components: ContextComponent[];
  /** Total estimated tokens. */
  totalTokens: number;
  /** Context window size. */
  contextWindowSize: number;
  /** Usage percentage. */
  usagePercent: number;
  /** Warning message, if any. */
  warning?: string;
  /** Error message, if any. */
  error?: string;
  /** Whether the hard ceiling blocked the phase (Issue #3713). */
  blocked?: boolean;
}

/** Aggregated budget statistics for daily summaries. */
export interface BudgetStats {
  /** Number of invocations in the period. */
  totalInvocations: number;
  /** Average total tokens across invocations. */
  averageTokens: number;
  /** Maximum total tokens in a single invocation. */
  maxTokens: number;
  /** Average usage percentage. */
  averageUsagePercent: number;
  /** Maximum usage percentage. */
  maxUsagePercent: number;
  /** Number of invocations that triggered a warning. */
  warningCount: number;
  /** Number of invocations that triggered an error. */
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a text string using a simple heuristic.
 *
 * Uses characters / 4 as a rough approximation for English text.
 * This matches the heuristic in claude_executor.ts for consistency.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (floored)
 */
export function estimateComponentTokens(text: string): number {
  if (!text) return 0;
  return Math.floor(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Context window lookup
// ---------------------------------------------------------------------------

/**
 * Look up the context window size for a given model.
 *
 * Handles both short names (e.g., "opus") and full model IDs
 * (e.g., "claude-opus-4-6"). Falls back to the default window size
 * for unrecognised models.
 *
 * @param model - Model identifier
 * @returns Context window size in tokens
 */
export function getContextWindowSize(model: string): number {
  // Direct match on short name
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model]!;
  }

  // Extract tier from full model ID (e.g., "claude-opus-4-6")
  for (const tier of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (tier === "default") continue;
    if (model.includes(`-${tier}-`) || model.includes(`-${tier}`)) {
      return MODEL_CONTEXT_WINDOWS[tier]!;
    }
  }

  return MODEL_CONTEXT_WINDOWS["default"]!;
}

// ---------------------------------------------------------------------------
// Budget checking
// ---------------------------------------------------------------------------

/**
 * Check context budget against the model's context window.
 *
 * Compares the total estimated token count of all components against
 * the model's context window size and emits warnings/errors when
 * configurable thresholds are exceeded.
 *
 * Issue #3713: the check is no longer purely observational. At or above
 * `blockThresholdPercent` it returns `ok: false` with a `blockReason` — a
 * hard ceiling the caller must honour by stopping the phase, so an issue
 * whose prompt keeps growing is bounded by context rather than by
 * wall-clock alone. A ceiling of `0` (or less) disables the block and
 * restores the old warn-only behaviour.
 *
 * @param components - Prompt components with estimated token counts
 * @param model - Model identifier for window size lookup
 * @param thresholds - Optional threshold overrides
 * @returns Budget check result with usage breakdown
 */
export function checkContextBudget(
  components: ContextComponent[],
  model: string,
  thresholds?: BudgetThresholds,
): ContextBudgetResult {
  const warningThreshold = thresholds?.warningThresholdPercent ??
    CONTEXT_BUDGET_DEFAULTS.warningThresholdPercent;
  const errorThreshold = thresholds?.errorThresholdPercent ??
    CONTEXT_BUDGET_DEFAULTS.errorThresholdPercent;
  const blockThreshold = thresholds?.blockThresholdPercent ??
    CONTEXT_BUDGET_DEFAULTS.blockThresholdPercent;

  const contextWindowSize = getContextWindowSize(model);
  const totalTokens = components.reduce((sum, c) => sum + c.tokens, 0);
  const usagePercent = (totalTokens / contextWindowSize) * 100;

  const result: ContextBudgetResult = {
    ok: true,
    components,
    totalTokens,
    contextWindowSize,
    usagePercent,
  };

  if (blockThreshold > 0 && usagePercent >= blockThreshold) {
    result.ok = false;
    result.blockReason = `Context usage (${
      usagePercent.toFixed(1)
    }%) reached the hard ceiling of ${blockThreshold}% — ${totalTokens.toLocaleString()} of ${contextWindowSize.toLocaleString()} tokens. Stopping before the prompt is truncated.`;
  }

  if (usagePercent >= errorThreshold) {
    result.error = `Context usage (${
      usagePercent.toFixed(1)
    }%) exceeds ${errorThreshold}% threshold — risk of degraded responses`;
  } else if (usagePercent >= warningThreshold) {
    result.warning = `Context usage (${
      usagePercent.toFixed(1)
    }%) exceeds ${warningThreshold}% threshold`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a budget result as a human-readable log line.
 *
 * Output format:
 *   Context budget: system=12,450 dynamic=3,200 issue=1,800 total=17,450/200,000 (8.7%)
 *
 * @param result - Budget check result to format
 * @returns Formatted string
 */
export function formatBudgetBreakdown(result: ContextBudgetResult): string {
  const parts = result.components.map(
    (c) => `${c.name}=${c.tokens.toLocaleString()}`,
  );

  const totalStr =
    `total=${result.totalTokens.toLocaleString()}/${result.contextWindowSize.toLocaleString()}`;
  const percentStr = `(${result.usagePercent.toFixed(1)}%)`;

  let prefix = "Context budget:";
  if (!result.ok) {
    prefix = "Context budget BLOCKED:";
  } else if (result.error) {
    prefix = "Context budget ERROR:";
  } else if (result.warning) {
    prefix = "Context budget WARNING:";
  }

  return `${prefix} ${parts.join(" ")} ${totalStr} ${percentStr}`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Build the log file path for a given date.
 */
function buildBudgetLogPath(logDir: string, date: string): string {
  return `${logDir}/${BUDGET_LOG_PREFIX}${date}${BUDGET_LOG_SUFFIX}`;
}

/**
 * Get today's date as YYYY-MM-DD.
 */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Log a context budget entry to the daily budget log.
 *
 * Appends a single JSON line to the day's log file. Creates the log
 * directory and file if they do not exist.
 *
 * @param logDir - Directory for budget log files
 * @param entry - Budget log entry to write
 */
export async function logContextBudget(
  logDir: string,
  entry: BudgetLogEntry,
): Promise<void> {
  await Deno.mkdir(logDir, { recursive: true });
  const logPath = buildBudgetLogPath(logDir, todayString());
  const line = JSON.stringify(entry) + "\n";
  await Deno.writeTextFile(logPath, line, { append: true });
}

/**
 * Read all budget log entries for a given date.
 *
 * @param logDir - Directory containing budget log files
 * @param date - Date in YYYY-MM-DD format (defaults to today)
 * @returns Array of budget log entries (empty if no log exists)
 */
export async function readBudgetLog(
  logDir: string,
  date?: string,
): Promise<BudgetLogEntry[]> {
  const targetDate = date ?? todayString();
  const logPath = buildBudgetLogPath(logDir, targetDate);

  let content: string;
  try {
    content = await Deno.readTextFile(logPath);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  const entries: BudgetLogEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
      continue;
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Statistics aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate budget statistics from a set of log entries.
 *
 * Computes average/max context usage, warning/error counts.
 * Intended for inclusion in daily credit summaries.
 *
 * @param entries - Budget log entries to aggregate
 * @returns Aggregated budget statistics
 */
export function aggregateBudgetStats(entries: BudgetLogEntry[]): BudgetStats {
  if (entries.length === 0) {
    return {
      totalInvocations: 0,
      averageTokens: 0,
      maxTokens: 0,
      averageUsagePercent: 0,
      maxUsagePercent: 0,
      warningCount: 0,
      errorCount: 0,
    };
  }

  let totalTokensSum = 0;
  let maxTokens = 0;
  let usagePercentSum = 0;
  let maxUsagePercent = 0;
  let warningCount = 0;
  let errorCount = 0;

  for (const entry of entries) {
    totalTokensSum += entry.totalTokens;
    usagePercentSum += entry.usagePercent;

    if (entry.totalTokens > maxTokens) {
      maxTokens = entry.totalTokens;
    }
    if (entry.usagePercent > maxUsagePercent) {
      maxUsagePercent = entry.usagePercent;
    }
    if (entry.warning) warningCount++;
    if (entry.error) errorCount++;
  }

  return {
    totalInvocations: entries.length,
    averageTokens: Math.round(totalTokensSum / entries.length),
    maxTokens,
    averageUsagePercent: Math.round((usagePercentSum / entries.length) * 10) /
      10,
    maxUsagePercent,
    warningCount,
    errorCount,
  };
}

/**
 * Format budget statistics as a human-readable summary block.
 *
 * @param stats - Aggregated budget statistics
 * @returns Formatted multi-line string for daily summary
 */
export function formatBudgetStats(stats: BudgetStats): string {
  if (stats.totalInvocations === 0) {
    return "Context Budget: No invocations recorded.";
  }

  const lines: string[] = [];
  lines.push("Context Budget:");
  lines.push(`  Invocations:        ${stats.totalInvocations}`);
  lines.push(`  Avg context tokens: ${stats.averageTokens.toLocaleString()}`);
  lines.push(`  Max context tokens: ${stats.maxTokens.toLocaleString()}`);
  lines.push(`  Avg usage:          ${stats.averageUsagePercent.toFixed(1)}%`);
  lines.push(`  Max usage:          ${stats.maxUsagePercent.toFixed(1)}%`);
  if (stats.warningCount > 0) {
    lines.push(`  Warnings:           ${stats.warningCount}`);
  }
  if (stats.errorCount > 0) {
    lines.push(`  Errors:             ${stats.errorCount}`);
  }
  return lines.join("\n");
}
