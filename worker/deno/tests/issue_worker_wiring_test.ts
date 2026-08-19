/**
 * Tests for issue_worker_wiring.ts — dependency injection and module wiring.
 *
 * Following TDD: tests written first to define expected behaviour.
 * Issue #962: Create issue_worker_wiring.ts — dependency injection and module wiring.
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { Logger } from "../types.ts";
import {
  type ClaudeDeps,
  type ConfigDeps,
  type CrashHandlingDeps,
  createDefaultDeps,
  createMockDeps,
  type FailureTrackingDeps,
  type GitDeps,
  type GitHubDeps,
  type InfrastructureDeps,
  type IssueDeps,
  type PrDeps,
  type QualityDeps,
  type SecurityDeps,
  type WorkerDeps,
} from "../lib/issue_worker_wiring.ts";

// ---------------------------------------------------------------------------
// createDefaultDeps — returns complete WorkerDeps with no undefined properties
// ---------------------------------------------------------------------------

Deno.test("createDefaultDeps - returns a WorkerDeps with all top-level properties defined", () => {
  const deps = createDefaultDeps();

  assertExists(deps.logger, "logger must be defined");
  assertExists(deps.config, "config must be defined");
  assertExists(deps.github, "github must be defined");
  assertExists(deps.git, "git must be defined");
  assertExists(deps.issues, "issues must be defined");
  assertExists(deps.pr, "pr must be defined");
  assertExists(deps.claude, "claude must be defined");
  assertExists(deps.security, "security must be defined");
  assertExists(deps.failureTracking, "failureTracking must be defined");
  assertExists(deps.crashHandling, "crashHandling must be defined");
  assertExists(deps.infrastructure, "infrastructure must be defined");
  assertExists(deps.quality, "quality must be defined");
});

Deno.test("createDefaultDeps - logger has all required methods", () => {
  const deps = createDefaultDeps();
  const logger = deps.logger;

  assertEquals(typeof logger.info, "function");
  assertEquals(typeof logger.warn, "function");
  assertEquals(typeof logger.error, "function");
  assertEquals(typeof logger.debug, "function");
  assertEquals(typeof logger.security, "function");
  assertEquals(typeof logger.skipReason, "function");
  assertEquals(typeof logger.timing, "function");
  assertEquals(typeof logger.scanSummary, "function");
  assertEquals(typeof logger.workerSummary, "function");
});

Deno.test("createDefaultDeps - github deps has all required functions", () => {
  const deps = createDefaultDeps();
  const github = deps.github;

  assertEquals(typeof github.createClient, "function");
  assertEquals(typeof github.safeGhCommand, "function");
  assertEquals(typeof github.runGhCommand, "function");
  assertEquals(typeof github.ensureLabelExists, "function");
  assertEquals(typeof github.handleIssueFailure, "function");
  assertEquals(typeof github.checkGhAuth, "function");
});

Deno.test("createDefaultDeps - git deps has all required functions", () => {
  const deps = createDefaultDeps();
  const git = deps.git;

  assertEquals(typeof git.createBranchName, "function");
  assertEquals(typeof git.createFeatureBranchFromBase, "function");
  assertEquals(typeof git.pushUnpushedCommits, "function");
  assertEquals(typeof git.ensureDefaultBranchCurrent, "function");
  assertEquals(typeof git.resolveRebaseConflicts, "function");
  assertEquals(typeof git.recoverGitState, "function");
  assertEquals(typeof git.runGitCommand, "function");
  assertEquals(typeof git.syncFeatureBranchWithDefault, "function");
  assertEquals(typeof git.recoverFromPushRejection, "function");
  assertEquals(typeof git.validateRepoState, "function");
  assertEquals(typeof git.captureBranchHead, "function");
  assertEquals(typeof git.branchHeadChanged, "function");
});

Deno.test("createDefaultDeps - issue deps has all required functions", () => {
  const deps = createDefaultDeps();
  const issues = deps.issues;

  assertEquals(typeof issues.findOldestIssue, "function");
  assertEquals(typeof issues.findIssuesByLabel, "function");
  assertEquals(typeof issues.fetchIssueData, "function");
  assertEquals(typeof issues.createIssueCache, "function");
  assertEquals(typeof issues.claimIssue, "function");
  assertEquals(typeof issues.checkClaimChurn, "function");
  assertEquals(typeof issues.filterAndSort, "function");
  assertEquals(typeof issues.filterByAllowedAuthors, "function");
  assertEquals(typeof issues.selectHighestPriority, "function");
  assertEquals(typeof issues.fetchAllIssues, "function");
  assertEquals(typeof issues.getBlockingPRForIssue, "function");
  assertEquals(typeof issues.checkParentBlocked, "function");
  assertEquals(typeof issues.isIssueInCooldown, "function");
});

Deno.test("createDefaultDeps - pr deps has all required functions", () => {
  const deps = createDefaultDeps();
  const pr = deps.pr;

  assertEquals(typeof pr.enableAutoMerge, "function");
  assertEquals(typeof pr.finalisePr, "function");
  assertEquals(typeof pr.markCommentProcessed, "function");
  assertEquals(typeof pr.handlePrCommentFailure, "function");
  assertEquals(typeof pr.validatePrEvidence, "function");
  assertEquals(typeof pr.retargetPrToMilestone, "function");
  assertEquals(typeof pr.ensurePrReferencesIssue, "function");
  assertEquals(typeof pr.linkPrToIssue, "function");
  assertEquals(typeof pr.findExistingPrForIssue, "function");
  assertEquals(typeof pr.closeDuplicatePrs, "function");
  assertEquals(typeof pr.checkCiStatus, "function");
  assertEquals(typeof pr.directMergePr, "function");
});

Deno.test("createDefaultDeps - claude deps has all required functions", () => {
  const deps = createDefaultDeps();
  const claude = deps.claude;

  assertEquals(typeof claude.runClaudeWithRetry, "function");
  assertEquals(typeof claude.runHealthCheck, "function");
  assertEquals(typeof claude.isClaudeAuthError, "function");
  // executeClaudeCommand removed (Issue #2739) — was an unused no-fallback trap.
  assertEquals(typeof claude.buildClaudeModelArgs, "function");
  assertEquals(typeof claude.isHealthCacheValid, "function");
  assertEquals(typeof claude.recordHealthCheckSuccess, "function");
});

Deno.test("createDefaultDeps - config deps has all required functions", () => {
  const deps = createDefaultDeps();
  const config = deps.config;

  assertEquals(typeof config.loadConfig, "function");
  assertEquals(typeof config.validateConfig, "function");
  assertEquals(typeof config.validateConfigFull, "function");
  assertEquals(typeof config.buildDefaultWorkerConfig, "function");
  assertEquals(typeof config.isRepoAllowed, "function");
});

Deno.test("createDefaultDeps - security deps has all required functions", () => {
  const deps = createDefaultDeps();
  const security = deps.security;

  assertEquals(typeof security.validateIssueInput, "function");
  assertEquals(typeof security.detectSuspiciousPatterns, "function");
  assertEquals(typeof security.isAuthorisedCommenter, "function");
  assertEquals(typeof security.detectBotAccounts, "function");
});

Deno.test("createDefaultDeps - failureTracking deps has all required functions", () => {
  const deps = createDefaultDeps();
  const ft = deps.failureTracking;

  assertEquals(typeof ft.trackFailure, "function");
  assertEquals(typeof ft.shouldExitOnFailures, "function");
  assertEquals(typeof ft.resetFailures, "function");
  assertEquals(typeof ft.recordIssueCooldown, "function");
  assertEquals(typeof ft.isIssueInCooldown, "function");
  assertEquals(typeof ft.recordZeroProgress, "function");
  assertEquals(typeof ft.getSleepInterval, "function");
  assertEquals(typeof ft.recordRepoFailure, "function");
  assertEquals(typeof ft.isRepoDeprioritised, "function");
  assertEquals(typeof ft.detectFailureCategory, "function");
});

Deno.test("createDefaultDeps - crashHandling deps has all required functions", () => {
  const deps = createDefaultDeps();
  const ch = deps.crashHandling;

  assertEquals(typeof ch.cleanupInProgressIssue, "function");
  assertEquals(typeof ch.sendCrashNotification, "function");
  assertEquals(typeof ch.detectAndRecoverStuckIssues, "function");
  assertEquals(typeof ch.recordHeartbeat, "function");
  assertEquals(typeof ch.clearHeartbeat, "function");
});

Deno.test("createDefaultDeps - infrastructure deps has all required functions", () => {
  const deps = createDefaultDeps();
  const infra = deps.infrastructure;

  assertEquals(typeof infra.atomicWrite, "function");
  assertEquals(typeof infra.safeReadFile, "function");
  assertEquals(typeof infra.safeMktemp, "function");
  assertEquals(typeof infra.checkAndCleanupDiskSpace, "function");
  assertEquals(typeof infra.checkAndRotateLog, "function");
  assertEquals(typeof infra.buildPrompt, "function");
  assertEquals(typeof infra.loadPrompt, "function");
  assertEquals(typeof infra.shuffleArray, "function");
  assertEquals(typeof infra.evaluateRunGuard, "function");
});

Deno.test("createDefaultDeps - quality deps has all required functions", () => {
  const deps = createDefaultDeps();
  const q = deps.quality;

  assertEquals(typeof q.runQualityGate, "function");
  assertEquals(typeof q.formatSummary, "function");
});

// ---------------------------------------------------------------------------
// createDefaultDeps — no undefined nested properties
// ---------------------------------------------------------------------------

Deno.test("createDefaultDeps - no undefined properties in any sub-interface", () => {
  const deps = createDefaultDeps();

  // Check each sub-interface has no undefined values using Object.entries
  // on the runtime object (cast needed because typeof-based interfaces
  // lack an index signature).
  const subInterfaces: Array<[string, object]> = [
    ["github", deps.github],
    ["git", deps.git],
    ["issues", deps.issues],
    ["pr", deps.pr],
    ["claude", deps.claude],
    ["config", deps.config],
    ["security", deps.security],
    ["failureTracking", deps.failureTracking],
    ["crashHandling", deps.crashHandling],
    ["infrastructure", deps.infrastructure],
    ["quality", deps.quality],
  ];

  for (const [name, obj] of subInterfaces) {
    for (const [key, value] of Object.entries(obj)) {
      assertNotEquals(
        value,
        undefined,
        `${name}.${key} must not be undefined`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// createMockDeps — returns a testable WorkerDeps
// ---------------------------------------------------------------------------

Deno.test("createMockDeps - returns a WorkerDeps with all top-level properties defined", () => {
  const deps = createMockDeps();

  assertExists(deps.logger, "logger must be defined");
  assertExists(deps.config, "config must be defined");
  assertExists(deps.github, "github must be defined");
  assertExists(deps.git, "git must be defined");
  assertExists(deps.issues, "issues must be defined");
  assertExists(deps.pr, "pr must be defined");
  assertExists(deps.claude, "claude must be defined");
  assertExists(deps.security, "security must be defined");
  assertExists(deps.failureTracking, "failureTracking must be defined");
  assertExists(deps.crashHandling, "crashHandling must be defined");
  assertExists(deps.infrastructure, "infrastructure must be defined");
  assertExists(deps.quality, "quality must be defined");
});

Deno.test("createMockDeps - no undefined properties in any sub-interface", () => {
  const deps = createMockDeps();

  const subInterfaces: Array<[string, object]> = [
    ["github", deps.github],
    ["git", deps.git],
    ["issues", deps.issues],
    ["pr", deps.pr],
    ["claude", deps.claude],
    ["config", deps.config],
    ["security", deps.security],
    ["failureTracking", deps.failureTracking],
    ["crashHandling", deps.crashHandling],
    ["infrastructure", deps.infrastructure],
    ["quality", deps.quality],
  ];

  for (const [name, obj] of subInterfaces) {
    for (const [key, value] of Object.entries(obj)) {
      assertNotEquals(
        value,
        undefined,
        `${name}.${key} must not be undefined`,
      );
    }
  }
});

Deno.test("createMockDeps - mock logger does not throw", () => {
  const deps = createMockDeps();

  // All logger methods should be callable without throwing
  deps.logger.info("test");
  deps.logger.warn("test");
  deps.logger.error("test");
  deps.logger.debug("test");
  deps.logger.security("event", "details");
  deps.logger.skipReason("code", "details");
  deps.logger.timing("op", 1.5);
  deps.logger.scanSummary(5, 3, 2);
  deps.logger.workerSummary(10, 60);
});

Deno.test("createMockDeps - mock security returns safe defaults", () => {
  const deps = createMockDeps();

  const result = deps.security.validateIssueInput("title", "body");
  assertEquals(result.titleSuspicious, false);
  assertEquals(result.bodySuspicious, false);

  const patternResult = deps.security.detectSuspiciousPatterns("safe text");
  assertEquals(patternResult.detected, false);

  const isAuthorised = deps.security.isAuthorisedCommenter("user", ["user"]);
  assertEquals(isAuthorised, true);
});

Deno.test("createMockDeps - mock config returns valid defaults", async () => {
  const deps = createMockDeps();

  const config = await deps.config.loadConfig("test.json");
  assertExists(config);
  assertEquals(typeof config.repos, "object");

  const defaultConfig = deps.config.buildDefaultWorkerConfig();
  assertExists(defaultConfig);
});

Deno.test("createMockDeps - allows partial overrides", () => {
  const customLogger = createMockDeps().logger;
  const calls: string[] = [];
  customLogger.info = (msg: string) => calls.push(msg);

  const deps = createMockDeps({ logger: customLogger });

  deps.logger.info("tracked message");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "tracked message");
});

Deno.test("createMockDeps - allows sub-interface partial overrides", () => {
  const deps = createMockDeps({
    security: {
      isAuthorisedCommenter: () => false,
    },
  });

  // Overridden function returns custom value
  assertEquals(deps.security.isAuthorisedCommenter("user", []), false);

  // Other security functions still exist as mocks
  assertEquals(typeof deps.security.validateIssueInput, "function");
  assertEquals(typeof deps.security.detectSuspiciousPatterns, "function");
});

// ---------------------------------------------------------------------------
// Type-level tests — WorkerDeps satisfies expected shape
// ---------------------------------------------------------------------------

Deno.test("type check - WorkerDeps sub-interfaces are correctly typed", () => {
  // This test verifies that the type assignments compile correctly.
  // If the types are wrong, this file will not pass deno check.
  const deps: WorkerDeps = createDefaultDeps();

  const _github: GitHubDeps = deps.github;
  const _git: GitDeps = deps.git;
  const _issues: IssueDeps = deps.issues;
  const _pr: PrDeps = deps.pr;
  const _claude: ClaudeDeps = deps.claude;
  const _config: ConfigDeps = deps.config;
  const _security: SecurityDeps = deps.security;
  const _ft: FailureTrackingDeps = deps.failureTracking;
  const _ch: CrashHandlingDeps = deps.crashHandling;
  const _infra: InfrastructureDeps = deps.infrastructure;
  const _q: QualityDeps = deps.quality;

  // If we get here, all type assignments are valid
  assertExists(deps);
});

Deno.test("type check - createMockDeps returns WorkerDeps", () => {
  const deps: WorkerDeps = createMockDeps();
  assertExists(deps);
});

// ---------------------------------------------------------------------------
// Issue #2167 — mock bodies returned by createMockDeps() must match the real
// production return shapes. Previously every mock was wrapped in a
// `as unknown as <Slot>` double-cast that erased the structural check;
// these tests pin the shape so a future refactor cannot silently regress.
// ---------------------------------------------------------------------------

Deno.test("createMockDeps - safeGhCommand mock returns the full GhCommandResult shape", async () => {
  const deps = createMockDeps();
  const result = await deps.github.safeGhCommand([]);
  assertEquals(result.ok, true);
  if (result.ok) {
    // All six fields must be present — adding/removing a field on the real
    // signature should immediately break this assertion or the type check.
    assertEquals(result.value.stdout, "");
    assertEquals(result.value.stderr, "");
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.rateLimited, false);
    assertEquals(result.value.circuitBroken, false);
  }
});

Deno.test("createMockDeps - handleIssueFailure mock returns HandleFailureResult shape", async () => {
  const deps = createMockDeps();
  const result = await deps.github.handleIssueFailure({
    repo: "owner/repo",
    issueNumber: 1,
    githubUser: "tester",
    failureMessage: "mock",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.markedAsFailed, false);
    assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(result.value.failureCategory, "unknown");
    assertEquals(result.value.isInfrastructure, false);
  }
});

Deno.test("createMockDeps - fetchIssueData mock returns the IssueData shape", async () => {
  const deps = createMockDeps();
  const data = await deps.issues.fetchIssueData("owner/repo", 1);
  // Fields required on IssueData — state and milestoneTitle were missed by
  // the previous `as unknown as` cast.
  assertEquals(data.state, "OPEN");
  assertEquals(data.milestoneTitle, "");
  assertEquals(data.body, "");
  assertEquals(Array.isArray(data.labels), true);
  assertEquals(Array.isArray(data.comments), true);
});

Deno.test("createMockDeps - detectAndRecoverStuckIssues mock returns RecoveryScanResult", async () => {
  const deps = createMockDeps();
  const result = await deps.crashHandling.detectAndRecoverStuckIssues(
    {
      workDir: "/tmp",
      stuckIssueTimeout: 0,
      assignedNoHeartbeatTimeout: 0,
      staleAssignmentTimeout: 0,
      repos: [],
    },
    "tester",
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.stuckRecovered, 0);
    assertEquals(result.value.noHeartbeatRecovered, 0);
    assertEquals(result.value.staleRecovered, 0);
  }
});

Deno.test("createMockDeps - sub-interface override preserves the typed mock body", async () => {
  // Issue #2167 — overrides must remain assignable to the dep slot's
  // declared signature. Passing an honestly-typed override should compile
  // and behave at runtime.
  const deps = createMockDeps({
    github: {
      safeGhCommand: () =>
        Promise.resolve({
          ok: true,
          value: {
            stdout: "overridden",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            rateLimited: false,
            circuitBroken: false,
          },
        }),
    },
  });
  const result = await deps.github.safeGhCommand([]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.stdout, "overridden");
  }
});

// ---------------------------------------------------------------------------
// The phase logger must be the caller's file-backed logger (Issue #4320)
// ---------------------------------------------------------------------------

Deno.test("createDefaultDeps - uses the caller's logger so issue-phase lines reach worker.log (Issue #4320)", () => {
  const lines: string[] = [];
  const fileLogger = {
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
    debug: (m: string) => lines.push(`debug ${m}`),
  } as unknown as Logger;

  const deps = createDefaultDeps({ logger: fileLogger });
  assertEquals(deps.logger, fileLogger);
  deps.logger.info("[agent-progress] execute: 1m0s elapsed");
  assertEquals(lines, ["info [agent-progress] execute: 1m0s elapsed"]);

  // Without a logger the default is still built (stderr sink) — callers with
  // no file, such as CLI commands and tests, are unchanged.
  const fallback = createDefaultDeps();
  assertEquals(typeof fallback.logger.info, "function");
});
