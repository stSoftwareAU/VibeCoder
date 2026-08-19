/**
 * Integration tests for the unworkable-work-on deadlock fix (Issue #2751).
 *
 * `hasSuppressingWorkOn` is now computed from the *post-`filterAndSort`*
 * set. A repo whose only open `work-on` issues are dropped by
 * `filterAndSort` (milestone-tracking trackers, assigned, failed,
 * needs-human, …) must no longer suppress its `low-priority`/`idle-task`
 * backlog — the `private-repo-12` field case, where 28 low-priority issues
 * sat frozen for over a month behind 2 milestone-tracking work-on issues
 * the worker never actions.
 *
 * The serialisation guarantee is preserved for work-on issues that
 * *survive* `filterAndSort` and are blocked for a genuine serialisation
 * reason (PR-blocked, milestone-occupied): those still suppress.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "unworkable-workon-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "unworkable-workon-workdir-" }),
    repos: ["owner/repo-a"],
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
    ...overrides,
  };
}

interface FixtureIssue {
  number: number;
  title: string;
  url: string;
  assignees: Record<string, unknown>[];
  labels: { name: string }[];
  createdAt: string;
  author: { login: string };
  milestone: unknown;
  body?: string;
}

interface FixturePR {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
}

interface RepoFixture {
  issues: FixtureIssue[];
  timeline?: Record<string, unknown>[];
  prs?: FixturePR[];
}

function createMockGh(
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
    const fixture = fixtures[repo];

    if (command.includes("issue view") && args.includes("body")) {
      const numIdx = args.indexOf("view") + 1;
      const num = Number(args[numIdx]);
      const issue = fixture?.issues.find((i) => i.number === num);
      return Promise.resolve(JSON.stringify({ body: issue?.body ?? "" }));
    }
    if (command.includes("issue view") && command.includes("state")) {
      const numIdx = args.indexOf("view") + 1;
      const num = Number(args[numIdx]);
      const issue = fixture?.issues.find((i) => i.number === num);
      return Promise.resolve(
        JSON.stringify({
          number: num,
          state: issue ? "OPEN" : "CLOSED",
          title: issue?.title ?? "",
        }),
      );
    }
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(fixture?.issues ?? []));
    }
    if (command.includes("pr list")) {
      return Promise.resolve(JSON.stringify(fixture?.prs ?? []));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(fixture?.timeline ?? []));
    }
    return Promise.resolve("[]");
  };
}

const ALICE = { login: "alice" };

function issue(
  partial: Partial<FixtureIssue> & { number: number },
): FixtureIssue {
  return {
    title: `Issue ${partial.number}`,
    url: `https://github.com/owner/repo-a/issues/${partial.number}`,
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    author: ALICE,
    milestone: null,
    body: "",
    ...partial,
  };
}

Deno.test(
  "findOldestIssue - milestone-tracking work-on issues no longer suppress the repo's low-priority backlog (private-repo-12 field case)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      "owner/repo-a": {
        issues: [
          // Eligible low-priority backlog item.
          issue({
            number: 100,
            title: "Tidy backlog item",
            labels: [{ name: "low-priority" }],
            createdAt: "2024-02-01T00:00:00Z",
          }),
          // Two milestone-tracking work-on issues — matched by
          // isMilestoneTrackingIssue and dropped by filterAndSort, so the
          // worker never actions them.
          issue({
            number: 200,
            title: "Merge milestone 'v21' to main",
            labels: [{ name: "work-on" }],
            createdAt: "2024-03-01T00:00:00Z",
          }),
          issue({
            number: 201,
            title: "Merge milestone 'v22' to main",
            labels: [{ name: "work-on" }],
            createdAt: "2024-03-02T00:00:00Z",
          }),
        ],
        timeline: [
          { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });

    // The only work-on issues are milestone-tracking (dropped by
    // filterAndSort), so they no longer suppress the low-priority backlog
    // and #100 is selected.
    assertEquals(result.found, true);
    assertEquals(result.output.includes("|100|"), true);
  },
);

Deno.test(
  "findOldestIssue - a PR-blocked work-on issue that survives filterAndSort still suppresses low-priority (serialisation preserved)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      "owner/repo-a": {
        issues: [
          issue({
            number: 100,
            title: "Backlog chore",
            labels: [{ name: "low-priority" }],
          }),
          // Unassigned, no blocking label — survives filterAndSort — but a
          // worker PR targeting the default branch blocks it. This is a
          // genuine serialisation signal, so the low-priority tier stays
          // suppressed.
          issue({
            number: 200,
            title: "Default-branch work",
            labels: [{ name: "work-on" }],
            createdAt: "2024-06-01T00:00:00Z",
            body: "No dependencies",
          }),
        ],
        prs: [
          {
            number: 5,
            title: "WIP for #200",
            baseRefName: "main",
            headRefName: "feature-x",
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
    });

    // The work-on issue survives filterAndSort and is PR-blocked (not
    // dependency-blocked), so it keeps the repo's low-priority backlog
    // suppressed — the one-PR-per-work-stream guarantee holds.
    assertEquals(result.found, false);
  },
);
