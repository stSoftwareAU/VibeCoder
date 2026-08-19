/**
 * Tests for `collectLowPriorityCandidates` (Issue #1724).
 *
 * The collector mirrors `collectWorkOnCandidates`, so these tests focus
 * on the behaviour that differs between the two: the label being fetched,
 * the `labelIndex`, and the `source` value on emitted candidates. The
 * filter exclusion paths are exercised collectively through stubbed gh
 * responses so the per-issue check matrix matches the work-on collector.
 */

import { assertEquals } from "@std/assert";
import { collectLowPriorityCandidates } from "../lib/collect_low_priority_candidates.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
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
  const dir = Deno.makeTempDirSync({ prefix: "low-priority-test-" });
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
    workDir: Deno.makeTempDirSync({ prefix: "low-priority-workdir-" }),
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test(
  "collect_low_priority_candidates - eligible issue produces one candidate with labelIndex 199 and source low-priority",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 42,
          title: "Tidy logs",
          url: "https://github.com/owner/repo/issues/42",
          assignees: [],
          labels: [{ name: "low-priority" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-01T00:00:00Z",
        },
      ],
      issueView: { title: "Tidy logs", body: "Reduce verbose logs" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);
    const repoPRs: OpenPR[] = [];
    const repoClosedPRs: ClosedPR[] = [];
    const repoAllIssues: FilterableIssue[] = [];

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );

    assertEquals(result.candidates.length, 1);
    const c = result.candidates[0]!;
    assertEquals(c.repo, "owner/repo");
    assertEquals(c.number, 42);
    assertEquals(c.labelIndex, 199);
    assertEquals(c.source, "low-priority");
    assertEquals(c.title, "Tidy logs");
  },
);

// ---------------------------------------------------------------------------
// Filter paths
// ---------------------------------------------------------------------------

Deno.test(
  "collect_low_priority_candidates - excludes issue when label was added by an unauthorised author",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 50,
          title: "Sneaky add",
          url: "https://github.com/owner/repo/issues/50",
          assignees: [],
          labels: [{ name: "low-priority" }],
          createdAt: "2024-03-02T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // Label added by a user not in allowedAuthors
      timeline: [
        {
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: "mallory" },
          created_at: "2024-03-02T00:00:00Z",
        },
      ],
      issueView: { title: "Sneaky add", body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
  },
);

Deno.test(
  "collect_low_priority_candidates - excludes issue blocked by milestone occupancy",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 60,
          title: "Milestone blocked",
          url: "https://github.com/owner/repo/issues/60",
          assignees: [],
          labels: [{ name: "low-priority" }],
          createdAt: "2024-03-03T00:00:00Z",
          author: { login: "alice" },
          milestone: { title: "v1" },
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-03T00:00:00Z",
        },
      ],
      issueView: { title: "Milestone blocked", body: "" },
    });

    // Another worker-assigned issue in the same milestone occupies the
    // work stream, which must block this candidate.
    const repoAllIssues: FilterableIssue[] = [
      {
        number: 99,
        title: "Already in flight",
        url: "https://github.com/owner/repo/issues/99",
        author: "alice",
        assignees: ["bot"],
        labels: ["help-wanted"],
        createdAt: "2024-02-28T00:00:00Z",
        milestone: "v1",
      },
    ];

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      repoAllIssues,
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
  },
);

Deno.test(
  "collect_low_priority_candidates - excludes issue blocked by recently-closed PR cooldown",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 70,
          title: "Recently closed PR",
          url: "https://github.com/owner/repo/issues/70",
          assignees: [],
          labels: [{ name: "low-priority" }],
          createdAt: "2024-03-04T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-04T00:00:00Z",
        },
      ],
      issueView: { title: "Recently closed PR", body: "" },
    });

    const closedPRs: ClosedPR[] = [
      {
        number: 200,
        title: "Closes #70",
        closedAt: new Date().toISOString(),
      },
    ];

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      closedPRs,
    );

    assertEquals(result.candidates.length, 0);
  },
);

Deno.test(
  "collect_low_priority_candidates - excludes issue blocked by an open PR targeting the same branch",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 80,
          title: "PR blocked",
          url: "https://github.com/owner/repo/issues/80",
          assignees: [],
          labels: [{ name: "low-priority" }],
          createdAt: "2024-03-05T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-05T00:00:00Z",
        },
      ],
      issueView: { title: "PR blocked", body: "" },
    });

    const repoPRs: OpenPR[] = [
      {
        number: 300,
        title: "Default-branch PR in flight",
        baseRefName: "main",
        headRefName: "feature/x",
      },
    ];

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      repoPRs,
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
  },
);

Deno.test(
  "collect_low_priority_candidates - excludes issue blocked by an unresolved dependency",
  async () => {
    const config = makeConfig();
    let dependencyStateChecks = 0;
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("issue list")) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 90,
              title: "Has dep",
              url: "https://github.com/owner/repo/issues/90",
              assignees: [],
              labels: [{ name: "low-priority" }],
              createdAt: "2024-03-06T00:00:00Z",
              author: { login: "alice" },
              milestone: null,
            },
          ]),
        );
      }
      if (command.includes("timeline")) {
        return Promise.resolve(
          JSON.stringify([
            {
              event: "labeled",
              label: { name: "low-priority" },
              actor: { login: "alice" },
              created_at: "2024-03-06T00:00:00Z",
            },
          ]),
        );
      }
      if (command.includes("issue view")) {
        // TOCTOU title/body fetch for #90.
        if (command.includes("title,body")) {
          return Promise.resolve(
            JSON.stringify({ title: "Has dep", body: "Depends on #91" }),
          );
        }
        // getIssueBody(repo, 90) — used by isDependencyBlocked
        // to extract dependency references.
        if (command.includes("--json body")) {
          return Promise.resolve(JSON.stringify({ body: "Depends on #91" }));
        }
        // getIssueState(repo, 91) — dependency #91 is still OPEN, so
        // the candidate must be excluded.
        if (command.includes("number,state,title")) {
          dependencyStateChecks++;
          return Promise.resolve(
            JSON.stringify({ number: 91, state: "OPEN", title: "Dependency" }),
          );
        }
      }
      if (command.includes("api repos/")) {
        // Sub-issue extraction (checkParentBlocked) — no sub-issues.
        return Promise.resolve(JSON.stringify({ body: "Depends on #91" }));
      }
      return Promise.resolve("[]");
    };

    const cache = createTestCache();
    const fetcher = createIssueFetcher(ghFn);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(ghFn, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
    // Sanity check: the dependency check actually ran.
    assertEquals(dependencyStateChecks > 0, true);
  },
);

Deno.test(
  "collect_low_priority_candidates - blocks issue whose content was modified after approval by an untrusted author",
  async () => {
    const config = makeConfig();
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("issue list")) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 100,
              title: "Tampered",
              url: "https://github.com/owner/repo/issues/100",
              assignees: [],
              labels: [{ name: "low-priority" }],
              createdAt: "2024-03-07T00:00:00Z",
              // Issue author is *not* in allowedAuthors — modifications by
              // them after label approval count as untrusted.
              author: { login: "mallory" },
              milestone: null,
            },
          ]),
        );
      }
      if (command.includes("timeline")) {
        return Promise.resolve(
          JSON.stringify([
            {
              event: "labeled",
              label: { name: "low-priority" },
              actor: { login: "alice" },
              created_at: "2024-03-07T00:00:00Z",
            },
          ]),
        );
      }
      if (command.includes("issue view") && command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: "Tampered TITLE", body: "Tampered body" }),
        );
      }
      return Promise.resolve("[]");
    };

    const cache = createTestCache();
    const fetcher = createIssueFetcher(ghFn);

    // Pre-seed the content approval state so the verifier reports
    // "changed" rather than "no_snapshot".
    const stateDir = resolveContentApprovalStateDir(config.workDir);
    await Deno.mkdir(stateDir, { recursive: true });
    const stateFile = `${stateDir}/.content_approval_state.json`;
    const seeded = {
      snapshots: {
        "owner/repo|100": {
          repo: "owner/repo",
          issueNumber: 100,
          // Hash of "Original\nOriginal body" — definitely will not match
          // the tampered title/body returned above.
          contentHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
          capturedAt: Math.floor(Date.now() / 1000) - 3600,
          issueAuthor: "mallory",
        },
      },
    };
    await Deno.writeTextFile(stateFile, JSON.stringify(seeded));

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(ghFn, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Edge case
// ---------------------------------------------------------------------------

Deno.test(
  "collect_low_priority_candidates - empty issue list returns []",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({ issues: [] });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLowPriorityCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates, []);
  },
);

// ---------------------------------------------------------------------------
// Human-authored blocking PR (Issue #4078)
// ---------------------------------------------------------------------------

/** A low-priority issue eligible but for the open PR blocking it. */
function blockedLowPriorityMock(): (args: string[]) => Promise<string> {
  return createMockGh({
    issues: [
      {
        number: 60,
        title: "Tidy logs",
        url: "https://github.com/owner/repo/issues/60",
        assignees: [],
        labels: [{ name: "low-priority" }],
        createdAt: "2026-08-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      },
    ],
    timeline: [
      {
        event: "labeled",
        label: { name: "low-priority" },
        actor: { login: "alice" },
        created_at: "2026-08-01T00:00:00Z",
      },
    ],
    issueView: { title: "Tidy logs", body: "Reduce verbose logs" },
  });
}

async function collectWithBlockingPr(prAuthor: string) {
  const config = makeConfig({ fleetPrAuthors: ["stsvcbot"] });
  const mockGh = blockedLowPriorityMock();
  const cache = createTestCache();
  const diag = createDiagnostics({ enabled: true, write: () => {} });
  const result = await collectLowPriorityCandidates(
    "owner/repo",
    config,
    { ...buildOptions(mockGh, cache), diagnostics: diag },
    [{
      number: 103,
      title: "Tidy the config loader",
      baseRefName: "main",
      headRefName: "tidy-config",
      author: prAuthor,
    }],
    [],
    createIssueFetcher(mockGh),
    [],
  );
  return { result, messages: diag.getMessages() };
}

Deno.test(
  "collect_low_priority_candidates - a human-authored blocking PR does not block (Issue #4133)",
  async () => {
    // Supersedes the #4078 "named in the skip reason" pair: a human's open
    // PR is theirs to manage, so it never defers a low-priority issue.
    const { result, messages } = await collectWithBlockingPr("alice");

    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 60);
    assertEquals(
      messages.find((m) => m.includes("skipped=pr-blocked")),
      undefined,
    );
  },
);

Deno.test(
  "collect_low_priority_candidates - a fleet-authored blocking PR still blocks (Issue #4133)",
  async () => {
    const { result, messages } = await collectWithBlockingPr("stsvcbot");

    assertEquals(result.candidates, []);
    const skip = messages.find((m) => m.includes("skipped=pr-blocked"));
    assertEquals(skip !== undefined, true);
    assertEquals(skip!.includes("PR #103"), true);
  },
);
