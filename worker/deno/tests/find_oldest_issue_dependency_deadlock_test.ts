/**
 * Regression tests for the work-on / low-priority dependency deadlock.
 *
 * A repo's only open `work-on` issue can be *dependency-blocked* by an
 * open issue that is itself only `low-priority`. The Issue #2164
 * suppression rule ("a repo with any open work-on issue must not
 * contribute low-priority candidates") originally fired even when the
 * sole work-on issue was purely dependency-blocked. That froze the
 * whole repo: the work-on issue could not be picked (its dependency was
 * open) and the dependency could not be picked either (low-priority,
 * suppressed by the open work-on issue). The collateral damage extended
 * to every unrelated low-priority issue in the repo.
 *
 * The fix narrows the suppression signal: a work-on issue that is
 * *solely* dependency-blocked no longer marks its repo as
 * `reposWithOpenWorkOn`, so the low-priority work that unblocks it (and
 * any other low-priority backlog) becomes eligible again. A work-on
 * issue blocked for a serialisation reason (PR-blocked, milestone
 * occupied, assigned, or merely needs-human-filtered) still suppresses,
 * preserving the one-PR-per-work-stream guarantee.
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "dep-deadlock-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "deadlock-workdir-" }),
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

interface RepoFixture {
  issues: FixtureIssue[];
  timeline?: Record<string, unknown>[];
}

/**
 * Build a mock gh command. Adds `issue view ... --json body` handling on
 * top of the per-repo issue/timeline mock so forward-dependency parsing
 * ("Depends on #N") resolves from the fixture body.
 */
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

    // `issue view N --json body` — used by dependency body parsing.
    if (command.includes("issue view") && args.includes("body")) {
      const numIdx = args.indexOf("view") + 1;
      const num = Number(args[numIdx]);
      const issue = fixture?.issues.find((i) => i.number === num);
      return Promise.resolve(JSON.stringify({ body: issue?.body ?? "" }));
    }
    // `issue view N --json number,state,title` — open-state fallback.
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
      return Promise.resolve("[]");
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
  "findOldestIssue - dependency-blocked work-on no longer suppresses the low-priority issue it depends on (deadlock fix)",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      "owner/repo-a": {
        issues: [
          // The dependency — only low-priority, no blockers.
          issue({
            number: 100,
            title: "Root chore (dependency)",
            labels: [{ name: "low-priority" }],
            body: "",
          }),
          // The sole work-on issue, blocked solely by #100.
          issue({
            number: 200,
            title: "Integrate (work-on)",
            labels: [{ name: "work-on" }],
            createdAt: "2024-06-01T00:00:00Z",
            body: "Depends on #100",
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

    // The work-on issue is dependency-blocked, so it is not a candidate.
    // Its low-priority dependency (#100) must now be picked up to break
    // the deadlock rather than being suppressed.
    assertEquals(result.found, true);
    assertEquals(result.output.includes("|100|"), true);
  },
);

Deno.test(
  "findOldestIssue - a work-on issue assigned to someone else no longer suppresses low-priority (Issue #2751)",
  async () => {
    // Issue #2751 narrowed the suppression signal to the *post-
    // `filterAndSort`* set. An assigned work-on issue is dropped by
    // `filterAndSort`, so it is work the worker can never action this
    // cycle and must not freeze the repo's low-priority backlog. Under
    // the shared-username multi-worker model an assignment to a *different*
    // login is effectively an external/human claim, which the design
    // principle says must never block a work stream. The serialisation
    // guarantee is still enforced for work-on issues that *survive*
    // `filterAndSort` (PR-blocked, milestone-occupied) — see
    // `find_oldest_issue_unworkable_workon_test.ts`.
    //
    // Before #2751 this scenario asserted `result.found === false`
    // (suppressed); the corrected behaviour picks the low-priority issue.
    const config = makeConfig();
    const mockGh = createMockGh({
      "owner/repo-a": {
        issues: [
          issue({
            number: 100,
            title: "Backlog chore",
            labels: [{ name: "low-priority" }],
            body: "",
          }),
          // Work-on issue assigned to a different login — dropped by
          // filterAndSort, so it must not suppress the backlog.
          issue({
            number: 200,
            title: "Already being worked",
            labels: [{ name: "work-on" }],
            assignees: [{ login: "other-bot" }],
            createdAt: "2024-06-01T00:00:00Z",
            body: "",
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

    // The only work-on issue was dropped by filterAndSort, so the repo's
    // low-priority backlog (#100) is no longer suppressed and is picked.
    assertEquals(result.found, true);
    assertEquals(result.output.includes("|100|"), true);
  },
);
