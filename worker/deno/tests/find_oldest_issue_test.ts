/**
 * Integration tests for `findOldestIssue` cross-repo priority ordering
 * (Issue #1720, part of #1717).
 *
 * The single-repo tests in `issue_finder_test.ts` and the unit tests in
 * `issue_priority_test.ts` cover their respective layers. This file
 * exercises the contract that ties them together: when candidates are
 * collected from multiple repos before selection, the priority hierarchy
 * (configured-label tiers in order, then work-on) holds across repos.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "find-oldest-cross-repo-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "find-oldest-workdir-" }),
    repos: ["owner/repo-a", "owner/repo-b"],
    // Order matters: index 0 = top-priority, 1 = help-wanted, 2 = claude.
    issueLabels: ["top-priority", "help-wanted", "claude"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    ...overrides,
  };
}

interface RepoFixture {
  /** Open issues returned for any `gh issue list ... --repo <repo>` query. */
  issues: Record<string, unknown>[];
  /** Timeline events returned for any timeline query in the repo. */
  timeline?: Record<string, unknown>[];
}

/**
 * Build a mock gh command that returns different issue lists per repo.
 * Mirrors the helper in `find_oldest_issue_low_priority_test.ts` so the
 * test fixtures look familiar to reviewers.
 */
function createPerRepoMockGh(
  fixtures: Record<string, RepoFixture>,
): (args: string[]) => Promise<string> {
  function resolveRepo(args: string[]): string {
    const repoIdx = args.indexOf("--repo");
    if (repoIdx >= 0) return args[repoIdx + 1] ?? "";
    for (const arg of args) {
      const match = arg.match(/^repos\/([^/]+\/[^/]+)\//);
      if (match) return match[1] ?? "";
    }
    return "";
  }

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    const repo = resolveRepo(args);

    if (command.includes("issue list")) {
      const fixture = fixtures[repo];
      return Promise.resolve(JSON.stringify(fixture?.issues ?? []));
    }
    if (command.includes("pr list")) {
      return Promise.resolve("[]");
    }
    if (command.includes("timeline")) {
      const fixture = fixtures[repo];
      return Promise.resolve(JSON.stringify(fixture?.timeline ?? []));
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "findOldestIssue - cross-repo: top-priority in repo A wins over work-on in repo B (Issue #1720)",
  async () => {
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        // Newer top-priority issue in repo A — must still beat the older
        // work-on issue in repo B because tier ordering dominates age.
        issues: [
          {
            number: 1,
            title: "Top-priority bug",
            url: "https://github.com/owner/repo-a/issues/1",
            assignees: [],
            labels: [{ name: "top-priority" }],
            createdAt: "2024-06-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
        ],
      },
      "owner/repo-b": {
        issues: [
          {
            number: 2,
            title: "Work-on chore",
            url: "https://github.com/owner/repo-b/issues/2",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      // Deterministic selection within the chosen tier.
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("owner/repo-a"), true);
    assertEquals(result.output.includes("|1|"), true);
  },
);

Deno.test(
  "findOldestIssue - cross-repo: help-wanted in repo A beats claude in repo B (Issue #1720)",
  async () => {
    // Both repos have configured-label issues, but at different priority
    // tiers. The lower labelIndex (help-wanted = 1) must outrank the
    // higher labelIndex (claude = 2) regardless of which repo it sits in
    // and regardless of createdAt.
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 11,
            title: "Help wanted issue",
            url: "https://github.com/owner/repo-a/issues/11",
            assignees: [],
            labels: [{ name: "help-wanted" }],
            // Newer than repo B's claude issue.
            createdAt: "2024-05-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "help-wanted" }, actor: ALICE },
        ],
      },
      "owner/repo-b": {
        issues: [
          {
            number: 22,
            title: "Claude issue",
            url: "https://github.com/owner/repo-b/issues/22",
            assignees: [],
            labels: [{ name: "claude" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "claude" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("owner/repo-a"), true);
    assertEquals(result.output.includes("|11|"), true);
  },
);

Deno.test(
  "findOldestIssue - same-repo: top-priority beats work-on regardless of age (Issue #1731)",
  async () => {
    // Captures the user's screenshot scenario in #1731: a single repo with
    // both a top-priority issue and a work-on issue (no suppression). The
    // top-priority issue is newer than the work-on issue, so a naive
    // oldest-first selector would pick the work-on issue. Tier ordering
    // must dominate age, and the choice must be the same whether the work
    // is split across repos (covered by the cross-repo tests above) or
    // sits in the same repo.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 100,
            title: "Top-priority issue (newer)",
            url: "https://github.com/owner/repo-a/issues/100",
            assignees: [],
            labels: [{ name: "top-priority" }],
            createdAt: "2024-06-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
          {
            number: 50,
            title: "Work-on issue (older)",
            url: "https://github.com/owner/repo-a/issues/50",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("owner/repo-a"), true);
    assertEquals(result.output.includes("|100|"), true);
  },
);

Deno.test(
  "findOldestIssue - same-repo: issue with both top-priority and work-on labels selected via top-priority tier (Issue #1731)",
  async () => {
    // Issue #1731 itself carries both `work-on` and `top-priority` labels.
    // Such an issue is collected by both `collectLabelCandidates` (under
    // top-priority, labelIndex 0) and `collectWorkOnCandidates`
    // (labelIndex 99). `selectHighestPriority` must pick it via the
    // configured-label tier — never via the work-on tier — so downstream
    // logging and routing reflect the correct tier.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 1731,
            title: "Top priority should be worked on first",
            url: "https://github.com/owner/repo-a/issues/1731",
            assignees: [],
            labels: [{ name: "work-on" }, { name: "top-priority" }],
            createdAt: "2026-04-28T10:45:19Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|1731|"), true);
  },
);

// =============================================================================
// Selection-reasoning diagnostic (Issue #1718)
// =============================================================================

/** Build a diagnostics instance that captures every emitted message. */
function captureDiagnostics(): {
  diag: ReturnType<typeof createDiagnostics>;
  output: string[];
} {
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: false,
    write: (msg: string) => output.push(msg),
  });
  return { diag, output };
}

Deno.test(
  "findOldestIssue - emits selection-reasoning when work-on selected and top-priority blocked (Issue #1718)",
  async () => {
    // Top-priority issue lives in milestone v1.0, which is occupied by
    // another bot-assigned issue. Work-on issue lives in milestone v2.0,
    // unoccupied. Because the milestones differ, blocked-entry suppression
    // does not catch the work-on, and `selectHighestPriority` picks it.
    // The reasoning line must surface the blocked top-priority.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 1691,
            title: "Top-priority bug in v1.0",
            url: "https://github.com/owner/repo-a/issues/1691",
            assignees: [],
            labels: [{ name: "top-priority" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: { title: "v1.0" },
          },
          {
            // Occupies v1.0 — assigned to the worker user "bot".
            number: 1690,
            title: "Already in flight in v1.0",
            url: "https://github.com/owner/repo-a/issues/1690",
            assignees: [{ login: "bot" }],
            labels: [],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: { title: "v1.0" },
          },
          {
            number: 1711,
            title: "Work-on chore in v2.0",
            url: "https://github.com/owner/repo-a/issues/1711",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-02-01T00:00:00Z",
            author: ALICE,
            milestone: { title: "v2.0" },
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const { diag, output } = captureDiagnostics();
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|1711|"), true);

    const reasoningLine = output.find((m) => m.includes("selection-reasoning"));
    assertEquals(
      reasoningLine !== undefined,
      true,
      `expected selection-reasoning line, got: ${output.join("\n")}`,
    );
    assertStringIncludes(reasoningLine!, "selected=owner/repo-a#1711");
    assertStringIncludes(reasoningLine!, "source=work-on");
    assertStringIncludes(
      reasoningLine!,
      "owner/repo-a#1691(milestone-occupied)",
    );
    assertStringIncludes(reasoningLine!, "configured-label-blocked=1");
  },
);

Deno.test(
  "findOldestIssue - no selection-reasoning when configured-label is selected (Issue #1718)",
  async () => {
    // Both top-priority and work-on are eligible. Configured-label wins.
    // The reasoning line is suppressed to avoid noise.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 1,
            title: "Top-priority",
            url: "https://github.com/owner/repo-a/issues/1",
            assignees: [],
            labels: [{ name: "top-priority" }],
            createdAt: "2024-06-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
          {
            number: 2,
            title: "Work-on",
            url: "https://github.com/owner/repo-a/issues/2",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const { diag, output } = captureDiagnostics();
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|1|"), true);

    const reasoningLine = output.find((m) => m.includes("selection-reasoning"));
    assertEquals(reasoningLine, undefined);
  },
);

Deno.test(
  "findOldestIssue - no selection-reasoning when no configured-label candidates exist (Issue #1718)",
  async () => {
    // Only a work-on candidate exists — no surprise that work-on was
    // chosen. Reasoning line is suppressed.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 42,
            title: "Lone work-on",
            url: "https://github.com/owner/repo-a/issues/42",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-02-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const { diag, output } = captureDiagnostics();
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|42|"), true);

    const reasoningLine = output.find((m) => m.includes("selection-reasoning"));
    assertEquals(reasoningLine, undefined);
  },
);

Deno.test(
  "findOldestIssue - cross-repo: work-on selected when no configured-label exists in any repo (Issue #1720)",
  async () => {
    // Sanity case for the cross-repo work-on path: repo A has no eligible
    // work, repo B has a work-on issue. The work-on candidate should win.
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [],
        timeline: [],
      },
      "owner/repo-b": {
        issues: [
          {
            number: 42,
            title: "Lone work-on issue",
            url: "https://github.com/owner/repo-b/issues/42",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-02-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("owner/repo-b"), true);
    assertEquals(result.output.includes("|42|"), true);
  },
);

// =============================================================================
// Fleet-aware open-PR duplicate guard (Issue #3100)
// =============================================================================

interface FleetFixtureOptions {
  /** Open PRs keyed by gh `--author` value. */
  prsByAuthor?: Record<
    string,
    Array<{ number: number; baseRefName: string }>
  >;
  /** Extra labels on the work-on issue (e.g. "ignore-open-prs"). */
  extraLabels?: string[];
  /** Timeline labeled events for the work-on issue. */
  timeline?: Record<string, unknown>[];
}

/**
 * Mock gh for the single-repo fleet guard tests. repo-a is empty; repo-b
 * has one non-milestone work-on issue (#77). `pr list` is answered per
 * `--author` so a sibling fleet account's PR can be simulated.
 */
function createFleetMockGh(
  opts: FleetFixtureOptions,
): (args: string[]) => Promise<string> {
  const issue = {
    number: 77,
    title: "Fleet work-on issue",
    url: "https://github.com/owner/repo-b/issues/77",
    assignees: [],
    labels: [
      { name: "work-on" },
      ...(opts.extraLabels ?? []).map((n) => ({
        name: n,
      })),
    ],
    createdAt: "2024-01-01T00:00:00Z",
    author: ALICE,
    milestone: null,
  };

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";

    if (command.includes("issue list")) {
      return Promise.resolve(
        repo === "owner/repo-b" ? JSON.stringify([issue]) : "[]",
      );
    }
    if (command.includes("issue view")) {
      // fetchIssueLabels: `gh issue view <n> --json labels`
      return Promise.resolve(JSON.stringify({ labels: issue.labels }));
    }
    if (command.includes("pr list")) {
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] ?? "" : "";
      const prs = (opts.prsByAuthor?.[author] ?? []).map((p) => ({
        number: p.number,
        title: `PR ${p.number}`,
        baseRefName: p.baseRefName,
        headRefName: `issue-${p.number}`,
      }));
      return Promise.resolve(JSON.stringify(prs));
    }
    if (command.includes("timeline")) {
      const timeline = opts.timeline ??
        [{ event: "labeled", label: { name: "work-on" }, actor: ALICE }];
      return Promise.resolve(JSON.stringify(timeline));
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "findOldestIssue - skips issue when another fleet account has an open PR (Issue #3100)",
  async () => {
    // "stsvcbot" (a sibling fleet host) already has an open PR targeting
    // the default branch for the work-on issue. The current host ("bot")
    // must detect it via the fleet union and skip the issue.
    //
    // Issue #4133: the sibling is declared in `fleetPrAuthors` — the
    // push-capable set — because only fleet-owned PRs block now. A login
    // present in `allowedAuthors` alone is a human (next test).
    const config = makeConfig({
      allowedAuthors: ["alice", "stsvcbot"],
      fleetPrAuthors: ["stsvcbot"],
    });
    const mockGh = createFleetMockGh({
      prsByAuthor: { stsvcbot: [{ number: 639, baseRefName: "main" }] },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - a trusted human's open PR does not block the issue (Issue #4133)",
  async () => {
    // "maintainer" is a trusted human: listed in `allowedAuthors` only, so never
    // push-capable. Their unrelated PR must not park the work-on queue.
    const config = makeConfig({ allowedAuthors: ["alice", "maintainer"] });
    const mockGh = createFleetMockGh({
      prsByAuthor: { maintainer: [{ number: 4036, baseRefName: "main" }] },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
  },
);

Deno.test(
  "findOldestIssue - own-account open PR still blocks the issue (Issue #3100 regression)",
  async () => {
    // Regression: the current host's own open PR must keep blocking.
    const config = makeConfig({ allowedAuthors: ["alice"] });
    const mockGh = createFleetMockGh({
      prsByAuthor: { bot: [{ number: 500, baseRefName: "main" }] },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - issue selected when no fleet account has an open PR (Issue #3100)",
  async () => {
    // Positive control: the fleet union must not over-block. With no PRs for
    // any fleet account the work-on issue is selectable.
    const config = makeConfig({ allowedAuthors: ["alice", "stsvcbot"] });
    const mockGh = createFleetMockGh({ prsByAuthor: {} });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|77|"), true);
  },
);

Deno.test(
  "findOldestIssue - ignore-open-prs escape hatch lets a fleet-blocked issue through (Issue #3100)",
  async () => {
    // Even with a sibling fleet account's open PR, the ignore-open-prs label
    // (added by an allowed author) overrides the block.
    const config = makeConfig({ allowedAuthors: ["alice", "stsvcbot"] });
    const mockGh = createFleetMockGh({
      prsByAuthor: { stsvcbot: [{ number: 640, baseRefName: "main" }] },
      extraLabels: ["ignore-open-prs"],
      timeline: [
        { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        { event: "labeled", label: { name: "ignore-open-prs" }, actor: ALICE },
      ],
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|77|"), true);
  },
);

// =============================================================================
// Fleet-wide, permanent post-merge re-pickup guard (Issue #3151)
// =============================================================================

/**
 * Mock gh that serves one repo's open issues, per-author closed PRs (with
 * merge state via `--state closed`), and a timeline. Used to prove the
 * post-merge re-pickup guard is fleet-wide and permanent.
 */
function mockGhWithClosedPRs(opts: {
  issues: Record<string, unknown>[];
  closedByAuthor: Record<
    string,
    Array<
      {
        number: number;
        title: string;
        mergedAt: string | null;
        closedAt: string | null;
      }
    >
  >;
  timeline: Record<string, unknown>[];
}): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(opts.issues));
    }
    if (command.includes("pr list")) {
      const stateIdx = args.indexOf("--state");
      const state = stateIdx >= 0 ? args[stateIdx + 1] ?? "" : "";
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] ?? "" : "";
      if (state === "closed") {
        return Promise.resolve(
          JSON.stringify(opts.closedByAuthor[author] ?? []),
        );
      }
      return Promise.resolve("[]");
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(opts.timeline));
    }
    return Promise.resolve("[]");
  };
}

const workOnIssue3151 = {
  number: 678,
  title: "Fix validation (#678)",
  url: "https://github.com/owner/repo-a/issues/678",
  assignees: [],
  labels: [{ name: "work-on" }],
  createdAt: "2024-01-01T00:00:00Z",
  author: ALICE,
  milestone: null,
};

const workOnTimeline3151 = [
  { event: "labeled", label: { name: "work-on" }, actor: ALICE },
];

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

Deno.test(
  "findOldestIssue - a PR merged by a SIBLING account past the cooldown permanently blocks re-pickup (Issue #3151)",
  async () => {
    const config = makeConfig({ repos: ["owner/repo-a"] });
    // The sibling (alice) merged PR #680 for issue #678 two hours ago —
    // well past the 1h cooldown. The single-account guard would have missed
    // it (bot never authored it) and the cooldown would have expired anyway.
    const mockGh = mockGhWithClosedPRs({
      issues: [workOnIssue3151],
      closedByAuthor: {
        alice: [{
          number: 680,
          title: "Fix validation (#678)",
          mergedAt: isoSecondsAgo(7200),
          closedAt: isoSecondsAgo(7200),
        }],
      },
      timeline: workOnTimeline3151,
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - a closed-UNMERGED sibling PR past the cooldown does NOT block (retry path preserved) (Issue #3151)",
  async () => {
    const config = makeConfig({ repos: ["owner/repo-a"] });
    // Same sibling PR but closed-not-merged and past the cooldown window →
    // the issue must remain eligible so the retry path can re-attempt it.
    const mockGh = mockGhWithClosedPRs({
      issues: [workOnIssue3151],
      closedByAuthor: {
        alice: [{
          number: 680,
          title: "Fix validation (#678)",
          mergedAt: null,
          closedAt: isoSecondsAgo(7200),
        }],
      },
      timeline: workOnTimeline3151,
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|678|"), true);
  },
);

Deno.test(
  "findOldestIssue - a merged PR by the HOST's OWN account permanently blocks re-pickup (Issue #3151 same-account)",
  async () => {
    // Mode B has two halves: the sibling-account case above and this
    // same-account case. The host ("bot") merged its own PR #680 for issue
    // #678 two hours ago — past the cooldown. It must still be permanently
    // blocked (the #3123→#3126 same-account re-pickup shape).
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const mockGh = mockGhWithClosedPRs({
      issues: [workOnIssue3151],
      closedByAuthor: {
        bot: [{
          number: 680,
          title: "Fix validation (#678)",
          mergedAt: isoSecondsAgo(7200),
          closedAt: isoSecondsAgo(7200),
        }],
      },
      timeline: workOnTimeline3151,
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - a merged lock in one repo does NOT suppress a clean issue in another (Issue #3151 repo-scoped)",
  async () => {
    // A permanent merged-lock must be repo-scoped, not a fleet kill-switch:
    // repo-a's issue is merged-locked, but a clean issue in repo-b stays
    // selectable so the worker keeps making progress elsewhere.
    const config = makeConfig({ repos: ["owner/repo-a", "owner/repo-b"] });
    const cleanIssueRepoB = {
      number: 700,
      title: "Unrelated clean issue (#700)",
      url: "https://github.com/owner/repo-b/issues/700",
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2024-02-01T00:00:00Z",
      author: ALICE,
      milestone: null,
    };
    const mockGh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
      if (command.includes("issue list")) {
        return Promise.resolve(
          repo === "owner/repo-a"
            ? JSON.stringify([workOnIssue3151])
            : JSON.stringify([cleanIssueRepoB]),
        );
      }
      if (command.includes("pr list")) {
        const stateIdx = args.indexOf("--state");
        const state = stateIdx >= 0 ? args[stateIdx + 1] ?? "" : "";
        if (state === "closed" && repo === "owner/repo-a") {
          return Promise.resolve(JSON.stringify([{
            number: 680,
            title: "Fix validation (#678)",
            mergedAt: isoSecondsAgo(7200),
            closedAt: isoSecondsAgo(7200),
          }]));
        }
        return Promise.resolve("[]");
      }
      if (command.includes("timeline")) {
        return Promise.resolve(JSON.stringify(workOnTimeline3151));
      }
      return Promise.resolve("[]");
    };

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|700|"), true);
  },
);

// ---------------------------------------------------------------------------
// In-flight repo exclusion (Issue #4176, part of #4168)
// ---------------------------------------------------------------------------

function twoRepoFixtures(): Parameters<typeof createPerRepoMockGh>[0] {
  return {
    "owner/repo-a": {
      issues: [{
        number: 1,
        title: "Oldest work-on, in the held repo",
        url: "https://github.com/owner/repo-a/issues/1",
        assignees: [],
        labels: [{ name: "work-on" }],
        createdAt: "2024-01-01T00:00:00Z",
        author: ALICE,
        milestone: null,
      }],
      timeline: [{
        event: "labeled",
        label: { name: "work-on" },
        actor: ALICE,
      }],
    },
    "owner/repo-b": {
      issues: [{
        number: 7,
        title: "Newer work-on, in a free repo",
        url: "https://github.com/owner/repo-b/issues/7",
        assignees: [],
        labels: [{ name: "work-on" }],
        createdAt: "2024-06-01T00:00:00Z",
        author: ALICE,
        milestone: null,
      }],
      timeline: [{
        event: "labeled",
        label: { name: "work-on" },
        actor: ALICE,
      }],
    },
  };
}

Deno.test("findOldestIssue - with repo A held, the scan skips A#1 and returns B#7 (Issue #4176)", async () => {
  const config = makeConfig();
  const mockGh = createPerRepoMockGh(twoRepoFixtures());
  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    excludeRepos: new Set(["owner/repo-a"]),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
  assertEquals(result.found, true);
  assertEquals(result.output.includes("owner/repo-b"), true);
  assertEquals(result.output.includes("|7|"), true);
});

Deno.test("findOldestIssue - every candidate in a held repo → null, no error, no spin (Issue #4176)", async () => {
  const config = makeConfig();
  const mockGh = createPerRepoMockGh(twoRepoFixtures());
  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    excludeRepos: new Set(["owner/repo-a", "owner/repo-b"]),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
  assertEquals(result.found, false);
});

Deno.test("findOldestIssue - no exclusion set: serial ordering unchanged (oldest A#1 wins) (Issue #4176)", async () => {
  const config = makeConfig();
  const mockGh = createPerRepoMockGh(twoRepoFixtures());
  const result = await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache: createTestCache(),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
  assertEquals(result.found, true);
  assertEquals(result.output.includes("owner/repo-a"), true);
  assertEquals(result.output.includes("|1|"), true);
});

Deno.test(
  "findOldestIssue - a scan that selects nothing still reports its counts (Issue #219)",
  async () => {
    // Every candidate is in cooldown, so the scan returns nothing. The
    // counts must come back with the result: a pool slot that finds no work
    // logs them instead of retiring silently.
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 1,
            title: "Top-priority bug",
            url: "https://github.com/owner/repo-a/issues/1",
            assignees: [],
            labels: [{ name: "top-priority" }],
            createdAt: "2024-06-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
        ],
      },
      "owner/repo-b": { issues: [] },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      isIssueInCooldown: () => true,
    });

    assertEquals(result.found, false);
    const summary = result.diagnosticSummary;
    assert(
      summary,
      "a scan must report its counts so an idle slot can say why it found nothing",
    );
    assertEquals(summary.totalConsidered, 1);
    assertEquals(summary.skippedByReason.cooldown, 1);
  },
);
