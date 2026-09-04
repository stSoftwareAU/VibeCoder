/**
 * Tests for issue_finder.ts (Issue #910).
 *
 * Uses mock gh command functions to test the orchestration logic
 * without requiring real GitHub API access.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  findIssuesByLabel,
  findOldestIssue,
  findPlanningIssuesWithFallback,
} from "../lib/issue_finder.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import type { WorkerConfig } from "../types.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";

/**
 * Create an isolated cache for a single test.
 */
function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "finder-test-" });
  return new IssueCache(dir, 600);
}

/**
 * Build a test config with common defaults.
 */
function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate. Individual
    // tests override this with their own fixed path.
    workDir: Deno.makeTempDirSync({ prefix: "issue-finder-workdir-" }),
    repos: ["owner/repo"],
    issueLabels: ["help-wanted"],
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
 * Create a mock gh command that returns preset data for different queries.
 */
function createMockGh(data: {
  issues?: Record<string, unknown>[];
  prs?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
  issueView?: Record<string, unknown>;
}): (args: string[]) => Promise<string> {
  return async (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (command.includes("issue list")) {
      return JSON.stringify(data.issues ?? []);
    }
    if (command.includes("pr list")) {
      return JSON.stringify(data.prs ?? []);
    }
    if (command.includes("timeline")) {
      return JSON.stringify(data.timeline ?? []);
    }
    if (command.includes("issue view")) {
      return JSON.stringify(data.issueView ?? {});
    }
    return "[]";
  };
}

// =============================================================================
// findOldestIssue tests
// =============================================================================

Deno.test("issue_finder - findOldestIssue returns not found for empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await findOldestIssue(config, {
    githubUser: "bot",
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

Deno.test("issue_finder - findOldestIssue finds eligible issue", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Fix bug",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, true);
  assertEquals(result.output.includes("owner/repo"), true);
  assertEquals(result.output.includes("10"), true);
});

Deno.test("issue_finder - findOldestIssue skips assigned issues", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Assigned issue",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [{ login: "other-worker" }],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

Deno.test("issue_finder - findOldestIssue skips needs-human issues (Issue #1470)", async () => {
  // needs-human is the worker-to-human escalation signal. findOldestIssue
  // must never return such an issue, otherwise the worker loops on tasks
  // it has explicitly handed back.
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 77,
        title: "Handed back to a human",
        url: "https://github.com/owner/repo/issues/77",
        assignees: [],
        labels: [{ name: "help-wanted" }, { name: "needs-human" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    // needs-human added by a trusted author so label_security does not
    // strip it before filterAndSort runs. filterAndSort must then drop
    // the issue for the needs-human reason.
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

Deno.test(
  "issue_finder - findOldestIssue surfaces needs-human skip reason in diagnostics (Issue #1470)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 78,
          title: "Handed back to a human",
          url: "https://github.com/owner/repo/issues/78",
          assignees: [],
          labels: [{ name: "help-wanted" }, { name: "needs-human" }],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      prs: [],
      // Trusted author added needs-human — timeline check keeps it.
      timeline: [
        {
          event: "labeled",
          label: { name: "help-wanted" },
          actor: { login: "alice" },
        },
        {
          event: "labeled",
          label: { name: "needs-human" },
          actor: { login: "alice" },
        },
      ],
    });

    // Enable diagnostics so emit() records to the messages buffer even
    // when ISSUE_FINDER_DEBUG is not set in the environment.
    const diagnostics = createDiagnostics({ enabled: true, write: () => {} });
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      diagnostics,
    });

    assertEquals(result.found, false);
    const summary = diagnostics.getSummary();
    assertEquals((summary.skippedByReason["needs-human"] ?? 0) > 0, true);
    const msgs = diagnostics.getMessages();
    const hasNeedsHumanMsg = msgs.some((m) =>
      m.includes("issue=#78") && m.includes("skipped=needs-human")
    );
    assertEquals(hasNeedsHumanMsg, true);
  },
);

Deno.test("issue_finder - findOldestIssue skips failed-label issues", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Failed issue",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }, { name: "failed" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

// ---------------------------------------------------------------------------
// Issue #1672: availability-check issue list is reused by candidate scan
// ---------------------------------------------------------------------------

Deno.test(
  "issue_finder - findOldestIssue reuses availability-check issues per repo (Issue #1672)",
  async () => {
    // Track every cache.read call keyed by "issues_all" (the key fetchAllIssues
    // uses). Before the fix, findOldestIssue itself called fetchAllIssues twice
    // per repo per iteration: once for availability classification and once
    // before invoking the candidate collectors. After the fix, the second call
    // is replaced by the in-memory map populated during classification.
    let allIssuesReadCount = 0;
    const tmpDir = Deno.makeTempDirSync({ prefix: "finder-test-1672-" });
    class TrackingCache extends IssueCache {
      override async read<T>(repo: string, key: string): Promise<T | null> {
        if (key === "issues_all") allIssuesReadCount++;
        return await super.read<T>(repo, key);
      }
    }
    const cache = new TrackingCache(tmpDir, 600);

    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 10,
          title: "Fix bug",
          url: "https://github.com/owner/repo/issues/10",
          assignees: [],
          labels: [{ name: "help-wanted" }],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      prs: [],
      timeline: [
        {
          event: "labeled",
          label: { name: "help-wanted" },
          actor: { login: "alice" },
        },
      ],
    });

    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache,
    });

    // Five legitimate cache.read("issues_all") calls remain after Issues
    // #1672, #1725, and #2006:
    //   1. availability classification (in find_oldest_issue.ts)
    //   2. fetchIssuesByLabel inside collectLabelCandidates (one issue label)
    //   3. fetchIssuesByLabel inside collectWorkOnCandidates (work-on label)
    //   4. fetchIssuesByLabel inside collectLowPriorityCandidates
    //      (low-priority label) — added in Issue #1725
    //   5. fetchIssuesByLabel inside collectIdleTaskCandidates
    //      (idle-task label) — added in Issue #2006
    // Before Issue #1672 there was an additional, redundant read directly
    // inside findOldestIssue immediately before calling the collectors.
    assertEquals(
      allIssuesReadCount,
      5,
      `Expected exactly 5 cache reads of "issues_all" per iteration after Issues #1672/#1725/#2006, got ${allIssuesReadCount}`,
    );
  },
);

Deno.test(
  "issue_finder - findOldestIssue still works when availability check throws (Issue #1672)",
  async () => {
    // If the availability classification raises, issuesByRepo will not contain
    // an entry for the repo. The second phase must fall back to fetchAllIssues
    // rather than passing an empty list to the collectors.
    let issueListCalls = 0;
    let throwOnNextIssueList = true;
    const config = makeConfig();
    const mockGh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("issue list") && command.includes("--state open")) {
        issueListCalls++;
        if (throwOnNextIssueList) {
          throwOnNextIssueList = false;
          return Promise.reject(new Error("transient failure"));
        }
        return Promise.resolve(JSON.stringify([
          {
            number: 10,
            title: "Fix bug",
            url: "https://github.com/owner/repo/issues/10",
            assignees: [],
            labels: [{ name: "help-wanted" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: { login: "alice" },
            milestone: null,
          },
        ]));
      }
      if (command.includes("timeline")) {
        return Promise.resolve(JSON.stringify([
          {
            event: "labeled",
            label: { name: "help-wanted" },
            actor: { login: "alice" },
          },
        ]));
      }
      return Promise.resolve("[]");
    };

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });

    // The first issue list call threw, so the fallback path must run; the
    // worker should still find the issue via the second-phase fetchAllIssues.
    assertEquals(result.found, true);
    assertEquals(
      issueListCalls > 1,
      true,
      "Should have retried issue list after availability check threw",
    );
  },
);

Deno.test("issue_finder - findOldestIssue respects cooldown", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "In cooldown",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    isIssueInCooldown: (_repo, num) => num === 10,
  });
  assertEquals(result.found, false);
});

// =============================================================================
// findIssuesByLabel tests
// =============================================================================

Deno.test("issue_finder - findIssuesByLabel returns not found for empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await findIssuesByLabel(config, "refine-issue", false, {
    githubUser: "bot",
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

Deno.test("issue_finder - findIssuesByLabel finds issues by label", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 5,
        title: "Refine this",
        url: "https://github.com/owner/repo/issues/5",
        assignees: [],
        labels: [{ name: "refine-issue" }],
        createdAt: "2024-01-15T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    timeline: [
      {
        event: "labeled",
        label: { name: "refine-issue" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findIssuesByLabel(config, "refine-issue", false, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, true);
  assertEquals(result.output.includes("5"), true);
});

Deno.test("issue_finder - findIssuesByLabel finds needs-revision issues (Issue #898)", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 7,
        title: "Apply PR feedback",
        url: "https://github.com/owner/repo/issues/7",
        assignees: [],
        labels: [{ name: "needs-revision" }],
        createdAt: "2024-02-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    timeline: [
      {
        event: "labeled",
        label: { name: "needs-revision" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findIssuesByLabel(config, "needs-revision", false, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, true);
  assertEquals(result.output.includes("7"), true);
});

Deno.test(
  "issue_finder - findIssuesByLabel skips needs-human issues (Issue #1874)",
  async () => {
    // The grill-me / refinement / planning / question discovery paths all
    // route through findIssuesByLabel. needs-human is the worker-to-human
    // escalation signal — findIssuesByLabel must never surface such an
    // issue, otherwise the worker re-runs (e.g. another grill-me round)
    // before the developer has finished replying. Mirrors the
    // findOldestIssue behaviour added in #1470.
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 193,
          title: "Awaiting developer reply",
          url: "https://github.com/owner/repo/issues/193",
          assignees: [],
          labels: [{ name: "grill-me" }, { name: "needs-human" }],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // Trusted author added grill-me — author allowlist check passes.
      timeline: [
        {
          event: "labeled",
          label: { name: "grill-me" },
          actor: { login: "alice" },
        },
        {
          event: "labeled",
          label: { name: "needs-human" },
          actor: { login: "alice" },
        },
      ],
    });

    const result = await findIssuesByLabel(config, "grill-me", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    assertEquals(result.found, false);
  },
);

Deno.test("issue_finder - findIssuesByLabel filters failed when requested", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 5,
        title: "Failed question",
        url: "https://github.com/owner/repo/issues/5",
        assignees: [],
        labels: [{ name: "question" }, { name: "failed" }],
        createdAt: "2024-01-15T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
  });

  const result = await findIssuesByLabel(config, "question", true, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });
  assertEquals(result.found, false);
});

// Issue #3083: operational dispatch labels (planning/question/refine-issue/
// grill-me/needs-revision) drive privileged automation phases. For these the
// label *adder* must always be on the allowlist — a trusted issue author is
// not enough. Otherwise a non-allowlisted triage collaborator could apply an
// operational label to a trusted-authored issue and steer the worker into a
// privileged phase.
Deno.test(
  "issue_finder - findIssuesByLabel skips operational-label issue when label added by untrusted user (Issue #3083)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 42,
          // Trusted maintainer authored the issue …
          title: "Legitimate issue",
          url: "https://github.com/owner/repo/issues/42",
          assignees: [],
          labels: [{ name: "planning" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // … but a non-allowlisted triage collaborator applied the planning label.
      timeline: [
        {
          event: "labeled",
          label: { name: "planning" },
          actor: { login: "mallory" },
        },
      ],
    });

    const result = await findIssuesByLabel(config, "planning", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    // The issue must be skipped: the operational label adder is untrusted.
    assertEquals(result.found, false);
  },
);

Deno.test(
  "issue_finder - findIssuesByLabel surfaces operational-label issue when trusted author adds the label (Issue #3083)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 43,
          title: "Legitimate issue",
          url: "https://github.com/owner/repo/issues/43",
          assignees: [],
          labels: [{ name: "planning" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // Trusted maintainer added the operational label — the AND gate passes.
      timeline: [
        {
          event: "labeled",
          label: { name: "planning" },
          actor: { login: "alice" },
        },
      ],
    });

    const result = await findIssuesByLabel(config, "planning", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    assertEquals(result.found, true);
    assertEquals(result.output.includes("43"), true);
  },
);

// Issue #847 (part of #843): a `custom_label_prompts` label dispatches a
// privileged automation phase with an operator-supplied prompt, so it joins the
// AND-gated set — the label *adder* must be on the allowlist even when the
// issue author already is.
Deno.test(
  "issue_finder - findIssuesByLabel skips a custom-label issue when the label adder is untrusted (Issue #847)",
  async () => {
    const config = makeConfig({
      customLabelPrompts: [
        { label: "deploy-review", promptPath: "/srv/prompts/deploy-review.md" },
      ],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 71,
          // Trusted maintainer authored the issue …
          title: "Custom label issue",
          url: "https://github.com/owner/repo/issues/71",
          assignees: [],
          labels: [{ name: "deploy-review" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // … but a non-allowlisted triage collaborator applied the custom label.
      timeline: [
        {
          event: "labeled",
          label: { name: "deploy-review" },
          actor: { login: "mallory" },
        },
      ],
    });

    const result = await findIssuesByLabel(config, "deploy-review", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    assertEquals(result.found, false);
  },
);

Deno.test(
  "issue_finder - findIssuesByLabel surfaces a custom-label issue when a trusted author added the label (Issue #847)",
  async () => {
    const config = makeConfig({
      customLabelPrompts: [
        { label: "deploy-review", promptPath: "/srv/prompts/deploy-review.md" },
      ],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 72,
          title: "Custom label issue",
          url: "https://github.com/owner/repo/issues/72",
          assignees: [],
          labels: [{ name: "deploy-review" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "deploy-review" },
          actor: { login: "alice" },
        },
      ],
    });

    const result = await findIssuesByLabel(config, "deploy-review", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    assertEquals(result.found, true);
    assertEquals(result.output.includes("72"), true);
  },
);

Deno.test(
  "issue_finder - findIssuesByLabel fails closed when a custom label's adder cannot be attributed (Issue #847)",
  async () => {
    const config = makeConfig({
      customLabelPrompts: [
        { label: "deploy-review", promptPath: "/srv/prompts/deploy-review.md" },
      ],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 73,
          title: "Custom label issue",
          url: "https://github.com/owner/repo/issues/73",
          assignees: [],
          labels: [{ name: "deploy-review" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // No `labeled` event for the custom label — the adder is unknown.
      timeline: [],
    });

    const result = await findIssuesByLabel(config, "deploy-review", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });
    assertEquals(result.found, false);
  },
);

// =============================================================================
// findPlanningIssuesWithFallback tests (Issue #977)
// =============================================================================

Deno.test("issue_finder - findPlanningIssuesWithFallback returns label-based results when available", async () => {
  const config = makeConfig();

  const mockGh = (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // Return a planning-labelled issue
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 50,
          title: "Plan feature X",
          url: "https://github.com/owner/repo/issues/50",
          assignees: [],
          labels: [{ name: "planning" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ]));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        {
          event: "labeled",
          label: { name: "planning" },
          actor: { login: "alice" },
        },
      ]));
    }
    return Promise.resolve("[]");
  };

  const result = await findPlanningIssuesWithFallback(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });

  assertEquals(result.found, true);
  assertEquals(result.output.includes("50"), true);
});

// Issue #1476: findPlanningIssuesWithFallback detects escalation via
// comments but no longer re-adds the planning label. A trusted human
// adds the label to confirm escalation.
Deno.test("issue_finder - findPlanningIssuesWithFallback detects planning via comment fallback without adding label (Issue #1476)", async () => {
  const config = makeConfig();
  const labelAddCalls: string[][] = [];

  const mockGh = (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // No planning-labelled issues
    if (command.includes("issue list") && command.includes("planning")) {
      return Promise.resolve(JSON.stringify([]));
    }

    // All issues (for fallback scan) — one open issue without planning label
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 77,
          title: "Complex issue",
          url: "https://github.com/owner/repo/issues/77",
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-07-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ]));
    }

    // Comment fallback — issue has escalation comment
    if (
      command.includes("issue view") && command.includes("comments") &&
      command.includes("--jq")
    ) {
      return Promise.resolve(
        "## Automatic Escalation to Planning Mode\n\nThis issue is too complex.",
      );
    }

    // Record any label-add call so we can assert it did NOT happen
    if (
      command.includes("issues/77/labels") || command.includes("--add-label")
    ) {
      labelAddCalls.push(args);
      return Promise.resolve("");
    }
    if (
      command.includes("api") && command.includes("repos/owner/repo/labels") &&
      !command.includes("issues/")
    ) {
      // ensureLabelExists for the planning label
      labelAddCalls.push(args);
      return Promise.resolve("");
    }

    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([]));
    }

    return Promise.resolve("[]");
  };

  const result = await findPlanningIssuesWithFallback(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });

  // Issue is still detected for planning purposes
  assertEquals(result.found, true);
  assertEquals(result.output.includes("77"), true);
  // Issue #1476: NO label-add attempt should have been made
  assertEquals(
    labelAddCalls.length,
    0,
    "Issue #1476: planning label must not be added programmatically",
  );
});

Deno.test("issue_finder - findPlanningIssuesWithFallback returns not found when no escalation comments", async () => {
  const config = makeConfig();

  const mockGh = (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // No planning-labelled issues
    if (command.includes("issue list") && command.includes("planning")) {
      return Promise.resolve(JSON.stringify([]));
    }

    // One open issue without planning label
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 88,
          title: "Normal issue",
          url: "https://github.com/owner/repo/issues/88",
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-07-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ]));
    }

    // No escalation comments
    if (command.includes("issue view") && command.includes("comments")) {
      return Promise.resolve("Just a regular comment about the issue.");
    }

    return Promise.resolve("[]");
  };

  const result = await findPlanningIssuesWithFallback(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });

  assertEquals(result.found, false);
});

Deno.test("issue_finder - findPlanningIssuesWithFallback skips assigned issues and failed issues without escalation comments", async () => {
  const config = makeConfig();

  const mockGh = (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // No planning-labelled issues
    if (command.includes("issue list") && command.includes("planning")) {
      return Promise.resolve(JSON.stringify([]));
    }

    // Two issues: one assigned, one failed without escalation comment
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 91,
          title: "Assigned issue",
          url: "https://github.com/owner/repo/issues/91",
          assignees: [{ login: "someone" }],
          labels: [{ name: "work-on" }],
          createdAt: "2024-07-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
        {
          number: 92,
          title: "Failed issue",
          url: "https://github.com/owner/repo/issues/92",
          assignees: [],
          labels: [{ name: "failed" }],
          createdAt: "2024-07-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ]));
    }

    // No escalation comments on the failed issue
    if (command.includes("issue view") && command.includes("comments")) {
      return Promise.resolve("Just a regular failure — no escalation.");
    }

    return Promise.resolve("[]");
  };

  const result = await findPlanningIssuesWithFallback(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });

  assertEquals(result.found, false);
});

// Issue #999: Churn-escalated issues with failed label should be found via comment fallback
Deno.test("issue_finder - findPlanningIssuesWithFallback finds failed issues with escalation comments (Issue #999)", async () => {
  const config = makeConfig();
  const labelAddCalls: string[][] = [];

  const mockGh = (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // No planning-labelled issues
    if (command.includes("issue list") && command.includes("planning")) {
      return Promise.resolve(JSON.stringify([]));
    }

    // One failed issue — churn escalated (has failed label)
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 95,
          title: "Churn-escalated issue",
          url: "https://github.com/owner/repo/issues/95",
          assignees: [],
          labels: [{ name: "failed" }, { name: "work-on" }],
          createdAt: "2024-07-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ]));
    }

    // Comment fallback — issue has claim churn escalation comment
    if (
      command.includes("issue view") && command.includes("comments") &&
      command.includes("--jq")
    ) {
      return Promise.resolve(
        "## Claim Churn Detected\n\nThis issue has been claimed and released 5 times.\n\ncc @alice @bob — please add the `planning` label.",
      );
    }

    // Label add via REST API — record it
    if (command.includes("repos/") && command.includes("labels")) {
      labelAddCalls.push(args);
      return Promise.resolve("");
    }

    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([]));
    }

    return Promise.resolve("[]");
  };

  const result = await findPlanningIssuesWithFallback(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
  });

  assertEquals(
    result.found,
    true,
    "Should find churn-escalated issue with failed label",
  );
  assertEquals(result.output.includes("95"), true, "Should include issue #95");
});

// =============================================================================
// Diagnostic logging integration tests (Issue #1062)
// =============================================================================

Deno.test("issue_finder - diagnostics logs repo classification for free repo", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Fix bug",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
  });

  const repoMsg = output.find((m) => m.includes("classification="));
  assertEquals(repoMsg !== undefined, true, "Should log repo classification");
  assertStringIncludes(repoMsg!, "repo=owner/repo");
});

Deno.test("issue_finder - diagnostics logs deprioritised repo", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({ issues: [], prs: [] });

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
    isRepoDeprioritised: () => true,
  });

  const repoMsg = output.find((m) =>
    m.includes("classification=deprioritised")
  );
  assertEquals(
    repoMsg !== undefined,
    true,
    "Should log deprioritised classification",
  );
});

Deno.test("issue_finder - diagnostics logs eligible issue and final selection", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Fix bug",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
  });

  assertEquals(result.found, true);

  // Should log issue as considered
  const consideredMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("status=considered")
  );
  assertEquals(
    consideredMsg !== undefined,
    true,
    "Should log issue considered",
  );

  // Should log issue as eligible
  const eligibleMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("status=eligible")
  );
  assertEquals(eligibleMsg !== undefined, true, "Should log issue eligible");

  // Should log final selection
  const selectedMsg = output.find((m) =>
    m.includes("selected") && m.includes("issue=#10")
  );
  assertEquals(selectedMsg !== undefined, true, "Should log final selection");

  // Should log summary
  const summaryMsg = output.find((m) =>
    m.includes("summary") && m.includes("total_considered=")
  );
  assertEquals(summaryMsg !== undefined, true, "Should log summary");
});

Deno.test("issue_finder - diagnostics logs skipped issues with reasons", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Assigned issue",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [{ login: "other-worker" }],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
  });

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
  });

  // Assigned issue should be logged as filtered out by filterAndSort
  const skipMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("skipped=")
  );
  assertEquals(
    skipMsg !== undefined,
    true,
    "Should log skipped issue with reason",
  );
});

Deno.test("issue_finder - diagnostics logs cooldown skips", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "In cooldown",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    // Issue #2967: the configured-label collector now verifies the label
    // was added by an allowed author, so the issue must reach the cooldown
    // filter via an authorised "labeled" event.
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
    isIssueInCooldown: (_repo, num) => num === 10,
  });

  const cooldownMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("skipped=cooldown")
  );
  assertEquals(cooldownMsg !== undefined, true, "Should log cooldown skip");
});

Deno.test("issue_finder - diagnostics summary counts are correct", async () => {
  const config = makeConfig();
  const diag = createDiagnostics({ enabled: true, write: () => {} });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Eligible",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
      {
        number: 11,
        title: "Assigned",
        url: "https://github.com/owner/repo/issues/11",
        assignees: [{ login: "other" }],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-02T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
  });

  const summary = diag.getSummary();
  // Issue #10 is considered and eligible; issue #11 is considered and filtered out
  assertEquals(
    summary.totalConsidered >= 1,
    true,
    "Should have considered issues",
  );
  assertEquals(
    summary.totalEligible >= 1,
    true,
    "Should have at least one eligible issue",
  );
});

// ---------------------------------------------------------------------------
// Cross-worker cooldown (Issue #1087)
// ---------------------------------------------------------------------------

Deno.test("issue_finder - findOldestIssue skips issues with cross-worker cooldown", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Cross-worker cooled down",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    // Issue #2967: authorised "labeled" event so the configured-label
    // collector's author check passes and the cross-worker cooldown runs.
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
    hasCrossWorkerCooldown: async (_repo, num) => num === 10,
  });

  assertEquals(
    result.found,
    false,
    "Should not find issue in cross-worker cooldown",
  );

  const cooldownMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("skipped=cross-worker-cooldown")
  );
  assertEquals(
    cooldownMsg !== undefined,
    true,
    "Should log cross-worker cooldown skip",
  );
});

Deno.test("issue_finder - findOldestIssue selects issue when cross-worker cooldown is clear", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Available",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    // Issue #2967: authorised "labeled" event so the configured-label
    // collector's author check passes and the issue is selectable.
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    hasCrossWorkerCooldown: async (_repo, _num) => false,
  });

  assertEquals(
    result.found,
    true,
    "Should find issue when cross-worker cooldown is clear",
  );
});

Deno.test("issue_finder - findIssuesByLabel skips issues with cross-worker cooldown", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Cooled down",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "planning" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
  });

  const result = await findIssuesByLabel(config, "planning", false, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    hasCrossWorkerCooldown: async (_repo, num) => num === 10,
  });

  assertEquals(
    result.found,
    false,
    "Should not find issue in cross-worker cooldown",
  );
});

Deno.test("issue_finder - cross-worker cooldown works alongside local cooldown", async () => {
  const config = makeConfig();
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: true,
    write: (msg) => output.push(msg),
  });
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Local cooldown",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
      {
        number: 11,
        title: "Cross-worker cooldown",
        url: "https://github.com/owner/repo/issues/11",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-02T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    // Issue #2967: authorised "labeled" event so both issues pass the
    // configured-label collector's author check and reach the cooldown
    // filters.
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    diagnostics: diag,
    isIssueInCooldown: (_repo, num) => num === 10,
    hasCrossWorkerCooldown: async (_repo, num) => num === 11,
  });

  // Both issues should be filtered out
  assertEquals(result.found, false, "Both cooldown types should filter issues");

  // Local cooldown should be logged
  const localMsg = output.find((m) =>
    m.includes("issue=#10") && m.includes("skipped=cooldown")
  );
  assertEquals(localMsg !== undefined, true, "Should log local cooldown");

  // Cross-worker cooldown should be logged
  const crossMsg = output.find((m) =>
    m.includes("issue=#11") && m.includes("skipped=cross-worker-cooldown")
  );
  assertEquals(
    crossMsg !== undefined,
    true,
    "Should log cross-worker cooldown",
  );
});

// =============================================================================
// Content approval TOCTOU protection (Issue #1341)
// =============================================================================

/** In-memory file system for content approval tests. */
function createContentApprovalMemoryFs(): {
  deps: ContentApprovalDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const deps: ContentApprovalDeps = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Deno.errors.NotFound(`File not found: ${path}`);
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    renameFile: async (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`File not found: ${oldPath}`);
      files.set(newPath, content);
      files.delete(oldPath);
    },
    removeFile: async (path: string) => {
      files.delete(path);
    },
  };
  return { deps, files };
}

/**
 * Create a mock gh function for work-on content approval tests.
 *
 * Simulates timeline (label added by allowed author), issue list,
 * and issue view (returns specified title/body).
 */
function createWorkOnMockGh(opts: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
  labelAdder: string;
  actions?: string[];
  /**
   * Issue #3715: login recorded against the most recent title/body edit.
   * The re-baseline decision turns on this actor rather than the issue
   * author, so scenarios with changed content must name the editor.
   */
  editedBy?: string;
}): (args: string[]) => Promise<string> {
  const actions = opts.actions ?? [];
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // Edit-actor lookup (Issue #3715). Matched on `userContentEdits` so the
    // other GraphQL timeline queries still fall through, and checked first
    // because the query text also contains "timelineItems".
    if (args[0] === "api" && command.includes("userContentEdits")) {
      // Issue #3964: the edit must post-date the snapshot (captured at real
      // wall-clock time in these tests) to land inside the judged window — a
      // mismatch with zero in-window edits now re-baselines instead.
      const nodes = opts.editedBy
        ? [{
          editedAt: new Date(Date.now() + 3600_000).toISOString(),
          editor: { login: opts.editedBy },
        }]
        : [];
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              userContentEdits: { nodes },
              timelineItems: { nodes: [] },
            },
          },
        },
      }));
    }

    // Issue list (returns work-on labelled issue)
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: opts.issueNumber,
          title: opts.issueTitle,
          url: `https://github.com/owner/repo/issues/${opts.issueNumber}`,
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: opts.issueAuthor },
          milestone: null,
        },
      ]));
    }

    // Timeline (label added by specified user)
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: opts.labelAdder },
        },
      ]));
    }

    // Issue view (returns current title and body)
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({
        title: opts.issueTitle,
        body: opts.issueBody,
      }));
    }

    // Issue view for body (used by dependency checker)
    if (command.includes("issue view") && command.includes("body")) {
      return Promise.resolve(JSON.stringify({ body: opts.issueBody }));
    }

    // Label removal (track it)
    if (command.includes("--remove-label")) {
      actions.push("remove-label");
      return Promise.resolve("");
    }

    // Comment posting (track it)
    if (command.includes("issue comment")) {
      actions.push("post-comment");
      return Promise.resolve("");
    }
    // Issue #2211: escalateToHuman's shim posts comments via REST API
    // (POST /repos/.../issues/N/comments -f body=...). Capture those too.
    if (
      command.includes("api") && command.includes("POST") &&
      command.includes("/comments") &&
      args.some((a) => a.startsWith("body="))
    ) {
      actions.push("post-comment");
      return Promise.resolve("");
    }

    // PR list
    if (command.includes("pr list")) {
      return Promise.resolve(JSON.stringify([]));
    }

    return Promise.resolve("[]");
  };
}

Deno.test("issue_finder - work-on issue proceeds when content unchanged (Issue #1341)", async () => {
  const { deps } = createContentApprovalMemoryFs();
  const workDir = "/tmp/test-content-unchanged";
  const config = makeConfig({ workDir, issueLabels: [] });

  // Pre-capture snapshot matching the current content
  await captureContentSnapshot(
    resolveContentApprovalStateDir(workDir),
    "owner/repo",
    42,
    "Fix the bug",
    "Detailed description",
    "untrusted-user",
    deps,
  );

  const mockGh = createWorkOnMockGh({
    issueNumber: 42,
    issueTitle: "Fix the bug",
    issueBody: "Detailed description",
    issueAuthor: "untrusted-user",
    labelAdder: "alice",
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    contentApprovalDeps: deps,
  });

  assertEquals(
    result.found,
    true,
    "Should find issue when content is unchanged",
  );
  assertEquals(result.output.includes("42"), true);
});

Deno.test("issue_finder - work-on issue blocked when untrusted author modifies content (Issue #1341)", async () => {
  const { deps } = createContentApprovalMemoryFs();
  const workDir = "/tmp/test-content-blocked";
  const config = makeConfig({ workDir, issueLabels: [] });
  const actions: string[] = [];

  // Capture snapshot with original content
  await captureContentSnapshot(
    resolveContentApprovalStateDir(workDir),
    "owner/repo",
    42,
    "Original title",
    "Original body",
    "untrusted-user",
    deps,
  );

  // Mock returns MODIFIED content (different from snapshot)
  const mockGh = createWorkOnMockGh({
    issueNumber: 42,
    issueTitle: "Malicious title",
    issueBody: "Injected instructions to take over the system",
    issueAuthor: "untrusted-user",
    labelAdder: "alice",
    editedBy: "untrusted-user",
    actions,
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    contentApprovalDeps: deps,
  });

  assertEquals(
    result.found,
    false,
    "Should block issue modified by untrusted author",
  );
  // Issue #3964: blocking adds needs-human but never strips the approval.
  assertEquals(
    actions.includes("remove-label"),
    false,
    "Must not remove the work-on label when blocking",
  );
  assertEquals(
    actions.includes("post-comment"),
    true,
    "Should post security comment",
  );
});

Deno.test("issue_finder - work-on issue proceeds with warning when trusted author modifies content (Issue #1341)", async () => {
  const { deps } = createContentApprovalMemoryFs();
  const workDir = "/tmp/test-content-trusted";
  const config = makeConfig({ workDir, issueLabels: [] });

  // Capture snapshot with original content by trusted author
  await captureContentSnapshot(
    resolveContentApprovalStateDir(workDir),
    "owner/repo",
    42,
    "Original title",
    "Original body",
    "alice",
    deps,
  );

  // Mock returns MODIFIED content but author is trusted
  const mockGh = createWorkOnMockGh({
    issueNumber: 42,
    issueTitle: "Updated title",
    issueBody: "Improved description with more detail",
    issueAuthor: "alice",
    labelAdder: "alice",
    editedBy: "alice",
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    contentApprovalDeps: deps,
  });

  assertEquals(
    result.found,
    true,
    "Should proceed when trusted author modifies content",
  );
  assertEquals(result.output.includes("42"), true);
});

Deno.test("issue_finder - work-on issue captures snapshot on first encounter (Issue #1341)", async () => {
  const { deps } = createContentApprovalMemoryFs();
  const workDir = "/tmp/test-content-first";
  const config = makeConfig({ workDir, issueLabels: [] });

  // No snapshot exists — first encounter

  const mockGh = createWorkOnMockGh({
    issueNumber: 42,
    issueTitle: "New issue",
    issueBody: "First time seeing this",
    issueAuthor: "untrusted-user",
    labelAdder: "alice",
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    contentApprovalDeps: deps,
  });

  assertEquals(
    result.found,
    true,
    "Should proceed on first encounter (no snapshot)",
  );
  assertEquals(result.output.includes("42"), true);
});

// =============================================================================
// `nice`-tier ordering of label/planning finders (Issue #2775)
// =============================================================================

/** Build a labelled, allowed-author issue list entry. */
function niceIssue(
  number: number,
  createdAt: string,
  label = "refine-issue",
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    assignees: [],
    labels: [{ name: label }],
    createdAt,
    author: { login: "alice" },
    milestone: null,
  };
}

/**
 * Mock gh that returns a different `issue list` payload per `--repo`.
 *
 * Issue #3083: operational dispatch labels (refine-issue/planning/...) now
 * require the label *adder* to be on the allowlist, so a per-issue timeline
 * request is served showing the trusted author (`alice`) added each label —
 * keeping these `nice`-ordering tests exercising candidate ordering rather than
 * tripping the authorship gate. All other commands return an empty array.
 */
function createPerRepoMockGh(
  byRepo: Record<string, Record<string, unknown>[]>,
): (args: string[]) => Promise<string> {
  const allIssues = Object.values(byRepo).flat();
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(byRepo[repo] ?? []));
    }
    const timelineMatch = /issues\/(\d+)\/timeline/.exec(command);
    if (timelineMatch) {
      const num = Number(timelineMatch[1]);
      const issue = allIssues.find((i) => i["number"] === num);
      const labels =
        (issue?.["labels"] as Array<{ name: string }> | undefined) ?? [];
      const events = labels.map((l) => ({
        event: "labeled",
        label: { name: l.name },
        actor: { login: "alice" },
      }));
      return Promise.resolve(JSON.stringify(events));
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "issue_finder - findIssuesByLabel surfaces the lower-`nice` repo first (Issue #2775)",
  async () => {
    // owner/high carries the OLDER issue but a higher `nice` (worked later);
    // owner/low defaults to nice 0. Cross-repo oldest-first would surface the
    // older owner/high issue, but `nice` must drain owner/low first.
    const config = makeConfig({
      repos: ["owner/high", "owner/low"],
      shuffleRepos: false,
      repoConfig: { "owner/high": { nice: 10 } },
    });
    const mockGh = createPerRepoMockGh({
      "owner/high": [niceIssue(1, "2024-01-01T00:00:00Z")],
      "owner/low": [niceIssue(2, "2024-06-01T00:00:00Z")],
    });

    const result = await findIssuesByLabel(config, "refine-issue", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0 },
    });

    assertEquals(result.found, true);
    const firstLine = result.output.split("\n")[0] ?? "";
    assertStringIncludes(firstLine, "owner/low|2|");
    // The higher-`nice` candidate still appears, just later.
    assertStringIncludes(result.output, "owner/high|1|");
  },
);

Deno.test(
  "issue_finder - findIssuesByLabel rotates fairly across equal-`nice` repos (Issue #2775)",
  async () => {
    // Both repos default to nice 0. owner/a holds the older issue. With a
    // randomFn selecting the second repo, the first candidate must rotate to
    // owner/b rather than always resolving to the globally-oldest issue.
    const config = makeConfig({
      repos: ["owner/a", "owner/b"],
      shuffleRepos: false,
    });
    const mockGh = createPerRepoMockGh({
      "owner/a": [niceIssue(1, "2024-01-01T00:00:00Z")],
      "owner/b": [niceIssue(2, "2024-06-01T00:00:00Z")],
    });

    const pickFirst = await findIssuesByLabel(config, "refine-issue", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0 },
    });
    assertStringIncludes(pickFirst.output.split("\n")[0] ?? "", "owner/a|1|");

    const pickSecond = await findIssuesByLabel(config, "refine-issue", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0.99 },
    });
    assertStringIncludes(pickSecond.output.split("\n")[0] ?? "", "owner/b|2|");
  },
);

Deno.test(
  "issue_finder - findIssuesByLabel default-everywhere keeps oldest-first parity (Issue #2775)",
  async () => {
    // No `nice` config anywhere → single tier. With the repo index pinned to
    // the first repo, the first candidate is the globally-oldest issue, the
    // same as the previous oldest-first behaviour.
    const config = makeConfig({
      repos: ["owner/a", "owner/b"],
      shuffleRepos: false,
    });
    const mockGh = createPerRepoMockGh({
      "owner/a": [niceIssue(5, "2024-03-01T00:00:00Z")],
      "owner/b": [niceIssue(6, "2024-01-01T00:00:00Z")],
    });

    const result = await findIssuesByLabel(config, "refine-issue", false, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0 },
    });

    assertEquals(result.found, true);
    // owner/b#6 is older overall, so it leads when a single tier is in play.
    assertStringIncludes(result.output.split("\n")[0] ?? "", "owner/b|6|");
  },
);

Deno.test(
  "issue_finder - findPlanningIssuesWithFallback primary path inherits `nice` ordering (Issue #2775)",
  async () => {
    // Primary path delegates to findIssuesByLabel, so the planning label scan
    // must surface the lower-`nice` repo first.
    const config = makeConfig({
      repos: ["owner/high", "owner/low"],
      shuffleRepos: false,
      repoConfig: { "owner/high": { nice: 5 } },
    });
    const mockGh = createPerRepoMockGh({
      "owner/high": [niceIssue(1, "2024-01-01T00:00:00Z", "planning")],
      "owner/low": [niceIssue(2, "2024-06-01T00:00:00Z", "planning")],
    });

    const result = await findPlanningIssuesWithFallback(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0 },
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output.split("\n")[0] ?? "", "owner/low|2|");
  },
);

Deno.test(
  "issue_finder - findPlanningIssuesWithFallback comment fallback honours `nice` (Issue #2775)",
  async () => {
    // No planning-labelled issues → comment fallback. owner/high has the older
    // escalated issue but a higher `nice`; owner/low must lead.
    const config = makeConfig({
      repos: ["owner/high", "owner/low"],
      shuffleRepos: false,
      repoConfig: { "owner/high": { nice: 7 } },
    });
    const escalation = "## Automatic Escalation to Planning Mode\nplease plan";
    const mockGh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
      if (command.includes("issue view")) {
        // Comment body fetch for the fallback escalation check.
        return Promise.resolve(escalation);
      }
      if (command.includes("issue list")) {
        // Issues carry no planning label, so the primary scan finds nothing
        // and the comment fallback runs.
        const byRepo: Record<string, Record<string, unknown>[]> = {
          "owner/high": [niceIssue(1, "2024-01-01T00:00:00Z", "bug")],
          "owner/low": [niceIssue(2, "2024-06-01T00:00:00Z", "bug")],
        };
        return Promise.resolve(JSON.stringify(byRepo[repo] ?? []));
      }
      return Promise.resolve("[]");
    };

    const result = await findPlanningIssuesWithFallback(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0 },
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output.split("\n")[0] ?? "", "owner/low|2|");
    assertStringIncludes(result.output, "owner/high|1|");
  },
);

// ---------------------------------------------------------------------------
// Cooldown refusals ride the result (Issue #655)
// ---------------------------------------------------------------------------
// `blockedDetails` is what the idle-inversion escalation reads to name the
// gate that refused each issue the census called claimable (Issue #460). The
// cooldown filters logged a skip line and recorded nothing, so VibeCoder#655
// was filed with no "What the claim scan did with them" section at all — the
// one fact its reader needed.

Deno.test("issue_finder - a cooldown refusal is recorded in blockedDetails (Issue #655)", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Local cooldown",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
      {
        number: 11,
        title: "Cross-worker cooldown",
        url: "https://github.com/owner/repo/issues/11",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-02T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    isIssueInCooldown: (_repo, num) => num === 10,
    hasCrossWorkerCooldown: async (_repo, num) => num === 11,
  });

  assertEquals(result.found, false);
  const reasons = new Map(
    (result.blockedDetails ?? []).map((b) => [b.issueNumber, b.reason]),
  );
  assertEquals(
    reasons.get(10),
    "cooldown",
    "a local cooldown refusal must name itself in blockedDetails",
  );
  assertEquals(
    reasons.get(11),
    "cross-worker-cooldown",
    "a cross-worker cooldown refusal must name itself in blockedDetails",
  );
});

Deno.test("issue_finder - a selected issue leaves no cooldown entry behind (Issue #655)", async () => {
  const config = makeConfig();
  const mockGh = createMockGh({
    issues: [
      {
        number: 10,
        title: "Available",
        url: "https://github.com/owner/repo/issues/10",
        assignees: [],
        labels: [{ name: "help-wanted" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    prs: [],
    timeline: [
      {
        event: "labeled",
        label: { name: "help-wanted" },
        actor: { login: "alice" },
      },
    ],
  });

  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    isIssueInCooldown: () => false,
  });

  assertEquals(result.found, true);
  assertEquals(
    (result.blockedDetails ?? []).filter((b) => b.reason === "cooldown"),
    [],
  );
});
