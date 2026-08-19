/**
 * GitHub error classification — transient vs permanent (Issue #630).
 *
 * Provides structured error classification for GitHub CLI errors,
 * distinguishing between retryable (transient) and non-retryable
 * (permanent) failures.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Categories of GitHub errors for structured error handling.
 */
export enum GitHubErrorCategory {
  /** HTTP 5xx server errors — transient, retryable */
  TransientServer = "transient_server",
  /** HTTP 429 or rate limit messages — transient, retryable */
  RateLimit = "rate_limit",
  /** Network timeouts, DNS failures, connection errors — transient, retryable */
  Network = "network",
  /** HTTP 401 — authentication failure, permanent */
  Authentication = "authentication",
  /** HTTP 403 — permission denied, permanent */
  Permission = "permission",
  /** HTTP 404 or resource not found — permanent */
  NotFound = "not_found",
  /** HTTP 422 or input validation failure — permanent */
  Validation = "validation",
  /** Unrecognised error — treated as permanent */
  Unknown = "unknown",
}

/**
 * Result of classifying a GitHub error.
 */
export interface GitHubErrorClassification {
  /** The error category */
  category: GitHubErrorCategory;
  /** Whether this error is transient and should be retried */
  isRetryable: boolean;
  /** The original error message */
  message: string;
}

/**
 * Classify a GitHub CLI error message into a structured category.
 *
 * This enables callers to handle different error types appropriately:
 * - Transient errors (server, rate limit, network) can be retried
 * - Permanent errors (auth, permission, not found, validation) should fail immediately
 *
 * @param errorMessage - The error message to classify
 * @returns Structured classification result
 */
export function classifyGitHubError(
  errorMessage: string,
): GitHubErrorClassification {
  if (!errorMessage) {
    return {
      category: GitHubErrorCategory.Unknown,
      isRetryable: false,
      message: errorMessage,
    };
  }

  const lower = errorMessage.toLowerCase();

  // --- Rate limiting (check before server errors since 429 is 4xx) ---
  if (lower.includes("http 429") || lower.includes("rate limit")) {
    return {
      category: GitHubErrorCategory.RateLimit,
      isRetryable: true,
      message: errorMessage,
    };
  }

  // --- HTTP 5xx server errors ---
  if (/http [5]\d{2}/i.test(errorMessage)) {
    return {
      category: GitHubErrorCategory.TransientServer,
      isRetryable: true,
      message: errorMessage,
    };
  }

  // --- Authentication (HTTP 401) ---
  if (lower.includes("http 401") || lower.includes("unauthorized")) {
    return {
      category: GitHubErrorCategory.Authentication,
      isRetryable: false,
      message: errorMessage,
    };
  }

  // --- Permission (HTTP 403) ---
  if (lower.includes("http 403") || lower.includes("forbidden")) {
    return {
      category: GitHubErrorCategory.Permission,
      isRetryable: false,
      message: errorMessage,
    };
  }

  // --- Not found (HTTP 404 or repo/issue not found) ---
  // Check before network errors because "could not resolve to a repository"
  // contains "could not resolve" which would otherwise match DNS errors.
  if (
    lower.includes("http 404") ||
    lower.includes("not found") ||
    lower.includes("could not resolve to a repository")
  ) {
    return {
      category: GitHubErrorCategory.NotFound,
      isRetryable: false,
      message: errorMessage,
    };
  }

  // --- Network/connection errors ---
  if (
    /timed?\s*out/i.test(errorMessage) ||
    lower.includes("timeout") ||
    lower.includes("connection refused") ||
    lower.includes("could not resolve") ||
    lower.includes("network is unreachable") ||
    lower.includes("no route to host") ||
    lower.includes("ssl_error") ||
    lower.includes("tls handshake") ||
    lower.includes("broken pipe") ||
    lower.includes("reset by peer") ||
    lower.includes("rpc failed") ||
    lower.includes("unexpected disconnect")
  ) {
    return {
      category: GitHubErrorCategory.Network,
      isRetryable: true,
      message: errorMessage,
    };
  }

  // --- Validation (HTTP 422) ---
  if (lower.includes("http 422") || lower.includes("unprocessable")) {
    return {
      category: GitHubErrorCategory.Validation,
      isRetryable: false,
      message: errorMessage,
    };
  }

  // --- Unknown ---
  return {
    category: GitHubErrorCategory.Unknown,
    isRetryable: false,
    message: errorMessage,
  };
}
