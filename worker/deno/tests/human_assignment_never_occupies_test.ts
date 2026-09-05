/**
 * Regression tests for Issue #1064 — locking and scheduling exist only
 * between Vibe Coders.
 *
 * There is no locking or scheduling between humans and Vibe Coders: a human
 * assigning themselves an issue must never stop a Vibe Coder picking up other
 * work. The work-stream occupancy guard (`isMilestoneOccupied`) used to
 * resolve "the fleet" from `config.allowedAuthors`, which is a **permission**
 * list ("whose issues may we work on") and legitimately holds humans. On the
 * live deployment `allowed_authors` was `["nleck", "VibeCoderST",
 * "stservice"]`, so #944 — no milestone, assigned to the human `nleck` —
 * occupied the `""` default-branch work stream and filtered the unassigned
 * `top-priority` issues #997 and #986 out of candidate selection for ~21
 * hours.
 *
 * The guard now resolves the fleet from `resolveFleetMaintenanceAuthorSet`
 * (host login + `fleet_pr_authors` + `service_accounts`) — the same
 * push-capable set `getBlockingPRForIssue` already used. The duplicate-PR
 * guard these tests must not weaken is preserved: a **sibling Vibe Coder's**
 * assignment still occupies the stream, and so does this host's own.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { collectLabelCandidates } from "../lib/collect_label_candidates.ts";
import {
  buildNewWorkGateContext,
  filterNewWorkEligible,
} from "../lib/new_work_eligibility.ts";
import { diagnoseRepoIssue } from "../lib/diagnose_repo.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { resolveFleetMaintenanceAuthorSet } from "../lib/fleet_authors.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo";

/** This host. */
const HOST = "VibeCoderST";
/** A second Vibe Coder in the same fleet. */
const SIBLING = "stservice";
/**
 * A human. Present in `allowed_authors` — that is what the list is for — and
 * absent from every fleet-identity list.
 */
const HUMAN = "nleck";

function createTestCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "human-occupancy-test-" }),
    600,
  );
}

/**
 * The live deployment's author configuration: the human sits in
 * `allowed_authors` alongside the fleet accounts, and only the fleet accounts
 * appear in `fleet_pr_authors`.
 */
function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: [HUMAN, HOST, SIBLING],
    fleetPrAuthors: [SIBLING],
    serviceAccounts: [SIBLING],
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "human-occupancy-workdir-" }),
    ...overrides,
  };
}

function makeIssue(
  number: number,
  overrides: Partial<FilterableIssue> = {},
): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    author: HUMAN,
    assignees: [],
    labels: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    milestone: "",
    body: "",
    ...overrides,
  };
}

/** The `gh issue list` payload shape for a `top-priority` candidate. */
function listedIssue(
  number: number,
  milestone: string | null,
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    assignees: [],
    labels: [{ name: "top-priority" }],
    createdAt: "2026-09-04T09:24:00Z",
    author: { login: HUMAN },
    milestone: milestone === null ? null : { title: milestone },
  };
}

function createMockGh(
  issues: Record<string, unknown>[],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(new Error("GraphQL unavailable in this fake"));
    }
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: "Issue", body: "Body" }),
      );
    }
    if (command.includes("timeline")) {
      // The `top-priority` label was added by a trusted author, so the
      // label-authorisation gate passes and occupancy is the gate under test.
      return Promise.resolve(JSON.stringify([
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: HUMAN },
          created_at: "2026-09-04T09:24:00Z",
        },
      ]));
    }
    return Promise.resolve("[]");
  };
}

function buildOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: IssueCache,
): FindIssuesOptions {
  return { githubUser: HOST, ghCommandFn, cache };
}

/**
 * Run the configured-label collector over one `top-priority` candidate in
 * `stream`, with `occupant` holding a second open issue in the same stream.
 */
async function selectableWith(
  occupantAssignees: string[],
  stream: string,
): Promise<boolean> {
  const config = makeConfig();
  const candidateNumber = 997;
  const occupantNumber = 944;
  const mockGh = createMockGh([
    listedIssue(candidateNumber, stream === "" ? null : stream),
  ]);
  const cache = createTestCache();
  const repoAllIssues: FilterableIssue[] = [
    makeIssue(occupantNumber, {
      assignees: occupantAssignees,
      milestone: stream,
    }),
    makeIssue(candidateNumber, { milestone: stream, labels: ["top-priority"] }),
  ];

  const result = await collectLabelCandidates(
    REPO,
    config,
    buildOptions(mockGh, cache),
    [] as OpenPR[],
    repoAllIssues,
    createIssueFetcher(mockGh),
    [] as ClosedPR[],
  );
  return result.candidates.some((c) => c.number === candidateNumber);
}

// ---------------------------------------------------------------------------
// The live incident — a human assignee must not occupy a work stream
// ---------------------------------------------------------------------------

Deno.test(
  "human_assignment_never_occupies - a human's assignment does not occupy the default-branch stream (Issue #1064)",
  async () => {
    assertEquals(await selectableWith([HUMAN], ""), true);
  },
);

Deno.test(
  "human_assignment_never_occupies - a human's assignment does not occupy a milestone stream (Issue #1064)",
  async () => {
    assertEquals(await selectableWith([HUMAN], "Fleet Logs"), true);
  },
);

// ---------------------------------------------------------------------------
// The duplicate-PR guard survives — Vibe Coders still lock each other out
// ---------------------------------------------------------------------------

Deno.test(
  "human_assignment_never_occupies - a sibling Vibe Coder's assignment still occupies the default-branch stream",
  async () => {
    assertEquals(await selectableWith([SIBLING], ""), false);
  },
);

Deno.test(
  "human_assignment_never_occupies - a sibling Vibe Coder's assignment still occupies a milestone stream",
  async () => {
    assertEquals(await selectableWith([SIBLING], "Fleet Logs"), false);
  },
);

Deno.test(
  "human_assignment_never_occupies - this host's own assignment still occupies the default-branch stream",
  async () => {
    assertEquals(await selectableWith([HOST], ""), false);
  },
);

Deno.test(
  "human_assignment_never_occupies - this host's own assignment still occupies a milestone stream",
  async () => {
    assertEquals(await selectableWith([HOST], "Fleet Logs"), false);
  },
);

// ---------------------------------------------------------------------------
// The exact live shape, end to end (#944 / #997)
// ---------------------------------------------------------------------------

Deno.test(
  "human_assignment_never_occupies - the live #944/#997 shape selects the top-priority issue (Issue #1064)",
  async () => {
    const config = makeConfig();
    // #944: milestone-less, assigned to the human, carries no dispatch label.
    // #997: milestone-less, unassigned, `top-priority` — the issue that sat
    // filtered out for ~21 hours.
    const mockGh = createMockGh([listedIssue(997, null)]);
    const cache = createTestCache();
    const repoAllIssues: FilterableIssue[] = [
      makeIssue(944, {
        title: "Human-held issue",
        assignees: [HUMAN],
        milestone: "",
      }),
      makeIssue(997, {
        title: "Bug, top priority",
        labels: ["bug", "top-priority"],
        milestone: "",
      }),
    ];

    const result = await collectLabelCandidates(
      REPO,
      config,
      buildOptions(mockGh, cache),
      [] as OpenPR[],
      repoAllIssues,
      createIssueFetcher(mockGh),
      [] as ClosedPR[],
    );

    assertEquals(result.candidates.map((c) => c.number), [997]);
    assertEquals(
      result.blockedDetails.filter((b) => b.reason === "milestone-occupied"),
      [],
    );
  },
);

// ---------------------------------------------------------------------------
// The shared `work-on` eligibility sequence applies the same rule
// ---------------------------------------------------------------------------

/** Run `filterNewWorkEligible` with `occupantAssignees` holding stream `""`. */
async function eligibleWith(occupantAssignees: string[]): Promise<number[]> {
  const config = makeConfig();
  const repoIssues = [
    {
      number: 944,
      title: "Human-held issue",
      url: `https://github.com/${REPO}/issues/944`,
      assignees: occupantAssignees.map((login) => ({ login })),
      labels: [],
      createdAt: "2026-09-04T02:17:31Z",
      author: { login: HUMAN },
      milestone: null,
    },
  ];
  const gh = (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(new Error("GraphQL unavailable in this fake"));
    }
    if (args[0] === "api") return Promise.resolve("[]");
    if (command.startsWith("issue list")) {
      return Promise.resolve(JSON.stringify(repoIssues));
    }
    if (command.startsWith("pr list")) return Promise.resolve("[]");
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("labels")) {
        return Promise.resolve(JSON.stringify({ labels: [] }));
      }
      return Promise.resolve(JSON.stringify({}));
    }
    return Promise.resolve("[]");
  };

  const options: FindIssuesOptions = {
    githubUser: HOST,
    ghCommandFn: gh,
    cache: createTestCache(),
  };
  const ctx = await buildNewWorkGateContext(REPO, config, options, gh);
  const candidate = makeIssue(986, {
    labels: ["top-priority"],
    milestone: "",
  });
  const verdict = await filterNewWorkEligible([candidate], "work-on", ctx);
  return verdict.eligible.map((i) => i.number);
}

Deno.test(
  "human_assignment_never_occupies - new-work eligibility ignores a human's assignment (Issue #1064)",
  async () => {
    assertEquals(await eligibleWith([HUMAN]), [986]);
  },
);

Deno.test(
  "human_assignment_never_occupies - new-work eligibility still defers to a sibling Vibe Coder",
  async () => {
    assertEquals(await eligibleWith([SIBLING]), []);
  },
);

Deno.test(
  "human_assignment_never_occupies - new-work eligibility still defers to this host's own assignment",
  async () => {
    assertEquals(await eligibleWith([HOST]), []);
  },
);

// ---------------------------------------------------------------------------
// The repo diagnostic reports the same rule
// ---------------------------------------------------------------------------

/** `diagnoseRepoIssue`'s occupancy verdict for a milestone held by `holder`. */
function diagnosticOccupied(holder: string): boolean {
  const config = makeConfig();
  const milestone = "Fleet Logs";
  const result = diagnoseRepoIssue({
    issue: makeIssue(997, { milestone, labels: ["top-priority"] }),
    prs: [],
    allIssues: [
      makeIssue(944, { assignees: [holder], milestone }),
      makeIssue(997, { milestone, labels: ["top-priority"] }),
    ],
    labelConfig: {
      failedLabel: config.failedLabel,
      failedOnceLabel: config.failedOnceLabel,
      refineIssueLabel: config.refineIssueLabel,
      planningLabel: config.planningLabel,
      questionLabel: config.questionLabel,
      needsHumanLabel: config.needsHumanLabel,
    },
    workerUser: HOST,
    pushCapableAuthors: resolveFleetMaintenanceAuthorSet({
      githubUser: HOST,
      fleetPrAuthors: config.fleetPrAuthors ?? [],
    }),
  });
  return result.reasons.some((r) => r.includes("is occupied"));
}

Deno.test(
  "human_assignment_never_occupies - diagnoseRepoIssue does not report a human-held stream as occupied (Issue #1064)",
  () => {
    assertEquals(diagnosticOccupied(HUMAN), false);
  },
);

Deno.test(
  "human_assignment_never_occupies - diagnoseRepoIssue still reports a sibling-held stream as occupied",
  () => {
    assertEquals(diagnosticOccupied(SIBLING), true);
  },
);
