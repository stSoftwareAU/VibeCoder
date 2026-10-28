/**
 * Regression tests for the claim scan's labelled-issue window (Issue #4464).
 *
 * The open-issue listing is newest-first. The scan collectors used to read
 * only the first 50 `work-on` issues of it, so with more than 50 labelled
 * issues the OLDEST were never considered and recorded no skip reason, while
 * the idle-decision census counted them. The collectors now read up to
 * `SCAN_LABELLED_ISSUE_LIMIT`, the full width of the listing, and these tests
 * drive that through the real `findOldestIssue` entry point.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };
const DAY_MS = 24 * 60 * 60 * 1000;

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "label-window-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "label-window-workdir-" }),
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
  body: string;
}

/** Creation timestamp `dayOffset` days after 1 January 2024. */
function createdAt(dayOffset: number): string {
  return new Date(Date.UTC(2024, 0, 1) + dayOffset * DAY_MS).toISOString();
}

function issue(
  partial: Partial<FixtureIssue> & { number: number },
): FixtureIssue {
  return {
    title: `Issue ${partial.number}`,
    url: `https://github.com/owner/repo-a/issues/${partial.number}`,
    assignees: [],
    labels: [],
    createdAt: createdAt(partial.number),
    author: ALICE,
    milestone: null,
    body: "",
    ...partial,
  };
}

/**
 * Mock gh for one repository. `issue list` is answered newest-first, as
 * `gh issue list` does, and truncated to the `--limit` it was given, so a
 * narrower window genuinely hides the oldest issues.
 */
function createMockGh(
  issues: FixtureIssue[],
): (args: string[]) => Promise<string> {
  const timeline = [
    { event: "labeled", label: { name: "work-on" }, actor: ALICE },
  ];
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (command.includes("issue list")) {
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
      const newestFirst = [...issues].sort((a, b) => b.number - a.number);
      return Promise.resolve(JSON.stringify(newestFirst.slice(0, limit)));
    }
    // Per-issue view used by dependency resolution: a number missing from
    // the open fixture is closed.
    if (command.includes("issue view")) {
      const number = Number(args[args.indexOf("view") + 1]);
      const found = issues.find((i) => i.number === number);
      return Promise.resolve(JSON.stringify({
        number,
        state: found ? "OPEN" : "CLOSED",
        title: found?.title ?? "",
        body: found?.body ?? "",
        milestone: found?.milestone ?? null,
      }));
    }
    if (command.includes("pr list")) {
      return Promise.resolve("[]");
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(timeline));
    }
    if (command.includes("/milestones")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "findOldestIssue - 60 work-on issues: a blocked newest 57 does not hide the 3 oldest claimable issues (Issue #4464)",
  async () => {
    // Issue #1 is the open dependency. It is unlabelled, so it is never a
    // candidate, but it makes the 57 newest blocked on an open issue.
    const blocker = issue({
      number: 1,
      title: "Open dependency (unlabelled)",
    });
    // The 3 OLDEST: plain, claimable work-on issues (#101, #102, #103).
    const oldest = [101, 102, 103].map((number) =>
      issue({
        number,
        title: `Oldest claimable ${number}`,
        labels: [{ name: "work-on" }],
      })
    );
    // The 57 NEWEST (#104..#160): work-on, but blocked on #1.
    const newest = Array.from({ length: 57 }, (_, i) =>
      issue({
        number: 104 + i,
        title: `Blocked ${104 + i}`,
        labels: [{ name: "work-on" }],
        body: "Depends on #1",
      }));
    const mockGh = createMockGh([blocker, ...oldest, ...newest]);

    const result = await findOldestIssue(makeConfig(), {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      // Deterministic selection within the chosen tier.
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    const selectedOneOfOldest = [101, 102, 103].some((number) =>
      result.output.startsWith(`owner/repo-a|${number}|`)
    );
    assert(
      selectedOneOfOldest,
      `expected one of the 3 oldest (#101-#103), got: ${result.output}`,
    );
  },
);

Deno.test(
  "findOldestIssue - 60 plain work-on issues: the oldest eligible one is selected (Issue #4464)",
  async () => {
    // No blockers: every issue is claimable. #1 is the oldest, and in the
    // newest-first listing it sits beyond the first 50 entries.
    const plain = Array.from({ length: 60 }, (_, i) =>
      issue({
        number: i + 1,
        title: `Plain ${i + 1}`,
        labels: [{ name: "work-on" }],
      }));
    const mockGh = createMockGh(plain);

    const result = await findOldestIssue(makeConfig(), {
      githubUser: "bot",
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.startsWith("owner/repo-a|1|"), true);
  },
);
