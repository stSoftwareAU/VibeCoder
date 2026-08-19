/**
 * Tests for the retry utility module.
 *
 * Following TDD: These tests define the expected behaviour for
 * retryWithBackoff and isRetryableError.
 *
 * Issue #217 — Add retry resilience to GitHub API calls in TypeScript module.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  isRetryableError,
  type RetryOptions,
  retryWithBackoff,
} from "../lib/retry.ts";

// --- isRetryableError tests ---

Deno.test("retry - isRetryableError returns true for HTTP 500 errors", () => {
  assertEquals(isRetryableError("HTTP 500 Internal Server Error"), true);
});

Deno.test("retry - isRetryableError returns true for HTTP 502 errors", () => {
  assertEquals(isRetryableError("HTTP 502 Bad Gateway"), true);
});

Deno.test("retry - isRetryableError returns true for HTTP 503 errors", () => {
  assertEquals(isRetryableError("HTTP 503 Service Unavailable"), true);
});

Deno.test("retry - isRetryableError returns true for HTTP 504 errors", () => {
  assertEquals(isRetryableError("HTTP 504 Gateway Timeout"), true);
});

Deno.test("retry - isRetryableError returns true for HTTP 429 rate limiting", () => {
  assertEquals(isRetryableError("HTTP 429 Too Many Requests"), true);
});

Deno.test("retry - isRetryableError returns false for primary API rate limit (Issue #1521)", () => {
  // Primary rate-limit exhaustion is not retryable — the per-hour quota
  // only resets at the top of the hour, so retries within the window are
  // guaranteed to fail and burn ~30s of backoff.
  assertEquals(
    isRetryableError(
      "GraphQL: API rate limit already exceeded for user ID 23146043.",
    ),
    false,
  );
  assertEquals(isRetryableError("API rate limit exceeded"), false);
  assertEquals(isRetryableError("API rate limit already exceeded"), false);
  assertEquals(isRetryableError("rate limit has been exceeded"), false);
});

Deno.test("retry - isRetryableError still retries generic rate-limit messages", () => {
  // Non-primary mentions of "rate limit" remain retryable — secondary
  // limits and generic 429 responses clear quickly.
  assertEquals(isRetryableError("hit a rate limit, please try later"), true);
});

Deno.test("retry - isRetryableError returns true for timeout errors", () => {
  assertEquals(isRetryableError("connection timed out"), true);
  assertEquals(isRetryableError("request timeout"), true);
});

Deno.test("retry - isRetryableError returns true for connection refused", () => {
  assertEquals(isRetryableError("connection refused"), true);
});

Deno.test("retry - isRetryableError returns true for DNS resolution failure", () => {
  assertEquals(isRetryableError("could not resolve host"), true);
});

Deno.test("retry - isRetryableError returns true for network unreachable", () => {
  assertEquals(isRetryableError("network is unreachable"), true);
});

Deno.test("retry - isRetryableError returns true for SSL errors", () => {
  assertEquals(isRetryableError("SSL_ERROR_SYSCALL"), true);
  assertEquals(isRetryableError("tls handshake failure"), true);
});

Deno.test("retry - isRetryableError returns true for socket errors", () => {
  assertEquals(isRetryableError("broken pipe"), true);
  assertEquals(isRetryableError("reset by peer"), true);
});

Deno.test("retry - isRetryableError returns false for HTTP 401", () => {
  assertEquals(isRetryableError("HTTP 401 Unauthorized"), false);
});

Deno.test("retry - isRetryableError returns false for HTTP 403", () => {
  assertEquals(isRetryableError("HTTP 403 Forbidden"), false);
});

Deno.test("retry - isRetryableError returns true for GitHub secondary rate limit", () => {
  assertEquals(
    isRetryableError("HTTP 403: You have exceeded a secondary rate limit"),
    true,
  );
  assertEquals(
    isRetryableError(
      "gh command failed (exit 1): secondary rate limit exceeded",
    ),
    true,
  );
});

Deno.test("retry - isRetryableError returns true for GitHub abuse detection", () => {
  assertEquals(
    isRetryableError(
      "HTTP 403: You have triggered an abuse detection mechanism",
    ),
    true,
  );
});

Deno.test("retry - isRetryableError returns true for socket errors", () => {
  assertEquals(isRetryableError("ECONNRESET"), true);
  assertEquals(isRetryableError("socket hang up"), true);
});

Deno.test("retry - isRetryableError returns false for HTTP 404", () => {
  assertEquals(isRetryableError("HTTP 404 Not Found"), false);
});

Deno.test("retry - isRetryableError returns false for HTTP 422", () => {
  assertEquals(isRetryableError("HTTP 422 Unprocessable Entity"), false);
});

Deno.test("retry - isRetryableError returns false for permission denied", () => {
  assertEquals(isRetryableError("permission denied"), false);
});

Deno.test("retry - isRetryableError returns false for empty string", () => {
  assertEquals(isRetryableError(""), false);
});

Deno.test("retry - isRetryableError returns false for generic error", () => {
  assertEquals(isRetryableError("something went wrong"), false);
});

// --- retryWithBackoff tests ---

Deno.test("retry - retryWithBackoff returns result on first success", async () => {
  const result = await retryWithBackoff(
    async () => "success",
    { maxAttempts: 3, initialDelayMs: 1, sleepFn: async () => {} },
  );
  assertEquals(result, "success");
});

Deno.test("retry - retryWithBackoff retries on transient errors and succeeds", async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("HTTP 503 Service Unavailable");
      }
      return "recovered";
    },
    { maxAttempts: 4, initialDelayMs: 1, sleepFn: async () => {} },
  );
  assertEquals(result, "recovered");
  assertEquals(attempts, 3);
});

Deno.test("retry - retryWithBackoff throws immediately on permanent errors", async () => {
  let attempts = 0;
  await assertRejects(
    async () => {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("HTTP 404 Not Found");
        },
        { maxAttempts: 4, initialDelayMs: 1, sleepFn: async () => {} },
      );
    },
    Error,
    "HTTP 404 Not Found",
  );
  assertEquals(attempts, 1);
});

Deno.test("retry - retryWithBackoff throws after exhausting all attempts", async () => {
  let attempts = 0;
  await assertRejects(
    async () => {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("HTTP 500 Internal Server Error");
        },
        { maxAttempts: 3, initialDelayMs: 1, sleepFn: async () => {} },
      );
    },
    Error,
    "HTTP 500 Internal Server Error",
  );
  assertEquals(attempts, 3);
});

Deno.test("retry - retryWithBackoff uses exponential backoff delays", async () => {
  const delays: number[] = [];
  let attempts = 0;

  await assertRejects(
    async () => {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("HTTP 500 error");
        },
        {
          maxAttempts: 4,
          initialDelayMs: 100,
          sleepFn: async (ms: number) => {
            delays.push(ms);
          },
        },
      );
    },
    Error,
  );

  // 3 retries after 4 attempts (no sleep before first attempt)
  assertEquals(delays.length, 3);
  // First delay should be around initialDelayMs (100) plus jitter
  assertEquals(delays[0]! >= 100, true);
  assertEquals(delays[0]! <= 200, true);
  // Second delay should be around 200 plus jitter
  assertEquals(delays[1]! >= 200, true);
  assertEquals(delays[1]! <= 400, true);
  // Third delay should be around 400 plus jitter
  assertEquals(delays[2]! >= 400, true);
  assertEquals(delays[2]! <= 800, true);
});

Deno.test("retry - retryWithBackoff calls onRetry callback", async () => {
  const retryLogs: Array<{ attempt: number; error: Error }> = [];
  let attempts = 0;

  await assertRejects(
    async () => {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("HTTP 502 Bad Gateway");
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1,
          sleepFn: async () => {},
          onRetry: (attempt: number, error: Error) => {
            retryLogs.push({ attempt, error });
          },
        },
      );
    },
    Error,
  );

  assertEquals(retryLogs.length, 2);
  assertEquals(retryLogs[0]!.attempt, 1);
  assertEquals(retryLogs[1]!.attempt, 2);
  assertEquals(retryLogs[0]!.error.message, "HTTP 502 Bad Gateway");
});

Deno.test("retry - retryWithBackoff uses default options when none provided", async () => {
  // Should succeed on first try with defaults
  const result = await retryWithBackoff(async () => "ok");
  assertEquals(result, "ok");
});

Deno.test("retry - retryWithBackoff handles non-Error throws as non-retryable", async () => {
  let attempts = 0;
  await assertRejects(
    async () => {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw "string error";
        },
        { maxAttempts: 3, initialDelayMs: 1, sleepFn: async () => {} },
      );
    },
    Error,
  );
  // Non-Error throws are treated as non-retryable (permanent)
  assertEquals(attempts, 1);
});

// --- RetryOptions type tests ---

Deno.test("retry - RetryOptions allows partial options", async () => {
  const opts: RetryOptions = { maxAttempts: 2 };
  const result = await retryWithBackoff(async () => "ok", opts);
  assertEquals(result, "ok");
});

Deno.test("retryWithBackoff - under `deno test` the DEFAULT back-off sleep is a no-op; attempts are unchanged (Issue #4347)", async () => {
  let attempts = 0;
  const start = Date.now();
  await assertRejects(() =>
    retryWithBackoff(() => {
      attempts++;
      return Promise.reject(new Error("HTTP 503 Service Unavailable"));
    }, { maxAttempts: 4, initialDelayMs: 2000 })
  );
  assertEquals(attempts, 4);
  // 2 s + 4 s + 8 s would be 14 s with real sleeps; under the test runner
  // the whole retry ladder completes in well under a second.
  assertEquals(Date.now() - start < 1000, true);
});
