/**
 * Integration tests for `findOldestIssue` tier-3 low-priority selection
 * (Issue #1725).
 *
 * Verifies the cross-repo "global" semantics: a low-priority candidate is
 * only selected when no configured-label or work-on candidate exists in
 * any scanned repo.
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "lp-finder-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "low-priority-workdir-" }),
    repos: ["owner/repo-a", "owner/repo-b"],
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

interface RepoFixture {
  /** Open issues for `gh issue list --state open --repo <repo>` */
  issues: Record<string, unknown>[];
  /** Timeline events for any `issue view ... timeline` query in the repo */
  timeline?: Record<string, unknown>[];
}

/**
 * Build a mock gh command that returns different issue lists per repo.
 * Timeline events are returned uniformly for every issue in that repo.
 */
function createPerRepoMockGh(
  fixtures: Record<string, RepoFixture>,
): (args: string[]) => Promise<string> {
  /**
   * Resolve the target repo for a gh CLI invocation. Most commands use
   * `--repo owner/repo`; `gh api` calls instead embed the repo in the
   * URL path (e.g. `repos/owner/repo/issues/N/timeline`).
   */
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

const ALICE = { login: "alice" };

Deno.test(
  "findOldestIssue - work-on in any repo suppresses low-priority everywhere (Issue #1725)",
  async () => {
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        // repo A has only a low-priority issue (older than B's work-on)
        issues: [
          {
            number: 100,
            title: "Old low-priority chore",
            url: "https://github.com/owner/repo-a/issues/100",
            assignees: [],
            labels: [{ name: "low-priority" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
        ],
      },
      "owner/repo-b": {
        // repo B has a work-on issue created later
        issues: [
          {
            number: 200,
            title: "Work-on issue",
            url: "https://github.com/owner/repo-b/issues/200",
            assignees: [],
            labels: [{ name: "work-on" }],
            createdAt: "2024-06-01T00:00:00Z",
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
    });

    assertEquals(result.found, true);
    // Work-on candidate from repo B must win even though A's low-priority
    // candidate is older — tier 2 outranks tier 3 globally.
    assertEquals(result.output.includes("owner/repo-b"), true);
    assertEquals(result.output.includes("|200|"), true);
  },
);

Deno.test(
  "findOldestIssue - oldest low-priority chosen when every repo has only low-priority issues (Issue #1725)",
  async () => {
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-a": {
        issues: [
          {
            number: 11,
            title: "Newer low-priority",
            url: "https://github.com/owner/repo-a/issues/11",
            assignees: [],
            labels: [{ name: "low-priority" }],
            createdAt: "2024-05-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
        ],
      },
      "owner/repo-b": {
        issues: [
          {
            number: 22,
            title: "Older low-priority",
            url: "https://github.com/owner/repo-b/issues/22",
            assignees: [],
            labels: [{ name: "low-priority" }],
            createdAt: "2024-01-01T00:00:00Z",
            author: ALICE,
            milestone: null,
          },
        ],
        timeline: [
          { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
        ],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      // Pin random pool to size 1 so the oldest is selected deterministically.
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // Older low-priority (#22 in repo-b) wins.
    assertEquals(result.output.includes("owner/repo-b"), true);
    assertEquals(result.output.includes("|22|"), true);
  },
);
