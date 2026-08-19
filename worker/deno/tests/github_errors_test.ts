/**
 * Consolidated tests for github_errors.ts — error classification and retry logic
 * (Issues #630, #690, #1304).
 *
 * Provides comprehensive coverage of classifyGitHubError including edge cases
 * for malformed messages, mixed signals, case sensitivity, gh command prefix
 * wrapping, and retry eligibility.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  classifyGitHubError,
  GitHubErrorCategory,
} from "../lib/github_errors.ts";
import type { GitHubErrorClassification } from "../lib/github_errors.ts";

// =============================================================================
// Rate limit classification
// =============================================================================

Deno.test("github_errors - HTTP 429 is classified as rate limit", () => {
  const result = classifyGitHubError("HTTP 429 Too Many Requests");
  assertEquals(result.category, GitHubErrorCategory.RateLimit);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - rate limit text without HTTP code is classified as rate limit", () => {
  const result = classifyGitHubError(
    "You have exceeded your rate limit. Please wait.",
  );
  assertEquals(result.category, GitHubErrorCategory.RateLimit);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - 'API rate limit exceeded' text is classified as rate limit", () => {
  const result = classifyGitHubError("API rate limit exceeded for user");
  assertEquals(result.category, GitHubErrorCategory.RateLimit);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - rate limit takes priority over 4xx pattern", () => {
  // 429 is a 4xx code but should be classified as rate limit, not unknown
  const result = classifyGitHubError("HTTP 429 rate limit exceeded");
  assertEquals(result.category, GitHubErrorCategory.RateLimit);
});

// =============================================================================
// Transient server errors (5xx)
// =============================================================================

Deno.test("github_errors - HTTP 500 is classified as transient server", () => {
  const result = classifyGitHubError("HTTP 500 Internal Server Error");
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - HTTP 502 Bad Gateway is classified as transient server", () => {
  const result = classifyGitHubError("HTTP 502 Bad Gateway");
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - HTTP 500 with gh command prefix is classified as transient server", () => {
  const result = classifyGitHubError(
    "gh command failed (exit 1): HTTP 500 Internal Server Error",
  );
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - HTTP 502 with gh command prefix is classified as transient server", () => {
  const result = classifyGitHubError(
    "gh command failed (exit 1): HTTP 502 Bad Gateway",
  );
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - HTTP 503 is classified as transient server", () => {
  const result = classifyGitHubError("HTTP 503 Service Unavailable");
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - HTTP 504 Gateway Timeout is classified as transient server", () => {
  const result = classifyGitHubError("HTTP 504 Gateway Timeout");
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - mixed case HTTP 503 is still classified as transient", () => {
  const result = classifyGitHubError("http 503 Service Unavailable");
  assertEquals(result.category, GitHubErrorCategory.TransientServer);
  assertEquals(result.isRetryable, true);
});

// =============================================================================
// Authentication errors
// =============================================================================

Deno.test("github_errors - HTTP 401 is classified as authentication error", () => {
  const result = classifyGitHubError("HTTP 401 Unauthorized");
  assertEquals(result.category, GitHubErrorCategory.Authentication);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - 'unauthorized' text without HTTP code is classified as authentication", () => {
  const result = classifyGitHubError("Request unauthorized: bad credentials");
  assertEquals(result.category, GitHubErrorCategory.Authentication);
  assertEquals(result.isRetryable, false);
});

// =============================================================================
// Permission errors
// =============================================================================

Deno.test("github_errors - HTTP 403 is classified as permission error", () => {
  const result = classifyGitHubError("HTTP 403 Forbidden");
  assertEquals(result.category, GitHubErrorCategory.Permission);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - 'forbidden' text without HTTP code is classified as permission", () => {
  const result = classifyGitHubError("Access forbidden for this resource");
  assertEquals(result.category, GitHubErrorCategory.Permission);
  assertEquals(result.isRetryable, false);
});

// =============================================================================
// Not found errors
// =============================================================================

Deno.test("github_errors - HTTP 404 is classified as not found", () => {
  const result = classifyGitHubError("HTTP 404 Not Found");
  assertEquals(result.category, GitHubErrorCategory.NotFound);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - 'could not resolve to a repository' is classified as not found", () => {
  const result = classifyGitHubError(
    "Could not resolve to a Repository with the name 'org/nonexistent'",
  );
  assertEquals(result.category, GitHubErrorCategory.NotFound);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - generic 'not found' text is classified as not found", () => {
  const result = classifyGitHubError("Issue not found in repository");
  assertEquals(result.category, GitHubErrorCategory.NotFound);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - 'could not resolve to a repository' with gh command prefix is classified as not found", () => {
  const result = classifyGitHubError(
    "gh command failed (exit 1): Could not resolve to a Repository with the name 'org/nonexistent'",
  );
  assertEquals(result.category, GitHubErrorCategory.NotFound);
  assertEquals(result.isRetryable, false);
});

// =============================================================================
// Network errors
// =============================================================================

Deno.test("github_errors - connection timeout is classified as network error", () => {
  const result = classifyGitHubError("connection timed out after 30s");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - 'timeout' keyword is classified as network error", () => {
  const result = classifyGitHubError("request timeout");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - connection refused is classified as network error", () => {
  const result = classifyGitHubError("connection refused");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - DNS failure is classified as network error", () => {
  const result = classifyGitHubError("could not resolve host: api.github.com");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - TLS handshake failure is classified as network error", () => {
  const result = classifyGitHubError("tls handshake failed");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - broken pipe is classified as network error", () => {
  const result = classifyGitHubError("write: broken pipe");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - reset by peer is classified as network error", () => {
  const result = classifyGitHubError("connection reset by peer");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - SSL error is classified as network error", () => {
  const result = classifyGitHubError("ssl_error: certificate verify failed");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - RPC failure is classified as network error", () => {
  const result = classifyGitHubError("error: rpc failed; curl 56 recv failure");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - unexpected disconnect is classified as network error", () => {
  const result = classifyGitHubError(
    "fatal: unexpected disconnect while reading",
  );
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - network unreachable is classified as network error", () => {
  const result = classifyGitHubError("network is unreachable");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

Deno.test("github_errors - no route to host is classified as network error", () => {
  const result = classifyGitHubError("connect: no route to host");
  assertEquals(result.category, GitHubErrorCategory.Network);
  assertEquals(result.isRetryable, true);
});

// =============================================================================
// Validation errors
// =============================================================================

Deno.test("github_errors - HTTP 422 is classified as validation error", () => {
  const result = classifyGitHubError("HTTP 422 Unprocessable Entity");
  assertEquals(result.category, GitHubErrorCategory.Validation);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - 'unprocessable' text is classified as validation error", () => {
  const result = classifyGitHubError("Request was unprocessable");
  assertEquals(result.category, GitHubErrorCategory.Validation);
  assertEquals(result.isRetryable, false);
});

// =============================================================================
// Unknown / edge cases
// =============================================================================

Deno.test("github_errors - empty string is classified as unknown", () => {
  const result = classifyGitHubError("");
  assertEquals(result.category, GitHubErrorCategory.Unknown);
  assertEquals(result.isRetryable, false);
  assertEquals(result.message, "");
});

Deno.test("github_errors - unrecognised error message is classified as unknown", () => {
  const result = classifyGitHubError("something completely unexpected");
  assertEquals(result.category, GitHubErrorCategory.Unknown);
  assertEquals(result.isRetryable, false);
});

Deno.test("github_errors - classification preserves original message", () => {
  const msg = "HTTP 500 Internal Server Error — please try again";
  const result = classifyGitHubError(msg);
  assertEquals(result.message, msg);
});

Deno.test("github_errors - classification result has correct shape", () => {
  const result: GitHubErrorClassification = classifyGitHubError("HTTP 404");
  // Verify all expected properties exist and have correct types
  assertEquals(typeof result.category, "string");
  assertEquals(typeof result.isRetryable, "boolean");
  assertEquals(typeof result.message, "string");
});

// =============================================================================
// Retry eligibility summary — verify all categories have correct retry status
// =============================================================================

Deno.test("github_errors - all transient categories are retryable", () => {
  const transientCases = [
    "HTTP 500 Internal Server Error",
    "HTTP 429 rate limit exceeded",
    "connection timed out",
    "connection refused",
    "broken pipe",
  ];

  for (const msg of transientCases) {
    const result = classifyGitHubError(msg);
    assertEquals(
      result.isRetryable,
      true,
      `Expected "${msg}" to be retryable but got isRetryable=${result.isRetryable}`,
    );
  }
});

Deno.test("github_errors - all permanent categories are not retryable", () => {
  const permanentCases = [
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "HTTP 404 Not Found",
    "HTTP 422 Unprocessable Entity",
    "something unknown",
    "",
  ];

  for (const msg of permanentCases) {
    const result = classifyGitHubError(msg);
    assertEquals(
      result.isRetryable,
      false,
      `Expected "${msg}" to not be retryable but got isRetryable=${result.isRetryable}`,
    );
  }
});
