/**
 * Retry utility with exponential backoff and jitter for transient failures.
 *
 * Mirrors the shell-side retry logic in worker/shared/retry.sh, adapted
 * for TypeScript/Deno. Distinguishes retryable errors (5xx, rate limits,
 * network) from permanent failures (4xx, auth, permission).
 *
 * Issue #217 — Add retry resilience to GitHub API calls in TypeScript module.
 * Issue #1173 — Fault tolerance event counters.
 */

import { incrementCounter } from "./fault_tolerance_counters.ts";

/**
 * Options for retryWithBackoff.
 */
export interface RetryOptions {
  /** Maximum number of attempts including the initial one (default: 4) */
  maxAttempts?: number;
  /** Initial delay in milliseconds before first retry (default: 2000) */
  initialDelayMs?: number;
  /** Custom sleep function (override in tests to skip actual waits) */
  sleepFn?: (ms: number) => Promise<void>;
  /** Callback invoked before each retry attempt */
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_DELAY_MS = 2000;

/**
 * Determine if an error message indicates a transient (retryable) failure.
 *
 * Transient errors include:
 * - HTTP 5xx server errors (500, 502, 503, 504)
 * - HTTP 429 rate limiting
 * - Network timeouts, connection refused, DNS failures
 * - SSL/TLS connection errors
 * - Socket hang-ups and connection resets
 *
 * @param errorMessage - The error message to classify
 * @returns true if the error is transient and should be retried
 */
export function isRetryableError(errorMessage: string): boolean {
  if (!errorMessage) return false;

  const lower = errorMessage.toLowerCase();

  // Primary API rate limit exhaustion (Issue #1521) — the per-hour quota is
  // gone and will not recover until the reset timestamp, so retries inside
  // this window are guaranteed to fail. Checked before the generic "rate
  // limit" clause below so these specific phrases short-circuit to
  // non-retryable. Secondary rate limits and HTTP 429 remain retryable.
  if (
    lower.includes("api rate limit already exceeded") ||
    lower.includes("api rate limit exceeded") ||
    lower.includes("rate limit has been exceeded")
  ) {
    return false;
  }

  // HTTP 5xx server errors
  if (/http [5]\d{2}/i.test(errorMessage)) return true;

  // HTTP 429 rate limiting
  if (lower.includes("http 429") || lower.includes("rate limit")) return true;

  // Network/connection errors
  if (
    /timed?\s*out/i.test(errorMessage) ||
    lower.includes("timeout") ||
    lower.includes("connection refused") ||
    lower.includes("could not resolve") ||
    lower.includes("network is unreachable") ||
    lower.includes("no route to host")
  ) {
    return true;
  }

  // SSL/TLS errors
  if (lower.includes("ssl_error") || lower.includes("tls handshake")) {
    return true;
  }

  // GitHub secondary rate limits / abuse detection (HTTP 403)
  if (
    lower.includes("abuse detection") ||
    lower.includes("secondary rate limit")
  ) {
    return true;
  }

  // Socket/connection reset errors
  if (
    lower.includes("broken pipe") ||
    lower.includes("reset by peer") ||
    lower.includes("rpc failed") ||
    lower.includes("unexpected disconnect") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up")
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate a random jitter value between 0 and baseDelay (inclusive).
 *
 * Prevents thundering herd when multiple workers retry simultaneously.
 *
 * @param baseDelay - Maximum jitter in milliseconds
 * @returns Random jitter value
 */
function calculateJitter(baseDelay: number): number {
  if (baseDelay <= 0) return 0;
  return Math.floor(Math.random() * (baseDelay + 1));
}

/**
 * Default sleep function using setTimeout.
 */
/**
 * Whether this process is a `deno test` run (Issue #4347). Under the test
 * runner the default back-off sleep is a no-op: retry COUNTS and ordering
 * are unchanged (tests asserting on attempts are unaffected), but the
 * 2 s + 4 s + 8 s wall-clock waits vanish. Those waits were ~half the
 * quality gate: any test whose path reached a real `gh` against a
 * fixture repo 404'd and then slept 14 s per call. Production (mod.ts,
 * quality.ts, commands) never runs with a `_test.ts` main module.
 */
const IN_DENO_TEST = (() => {
  try {
    return /_test\.tsx?$/.test(Deno.mainModule);
  } catch {
    return false;
  }
})();

async function defaultSleep(ms: number): Promise<void> {
  if (IN_DENO_TEST) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with exponential backoff on transient failures.
 *
 * Runs the given function. If it throws and the error message indicates a
 * transient failure (5xx, network timeout, etc.), retries with exponential
 * backoff plus jitter. Permanent failures (4xx, auth errors) throw immediately.
 *
 * Follows the same backoff strategy as the shell version in retry.sh:
 * - Exponential: delay doubles after each retry
 * - Jitter: random value between 0 and current delay added
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns The result of the function on success
 * @throws The last error if all attempts are exhausted or on permanent failure
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const sleepFn = options?.sleepFn ?? defaultSleep;
  const onRetry = options?.onRetry;

  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (thrown: unknown) {
      // Wrap non-Error throws for consistent handling
      const error = thrown instanceof Error
        ? thrown
        : new Error(String(thrown));

      // Non-Error throws are treated as non-retryable
      if (!(thrown instanceof Error)) {
        throw error;
      }

      // Check if the error is retryable
      if (!isRetryableError(error.message)) {
        throw error;
      }

      // If this was the last attempt, throw
      if (attempt >= maxAttempts) {
        throw error;
      }

      // Track fault tolerance events (Issue #1173)
      incrementCounter("retryAttempts");
      const lower = error.message.toLowerCase();
      if (lower.includes("http 429") || lower.includes("rate limit")) {
        incrementCounter("rateLimitBackoffs");
      }

      // Notify about retry
      if (onRetry) {
        onRetry(attempt, error);
      }

      // Wait with exponential backoff + jitter
      const jitter = calculateJitter(delay);
      await sleepFn(delay + jitter);

      // Double the delay for next retry
      delay *= 2;
    }
  }

  // Should not reach here, but TypeScript needs a return
  throw new Error("retryWithBackoff: unexpected state");
}
