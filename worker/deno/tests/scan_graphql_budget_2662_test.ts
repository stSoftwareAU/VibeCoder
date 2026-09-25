/**
 * Scan-cycle GraphQL budget over a ~20-repository fleet (Issue #2662).
 *
 * On GRQ-23 on 2026-09-25, 72% of 33,237 GraphQL calls were spent under
 * `priority:issue-scanning`, and most of those were one-issue-at-a-time
 * `gh issue view` reads: `--json=title,body` (the scan-time content-integrity
 * check), `--json=body` (dependency bodies), `--json=labels` (the
 * `ignore-open-prs` check) and `--json=number,state,title,milestone`
 * (dependency state). The listing that found each candidate already returned
 * the title, body, labels, state and milestone, so every one of those reads
 * bought nothing the scan did not already hold.
 *
 * This test drives one scan cycle — the five `findOldestIssue` scans one
 * cached listing serves — over a 20-repository fixture through a counting
 * `gh` stub, classifying each call exactly as the production metrics do
 * (`isQuotaExemptGhCall`), and pins:
 *
 * - zero `issue view` calls for candidates the listing covered;
 * - the dependency states the listing did not cover are read in one batched
 *   GraphQL query per repository, not one `issue view` each;
 * - the cycle's GraphQL count falls by at least 60% from the measured
 *   pre-#2662 baseline ({@link BASELINE_GRAPHQL_CALLS});
 * - every scan claims exactly what it claimed before.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";

import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { TimelineBatchRegistry } from "../lib/timeline_batch_registry.ts";
import { TimelineCache } from "../lib/timeline_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { isQuotaExemptGhCall } from "../lib/primary_quota_latch.ts";
import type { WorkerConfig } from "../types.ts";

/**
 * GraphQL calls one scan cycle of this fixture made before Issue #2662,
 * measured by running this test against the pre-change finder: 20 `issue
 * list`, 80 `pr list`, 400 timeline batches, 600 `issue view
 * --json=title,body`, 117 `--json=body`, 63 `--json=labels` and 13
 * `--json=number,state,title,milestone`. Recorded in
 * `docs/archive/pr-summaries/pr-summary-2662.md`.
 */
const BASELINE_GRAPHQL_CALLS = 1293;

/** What every scan in the cycle selected before Issue #2662. */
const EXPECTED_CLAIM =
  "fleet/repo-02|1|https://github.com/fleet/repo-02/issues/1||Issue 1 in fleet/repo-02";

const REPO_COUNT = 20;
const REPOS = Array.from(
  { length: REPO_COUNT },
  (_, i) => `fleet/repo-${String(i + 1).padStart(2, "0")}`,
);

/** A dependency that is closed, so it is absent from the open listing. */
const CLOSED_DEP = 900;

interface FixtureIssue {
  number: number;
  title: string;
  url: string;
  assignees: { login: string }[];
  labels: { name: string }[];
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string };
  milestone: { title: string } | null;
}

/**
 * One repository's open issues: every tier the scan collects, with the
 * dependency and open-PR shapes that used to cost a per-issue read.
 */
function makeIssues(repo: string, repoIndex: number): FixtureIssue[] {
  const plan: Array<{ label: string; author: string; body: string }> = [
    {
      label: "top-priority",
      author: "alice",
      body: `Depends on #${CLOSED_DEP}`,
    },
    { label: "top-priority", author: "alice", body: "Plain top-priority." },
    { label: "work-on", author: "alice", body: `Depends on #${CLOSED_DEP}` },
    { label: "work-on", author: "alice", body: "Work on this." },
    { label: "work-on", author: "alice", body: "And this." },
    { label: "low-priority", author: "alice", body: "Backlog item." },
    { label: "low-priority", author: "alice", body: "Another backlog item." },
    { label: "idle-task", author: "bot", body: "Idle sweep wrapper." },
    { label: "idle-task", author: "bot", body: "Another idle sweep." },
    { label: "", author: "alice", body: "Unlabelled." },
  ];
  return plan.map((p, i) => {
    const number = i + 1;
    const day = String(((repoIndex + i) % 27) + 1).padStart(2, "0");
    return {
      number,
      title: `Issue ${number} in ${repo}`,
      url: `https://github.com/${repo}/issues/${number}`,
      assignees: [],
      labels: p.label ? [{ name: p.label }] : [],
      body: p.body,
      createdAt: `2026-08-${day}T00:00:00Z`,
      updatedAt: `2026-08-${day}T00:00:00Z`,
      author: { login: p.author },
      milestone: null,
    };
  });
}

const FIXTURE = new Map<string, FixtureIssue[]>(
  REPOS.map((repo, i) => [repo, makeIssues(repo, i)]),
);

/** Every third repository has an open fleet PR, which defers its issues. */
function openPrsFor(repo: string): unknown[] {
  const index = REPOS.indexOf(repo);
  if (index % 3 !== 0) return [];
  return [{
    number: 500,
    title: "Fleet PR in flight",
    author: { login: "bot" },
    baseRefName: "main",
    headRefName: "issue-4-fix",
    isDraft: false,
  }];
}

function repoOf(args: readonly string[]): string {
  const i = args.indexOf("--repo");
  if (i >= 0) return args[i + 1] ?? "";
  for (const arg of args) {
    const rest = /^repos\/([^/]+\/[^/]+)\//.exec(arg);
    if (rest) return rest[1] ?? "";
    const gql = /owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/.exec(arg);
    if (gql) return `${gql[1]}/${gql[2]}`;
  }
  return "";
}

/** Counting stub: every call is recorded as the metrics would bill it. */
interface CountingGh {
  gh: (args: string[]) => Promise<string>;
  graphql: number;
  shapes: Map<string, number>;
  issueViews: Array<{ repo: string; number: number; json: string }>;
}

function shapeOf(args: readonly string[]): string {
  if (args[0] === "api" && args[1] === "graphql") {
    const q = args.find((a) => a.startsWith("query="));
    if (q?.includes("timelineItems")) return "api graphql (timeline)";
    if (q?.includes("issueOrPullRequest")) return "api graphql (issue batch)";
    return "api graphql";
  }
  if (args[0] === "issue" && args[1] === "view") {
    return `issue view --json=${args[args.indexOf("--json") + 1]}`;
  }
  if (args[0] === "api") return "api (rest)";
  return `${args[0]} ${args[1]}`;
}

function createCountingGh(): CountingGh {
  const counter: CountingGh = {
    graphql: 0,
    shapes: new Map(),
    issueViews: [],
    gh: (args: string[]) => {
      if (!isQuotaExemptGhCall(args)) counter.graphql++;
      const shape = shapeOf(args);
      counter.shapes.set(shape, (counter.shapes.get(shape) ?? 0) + 1);
      const repo = repoOf(args);
      const issues = FIXTURE.get(repo) ?? [];

      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify(issues));
      }
      if (args[0] === "issue" && args[1] === "view") {
        const number = Number(args[2]);
        const json = args[args.indexOf("--json") + 1] ?? "";
        counter.issueViews.push({ repo, number, json });
        const issue = issues.find((i) => i.number === number);
        if (!issue) {
          // A closed dependency, absent from the open listing.
          return Promise.resolve(JSON.stringify({
            number,
            state: "CLOSED",
            title: `Closed #${number}`,
            milestone: null,
            body: "",
            labels: [],
          }));
        }
        return Promise.resolve(JSON.stringify({
          number,
          state: "OPEN",
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          milestone: issue.milestone,
        }));
      }
      if (args[0] === "pr" && args[1] === "list") {
        const state = args[args.indexOf("--state") + 1];
        return Promise.resolve(
          JSON.stringify(state === "open" ? openPrsFor(repo) : []),
        );
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const query = args.find((a) => a.startsWith("query=")) ?? "";
        const repository: Record<string, unknown> = {};
        if (query.includes("timelineItems")) {
          // Every label was applied by the trusted human.
          for (const m of query.matchAll(/n(\d+): issue\(number: (\d+)\)/g)) {
            const number = Number(m[2]);
            const issue = issues.find((i) => i.number === number);
            repository[`n${m[1]}`] = {
              timelineItems: {
                nodes: (issue?.labels ?? []).map((l) => ({
                  __typename: "LabeledEvent",
                  createdAt: "2026-08-01T00:00:00Z",
                  label: { name: l.name },
                  actor: { login: "alice" },
                })),
              },
            };
          }
        } else {
          for (
            const m of query.matchAll(
              /i(\d+): issueOrPullRequest\(number: (\d+)\)/g,
            )
          ) {
            const number = Number(m[2]);
            repository[`i${m[1]}`] = {
              number,
              state: "CLOSED",
              title: `Closed #${number}`,
              milestone: null,
            };
          }
        }
        return Promise.resolve(JSON.stringify({ data: { repository } }));
      }
      // REST: timelines, milestones, sub-issues — none of them GraphQL.
      return Promise.resolve("[]");
    },
  };
  return counter;
}

function makeConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir,
    repos: [...REPOS],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    shuffleRepos: false,
  };
}

/**
 * Scans in one scan cycle: the open-issue listing is cached for 600 s and the
 * idle scan repeats about every two minutes, so one listing serves five
 * scans. Each scan is its own iteration (a fresh timeline registry, as
 * `resetIterationCaches` gives production); the issue and timeline caches
 * persist across them exactly as they do on a host.
 */
const SCANS_PER_CYCLE = 5;

interface CycleResult {
  counter: CountingGh;
  /** What each scan selected, in `repo|number|…` form. */
  claims: string[];
}

async function runScanCycle(): Promise<CycleResult> {
  const dir = await Deno.makeTempDir({ prefix: "scan-budget-2662-" });
  try {
    const counter = createCountingGh();
    const config = makeConfig(`${dir}/work`);
    const cache = new IssueCache(`${dir}/cache`, 600);
    const timelineCache = new TimelineCache(300, `${dir}/timeline`);
    const claims: string[] = [];
    for (let scan = 0; scan < SCANS_PER_CYCLE; scan++) {
      const result = await findOldestIssue(config, {
        githubUser: "bot",
        ghCommandFn: counter.gh,
        cache,
        timelineCache,
        timelineBatchRegistry: new TimelineBatchRegistry(),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });
      claims.push(result.output);
    }
    return { counter, claims };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/** One cycle, shared by every assertion below — the fixture is read-only. */
let cycle: Promise<CycleResult> | undefined;
function scanCycle(): Promise<CycleResult> {
  cycle ??= runScanCycle();
  return cycle;
}

function describe(counter: CountingGh): string {
  return JSON.stringify(Object.fromEntries(counter.shapes));
}

Deno.test(
  "scan cycle over 20 repos makes no issue view for a candidate the listing covered (Issue #2662)",
  async () => {
    const { counter } = await scanCycle();
    const listed = counter.issueViews.filter((v) =>
      (FIXTURE.get(v.repo) ?? []).some((i) => i.number === v.number)
    );
    assertEquals(
      listed,
      [],
      `listed candidates were re-read one at a time: ${describe(counter)}`,
    );
  },
);

Deno.test(
  "scan cycle over 20 repos batches the dependency states the listing did not cover (Issue #2662)",
  async () => {
    const { counter } = await scanCycle();
    assertEquals(
      counter.issueViews,
      [],
      `a dependency outside the listing was read one issue at a time: ${
        describe(counter)
      }`,
    );
    const batches = counter.shapes.get("api graphql (issue batch)") ?? 0;
    assert(
      batches > 0 && batches <= REPO_COUNT,
      `expected at most one dependency batch per repo, got ${batches}`,
    );
  },
);

Deno.test(
  "scan cycle GraphQL calls over 20 repos fall by at least 60% (Issue #2662)",
  async () => {
    const { counter } = await scanCycle();
    assert(
      counter.graphql * 100 <= BASELINE_GRAPHQL_CALLS * 40,
      `one scan cycle made ${counter.graphql} GraphQL calls; the pre-#2662 ` +
        `baseline was ${BASELINE_GRAPHQL_CALLS}, so at most ` +
        `${Math.floor(BASELINE_GRAPHQL_CALLS * 0.4)} are allowed. ` +
        `Shapes: ${describe(counter)}`,
    );
  },
);

Deno.test(
  "scan cycle over 20 repos claims exactly what it claimed before (Issue #2662)",
  async () => {
    // Measured against the pre-#2662 finder with the same fixture: the
    // listing-seeded reads change what the scan costs, never what it picks.
    const { claims } = await scanCycle();
    assertEquals(claims, Array(SCANS_PER_CYCLE).fill(EXPECTED_CLAIM));
  },
);
