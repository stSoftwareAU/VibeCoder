/**
 * Tests for the logger module.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createLogger,
  formatDuration,
  formatTimestamp,
  LOG_LEVELS,
  type LogLevel,
} from "../lib/logger.ts";

Deno.test("logger - formatTimestamp returns ISO-like format with UTC Z suffix", () => {
  // Issue #1904: timestamps must include a `Z` suffix so worker logs are
  // unambiguous (previously the format was `YYYY-MM-DD HH:MM:SS` with no
  // timezone label, mixing with local-time shell logs in worker-*.log).
  const timestamp = formatTimestamp(new Date("2024-01-15T10:30:45.123Z"));
  assertEquals(timestamp, "2024-01-15 10:30:45Z");
});

Deno.test("logger - createLogger returns logger with all methods", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  assertEquals(typeof logger.info, "function");
  assertEquals(typeof logger.warn, "function");
  assertEquals(typeof logger.error, "function");
  assertEquals(typeof logger.debug, "function");
  assertEquals(typeof logger.security, "function");
});

Deno.test("logger - info logs with timestamp and INFO prefix", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  logger.info("Test message");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "INFO");
  assertStringIncludes(output[0]!, "Test message");
});

Deno.test("logger - warn logs with WARNING prefix", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  logger.warn("Warning message");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "WARNING");
  assertStringIncludes(output[0]!, "Warning message");
});

Deno.test("logger - error logs with ERROR prefix", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  logger.error("Error message");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "ERROR");
  assertStringIncludes(output[0]!, "Error message");
});

Deno.test("logger - debug logs only when debug is enabled", () => {
  const output: string[] = [];

  // Debug disabled
  const loggerNoDebug = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });
  loggerNoDebug.debug("Debug message 1");
  assertEquals(output.length, 0);

  // Debug enabled
  const loggerWithDebug = createLogger({
    write: (msg) => output.push(msg),
    debug: true,
  });
  loggerWithDebug.debug("Debug message 2");
  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "DEBUG");
  assertStringIncludes(output[0]!, "Debug message 2");
});

Deno.test("logger - security logs with SECURITY prefix and structured format", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  logger.security("ISSUE_PICKED_UP", "repo=org/repo issue=123");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[SECURITY]");
  assertStringIncludes(output[0]!, "ISSUE_PICKED_UP");
  assertStringIncludes(output[0]!, "repo=org/repo issue=123");
});

// =============================================================================
// Additional logger tests (Issue #218)
// =============================================================================

Deno.test("logger - createLogger with no options uses defaults", () => {
  // createLogger() with no args should not throw
  const logger = createLogger();
  assertEquals(typeof logger.info, "function");
  assertEquals(typeof logger.debug, "function");
});

Deno.test("logger - formatTimestamp pads single-digit values", () => {
  // January 5th, 3:4:7 AM UTC (Issue #1904: `Z` suffix added)
  const timestamp = formatTimestamp(new Date("2024-01-05T03:04:07Z"));
  assertEquals(timestamp, "2024-01-05 03:04:07Z");
});

Deno.test("logger - formatTimestamp handles midnight", () => {
  const timestamp = formatTimestamp(new Date("2024-12-31T00:00:00Z"));
  assertEquals(timestamp, "2024-12-31 00:00:00Z");
});

Deno.test("logger - formatTimestamp handles end of day", () => {
  const timestamp = formatTimestamp(new Date("2024-06-15T23:59:59Z"));
  assertEquals(timestamp, "2024-06-15 23:59:59Z");
});

Deno.test("logger - multiple log calls produce multiple output lines", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    debug: false,
  });

  logger.info("First");
  logger.warn("Second");
  logger.error("Third");

  assertEquals(output.length, 3);
  assertStringIncludes(output[0]!, "First");
  assertStringIncludes(output[1]!, "Second");
  assertStringIncludes(output[2]!, "Third");
});

Deno.test("logger - debug disabled by default", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    // debug is not set, defaults to false
  });

  logger.debug("Should not appear");
  assertEquals(output.length, 0);
});

Deno.test("logger - log output contains timestamp pattern", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.info("Timestamp test");

  // Issue #1904: Should contain a UTC timestamp pattern [YYYY-MM-DD HH:MM:SSZ]
  // The `Z` suffix labels the timezone explicitly.
  const timestampPattern = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\] /;
  assertEquals(timestampPattern.test(output[0]!), true);
});

Deno.test("logger - security event and details are separated by brackets", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.security("AUTH_FAILURE", "user=baduser");

  assertStringIncludes(output[0]!, "[AUTH_FAILURE]");
  assertStringIncludes(output[0]!, "user=baduser");
});

// =============================================================================
// Log level filtering tests (Issue #219)
// =============================================================================

Deno.test("logger - LOG_LEVELS contains all four levels in order", () => {
  assertEquals(LOG_LEVELS.DEBUG, 0);
  assertEquals(LOG_LEVELS.INFO, 1);
  assertEquals(LOG_LEVELS.WARNING, 2);
  assertEquals(LOG_LEVELS.ERROR, 3);
});

Deno.test("logger - logLevel ERROR suppresses INFO, WARNING, and DEBUG", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "ERROR",
  });

  logger.debug("debug msg");
  logger.info("info msg");
  logger.warn("warn msg");
  logger.error("error msg");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "error msg");
});

Deno.test("logger - logLevel WARNING suppresses INFO and DEBUG", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "WARNING",
  });

  logger.debug("debug msg");
  logger.info("info msg");
  logger.warn("warn msg");
  logger.error("error msg");

  assertEquals(output.length, 2);
  assertStringIncludes(output[0]!, "warn msg");
  assertStringIncludes(output[1]!, "error msg");
});

Deno.test("logger - logLevel INFO suppresses DEBUG only", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "INFO",
  });

  logger.debug("debug msg");
  logger.info("info msg");
  logger.warn("warn msg");
  logger.error("error msg");

  assertEquals(output.length, 3);
  assertStringIncludes(output[0]!, "info msg");
  assertStringIncludes(output[1]!, "warn msg");
  assertStringIncludes(output[2]!, "error msg");
});

Deno.test("logger - logLevel DEBUG allows all levels", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "DEBUG",
  });

  logger.debug("debug msg");
  logger.info("info msg");
  logger.warn("warn msg");
  logger.error("error msg");

  assertEquals(output.length, 4);
});

Deno.test("logger - default logLevel is INFO (debug suppressed)", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    // logLevel not set, defaults to INFO
  });

  logger.debug("debug msg");
  logger.info("info msg");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "info msg");
});

Deno.test("logger - security events are always logged regardless of logLevel", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "ERROR",
  });

  logger.security("IMPORTANT_EVENT", "key=value");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[SECURITY]");
});

Deno.test("logger - structured logging with key=value pairs", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "DEBUG",
  });

  logger.info("Processing issue", { repo: "org/repo", issue: 42 });

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "repo=org/repo");
  assertStringIncludes(output[0]!, "issue=42");
});

Deno.test("logger - structured logging with empty context omits key=value", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.info("Simple message");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "INFO: Simple message");
});

Deno.test("logger - structured context handles string values", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.warn("Check failed", { reason: "timeout", duration: "30s" });

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "reason=timeout");
  assertStringIncludes(output[0]!, "duration=30s");
});

Deno.test("logger - logLevel type is exported correctly", () => {
  // Verify that LogLevel type covers all valid levels
  const levels: LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR"];
  assertEquals(levels.length, 4);
});

// =============================================================================
// formatDuration tests (Issue #906 — migrated from logging.sh)
// =============================================================================

Deno.test("logger - formatDuration returns seconds for short durations", () => {
  assertEquals(formatDuration(0), "0s");
  assertEquals(formatDuration(45), "45s");
  assertEquals(formatDuration(59), "59s");
});

Deno.test("logger - formatDuration returns minutes and seconds", () => {
  assertEquals(formatDuration(60), "1m 0s");
  assertEquals(formatDuration(125), "2m 5s");
  assertEquals(formatDuration(3599), "59m 59s");
});

Deno.test("logger - formatDuration returns hours and minutes", () => {
  assertEquals(formatDuration(3600), "1h 0m");
  assertEquals(formatDuration(7380), "2h 3m");
  assertEquals(formatDuration(845), "14m 5s");
});

// =============================================================================
// skipReason tests (Issue #906 — migrated from logging.sh)
// =============================================================================

Deno.test("logger - skipReason logs with [SKIP] prefix at DEBUG level", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "DEBUG",
  });

  logger.skipReason("REPO_HAS_OPEN_PR", "repo=owner/repo issue=42");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[SKIP]");
  assertStringIncludes(output[0]!, "[REPO_HAS_OPEN_PR]");
  assertStringIncludes(output[0]!, "repo=owner/repo issue=42");
});

Deno.test("logger - skipReason is suppressed at INFO level", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "INFO",
  });

  logger.skipReason("REPO_HAS_OPEN_PR", "repo=owner/repo issue=42");
  assertEquals(output.length, 0);
});

// =============================================================================
// timing tests (Issue #906 — migrated from logging.sh)
// =============================================================================

Deno.test("logger - timing logs with [TIMING] prefix and duration", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.timing("CLAUDE_EXECUTION", 845, "repo=owner/repo issue=42");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[TIMING]");
  assertStringIncludes(output[0]!, "[CLAUDE_EXECUTION]");
  assertStringIncludes(output[0]!, "duration=845s");
  assertStringIncludes(output[0]!, "human=14m 5s");
  assertStringIncludes(output[0]!, "repo=owner/repo issue=42");
});

Deno.test("logger - timing works without optional details", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.timing("GIT_FETCH", 5);

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[TIMING]");
  assertStringIncludes(output[0]!, "duration=5s");
  assertStringIncludes(output[0]!, "human=5s");
});

Deno.test("logger - timing is suppressed at WARNING level", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "WARNING",
  });

  logger.timing("CLAUDE_EXECUTION", 100);
  assertEquals(output.length, 0);
});

// =============================================================================
// scanSummary tests (Issue #906 — migrated from logging.sh)
// =============================================================================

Deno.test("logger - scanSummary logs structured scan results", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.scanSummary(5, 3, 2, "REPO_HAS_OPEN_PR,ISSUE_IN_COOLDOWN");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[SCAN_SUMMARY]");
  assertStringIncludes(output[0]!, "repos_scanned=5");
  assertStringIncludes(output[0]!, "issues_found=3");
  assertStringIncludes(output[0]!, "issues_skipped=2");
  assertStringIncludes(
    output[0]!,
    "reasons=REPO_HAS_OPEN_PR,ISSUE_IN_COOLDOWN",
  );
});

Deno.test("logger - scanSummary defaults skip reasons to none", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.scanSummary(3, 1, 0);

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "reasons=none");
});

// =============================================================================
// workerSummary tests (Issue #906 — migrated from logging.sh)
// =============================================================================

Deno.test("logger - workerSummary logs structured worker statistics", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.workerSummary(10, 7200);

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[WORKER_SUMMARY]");
  assertStringIncludes(output[0]!, "issues_processed=10");
  assertStringIncludes(output[0]!, "duration=7200s");
  assertStringIncludes(output[0]!, "human=2h 0m");
  assertStringIncludes(output[0]!, "avg=720s_per_issue");
});

Deno.test("logger - workerSummary handles zero issues processed", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.workerSummary(0, 300);

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "avg=0s_per_issue");
});

// =============================================================================
// security format change test (Issue #906)
// =============================================================================

// =============================================================================
// UTC `Z` suffix coverage across every line type (Issue #1904)
// =============================================================================

Deno.test("logger - every line type carries the [YYYY-MM-DD HH:MM:SSZ] prefix", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
    logLevel: "DEBUG",
  });

  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  logger.security("EVT", "k=v");
  logger.skipReason("CODE", "details");
  logger.timing("OP", 5);
  logger.scanSummary(1, 2, 3);
  logger.workerSummary(1, 60);

  // Every line must start with [YYYY-MM-DD HH:MM:SSZ] — same TZ token,
  // unambiguous across machine moves, DST, and multi-region deployments.
  const linePrefix = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\] /;
  assertEquals(output.length, 9);
  for (const line of output) {
    assertEquals(
      linePrefix.test(line),
      true,
      `line is missing the UTC Z prefix: ${line}`,
    );
  }
});

Deno.test("logger - security uses bracketed event type format", () => {
  const output: string[] = [];
  const logger = createLogger({
    write: (msg) => output.push(msg),
  });

  logger.security("ISSUE_PICKED_UP", "repo=org/repo issue=123");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[SECURITY]");
  assertStringIncludes(output[0]!, "[ISSUE_PICKED_UP]");
  assertStringIncludes(output[0]!, "repo=org/repo issue=123");
});

// =============================================================================
// Secret redaction in the write path (Issue #2417)
// =============================================================================

Deno.test("logger - redacts a tokenised clone URL in an error message", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (msg) => output.push(msg) });
  const token = "ghp_" + "Z".repeat(36);

  logger.error(
    `git clone failed: https://x-access-token:${token}@github.com/org/repo.git`,
  );

  assertEquals(output.length, 1);
  assertEquals(output[0]!.includes(token), false);
  // Host/path stays so the diagnostic remains useful.
  assertStringIncludes(output[0]!, "github.com/org/repo.git");
});

Deno.test("logger - redacts a secret carried in structured context", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (msg) => output.push(msg) });
  const token = "github_pat_" + "abc123DEF456".repeat(3);

  logger.info("auth configured", { token });

  assertEquals(output.length, 1);
  assertEquals(output[0]!.includes(token), false);
});

Deno.test("logger - redacts a secret echoed via the security channel", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (msg) => output.push(msg) });
  const key = "AKIAIOSFODNN7EXAMPLE";

  logger.security("CONFIG_LOADED", `aws_key=${key}`);

  assertEquals(output.length, 1);
  assertEquals(output[0]!.includes(key), false);
  assertStringIncludes(output[0]!, "[SECURITY]");
});

Deno.test("logger - leaves ordinary log lines unchanged", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (msg) => output.push(msg) });

  logger.info("Processing issue", { repo: "org/repo", phase: "planning" });

  assertStringIncludes(output[0]!, "Processing issue");
  assertStringIncludes(output[0]!, "repo=org/repo");
  assertStringIncludes(output[0]!, "phase=planning");
  assertEquals(output[0]!.includes("REDACTED"), false);
});
