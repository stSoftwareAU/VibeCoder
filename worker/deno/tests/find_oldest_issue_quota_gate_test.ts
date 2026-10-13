/**
 * Tests for the quota-aware polling gate inside `findOldestIssue`
 * (Issue #3628).
 *
 * Below the park floor, repos at or above the park `nice` tier are skipped
 * whole — no PR fetches, no timeline batch, no candidate collectors. Below
 * the idle floor, idle-task collection is deferred fleet-wide. A null
 * reading polls exactly as before (fail-open).
 *
 * Uses the same mock `ghCommandFn` / `IssueCache` harness as the sibling
 * `find_oldest_issue_nice_test.ts`. The issue cache serves the collectors'
 * label searches from the phase-1 listing, so the assertions below observe
 * the gate through the calls the cache cannot avoid (PR fetches, timelines,
 * milestones) and through `parkedRepos` — never through search-command
 * counts.
 *
 * Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { RepoConfig, WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "find-oldest-quota-gate-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "quota-gate-workdir-" }),
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
  issues: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
}

/** A mock gh that records every call's command and repo. */
function createRecordingMockGh(
  fixtures: Record<string, RepoFixture>,
  calls: { repo: string; command: string }[],
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
    calls.push({ repo: resolveRepo(args), command });

    if (command.includes("issue list")) {
      const fixture = fixtures[resolveRepo(args)];
      return Promise.resolve(JSON.stringify(fixture?.issues ?? []));
    }
    if (command.includes("pr list")) {
      return Promise.resolve("[]");
    }
    if (command.includes("timeline")) {
      const fixture = fixtures[resolveRepo(args)];
      return Promise.resolve(JSON.stringify(fixture?.timeline ?? []));
    }
    return Promise.resolve("[]");
  };
}

/** Build a work-on issue fixture for a repo. */
function workOnFixture(
  repo: string,
  number: number,
  createdAt = "2024-01-01T00:00:00Z",
  labels: string[] = ["work-on"],
): RepoFixture {
  return {
    issues: [
      {
        number,
        title: `Issue ${number}`,
        url: `https://github.com/${repo}/issues/${number}`,
        assignees: [],
        labels: labels.map((name) => ({ name })),
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

/**
 * The calls the park skip removes: PR fetches, timeline reads and anything
 * search-shaped (the collectors' discovery searches). Phase-1 classification
 * calls — `issue list` and availability probes such as the milestones
 * listing — legitimately remain, because the census must still see the repo.
 */
function pollCalls(
  calls: { repo: string; command: string }[],
  repo: string,
): { repo: string; command: string }[] {
  return calls.filter((c) =>
    c.repo === repo &&
    (c.command.includes("pr list") || c.command.includes("timeline") ||
      c.command.includes("--search"))
  );
}

Deno.test(
  "findOldestIssue quota gate - the park tier skips a nice-99 repo whole (Issue #3628)",
  async () => {
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-a": 99 }),
    });
    const calls: { repo: string; command: string }[] = [];
    const mockGh = createRecordingMockGh({
      "owner/repo-a": workOnFixture("owner/repo-a", 100),
      "owner/repo-b": workOnFixture("owner/repo-b", 200),
    }, calls);

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 1400 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // Only repo-b could have produced a candidate.
    assertEquals(result.output.includes("owner/repo-b"), true);
    assertEquals(result.output.includes("|200|"), true);
    assertEquals(result.parkedRepos, ["owner/repo-a"]);
    // The parked repo got no PR fetch, timeline read or collector search.
    assertEquals(pollCalls(calls, "owner/repo-a"), []);
  },
);

Deno.test(
  "findOldestIssue quota gate - a low-nice repo is untouched below the park floor (Issue #3628)",
  async () => {
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-a": -10 }),
    });
    const calls: { repo: string; command: string }[] = [];
    const mockGh = createRecordingMockGh({
      "owner/repo-a": workOnFixture("owner/repo-a", 100),
      "owner/repo-b": workOnFixture("owner/repo-b", 200),
    }, calls);

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 1400 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // The lower-nice repo still polled fully and won selection.
    assertEquals(result.output.includes("owner/repo-a"), true);
    assertEquals(result.parkedRepos, undefined);
    assertEquals(pollCalls(calls, "owner/repo-a").length > 0, true);
  },
);

Deno.test(
  "findOldestIssue quota gate - the idle tier skips only the idle collector (Issue #3628)",
  async () => {
    const config = makeConfig();
    const calls: { repo: string; command: string }[] = [];
    const mockGh = createRecordingMockGh({
      "owner/repo-a": workOnFixture("owner/repo-a", 100),
      "owner/repo-b": workOnFixture("owner/repo-b", 200),
    }, calls);

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 400 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // Nothing was parked: below the idle floor a nice-0 repo still polls
    // its other tiers, and the work-on tier still won.
    assertEquals(result.parkedRepos, undefined);
    assertEquals(result.output.includes("|100|"), true);
  },
);

Deno.test(
  "findOldestIssue quota gate - a null reading claims idle work, a low reading defers it (Issue #3628)",
  async () => {
    // repo-b holds only an idle-task issue: with no reading the idle tier
    // is collected and claimed exactly as before the gate existed; below
    // the idle floor the same scan finds nothing. The issue cache serves
    // the collectors' searches from the phase-1 listing, so selection is
    // the observable for the deferral — not search-command counts.
    const idleFixture = (
      repo: string,
      number: number,
    ): RepoFixture => ({
      issues: [
        {
          number,
          title: `Idle issue ${number}`,
          url: `https://github.com/${repo}/issues/${number}`,
          assignees: [],
          labels: [{ name: "idle-task" }],
          createdAt: "2024-01-01T00:00:00Z",
          author: ALICE,
          milestone: null,
        },
      ],
      timeline: [
        { event: "labeled", label: { name: "idle-task" }, actor: ALICE },
      ],
    });

    const run = (quotaReading: { limit: number; remaining: number } | null) =>
      findOldestIssue(makeConfig(), {
        githubUser: "bot",
        ghCommandFn: createRecordingMockGh({
          "owner/repo-a": { issues: [] },
          "owner/repo-b": idleFixture("owner/repo-b", 200),
        }, []),
        cache: createTestCache(),
        ...(quotaReading === null ? {} : { quotaReading }),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

    const today = await run(null);
    assertEquals(today.found, true);
    assertEquals(today.output.includes("|200|"), true);

    const deferred = await run({ limit: 5000, remaining: 400 });
    assertEquals(deferred.found, false);
  },
);

Deno.test(
  "findOldestIssue quota gate - the park boundary is strict (Issue #3628)",
  async () => {
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-a": 99 }),
    });

    // Exactly at the floor: not gated.
    const atFloor = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: createRecordingMockGh({
        "owner/repo-a": workOnFixture("owner/repo-a", 100),
        "owner/repo-b": workOnFixture("owner/repo-b", 200),
      }, []),
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 1500 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });
    assertEquals(atFloor.parkedRepos, undefined);

    // One point below: parked.
    const below = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: createRecordingMockGh({
        "owner/repo-a": workOnFixture("owner/repo-a", 100),
        "owner/repo-b": workOnFixture("owner/repo-b", 200),
      }, []),
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 1499 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });
    assertEquals(below.parkedRepos, ["owner/repo-a"]);
  },
);

Deno.test(
  "findOldestIssue quota gate - below both floors a park repo is parked and a low-nice repo defers idle (Issue #3628)",
  async () => {
    const config = makeConfig({
      repoConfig: repoConfig({ "owner/repo-a": 99 }),
    });
    const calls: { repo: string; command: string }[] = [];
    const mockGh = createRecordingMockGh({
      "owner/repo-a": workOnFixture("owner/repo-a", 100),
      "owner/repo-b": workOnFixture("owner/repo-b", 200),
    }, calls);

    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      quotaReading: { limit: 5000, remaining: 300 },
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.parkedRepos, ["owner/repo-a"]);
    // repo-b (nice 0) still polled its PR fetches — only the idle tier is
    // fleet-wide deferred.
    assertEquals(pollCalls(calls, "owner/repo-b").length > 0, true);
    const idleCalls = calls.filter((c) => c.command.includes("idle-task"));
    assertEquals(idleCalls, []);
    assertEquals(result.found, true);
    assertEquals(result.output.includes("|200|"), true);
  },
);
