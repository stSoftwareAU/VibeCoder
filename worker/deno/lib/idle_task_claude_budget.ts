/**
 * Shared Claude budget for idle-task scans (SEC-2d46e408d10c, Issue #3657).
 *
 * `runClaudeWithTimeout` defaults to a four-hour hard cap with the silence
 * watchdog switched off (`timeoutSeconds = 14400`, `noOutputTimeout = 0`).
 * Every deliberately-configured phase overrides both; the idle-task scans used
 * to inherit them, so a wedged scan that emitted nothing was billed for the
 * full four hours instead of being killed at the usual 600s — multiplied by
 * the retry and model-fallback ladder, and with no operator present.
 *
 * This module is the single place idle-task scans get their bounds from:
 * every template routes through {@link runIdleTaskClaude} rather than calling
 * `runClaudeWithRetry` directly, so a new template cannot silently reintroduce
 * the fall-through.
 *
 * ## The cycle deadline binds an idle-task scan too (Issue #186)
 *
 * A flat hour-long budget ignores how much runway the cycle has left. A scan
 * claimed five minutes before the cycle deadline could legally run until
 * deadline + 55 min, holding its slot, delaying the hourly refresh, and
 * producing nothing the run could use. The execute phase solved this in
 * Issue #4254 with {@link resolveExecuteTimeoutSeconds}; the idle-task route
 * now applies the same rule.
 *
 * The deadline (and the worker logger, so the scan emits `[agent-progress]`
 * lines into `worker-*.log` instead of going silent) reaches this module as a
 * run context rather than as a parameter threaded through all seventeen
 * templates — the same choke-point reasoning as the budget itself: a new
 * template cannot forget to pass something it never sees.
 *
 * Australian English throughout (behaviour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import {
  type ClaudeRunResult,
  type RetryOptions,
  type RunClaudeOptions,
  runClaudeWithRetry,
} from "./claude_runner.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { resolveExecuteTimeoutSeconds } from "./execute_timeout.ts";
import { defaultLogger } from "./logger.ts";

/**
 * Hard wall-clock cap (seconds) for an idle-task scan.
 *
 * Sized to the configured issue-work budget (`claudeTimeout`, 1h) rather than
 * the 4h library default — an unattended read-only scan is never worth more
 * than a full issue run.
 */
export const IDLE_TASK_TIMEOUT_SECONDS = OPERATIONAL_DEFAULTS.claudeTimeout;

/**
 * Silence watchdog (seconds) for an idle-task scan.
 *
 * Matches `claudeNoOutputTimeout` (10 min): a scan that stops emitting output
 * is wedged, and must be killed promptly rather than left to run to the hard
 * cap.
 */
export const IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS =
  OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;

/** Signature of the underlying runner, so tests can inject a fake. */
export type IdleTaskClaudeRunner = (
  options: RunClaudeOptions,
  retryOptions?: RetryOptions,
) => Promise<Result<ClaudeRunResult>>;

/**
 * Ambient facts about the run an idle-task scan belongs to (Issue #186).
 *
 * Both fields are optional: a caller that knows neither (the `work-on-issue`
 * CLI path) leaves the scan bounded exactly as it was before.
 */
export interface IdleTaskRunContext {
  /**
   * Epoch-ms deadline of the current cycle. When set, a scan is bounded to
   * the runway left rather than the full {@link IDLE_TASK_TIMEOUT_SECONDS}.
   */
  cycleDeadlineEpochMs?: number;
  /**
   * Worker logger, so the runner's `[agent-progress]` lines land in
   * `worker-*.log`. Without it a 20-minute scan is indistinguishable from a
   * hang.
   */
  logger?: Logger;
}

/**
 * Live run contexts, innermost last. An array rather than a single slot so
 * two concurrent slots (Issue #4177) each drop only their own entry — a
 * sibling finishing first must not leave the other one unbounded.
 */
const runContexts: IdleTaskRunContext[] = [];

/** The context an idle-task scan starting now belongs to. */
export function getIdleTaskRunContext(): IdleTaskRunContext {
  return { ...(runContexts[runContexts.length - 1] ?? {}) };
}

/**
 * Run `fn` with `context` applied to every idle-task scan it starts.
 *
 * The context is removed in `finally`, by identity, so it cannot leak past
 * the run — including when `fn` throws.
 *
 * @param context - Cycle deadline and/or worker logger for this run.
 * @param fn - The work to perform under that context.
 * @returns Whatever `fn` returns.
 */
export async function withIdleTaskRunContext<T>(
  context: IdleTaskRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  const entry: IdleTaskRunContext = { ...context };
  runContexts.push(entry);
  try {
    return await fn();
  } finally {
    const index = runContexts.lastIndexOf(entry);
    if (index >= 0) runContexts.splice(index, 1);
  }
}

/** Outcome of {@link resolveIdleTaskBudget}. */
export interface IdleTaskBudget {
  /** The options to hand the runner, with every bound resolved. */
  options: RunClaudeOptions;
  /** True when the cycle deadline, not the idle-task budget, binds the run. */
  deadlineBound: boolean;
}

/**
 * Resolve every bound for an idle-task scan.
 *
 * The requested budget is the caller's `timeoutSeconds` when supplied, else
 * {@link IDLE_TASK_TIMEOUT_SECONDS}. When the run context carries a cycle
 * deadline, that budget is then bounded by the same rule the execute phase
 * uses (`min(requested, runway + kill grace)`, floored at
 * `EXECUTE_TIMEOUT_FLOOR_SECONDS`) — a deadline the launcher will act on
 * outranks any budget a template asked for.
 *
 * `noOutputTimeout` keeps its existing rule: an explicit value wins,
 * including `0`, which is a deliberate watchdog opt-out rather than an
 * omission.
 *
 * @param options - Runner options as built by an idle-task template.
 * @param nowMs - Current epoch-ms (injected for testing).
 * @returns The resolved options and whether the deadline bound them.
 */
export function resolveIdleTaskBudget(
  options: RunClaudeOptions,
  nowMs: number = Date.now(),
): IdleTaskBudget {
  const context = getIdleTaskRunContext();
  const requestedTimeout = options.timeoutSeconds ?? IDLE_TASK_TIMEOUT_SECONDS;
  const killAfterSeconds = options.killAfterSeconds ??
    OPERATIONAL_DEFAULTS.claudeKillAfter;
  const bounded = resolveExecuteTimeoutSeconds(
    requestedTimeout,
    killAfterSeconds,
    context.cycleDeadlineEpochMs,
    nowMs,
  );
  return {
    options: {
      ...options,
      timeoutSeconds: bounded.timeoutSeconds,
      noOutputTimeout: options.noOutputTimeout ??
        IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
      // The runner emits `[agent-progress]` only when it has a logger
      // (Issue #4169 wired it for execute); idle-task scans never passed one,
      // so they logged nothing at all between claim and result (Issue #186).
      logger: options.logger ?? context.logger ?? defaultLogger,
    },
    deadlineBound: bounded.deadlineBound,
  };
}

/**
 * Apply the idle-task budget to a set of runner options.
 *
 * Thin wrapper over {@link resolveIdleTaskBudget} for callers that only want
 * the options; the clamp is announced here so it is visible however the scan
 * was invoked.
 *
 * @param options - Runner options as built by an idle-task template.
 * @param nowMs - Current epoch-ms (injected for testing).
 * @returns A copy with every bound resolved.
 */
export function withIdleTaskBudget(
  options: RunClaudeOptions,
  nowMs: number = Date.now(),
): RunClaudeOptions {
  const budget = resolveIdleTaskBudget(options, nowMs);
  announceDeadlineBound(options, budget);
  return budget.options;
}

/** Log the clamp, so an operator sees why a scan got a short budget. */
function announceDeadlineBound(
  requested: RunClaudeOptions,
  budget: IdleTaskBudget,
): void {
  if (!budget.deadlineBound) return;
  budget.options.logger?.info(
    `[idle-task] ${requested.phase ?? "scan"} bounded to ` +
      `${budget.options.timeoutSeconds}s by the cycle deadline ` +
      `(requested ${requested.timeoutSeconds ?? IDLE_TASK_TIMEOUT_SECONDS}s) ` +
      `— an idle-task scan has no work-in-progress to preserve, so it must ` +
      `not outlive the cycle (Issue #186)`,
  );
}

/**
 * Invoke Claude for an idle-task scan with every bound always set.
 *
 * When the cycle deadline bound the run, retries are suppressed: the
 * timeout is resolved once and reused by every attempt, so a second
 * invocation — after a rate-limit back-off of up to ten minutes — would run
 * the same bounded budget again from well past the deadline. A scan has no
 * work-in-progress to protect, so the honest answer is to fail now and let
 * the next cycle re-file it.
 *
 * @param options - Runner options as built by an idle-task template.
 * @param retryOptions - Forwarded to the underlying runner, with retries
 *   removed when the deadline binds.
 * @param runFn - Injectable runner (defaults to `runClaudeWithRetry`).
 * @returns The runner's result.
 */
export function runIdleTaskClaude(
  options: RunClaudeOptions,
  retryOptions?: RetryOptions,
  runFn: IdleTaskClaudeRunner = runClaudeWithRetry,
): Promise<Result<ClaudeRunResult>> {
  const budget = resolveIdleTaskBudget(options);
  announceDeadlineBound(options, budget);
  return runFn(
    budget.options,
    budget.deadlineBound ? { ...retryOptions, maxRetries: 0 } : retryOptions,
  );
}
