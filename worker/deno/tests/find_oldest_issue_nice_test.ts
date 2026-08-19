/**
 * Integration tests for `findOldestIssue` repo-`nice` tiering
 * (Issue #2774, part of #2771).
 *
 * These tests verify that the operator-side per-repo `nice` value
 * (Issue #2772) is wired through `findOldestIssue` into the
 * `nice`-aware selection (Issue #2773): a lower-`nice` repo's work is
 * drained before any higher-`nice` repo's, fairness within a tier
 * rotates by repo, and a default-everywhere config still selects the
 * globally oldest eligible issue.
 *
 * Uses the same mock `ghCommandFn` / `IssueCache` harness as the sibling
 * `find_oldest_issue_*` tests. Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { RepoConfig, WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "find-oldest-nice-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "nice-workdir-" }),
    repos: ["owner/repo-low", "owner/repo-high"],
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
  issues: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
}

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

/** Build a work-on issue fixture for a repo. */
function workOnFixture(
  repo: string,
  number: number,
  createdAt: string,
  assignees: { login: string }[] = [],
): RepoFixture {
  return {
    issues: [
      {
        number,
        title: `Work-on issue ${number}`,
        url: `https://github.com/${repo}/issues/${number}`,
        assignees,
        labels: [{ name: "work-on" }],
        createdAt,
        author: ALICE,
        milestone: null,
      },
    ],
    timeline: [
      { event: "labeled", label: { name: "work-on" }, actor: ALICE },
    ],
  };
}

/** repo_config map giving a repo an explicit `nice` value. */
function repoConfig(
  entries: Record<string, number>,
): Record<string, RepoConfig> {
  const map: Record<string, RepoConfig> = {};
  for (const [repo, nice] of Object.entries(entries)) {
    map[repo] = { nice } as RepoConfig;
  }
  return map;
}

Deno.test(
  "findOldestIssue - low-nice repo with newer work beats high-nice repo with older work (Issue #2774)",
  async () => {
    // Reproduces the #2771 symptom: NEAT-AI-Discovery-style fresh work in a
    // prioritised (low-`nice`) repo must not sit behind an older backlog in a
    // default-`nice` repo.
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-low": -10 }), // repo-high defaults to 0
    });
    const mockGh = createPerRepoMockGh({
      // Prioritised repo: NEWER work.
      "owner/repo-low": workOnFixture(
        "owner/repo-low",
        100,
        "2024-06-01T00:00:00Z",
      ),
      // Default repo: OLDER work.
      "owner/repo-high": workOnFixture(
        "owner/repo-high",
        200,
        "2024-01-01T00:00:00Z",
      ),
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // The lower-`nice` repo wins despite its work being newer.
    assertEquals(result.output.includes("owner/repo-low"), true);
    assertEquals(result.output.includes("|100|"), true);
  },
);

Deno.test(
  "findOldestIssue - default-everywhere config selects the globally oldest (parity, Issue #2774)",
  async () => {
    // No repo_config => every repo resolves to nice 0 => single tier =>
    // selection is the globally oldest eligible issue, exactly as before.
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-low": workOnFixture(
        "owner/repo-low",
        100,
        "2024-06-01T00:00:00Z", // newer
      ),
      "owner/repo-high": workOnFixture(
        "owner/repo-high",
        200,
        "2024-01-01T00:00:00Z", // older
      ),
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      // Pool size 1 => deterministically oldest within the single tier.
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // Older issue (#200 in repo-high) wins under default parity.
    assertEquals(result.output.includes("owner/repo-high"), true);
    assertEquals(result.output.includes("|200|"), true);
  },
);

Deno.test(
  "findOldestIssue - equal-nice repos rotate fairly by repo within a tier (Issue #2774)",
  async () => {
    // Both repos share nice 0 and each has one work-on issue. The fair
    // within-tier rotation (Issue #2773) is by repo, not oldest-first, so a
    // non-zero RNG selects the *other* repo even though it is newer — proving
    // fairness now lives in selection, not the scan-order shuffle.
    const config = makeConfig();
    const mockGh = createPerRepoMockGh({
      "owner/repo-low": workOnFixture(
        "owner/repo-low",
        100,
        "2024-01-01T00:00:00Z", // older
      ),
      "owner/repo-high": workOnFixture(
        "owner/repo-high",
        200,
        "2024-06-01T00:00:00Z", // newer
      ),
    });

    // randomFn => 0.99 picks the last repo in the fair rotation pool rather
    // than the oldest issue.
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0.99, randomPoolSize: 3 },
    });

    assertEquals(result.found, true);
    // The newer repo is reachable purely via fair rotation.
    assertEquals(result.output.includes("owner/repo-high"), true);
    assertEquals(result.output.includes("|200|"), true);
  },
);

Deno.test(
  "findOldestIssue - busy low-nice repo yields to free high-nice repo (design Q3, Issue #2774)",
  async () => {
    // A prioritised (low-`nice`) repo whose only work stream is occupied by the
    // worker contributes no candidates and is excluded from the scan whenever
    // any repo is free. Selection therefore falls through to the free
    // higher-`nice` repo rather than deadlocking on the empty low tier.
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-low": -10 }),
    });
    const mockGh = createPerRepoMockGh({
      // Low-nice repo is BUSY: its work-on issue is assigned to the worker.
      "owner/repo-low": workOnFixture(
        "owner/repo-low",
        100,
        "2024-01-01T00:00:00Z",
        [{ login: "bot" }],
      ),
      // High-nice (default) repo has FREE work.
      "owner/repo-high": workOnFixture(
        "owner/repo-high",
        200,
        "2024-06-01T00:00:00Z",
      ),
    });

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // Free higher-`nice` repo is selected despite the busy lower-`nice` repo.
    assertEquals(result.output.includes("owner/repo-high"), true);
    assertEquals(result.output.includes("|200|"), true);
  },
);
