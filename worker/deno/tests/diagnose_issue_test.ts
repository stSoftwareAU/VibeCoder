/**
 * Tests for diagnose_issue.ts (Issue #1063).
 *
 * Uses mock gh command functions to test the diagnostic logic
 * without requiring real GitHub API access.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  diagnoseIssue,
  formatDiagnosticReport,
} from "../lib/diagnose_issue.ts";
import type { DiagnosticCheck } from "../lib/diagnose_issue.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

/**
 * Find a check by name and assert it exists.
 */
function findCheck(checks: DiagnosticCheck[], name: string): DiagnosticCheck {
  const check = checks.find((c) => c.name === name);
  assertExists(check, `Expected check "${name}" to exist`);
  return check;
}

/**
 * Build a test config with common defaults.
 */
function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: ["owner/repo"],
    issueLabels: ["help wanted", "claude"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    shuffleRepos: false,
    ...overrides,
  };
}

/**
 * Standard issue data for a well-formed open issue with a discovery label.
 */
function makeIssueViewData(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: [{ name: "help wanted" }],
    createdAt: "2024-01-01T00:00:00Z",
    author: { login: "alice" },
    milestone: null,
    ...overrides,
  };
}

/**
 * Create a mock gh command function for diagnostic tests.
 */
function createMockGh(opts: {
  issueView?: Record<string, unknown>;
  allIssues?: Record<string, unknown>[];
  prs?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
  issueBody?: string;
  failIssueView?: boolean;
  /**
   * When set, `prs` are only returned for this `--author` (Issue #4078),
   * so a test can control which fleet login the blocking PR is stamped
   * with.
   */
  prAuthor?: string;
}): (args: string[]) => Promise<string> {
  return async (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // Single issue view
    if (command.includes("issue view")) {
      if (opts.failIssueView) {
        throw new Error("Issue not found");
      }
      if (command.includes("body")) {
        return JSON.stringify({ body: opts.issueBody ?? "" });
      }
      if (command.includes("state")) {
        return JSON.stringify({
          number: (opts.issueView as { number?: number })?.number ?? 42,
          state: "OPEN",
          title: "Test issue",
        });
      }
      if (command.includes("milestone") && !command.includes("title")) {
        return JSON.stringify({
          milestone: (opts.issueView as { milestone?: unknown })?.milestone ??
            null,
        });
      }
      return JSON.stringify(opts.issueView ?? makeIssueViewData());
    }

    // Issue list (all issues)
    if (command.includes("issue list")) {
      return JSON.stringify(
        opts.allIssues ?? [opts.issueView ?? makeIssueViewData()],
      );
    }

    // PR list
    if (command.includes("pr list")) {
      if (opts.prAuthor !== undefined) {
        const idx = args.indexOf("--author");
        const author = idx >= 0 ? args[idx + 1] : "";
        if (author !== opts.prAuthor) return "[]";
      }
      return JSON.stringify(opts.prs ?? []);
    }

    // Timeline
    if (command.includes("timeline")) {
      return JSON.stringify(opts.timeline ?? []);
    }

    // API call for issue body (sub-issues check)
    if (command.includes("api") && command.includes("issues/")) {
      return JSON.stringify({ body: opts.issueBody ?? "" });
    }

    return "[]";
  };
}

// =============================================================================
// Issue not found
// =============================================================================

Deno.test("diagnose_issue - reports failure when issue cannot be fetched", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({ failIssueView: true });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  assertEquals(report.wouldBePickedUp, false);
  assertEquals(report.checks.length, 1);
  assertEquals(report.checks[0]!.name, "issue-exists");
  assertEquals(report.checks[0]!.passed, false);
});

// =============================================================================
// All checks pass — eligible issue
// =============================================================================

Deno.test("diagnose_issue - all checks pass for a clean eligible issue", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issueView: makeIssueViewData(),
    allIssues: [makeIssueViewData()],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  assertEquals(report.wouldBePickedUp, true);
  assertEquals(report.issueTitle, "Test issue");
  // All checks should pass
  for (const check of report.checks) {
    assert(
      check.passed,
      `Check "${check.name}" should pass but got: ${check.detail}`,
    );
  }
});

// =============================================================================
// Repo not in configured list
// =============================================================================

Deno.test("diagnose_issue - fails repo-allowed when repo not in config", async () => {
  const config = makeConfig({ repos: ["other/repo"] });
  const mockGh = createMockGh({ issueView: makeIssueViewData() });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "repo-allowed");
  assertEquals(check.passed, false);
  assert(check.suggestion !== undefined);
});

// =============================================================================
// Repo deprioritised
// =============================================================================

Deno.test("diagnose_issue - fails when repo is deprioritised", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({ issueView: makeIssueViewData() });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    isRepoDeprioritised: () => true,
  });

  const check = findCheck(report.checks, "repo-not-deprioritised");
  assertEquals(check.passed, false);
});

// =============================================================================
// Missing discovery label
// =============================================================================

Deno.test("diagnose_issue - fails when issue has no discovery label", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({ labels: [{ name: "bug" }] });
  const mockGh = createMockGh({ issueView });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "has-discovery-label");
  assertEquals(check.passed, false);
  assertEquals(report.wouldBePickedUp, false);
});

// =============================================================================
// Issue is assigned
// =============================================================================

Deno.test("diagnose_issue - fails when issue is assigned", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    assignees: [{ login: "someone" }],
  });
  const mockGh = createMockGh({ issueView });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "not-assigned");
  assertEquals(check.passed, false);
  assert(check.detail.includes("someone"));
});

// =============================================================================
// Blocking labels
// =============================================================================

Deno.test("diagnose_issue - fails when issue has a blocking label", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    labels: [{ name: "help wanted" }, { name: "failed" }],
  });
  const mockGh = createMockGh({ issueView });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "no-blocking-labels");
  assertEquals(check.passed, false);
  assert(check.detail.includes("failed"));
});

// =============================================================================
// Issue in cooldown
// =============================================================================

Deno.test("diagnose_issue - fails when issue is in cooldown", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({ issueView: makeIssueViewData() });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    isIssueInCooldown: () => true,
  });

  const check = findCheck(report.checks, "not-in-cooldown");
  assertEquals(check.passed, false);
});

// =============================================================================
// Dependency blocked
// =============================================================================

Deno.test("diagnose_issue - fails when issue has open dependency", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData();
  const mockGh = createMockGh({
    issueView,
    issueBody: "Depends on #99",
  });

  // Override to return OPEN state for dependency #99
  const ghFn = async (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (
      command.includes("issue view") && command.includes("state") &&
      command.includes("99")
    ) {
      return JSON.stringify({
        number: 99,
        state: "OPEN",
        title: "Blocking issue",
      });
    }
    return await mockGh(args);
  };

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: ghFn,
  });

  const check = findCheck(report.checks, "not-dependency-blocked");
  assertEquals(check.passed, false);
  assert(check.detail.includes("#99"));
});

// =============================================================================
// Work-on label author check
// =============================================================================

Deno.test("diagnose_issue - fails work-on author check when label added by unauthorised user", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    labels: [{ name: "work-on" }],
  });
  const mockGh = createMockGh({
    issueView,
    timeline: [{
      event: "labeled",
      label: { name: "work-on" },
      actor: { login: "unauthorised-user" },
      created_at: "2024-01-01T00:00:00Z",
    }],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "work-on-author-allowed");
  assertEquals(check.passed, false);
});

Deno.test("diagnose_issue - passes work-on author check when label added by allowed author", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    labels: [{ name: "work-on" }],
  });
  const mockGh = createMockGh({
    issueView,
    timeline: [{
      event: "labeled",
      label: { name: "work-on" },
      actor: { login: "alice" },
      created_at: "2024-01-01T00:00:00Z",
    }],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "work-on-author-allowed");
  assertEquals(check.passed, true);
});

// =============================================================================
// Format report
// =============================================================================

Deno.test("diagnose_issue - formatDiagnosticReport includes PASS/FAIL markers", () => {
  const report = {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    checks: [
      { name: "repo-allowed", passed: true, detail: "Repo is allowed" },
      {
        name: "not-assigned",
        passed: false,
        detail: "Issue is assigned to bob",
        suggestion: "Unassign the issue",
      },
    ],
    wouldBePickedUp: false,
  };

  const output = formatDiagnosticReport(report);
  assert(output.includes("[PASS] repo-allowed"));
  assert(output.includes("[FAIL] not-assigned"));
  assert(output.includes("→ Unassign the issue"));
  assert(output.includes("1/2 checks passed"));
  assert(output.includes("would NOT be picked up"));
});

Deno.test("diagnose_issue - formatDiagnosticReport shows positive verdict when all pass", () => {
  const report = {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    checks: [
      { name: "repo-allowed", passed: true, detail: "Repo is allowed" },
    ],
    wouldBePickedUp: true,
  };

  const output = formatDiagnosticReport(report);
  assert(output.includes("WOULD be picked up"));
});

// =============================================================================
// PR blocking
// =============================================================================

Deno.test("diagnose_issue - fails when blocked by open PR", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData();
  const mockGh = createMockGh({
    issueView,
    prs: [{
      number: 100,
      title: "Fix something",
      baseRefName: "main",
      headRefName: "fix-branch",
    }],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "no-blocking-pr");
  assertEquals(check.passed, false);
  assert(check.detail.includes("#100"));
});

Deno.test("diagnose_issue - a human-authored PR is not reported as blocking (Issue #4133)", async () => {
  // `alice` is a trusted human: her PR is hers to manage, so the guard
  // ignores it and the diagnostic must agree with the scan.
  const config = makeConfig({ fleetPrAuthors: ["stsvcbot"] });
  const mockGh = createMockGh({
    issueView: makeIssueViewData(),
    prAuthor: "alice",
    prs: [{
      number: 100,
      title: "Fix something",
      baseRefName: "main",
      headRefName: "fix-branch",
    }],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "no-blocking-pr");
  assertEquals(check.passed, true);
  assertEquals(check.detail, "No blocking PRs found");
});

Deno.test("diagnose_issue - a fleet-authored blocking PR is reported as blocking (Issue #4133)", async () => {
  const config = makeConfig({ fleetPrAuthors: ["stsvcbot"] });
  const mockGh = createMockGh({
    issueView: makeIssueViewData(),
    prAuthor: "stsvcbot",
    prs: [{
      number: 100,
      title: "Fix something",
      baseRefName: "main",
      headRefName: "fix-branch",
    }],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "no-blocking-pr");
  assertEquals(check.passed, false);
  assert(check.detail.includes("#100"));
});

// =============================================================================
// Milestone occupancy
// =============================================================================

Deno.test("diagnose_issue - fails when milestone is occupied by worker", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    milestone: { title: "v2.0" },
  });
  const mockGh = createMockGh({
    issueView,
    allIssues: [
      makeIssueViewData({ milestone: { title: "v2.0" } }),
      {
        ...makeIssueViewData({ milestone: { title: "v2.0" } }),
        number: 99,
        assignees: [{ login: "bot" }],
      },
    ],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "milestone-not-occupied");
  assertEquals(check.passed, false);
  assert(check.detail.includes("v2.0"));
});

Deno.test("diagnose_issue - passes when milestone has only human-assigned issues", async () => {
  const config = makeConfig();
  const issueView = makeIssueViewData({
    milestone: { title: "v2.0" },
  });
  const mockGh = createMockGh({
    issueView,
    allIssues: [
      makeIssueViewData({ milestone: { title: "v2.0" } }),
      {
        ...makeIssueViewData({ milestone: { title: "v2.0" } }),
        number: 99,
        assignees: [{ login: "human-dev" }],
      },
    ],
  });

  const report = await diagnoseIssue("owner/repo", 42, config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
  });

  const check = findCheck(report.checks, "milestone-not-occupied");
  assertEquals(check.passed, true);
});
