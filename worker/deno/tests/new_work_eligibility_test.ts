/**
 * Tests for `lib/new_work_eligibility.ts` (Issue #937, part of #843).
 *
 * The module is the `work-on` eligibility sequence lifted out so a second
 * PR-producing label route can apply it. These tests drive it directly:
 * the per-repo context build, the gate sequence's verdict, and the two edge
 * cases the sequence's ordering exists for — an empty candidate set, and a
 * reopened issue whose stale `failed` label must be shed before the blocking
 * label filter sees it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  buildNewWorkGateContext,
  filterNewWorkEligible,
} from "../lib/new_work_eligibility.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo";
const LABEL = "deploy-review";

function createTestCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "new-work-gate-" }),
    600,
  );
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    allowedAuthors: ["alice"],
    fleetPrAuthors: ["bot"],
    ...overrides,
  };
}

function makeIssue(
  number: number,
  labels: string[],
  overrides: Partial<FilterableIssue> = {},
): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    assignees: [],
    labels,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    author: "alice",
    milestone: "",
    body: "",
    ...overrides,
  };
}

/** A fake `gh` that answers from a fixed repository state. */
function createGh(fixture: {
  issues?: Record<string, unknown>[];
  openPRs?: Record<string, unknown>[];
  closedPRs?: Record<string, unknown>[];
  timelines?: Record<number, Record<string, unknown>[]>;
  removedLabels?: string[];
}): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(new Error("GraphQL unavailable in this fake"));
    }
    if (args[0] === "api") {
      const timeline = /\/issues\/(\d+)\/timeline/.exec(args[1] ?? "");
      if (timeline) {
        return Promise.resolve(
          JSON.stringify(fixture.timelines?.[Number(timeline[1])] ?? []),
        );
      }
      return Promise.resolve("[]");
    }
    if (command.startsWith("issue list")) {
      return Promise.resolve(JSON.stringify(fixture.issues ?? []));
    }
    if (command.startsWith("pr list")) {
      const closed = args.includes("closed");
      return Promise.resolve(
        JSON.stringify((closed ? fixture.closedPRs : fixture.openPRs) ?? []),
      );
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const removeAt = args.indexOf("--remove-label");
      if (removeAt !== -1) {
        fixture.removedLabels?.push(args[removeAt + 1] ?? "");
      }
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("labels")) {
        return Promise.resolve(JSON.stringify({ labels: [] }));
      }
      if (args.includes("body")) return Promise.resolve(JSON.stringify({}));
      return Promise.resolve(
        JSON.stringify({ number: Number(args[2]), state: "OPEN", title: "" }),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "new_work_eligibility - the context carries the fleet's open and closed PRs (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [],
      openPRs: [
        {
          number: 88,
          title: "feat: something (Issue #7)",
          baseRefName: "main",
          headRefName: "issue-7",
        },
      ],
      closedPRs: [
        {
          number: 70,
          title: "feat: earlier (Issue #5)",
          mergedAt: "2024-02-01T00:00:00Z",
          closedAt: "2024-02-01T00:00:00Z",
        },
      ],
    });

    const ctx = await buildNewWorkGateContext(
      REPO,
      makeConfig(),
      { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
      gh,
    );

    assertEquals(ctx.repoPRs.map((pr) => pr.number), [88]);
    assertEquals(ctx.repoClosedPRs.map((pr) => pr.number), [70]);
    // A merged PR is permanent, not cooldown-windowed (Issue #3151).
    assertEquals(ctx.repoClosedPRs[0]?.merged, true);
    // The host's own login is push-capable, so its PRs defer an issue.
    assertEquals(ctx.pushCapableAuthors.includes("bot"), true);
  },
);

Deno.test(
  "new_work_eligibility - the context build surfaces a gh failure rather than reporting no PRs (Issue #937)",
  async () => {
    // Fail loud: a swallowed PR-list error would read as "nothing blocking"
    // and let the very re-dispatch #937 is about through.
    const gh = (args: string[]): Promise<string> => {
      if (args.join(" ").startsWith("pr list")) {
        return Promise.reject(new Error("gh: API rate limit exceeded"));
      }
      return Promise.resolve("[]");
    };

    await assertRejects(
      () =>
        buildNewWorkGateContext(
          REPO,
          makeConfig(),
          { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
          gh,
        ),
      Error,
      "rate limit",
    );
  },
);

Deno.test(
  "new_work_eligibility - an empty candidate set yields no verdicts (Issue #937)",
  async () => {
    const gh = createGh({ issues: [] });
    const ctx = await buildNewWorkGateContext(
      REPO,
      makeConfig(),
      { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
      gh,
    );

    const verdict = await filterNewWorkEligible([], LABEL, ctx);
    assertEquals(verdict.eligible, []);
    assertEquals(verdict.blocked, []);
  },
);

Deno.test(
  "new_work_eligibility - the open PR defers only the issue it blocks (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [],
      openPRs: [
        {
          number: 88,
          title: "feat: something",
          baseRefName: "milestone/fleet-logs",
          headRefName: "issue-7",
        },
      ],
    });
    const ctx = await buildNewWorkGateContext(
      REPO,
      makeConfig(),
      { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
      gh,
    );

    // The open PR targets the `Fleet Logs` milestone branch, so it blocks the
    // milestone issue and leaves the unrelated non-milestone one alone.
    const verdict = await filterNewWorkEligible(
      [
        makeIssue(7, [LABEL], { milestone: "Fleet Logs" }),
        makeIssue(8, [LABEL]),
      ],
      LABEL,
      ctx,
    );

    assertEquals(verdict.eligible.map((i) => i.number), [8]);
    assertEquals(verdict.blocked.length, 1);
    assertEquals(verdict.blocked[0]?.issueNumber, 7);
    assertEquals(verdict.blocked[0]?.reason, "pr-blocked");
  },
);

Deno.test(
  "new_work_eligibility - a reopened issue sheds its stale failed label and stays eligible (Issue #937)",
  async () => {
    // Ordering matters: the blocking-label filter runs *after* the stale
    // cleanup, so an issue reopened after it failed is workable again rather
    // than stranded by the failure gate this route newly honours.
    const removedLabels: string[] = [];
    const gh = createGh({
      issues: [],
      timelines: {
        7: [
          {
            event: "labeled",
            label: { name: "failed" },
            created_at: "2024-01-05T00:00:00Z",
          },
          { event: "reopened", created_at: "2024-01-06T00:00:00Z" },
        ],
      },
      removedLabels,
    });
    const ctx = await buildNewWorkGateContext(
      REPO,
      makeConfig(),
      { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
      gh,
    );

    const verdict = await filterNewWorkEligible(
      [makeIssue(7, [LABEL, "failed"])],
      LABEL,
      ctx,
    );

    assertEquals(removedLabels, ["failed"]);
    assertEquals(verdict.eligible.map((i) => i.number), [7]);
    assertEquals(verdict.blocked, []);
  },
);

Deno.test(
  "new_work_eligibility - an issue still carrying failed is refused (Issue #937)",
  async () => {
    const gh = createGh({ issues: [], timelines: { 7: [] } });
    const ctx = await buildNewWorkGateContext(
      REPO,
      makeConfig(),
      { githubUser: "bot", ghCommandFn: gh, cache: createTestCache() },
      gh,
    );

    const verdict = await filterNewWorkEligible(
      [makeIssue(7, [LABEL, "failed"])],
      LABEL,
      ctx,
    );

    assertEquals(verdict.eligible, []);
    assertEquals(verdict.blocked[0]?.reason, "filtered-out");
  },
);
