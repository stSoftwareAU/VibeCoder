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

// ---------------------------------------------------------------------------
// Issue #2751: a low-priority issue waiting on a human must not hide the
// repo's idle tasks, while a workable-but-blocked one still does.
// ---------------------------------------------------------------------------

const IDLE_TASK_NUMBER = 701;
const LOW_PRIORITY_NUMBER = 90;

/**
 * One repo holding a low-priority issue (#90, carrying `extraLabels` and
 * the given `body`) and a worker-filed idle-task issue (#701).
 */
function createIdleTaskRepoMockGh(
  extraLabels: string[],
  lowPriorityBody: string,
  lowPriorityTitle = "Low-priority chore",
): (args: string[]) => Promise<string> {
  const bodyFor = (args: string[]): string =>
    args.includes(String(LOW_PRIORITY_NUMBER))
      ? lowPriorityBody
      : "Scan the repo for issues";
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: LOW_PRIORITY_NUMBER,
          title: lowPriorityTitle,
          url: `https://github.com/owner/repo-a/issues/${LOW_PRIORITY_NUMBER}`,
          assignees: [],
          labels: ["low-priority", ...extraLabels].map((name) => ({ name })),
          createdAt: "2024-01-01T00:00:00Z",
          author: ALICE,
          milestone: null,
        },
        {
          number: IDLE_TASK_NUMBER,
          title: "Idle-task scan",
          url: `https://github.com/owner/repo-a/issues/${IDLE_TASK_NUMBER}`,
          assignees: [],
          labels: [{ name: "idle-task" }],
          createdAt: "2024-06-01T00:00:00Z",
          author: { login: "bot" },
          milestone: null,
        },
      ]));
    }
    if (command.includes("pr list")) return Promise.resolve("[]");
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
        ...extraLabels.map((name) => ({
          event: "labeled",
          label: { name },
          actor: ALICE,
        })),
        {
          event: "labeled",
          label: { name: "idle-task" },
          actor: { login: "bot" },
        },
      ]));
    }
    if (command.includes("issue view")) {
      if (command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: "Issue", body: bodyFor(args) }),
        );
      }
      if (command.includes("--json body")) {
        return Promise.resolve(JSON.stringify({ body: bodyFor(args) }));
      }
      if (command.includes("number,state,title")) {
        return Promise.resolve(
          JSON.stringify({ number: 91, state: "OPEN", title: "Dependency" }),
        );
      }
    }
    if (command.includes("api repos/")) {
      return Promise.resolve(JSON.stringify({ body: bodyFor(args) }));
    }
    return Promise.resolve("[]");
  };
}

async function findInIdleTaskRepo(
  extraLabels: string[],
  lowPriorityBody: string,
  lowPriorityTitle?: string,
) {
  const config = makeConfig({
    repos: ["owner/repo-a"],
    allowedAuthors: ["alice", "bot"],
  });
  return await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: createIdleTaskRepoMockGh(
      extraLabels,
      lowPriorityBody,
      lowPriorityTitle,
    ),
    cache: createTestCache(),
    isIssueInCooldown: () => false,
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
}

Deno.test(
  "findOldestIssue - a needs-human low-priority issue no longer hides the repo's idle task (Issue #2751)",
  async () => {
    const result = await findInIdleTaskRepo(["needs-human"], "Tidy logs");

    assertEquals(result.found, true);
    assertEquals(result.output.includes(`|${IDLE_TASK_NUMBER}|`), true);
  },
);

Deno.test(
  "findOldestIssue - a dependency-blocked low-priority issue still hides the repo's idle task (Issue #2751)",
  async () => {
    const result = await findInIdleTaskRepo([], "Depends on #91");

    assertEquals(result.output.includes(`|${IDLE_TASK_NUMBER}|`), false);
    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - a claimable Finish follow-up low-priority issue still beats the idle task (Issue #2751)",
  async () => {
    const result = await findInIdleTaskRepo(
      [],
      "Finish the remaining work",
      "Finish #42: remaining work",
    );

    assertEquals(result.found, true);
    assertEquals(result.output.includes(`|${LOW_PRIORITY_NUMBER}|`), true);
  },
);
