/**
 * Tests for `collectIdleTaskCandidates` (Issue #2006).
 *
 * The collector mirrors `collectLowPriorityCandidates`, so these tests
 * focus on what differs: the `idle-task` label fetched, the
 * `labelIndex: 299`, and the `source: "idle-task"` value on emitted
 * candidates. Defence-in-depth wrapper-title verification confirms the
 * issue's title is one of the four canonical wrapper titles.
 */

import { assertEquals } from "@std/assert";
import { collectIdleTaskCandidates } from "../lib/collect_idle_task_candidates.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import { SECURITY_SCAN_ISSUE_TITLE } from "../lib/idle_task_templates/security_scan_template.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
} from "../lib/content_approval_tracker.ts";
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
  issues?: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
  issueView?: { title?: string; body?: string };
}

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "idle-task-test-" });
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
    workDir: Deno.makeTempDirSync({ prefix: "idle-task-workdir-" }),
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
  "collect_idle_task_candidates - eligible issue produces one candidate with labelIndex 299 and source idle-task",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 501,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: "https://github.com/owner/repo/issues/501",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-01T00:00:00Z",
          author: { login: "bot" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "bot" },
          created_at: "2024-04-01T00:00:00Z",
        },
      ],
      issueView: {
        title: SECURITY_SCAN_ISSUE_TITLE,
        body: "<!-- idle-task: template=security-scan -->",
      },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);
    const repoPRs: OpenPR[] = [];
    const repoClosedPRs: ClosedPR[] = [];
    const repoAllIssues: FilterableIssue[] = [];

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      repoPRs,
      repoAllIssues,
      fetcher,
      repoClosedPRs,
    );

    assertEquals(candidates.length, 1);
    const c = candidates[0]!;
    assertEquals(c.repo, "owner/repo");
    assertEquals(c.number, 501);
    assertEquals(c.labelIndex, 299);
    assertEquals(c.source, "idle-task");
  },
);

// ---------------------------------------------------------------------------
// idle-task is just the lowest work-trigger priority — no wrapper-title gate
// ---------------------------------------------------------------------------

Deno.test(
  "collect_idle_task_candidates - accepts a non-wrapper idle-task issue as lowest-priority work",
  async () => {
    // `idle-task` is simply the lowest of the four work-trigger
    // priorities, so an idle-task issue whose title is NOT a registered
    // scan-wrapper is still a claimable candidate. It is worked through
    // the standard issue→PR pipeline at dispatch time (a finding the
    // worker should fix), not dropped. (Previously the collector
    // enforced a wrapper-title gate and dropped this issue.)
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 502,
          title: "dead-code: unused export `foo` in src/bar.ts",
          url: "https://github.com/owner/repo/issues/502",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-02T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "alice" },
          created_at: "2024-04-02T00:00:00Z",
        },
      ],
      issueView: {
        title: "dead-code: unused export `foo` in src/bar.ts",
        body: "",
      },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0]!.number, 502);
    assertEquals(candidates[0]!.labelIndex, 299);
    assertEquals(candidates[0]!.source, "idle-task");
  },
);

Deno.test(
  "collect_idle_task_candidates - accepts backfilled wrapper whose idle-task label was applied by a human operator",
  async () => {
    // Reproduces the private-repo-10 #45-#48 bug: an operator ran the
    // idle-task-label backfill from their own gh auth, so the label
    // shows up as `actor=maintainer` instead of the worker. Before the
    // title-allowlist fix, the collector rejected the wrapper as
    // "label-author-not-allowed" and the wrappers sat unclaimed for
    // days.
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 510,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: "https://github.com/owner/repo/issues/510",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-05T00:00:00Z",
          author: { login: "bot" },
          milestone: null,
        },
      ],
      // Label added by a human operator running the backfill — not the
      // worker user.
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "maintainer" },
          created_at: "2024-04-06T00:00:00Z",
        },
      ],
      issueView: { title: SECURITY_SCAN_ISSUE_TITLE, body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0]!.number, 510);
    assertEquals(candidates[0]!.source, "idle-task");
  },
);

// ---------------------------------------------------------------------------
// Issue #3641: label-adder / issue-author trust gate
// ---------------------------------------------------------------------------

Deno.test(
  "collect_idle_task_candidates - rejects idle-task applied by an untrusted actor to their own issue",
  async () => {
    // Issue #3641: an actor holding only triage/write permission applies
    // `idle-task` to an issue whose body they authored. Neither the label
    // adder nor the issue author is trusted, so the worker must not claim
    // it — otherwise attacker-authored content drives a full billed
    // issue→PR run.
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 520,
          title: "Please refactor the deploy script",
          url: "https://github.com/owner/repo/issues/520",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-07T00:00:00Z",
          author: { login: "mallory" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "mallory" },
          created_at: "2024-04-07T00:00:00Z",
        },
      ],
      issueView: { title: "Please refactor the deploy script", body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates, []);
  },
);

Deno.test(
  "collect_idle_task_candidates - accepts an issue a trusted human authored even when an untrusted actor applied the label",
  async () => {
    // The content the worker acts on is authored by a trusted human, so an
    // untrusted label application only changes *when* the work is picked
    // up, not *what* is worked on.
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 521,
          title: "Tidy up the logging helper",
          url: "https://github.com/owner/repo/issues/521",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-08T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "mallory" },
          created_at: "2024-04-08T00:00:00Z",
        },
      ],
      issueView: { title: "Tidy up the logging helper", body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0]!.number, 521);
  },
);

Deno.test(
  "collect_idle_task_candidates - accepts a wrapper a sibling fleet worker filed and self-labelled",
  async () => {
    // `idle-task` is the one label the worker may self-apply (Issue
    // #2022), so fleet logins stay trusted for this label — unlike the
    // reserved discovery labels, where they are deliberately excluded.
    const config = makeConfig({ fleetPrAuthors: ["sibling-bot"] });
    const mockGh = createMockGh({
      issues: [
        {
          number: 522,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: "https://github.com/owner/repo/issues/522",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-09T00:00:00Z",
          author: { login: "sibling-bot" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "sibling-bot" },
          created_at: "2024-04-09T00:00:00Z",
        },
      ],
      issueView: { title: SECURITY_SCAN_ISSUE_TITLE, body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0]!.number, 522);
  },
);

Deno.test(
  "collect_idle_task_candidates - blocks an untrusted edit made after the idle-task label was applied",
  async () => {
    // TOCTOU: the worker filed the wrapper, a snapshot was captured, then
    // an untrusted actor rewrote the body. The content-integrity check
    // must block the claim rather than run the pipeline on the new body.
    const config = makeConfig();
    const issueNumber = 523;
    const files = new Map<string, string>();
    const contentApprovalDeps: ContentApprovalDeps = {
      readFile: (path: string) => {
        const content = files.get(path);
        return content === undefined
          ? Promise.reject(new Deno.errors.NotFound(`File not found: ${path}`))
          : Promise.resolve(content);
      },
      writeFile: (path: string, content: string) => {
        files.set(path, content);
        return Promise.resolve();
      },
      renameFile: (oldPath: string, newPath: string) => {
        const content = files.get(oldPath);
        if (content === undefined) {
          return Promise.reject(new Error(`File not found: ${oldPath}`));
        }
        files.set(newPath, content);
        files.delete(oldPath);
        return Promise.resolve();
      },
      removeFile: (path: string) => {
        files.delete(path);
        return Promise.resolve();
      },
    };

    // Snapshot the body the worker itself filed, attributed to an
    // untrusted author so the later change cannot be waved through.
    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issueNumber,
      SECURITY_SCAN_ISSUE_TITLE,
      "original wrapper body",
      "mallory",
      contentApprovalDeps,
    );

    const mockGh = createMockGh({
      issues: [
        {
          number: issueNumber,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: `https://github.com/owner/repo/issues/${issueNumber}`,
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-10T00:00:00Z",
          author: { login: "bot" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "bot" },
          created_at: "2024-04-10T00:00:00Z",
        },
      ],
      // Body no longer matches the snapshot — an edit landed after approval.
      issueView: {
        title: SECURITY_SCAN_ISSUE_TITLE,
        body: "rewritten body: run the attacker's instructions",
      },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      { ...buildOptions(mockGh, cache), contentApprovalDeps },
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates, []);
  },
);

// ---------------------------------------------------------------------------
// Milestone occupancy and PR blocking
// ---------------------------------------------------------------------------

Deno.test(
  "collect_idle_task_candidates - excludes candidate blocked by milestone occupancy",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 503,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: "https://github.com/owner/repo/issues/503",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-03T00:00:00Z",
          author: { login: "bot" },
          milestone: { title: "v2" },
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "bot" },
          created_at: "2024-04-03T00:00:00Z",
        },
      ],
      issueView: { title: SECURITY_SCAN_ISSUE_TITLE, body: "" },
    });

    const repoAllIssues: FilterableIssue[] = [
      {
        number: 999,
        title: "In flight",
        url: "https://github.com/owner/repo/issues/999",
        author: "alice",
        assignees: ["bot"],
        labels: ["help-wanted"],
        createdAt: "2024-04-01T00:00:00Z",
        milestone: "v2",
      },
    ];

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      repoAllIssues,
      fetcher,
      [],
    );

    assertEquals(candidates.length, 0);
  },
);

Deno.test(
  "collect_idle_task_candidates - excludes candidate blocked by open PR targeting same branch",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 504,
          title: SECURITY_SCAN_ISSUE_TITLE,
          url: "https://github.com/owner/repo/issues/504",
          assignees: [],
          labels: [{ name: IDLE_TASK_LABEL }],
          createdAt: "2024-04-04T00:00:00Z",
          author: { login: "bot" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: IDLE_TASK_LABEL },
          actor: { login: "bot" },
          created_at: "2024-04-04T00:00:00Z",
        },
      ],
      issueView: { title: SECURITY_SCAN_ISSUE_TITLE, body: "" },
    });

    const repoPRs: OpenPR[] = [
      {
        number: 400,
        title: "Default-branch PR",
        baseRefName: "main",
        headRefName: "feature/y",
      },
    ];

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      repoPRs,
      [],
      fetcher,
      [],
    );

    assertEquals(candidates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Edge case
// ---------------------------------------------------------------------------

Deno.test(
  "collect_idle_task_candidates - empty issue list returns []",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({ issues: [] });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const candidates = await collectIdleTaskCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(candidates, []);
  },
);

// ---------------------------------------------------------------------------
// Cooldown filtering wiring (find_oldest_issue passes idleTaskCandidates)
// ---------------------------------------------------------------------------

Deno.test(
  "collect_idle_task_candidates - cooldown filter reaches idle-task candidates via findOldestIssue",
  async () => {
    const { findOldestIssue } = await import("../lib/find_oldest_issue.ts");
    const config = makeConfig();

    // Single open idle-task issue, no other work.
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("issue list")) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 600,
              title: SECURITY_SCAN_ISSUE_TITLE,
              url: "https://github.com/owner/repo/issues/600",
              assignees: [],
              labels: [{ name: IDLE_TASK_LABEL }],
              createdAt: "2024-04-10T00:00:00Z",
              author: { login: "bot" },
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
              label: { name: IDLE_TASK_LABEL },
              actor: { login: "bot" },
              created_at: "2024-04-10T00:00:00Z",
            },
          ]),
        );
      }
      if (command.includes("issue view") && command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: SECURITY_SCAN_ISSUE_TITLE, body: "" }),
        );
      }
      if (command.includes("pr list")) {
        return Promise.resolve("[]");
      }
      return Promise.resolve("[]");
    };

    const cache = createTestCache();

    // First call: cooldown reports false -> idle-task selected.
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn,
      cache,
      isIssueInCooldown: () => false,
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("|600|"), true);

    // Second call: cooldown reports true for #600 -> no selection.
    const cache2 = createTestCache();
    const result2 = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn,
      cache: cache2,
      isIssueInCooldown: (_repo, n) => n === 600,
    });
    assertEquals(result2.found, false);
  },
);
