/**
 * Tests for the opt-in new-work eligibility gating on `findIssuesByLabel`
 * (Issue #937, part of #843).
 *
 * The custom-label dispatch (#848) reaches the same `workOnIssue` pipeline
 * `work-on` reaches, but through `findIssuesByLabel`, which applied none of
 * the eligibility gates. Because a custom label is never removed and
 * `unassign_on_pr_created` defaults to `true`, the next cycle re-ran the whole
 * implementation pipeline while the previous cycle's PR was still open.
 *
 * These tests drive the real finder against a fake that models GitHub's own
 * answers — issue list, PR list, timeline, labels — and assert on the
 * decision the worker reaches, never on the request text.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { findIssuesByLabel } from "../lib/find_issues_by_label.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo";
const CUSTOM_LABEL = "deploy-review";

/** An isolated cache per test, so no fixture leaks between them. */
function createTestCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "label-gating-" }),
    600,
  );
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    allowedAuthors: ["alice"],
    fleetPrAuthors: ["bot"],
    shuffleRepos: false,
    // A configured custom label — the route #937 is about. Built here rather
    // than through the parser so the test needs no prompt file on disk.
    customLabelPrompts: [{
      label: CUSTOM_LABEL,
      promptPath: "/srv/deploy.md",
      targetPhase: "issue",
    }],
    ...overrides,
  };
}

/** The repository state the fake `gh` answers from. */
interface RepoFixture {
  issues: Record<string, unknown>[];
  openPRs?: Record<string, unknown>[];
  closedPRs?: Record<string, unknown>[];
  /** Label events per issue, in REST timeline shape. */
  timelines?: Record<number, Record<string, unknown>[]>;
  /** Current labels per issue, as `gh issue view --json labels` returns. */
  issueLabels?: Record<number, string[]>;
  /** Issue bodies, read by the dependency gate. */
  bodies?: Record<number, string>;
  /** Issue states, for dependency resolution. */
  states?: Record<number, "OPEN" | "CLOSED">;
}

/**
 * A fake `gh` modelling GitHub's own rules rather than the worker's queries.
 *
 * The GraphQL timeline batch is refused, so every timeline read takes the REST
 * path and is served from the same per-issue fixture — a query asked the wrong
 * way round gets a truthfully wrong answer.
 */
function createGh(
  fixture: RepoFixture,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(new Error("GraphQL unavailable in this fake"));
    }

    if (args[0] === "api") {
      const path = args[1] ?? "";
      const timeline = /\/issues\/(\d+)\/timeline/.exec(path);
      if (timeline) {
        const number = Number(timeline[1]);
        return Promise.resolve(
          JSON.stringify(fixture.timelines?.[number] ?? []),
        );
      }
      return Promise.resolve("[]");
    }

    if (command.startsWith("issue list")) {
      return Promise.resolve(JSON.stringify(fixture.issues));
    }

    if (command.startsWith("pr list")) {
      const closed = args.includes("closed");
      const prs = (closed ? fixture.closedPRs : fixture.openPRs) ?? [];
      return Promise.resolve(JSON.stringify(prs));
    }

    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      if (args.includes("labels")) {
        const labels = fixture.issueLabels?.[number] ?? [];
        return Promise.resolve(
          JSON.stringify({ labels: labels.map((name) => ({ name })) }),
        );
      }
      if (args.includes("body")) {
        return Promise.resolve(
          JSON.stringify({ body: fixture.bodies?.[number] ?? "" }),
        );
      }
      return Promise.resolve(
        JSON.stringify({
          number,
          state: fixture.states?.[number] ?? "OPEN",
          title: `Issue ${number}`,
        }),
      );
    }

    return Promise.resolve("[]");
  };
}

/** A trusted add of the custom label, dated well before any PR. */
function trustedLabelAdd(): Record<string, unknown>[] {
  return [
    {
      event: "labeled",
      label: { name: CUSTOM_LABEL },
      actor: { login: "alice" },
      created_at: "2024-01-02T00:00:00Z",
    },
  ];
}

function customIssue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 7,
    title: "Roll out the new deployment",
    url: `https://github.com/${REPO}/issues/7`,
    assignees: [],
    labels: [{ name: CUSTOM_LABEL }],
    createdAt: "2024-01-01T00:00:00Z",
    author: { login: "alice" },
    milestone: null,
    body: "",
    ...overrides,
  };
}

/** ISO timestamp `secondsAgo` seconds in the past. */
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

// =============================================================================
// The gate the issue was filed for: an open PR must stop re-dispatch
// =============================================================================

Deno.test(
  "find_issues_by_label - a gated scan does not dispatch an issue whose fleet PR is open (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      openPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          baseRefName: "main",
          headRefName: "issue-7",
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "pr-blocked");
    assertEquals(result.blockedDetails?.[0]?.issueNumber, 7);
  },
);

Deno.test(
  "find_issues_by_label - an ungated scan still dispatches an issue whose PR is open (Issue #937)",
  async () => {
    // The gating is opt-in: `planning`, `question`, `refine-issue` and
    // `grill-me` remove their own label when they finish and must keep the
    // behaviour they have.
    const gh = createGh({
      issues: [customIssue()],
      openPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          baseRefName: "main",
          headRefName: "issue-7",
        },
      ],
      timelines: { 7: trustedLabelAdd() },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output, "|7|");
  },
);

Deno.test(
  "find_issues_by_label - a gated scan honours the ignore-open-prs escape hatch (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue({ labels: [{ name: CUSTOM_LABEL }] })],
      openPRs: [
        {
          number: 88,
          title: "chore: unrelated",
          baseRefName: "main",
          headRefName: "chore-x",
        },
      ],
      timelines: {
        7: [
          ...trustedLabelAdd(),
          {
            event: "labeled",
            label: { name: "ignore-open-prs" },
            actor: { login: "alice" },
            created_at: "2024-01-03T00:00:00Z",
          },
        ],
      },
      issueLabels: { 7: [CUSTOM_LABEL, "ignore-open-prs"] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output, "|7|");
  },
);

// =============================================================================
// Recently-closed and merged PRs
// =============================================================================

Deno.test(
  "find_issues_by_label - a gated scan holds an issue whose PR closed inside the cooldown (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      closedPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          mergedAt: null,
          closedAt: ago(60),
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "closed-pr-cooldown");
  },
);

Deno.test(
  "find_issues_by_label - a gated scan releases an issue once the closed-PR cooldown expires (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      closedPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          mergedAt: null,
          // Closed well outside the one-hour window.
          closedAt: ago(7200),
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output, "|7|");
  },
);

Deno.test(
  "find_issues_by_label - a gated scan holds an issue whose fleet PR merged, whatever the window (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      closedPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          mergedAt: "2024-02-01T00:00:00Z",
          closedAt: "2024-02-01T00:00:00Z",
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "merged-pr-permanent");
  },
);

Deno.test(
  "find_issues_by_label - a trusted re-label after the merge reopens the issue (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      closedPRs: [
        {
          number: 88,
          title: "feat: roll out the new deployment (Issue #7)",
          mergedAt: "2024-02-01T00:00:00Z",
          closedAt: "2024-02-01T00:00:00Z",
        },
      ],
      timelines: {
        7: [
          {
            event: "labeled",
            label: { name: CUSTOM_LABEL },
            actor: { login: "alice" },
            created_at: "2024-03-01T00:00:00Z",
          },
        ],
      },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output, "|7|");
  },
);

// =============================================================================
// Failure treatment and re-claim cooldown
// =============================================================================

Deno.test(
  "find_issues_by_label - a gated scan does not dispatch an issue carrying the failed label (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [
        customIssue({
          labels: [{ name: CUSTOM_LABEL }, { name: "failed" }],
        }),
      ],
      timelines: { 7: trustedLabelAdd() },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "filtered-out");
  },
);

Deno.test(
  "find_issues_by_label - a gated scan skips an issue held by the retry cooldown (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      timelines: { 7: trustedLabelAdd() },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
      isIssueInCooldown: (repo, number) => repo === REPO && number === 7,
    });

    assertEquals(result.found, false);
  },
);

// =============================================================================
// Milestone occupancy and dependency blocking
// =============================================================================

Deno.test(
  "find_issues_by_label - a gated scan holds an issue whose milestone is occupied (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [
        customIssue({ milestone: { title: "Fleet Logs" } }),
        {
          number: 9,
          title: "Already claimed",
          url: `https://github.com/${REPO}/issues/9`,
          assignees: [{ login: "bot" }],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: "alice" },
          milestone: { title: "Fleet Logs" },
          body: "",
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "milestone-occupied");
  },
);

Deno.test(
  "find_issues_by_label - a gated scan holds an issue whose dependency is still open (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [
        customIssue({ body: "Depends on #9" }),
        {
          number: 9,
          title: "The dependency",
          url: `https://github.com/${REPO}/issues/9`,
          assignees: [],
          labels: [],
          createdAt: "2024-01-01T00:00:00Z",
          author: { login: "alice" },
          milestone: null,
          body: "",
        },
      ],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
      bodies: { 7: "Depends on #9" },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
    assertEquals(result.blockedDetails?.[0]?.reason, "dependency-blocked");
  },
);

// =============================================================================
// The fix must not be "never dispatch anything"
// =============================================================================

Deno.test(
  "find_issues_by_label - a gated scan still dispatches an eligible issue (Issue #937)",
  async () => {
    const gh = createGh({
      issues: [customIssue()],
      timelines: { 7: trustedLabelAdd() },
      issueLabels: { 7: [CUSTOM_LABEL] },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, true);
    assertStringIncludes(result.output, "|7|");
    assertEquals(result.blockedDetails, undefined);
  },
);

Deno.test(
  "find_issues_by_label - a gated scan keeps refusing an untrusted label adder (Issue #937)",
  async () => {
    // The #847/#3083 trust gate runs before the eligibility gates and must
    // still hold: gating adds refusals, it never grants a dispatch.
    const gh = createGh({
      issues: [customIssue({ author: { login: "mallory" } })],
      timelines: {
        7: [
          {
            event: "labeled",
            label: { name: CUSTOM_LABEL },
            actor: { login: "mallory" },
            created_at: "2024-01-02T00:00:00Z",
          },
        ],
      },
    });

    const result = await findIssuesByLabel(makeConfig(), CUSTOM_LABEL, false, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
      gateNewWork: true,
    });

    assertEquals(result.found, false);
  },
);
