/**
 * Tests for `collectLabelCandidates` (Issue #2967).
 *
 * The configured-label collector serves the highest-priority tier
 * (`top-priority`). These tests pin the authorisation parity it must now
 * hold with the work-on and low-priority collectors: a priority label
 * added by an unauthorised actor is rejected, and content modified after
 * approval by an untrusted author is blocked (TOCTOU). The happy path
 * confirms an authorised label still yields a candidate.
 */

import { assertEquals } from "@std/assert";
import { collectLabelCandidates } from "../lib/collect_label_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

interface MockGhData {
  /** Issues returned by `gh issue list`. */
  issues?: Record<string, unknown>[];
  /** Timeline events returned by `gh api .../timeline`. */
  timeline?: Record<string, unknown>[];
  /** Body returned by `gh issue view --json title,body`. */
  issueView?: { title?: string; body?: string };
}

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "label-candidate-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: ["owner/repo"],
    // The configured-label tier is hardwired to [top-priority].
    issueLabels: ["top-priority"],
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
    workDir: Deno.makeTempDirSync({ prefix: "label-candidate-workdir-" }),
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
// Happy path — authorised label produces a candidate
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - top-priority label added by an allowed author produces one candidate",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 42,
          title: "Urgent fix",
          url: "https://github.com/owner/repo/issues/42",
          assignees: [],
          labels: [{ name: "top-priority" }],
          createdAt: "2024-03-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-01T00:00:00Z",
        },
      ],
      issueView: { title: "Urgent fix", body: "Fix the thing" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);
    const repoPRs: OpenPR[] = [];
    const repoClosedPRs: ClosedPR[] = [];
    const repoAllIssues: FilterableIssue[] = [];

    const result = await collectLabelCandidates(
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
    assertEquals(c.number, 42);
    assertEquals(c.source, "configured-label");
  },
);

// ---------------------------------------------------------------------------
// Regression — unauthorised label author is rejected (Issue #2967)
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - excludes issue when top-priority label was added by an unauthorised author",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({
      issues: [
        {
          number: 50,
          title: "Priority hijack",
          url: "https://github.com/owner/repo/issues/50",
          assignees: [],
          labels: [{ name: "top-priority" }],
          createdAt: "2024-03-02T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      // Label added by a user not in allowedAuthors (an untrusted triager).
      timeline: [
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "mallory" },
          created_at: "2024-03-02T00:00:00Z",
        },
      ],
      issueView: { title: "Priority hijack", body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLabelCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
    // The rejection is surfaced for the selection-reasoning diagnostic.
    assertEquals(
      result.blockedDetails.some(
        (b) => b.issueNumber === 50 && b.reason === "label-author-not-allowed",
      ),
      true,
    );
  },
);

// ---------------------------------------------------------------------------
// Regression — TOCTOU content tamper is blocked (Issue #2967 / #1341)
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - blocks issue whose content was modified after approval by an untrusted author",
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
              labels: [{ name: "top-priority" }],
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
              label: { name: "top-priority" },
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
          // Hash that will not match the tampered title/body above.
          contentHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
          capturedAt: Math.floor(Date.now() / 1000) - 3600,
          issueAuthor: "mallory",
        },
      },
    };
    await Deno.writeTextFile(stateFile, JSON.stringify(seeded));

    const result = await collectLabelCandidates(
      "owner/repo",
      config,
      buildOptions(ghFn, cache),
      [],
      [],
      fetcher,
      [],
    );

    assertEquals(result.candidates.length, 0);
    assertEquals(
      result.blockedDetails.some(
        (b) =>
          b.issueNumber === 100 &&
          b.reason === "content-modified-after-approval",
      ),
      true,
    );
  },
);

// ---------------------------------------------------------------------------
// Fleet-worker exclusion for operational labels (Issues #3225 / #3426).
//
// The fleet worker set excluded from operational-label trust is
// `github_user ∪ fleet_pr_authors` — deliberately NOT `allowed_authors`,
// because `allowed_authors` also lists the human authors who legitimately apply
// these labels. A sibling worker must therefore be listed in `fleet_pr_authors`
// to be excluded; when it is, an operational label it applied directly is
// stripped, while a human's priority label stays trusted.
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - strips an operational label a sibling worker (in fleet_pr_authors) applied while keeping a human's priority label trusted",
  async () => {
    // siblingbot is a sibling fleet worker: listed in both allowed_authors (for
    // PR-dedup, #3138) and fleet_pr_authors (the canonical sibling-worker list).
    // The #3225 backstop treats siblingbot as untrusted for operational labels,
    // so the needs-revision it applied directly is stripped and the
    // top-priority issue (applied by the human alice) survives.
    const config = makeConfig({
      allowedAuthors: ["alice", "siblingbot"],
      fleetPrAuthors: ["siblingbot"],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 60,
          title: "Priority work",
          url: "https://github.com/owner/repo/issues/60",
          assignees: [],
          labels: [{ name: "top-priority" }, { name: "needs-revision" }],
          createdAt: "2024-03-03T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "alice" }, // human — legitimately trusted
          created_at: "2024-03-03T00:00:00Z",
        },
        {
          event: "labeled",
          label: { name: "needs-revision" },
          actor: { login: "siblingbot" }, // sibling worker — must be excluded
          created_at: "2024-03-03T01:00:00Z",
        },
      ],
      issueView: { title: "Priority work", body: "Do the thing" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLabelCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    // needs-revision (sibling worker) is stripped as untrusted, so the issue is
    // not blocked; top-priority (human alice) stays trusted → one candidate.
    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 60);
  },
);

Deno.test(
  "collect_label_candidates - a human author in allowed_authors keeps operational-label trust (their planning label blocks the issue)",
  async () => {
    // Guard against the tempting-but-wrong "include allowed_authors in the
    // exclusion set" change (Issue #3426): allowed_authors contains humans, and
    // excluding them would strip a human's planning label. Here alice is a human
    // with no fleet_pr_authors entry, so her planning label is honoured and the
    // issue is correctly blocked (filtered out) rather than surfaced.
    const config = makeConfig({
      allowedAuthors: ["alice"],
      fleetPrAuthors: [],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 61,
          title: "Planning routed",
          url: "https://github.com/owner/repo/issues/61",
          assignees: [],
          labels: [{ name: "top-priority" }, { name: "planning" }],
          createdAt: "2024-03-04T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-04T00:00:00Z",
        },
        {
          event: "labeled",
          label: { name: "planning" },
          actor: { login: "alice" }, // human — must stay trusted
          created_at: "2024-03-04T01:00:00Z",
        },
      ],
      issueView: { title: "Planning routed", body: "" },
    });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLabelCandidates(
      "owner/repo",
      config,
      buildOptions(mockGh, cache),
      [],
      [],
      fetcher,
      [],
    );

    // planning stays (trusted human), so filterAndSort blocks the issue.
    assertEquals(result.candidates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Edge case — empty issue list
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - empty issue list returns no candidates",
  async () => {
    const config = makeConfig();
    const mockGh = createMockGh({ issues: [] });

    const cache = createTestCache();
    const fetcher = createIssueFetcher(mockGh);

    const result = await collectLabelCandidates(
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
// custom_label_prompts labels are trust-gated here too (Issue #847, part of #843)
// ---------------------------------------------------------------------------

Deno.test(
  "collect_label_candidates - strips a custom_label_prompts label added by an untrusted actor (Issue #847)",
  async () => {
    const config = makeConfig({
      customLabelPrompts: [
        {
          label: "deploy-review",
          promptPath: "/srv/prompts/deploy-review.md",
          targetPhase: "issue",
        },
      ],
    });
    const mockGh = createMockGh({
      issues: [
        {
          number: 60,
          title: "Custom label smuggled in",
          url: "https://github.com/owner/repo/issues/60",
          assignees: [],
          labels: [{ name: "top-priority" }, { name: "deploy-review" }],
          createdAt: "2024-03-03T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
        },
      ],
      timeline: [
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "alice" },
          created_at: "2024-03-03T00:00:00Z",
        },
        // The custom label came from a non-allowlisted triage collaborator.
        {
          event: "labeled",
          label: { name: "deploy-review" },
          actor: { login: "mallory" },
          created_at: "2024-03-03T01:00:00Z",
        },
      ],
      issueView: { title: "Custom label smuggled in", body: "" },
    });

    const lines: string[] = [];
    const cache = createTestCache();
    const result = await collectLabelCandidates(
      "owner/repo",
      config,
      {
        ...buildOptions(mockGh, cache),
        diagnostics: createDiagnostics({
          enabled: true,
          write: (line) => lines.push(line),
        }),
      },
      [],
      [],
      createIssueFetcher(mockGh),
      [],
    );

    // The issue still qualifies on its trusted `top-priority` label …
    assertEquals(result.candidates.length, 1);
    // … but the untrusted custom label was stripped and audited.
    assertEquals(
      lines.some(
        (l) =>
          l.includes("issue=#60") &&
          l.includes("untrusted-operational-label") &&
          l.includes("deploy-review(mallory)"),
      ),
      true,
      `expected an untrusted-operational-label diagnostic, got: ${
        lines.join("\n")
      }`,
    );
  },
);
