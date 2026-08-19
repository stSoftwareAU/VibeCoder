/**
 * Tests for the `hasSuppressingWorkOn` signal of `collectWorkOnCandidates`
 * (Issue #2751).
 *
 * The suppression signal must be computed from the *post-`filterAndSort`*
 * set, not the raw `fetchIssuesByLabel` count. Work-on issues the worker
 * can never action this cycle — milestone-tracking trackers (the proven
 * `Migration_v21` field case), issues assigned to anyone, and issues
 * carrying a blocking label (failed, needs-human, needs-revision,
 * refine-issue, planning, question) — are dropped by `filterAndSort` and
 * must NOT suppress the repo's low-priority/idle-task backlog. Otherwise a
 * repo whose only work-on issues are permanently unworkable deadlocks its
 * entire backlog behind them.
 *
 * The Issue #2610 dependency-blocked carve-out is preserved: of the issues
 * that survive `filterAndSort`, those whose sole blocker is an open
 * dependency are excluded too, leaving only genuine serialisation signals
 * (eligible, PR-blocked, milestone-occupied, closed-PR cooldown).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

interface MockGhData {
  /** Issues returned by `gh issue list` (any state). */
  issues?: Record<string, unknown>[];
  /** Timeline events returned by `gh api .../timeline`. */
  timeline?: Record<string, unknown>[];
  /** Body returned by `gh issue view --json title,body`. */
  issueView?: { title?: string; body?: string };
}

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "work-on-suppression-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: ["owner/repo"],
    issueLabels: ["help-wanted"],
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
    workDir: Deno.makeTempDirSync({ prefix: "work-on-suppression-workdir-" }),
    ...overrides,
  };
}

function createMockGh(data: MockGhData): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(data.issues ?? []));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      const view = data.issueView ?? { title: "", body: "" };
      return Promise.resolve(JSON.stringify(view));
    }
    // Matches both the REST per-issue timeline path and (failing-parse →
    // fallback) the batched GraphQL query, whose text contains
    // "timelineItems".
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(data.timeline ?? []));
    }
    return Promise.resolve("[]");
  };
}

function buildOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: IssueCache,
): FindIssuesOptions {
  return {
    githubUser: "bot",
    ghCommandFn,
    cache,
  };
}

async function collect(
  mockGh: (args: string[]) => Promise<string>,
  config: WorkerConfig,
  repoAllIssues: FilterableIssue[] = [],
) {
  const cache = createTestCache();
  const fetcher = createIssueFetcher(mockGh);
  const repoPRs: OpenPR[] = [];
  const repoClosedPRs: ClosedPR[] = [];
  return await collectWorkOnCandidates(
    "owner/repo",
    config,
    buildOptions(mockGh, cache),
    repoPRs,
    repoAllIssues,
    fetcher,
    repoClosedPRs,
  );
}

// ---------------------------------------------------------------------------
// Criterion 1: milestone-tracking only → does not suppress (the field case)
// ---------------------------------------------------------------------------

Deno.test(
  "collect_work_on_candidates - a repo whose only work-on issue is milestone-tracking does not suppress",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 200,
          // Title matches the milestone-tracking pattern, so
          // `isMilestoneTrackingIssue` drops it in `filterAndSort`.
          title: "Merge milestone 'v21' to main",
          url: "https://github.com/owner/repo/issues/200",
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-06-01T00:00:00Z",
        },
      ],
    });

    const result = await collect(mockGh, config);

    // hasOpenIssues stays true (there IS an open work-on issue), but the
    // suppression signal is false because the only work-on issue was
    // dropped by filterAndSort.
    assertEquals(result.hasOpenIssues, true);
    assertEquals(result.hasSuppressingWorkOn, false);
    assertEquals(result.candidates, []);
  },
);

// ---------------------------------------------------------------------------
// Criterion 2: mixed set → a surviving workable issue still suppresses
// ---------------------------------------------------------------------------

Deno.test(
  "collect_work_on_candidates - one workable work-on issue plus one milestone-tracking issue still suppresses (no over-correction)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        // Workable, eligible work-on issue — survives filterAndSort.
        {
          number: 10,
          title: "Implement feature",
          url: "https://github.com/owner/repo/issues/10",
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-05-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
          body: "No dependencies",
        },
        // Milestone-tracking issue — dropped by filterAndSort.
        {
          number: 20,
          title: "Merge milestone 'v21' to main",
          url: "https://github.com/owner/repo/issues/20",
          assignees: [],
          labels: [{ name: "work-on" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T00:00:00Z",
        },
      ],
      issueView: { title: "Implement feature", body: "No dependencies" },
    });

    const result = await collect(mockGh, config);

    assertEquals(result.hasOpenIssues, true);
    assertEquals(result.hasSuppressingWorkOn, true);
    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 10);
  },
);

// ---------------------------------------------------------------------------
// Criterion 3: other filterAndSort-dropped categories do not suppress
// ---------------------------------------------------------------------------

Deno.test(
  "collect_work_on_candidates - a work-on issue assigned to someone else does not suppress",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 30,
          title: "Already claimed",
          url: "https://github.com/owner/repo/issues/30",
          assignees: [{ login: "someone-else" }],
          labels: [{ name: "work-on" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-06-01T00:00:00Z",
        },
      ],
    });

    const result = await collect(mockGh, config);

    assertEquals(result.hasOpenIssues, true);
    assertEquals(result.hasSuppressingWorkOn, false);
    assertEquals(result.candidates, []);
  },
);

Deno.test(
  "collect_work_on_candidates - a needs-human work-on issue does not suppress",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 40,
          title: "Handed back to a human",
          url: "https://github.com/owner/repo/issues/40",
          assignees: [],
          labels: [{ name: "work-on" }, { name: "needs-human" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-06-01T00:00:00Z",
        },
        {
          // needs-human is operational; a trusted-author add keeps it on the
          // issue so filterAndSort can drop the issue for that label.
          event: "labeled",
          label: { name: "needs-human" },
          actor: { login: "alice" },
          created_at: "2024-06-02T00:00:00Z",
        },
      ],
    });

    const result = await collect(mockGh, config);

    assertEquals(result.hasOpenIssues, true);
    assertEquals(result.hasSuppressingWorkOn, false);
    assertEquals(result.candidates, []);
  },
);

Deno.test(
  "collect_work_on_candidates - a failed work-on issue does not suppress",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 50,
          title: "Permanently failed",
          url: "https://github.com/owner/repo/issues/50",
          assignees: [],
          labels: [{ name: "work-on" }, { name: "failed" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // No "reopened" event, so cleanStaleLabels keeps the failed label and
      // filterAndSort drops the issue.
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-06-01T00:00:00Z",
        },
      ],
    });

    const result = await collect(mockGh, config);

    assertEquals(result.hasOpenIssues, true);
    assertEquals(result.hasSuppressingWorkOn, false);
    assertEquals(result.candidates, []);
  },
);
