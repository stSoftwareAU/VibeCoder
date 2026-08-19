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
 * Australian English throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type ClaudeRunResult,
  type RetryOptions,
  type RunClaudeOptions,
  runClaudeWithRetry,
} from "./claude_runner.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

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
 * Apply the idle-task budget to a set of runner options.
 *
 * An explicitly-supplied `timeoutSeconds` / `noOutputTimeout` wins — including
 * `noOutputTimeout: 0`, which is a deliberate watchdog opt-out rather than an
 * omission. Only an omitted bound is filled in.
 *
 * @param options - Runner options as built by an idle-task template.
 * @returns A copy with both bounds guaranteed present.
 */
export function withIdleTaskBudget(
  options: RunClaudeOptions,
): RunClaudeOptions {
  return {
    ...options,
    timeoutSeconds: options.timeoutSeconds ?? IDLE_TASK_TIMEOUT_SECONDS,
    noOutputTimeout: options.noOutputTimeout ??
      IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
  };
}

/**
 * Invoke Claude for an idle-task scan with both bounds always set.
 *
 * @param options - Runner options as built by an idle-task template.
 * @param retryOptions - Forwarded verbatim to the underlying runner.
 * @param runFn - Injectable runner (defaults to `runClaudeWithRetry`).
 * @returns The runner's result.
 */
export function runIdleTaskClaude(
  options: RunClaudeOptions,
  retryOptions?: RetryOptions,
  runFn: IdleTaskClaudeRunner = runClaudeWithRetry,
): Promise<Result<ClaudeRunResult>> {
  return runFn(withIdleTaskBudget(options), retryOptions);
}
