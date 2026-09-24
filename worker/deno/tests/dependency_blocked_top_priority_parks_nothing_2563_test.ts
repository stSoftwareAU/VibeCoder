/**
 * A dependency-blocked `top-priority` issue parks nothing (Issue #2563).
 *
 * On 2026-09-24 the idle-decision census reported four claimable `work-on`
 * issues in stSoftwareAU/GRQ-AutoTrader (#948, #946, #938, #916, all in the
 * non-milestone stream) on three consecutive cycles while the claim scan
 * claimed none of them and recorded no reason for any of them.
 *
 * The scan was wrong. `collectLabelCandidates` pushed a dependency-blocked
 * `top-priority` issue (GRQ-AutoTrader#846, waiting on a milestone rollup)
 * into `blocked` whenever the repository had any open fleet PR — there, the
 * milestone rollup PR, which blocks nothing in the non-milestone stream —
 * and `selectHighestPriority` drops every `work-on` candidate sharing a
 * `blocked` entry's stream. So one issue waiting on its own dependency
 * silently parked every `work-on` issue in its stream: the top tier starving
 * the one below it, and a gate the census cannot see.
 *
 * These tests put the same fixture through both instruments — the claim scan
 * (`findOldestIssue`) and the census (`buildIdleDecisionCensus`) — and
 * require them to agree in both directions: what the census calls claimable
 * the scan claims, and what the census refuses the scan refuses.
 *
 * Uses Australian English spelling (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { buildIdleDecisionCensus } from "../lib/idle_decision_census.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo-a";
const ALICE = { login: "alice" };
const WORKER = "bot";

interface FixtureIssue {
  number: number;
  labels: string[];
  milestone: string;
  body?: string;
  assignees?: string[];
}

function makeConfig(): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store resolves from workDir.
    workDir: Deno.makeTempDirSync({ prefix: "issue-2563-workdir-" }),
    repos: [REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    shuffleRepos: false,
  };
}

function toGhIssue(issue: FixtureIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: `Issue ${issue.number}`,
    url: `https://github.com/${REPO}/issues/${issue.number}`,
    assignees: (issue.assignees ?? []).map((login) => ({ login })),
    labels: issue.labels.map((name) => ({ name })),
    createdAt: `2024-01-${String(issue.number % 28 + 1).padStart(2, "0")}Z`,
    author: ALICE,
    milestone: issue.milestone === "" ? null : { title: issue.milestone },
    body: issue.body ?? "",
  };
}

/** A gh stub serving one repository's open issues and open fleet PRs. */
function mockGh(
  issues: FixtureIssue[],
  openPRs: OpenPR[],
): (args: string[]) => Promise<string> {
  const ghIssues = issues.map(toGhIssue);
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(ghIssues));
    }
    if (command.includes("issue view")) {
      const number = Number(args[args.indexOf("view") + 1]);
      const issue = ghIssues.find((i) => i.number === number);
      return Promise.resolve(JSON.stringify({
        number,
        state: issue ? "OPEN" : "CLOSED",
        title: issue?.title ?? "",
        body: issue?.body ?? "",
        milestone: issue?.milestone ?? null,
      }));
    }
    if (command.includes("pr list") && command.includes("--state open")) {
      return Promise.resolve(JSON.stringify(openPRs));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
        { event: "labeled", label: { name: "work-on" }, actor: ALICE },
      ]));
    }
    return Promise.resolve("[]");
  };
}

/**
 * Run the claim scan and the census over the same repository state and
 * return what each would have the fleet claim.
 */
async function bothInstruments(
  issues: FixtureIssue[],
  openPRs: OpenPR[],
): Promise<{ scanClaimed: number | null; censusClaimable: number[] }> {
  const result = await findOldestIssue(makeConfig(), {
    githubUser: WORKER,
    ghCommandFn: mockGh(issues, openPRs),
    cache: new IssueCache(
      Deno.makeTempDirSync({ prefix: "issue-2563-cache-" }),
      600,
    ),
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
  const scanClaimed = result.found ? Number(result.output.split("|")[1]) : null;

  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: WORKER,
    repos: [{
      repo: REPO,
      monitored: true,
      scannedThisCycle: true,
      nice: 0,
      issues: issues.map((i) => ({
        number: i.number,
        labels: i.labels,
        assignees: i.assignees ?? [],
        milestone: i.milestone,
        body: i.body ?? "",
      })),
      openPRs,
    }],
  });
  return {
    scanClaimed,
    censusClaimable: census.perRepo[0]?.claimableIssues ?? [],
  };
}

/** The two instruments agree: the scan claims work iff the census sees it. */
function assertAgree(
  outcome: { scanClaimed: number | null; censusClaimable: number[] },
): void {
  if (outcome.scanClaimed === null) {
    assertEquals(
      outcome.censusClaimable,
      [],
      "the census calls work claimable that the scan refused",
    );
    return;
  }
  assert(
    outcome.censusClaimable.includes(outcome.scanClaimed),
    `the scan claimed #${outcome.scanClaimed}, which the census does not ` +
      `call claimable (${outcome.censusClaimable.join(",")})`,
  );
}

/** The milestone rollup PR GRQ-AutoTrader had open (#1060). */
const MILESTONE_ROLLUP_PR: OpenPR = {
  number: 1060,
  title: "Milestone: Auto buy part 2",
  baseRefName: "main",
  headRefName: "milestone/auto-buy-part-2",
};

/** A `top-priority` issue waiting on an open dependency, #846's shape. */
const DEPENDENCY_BLOCKED_TOP_PRIORITY: FixtureIssue = {
  number: 846,
  labels: ["top-priority"],
  milestone: "",
  body: "## Dependencies\n\nDepends on #844\n",
};
const OPEN_DEPENDENCY: FixtureIssue = {
  number: 844,
  labels: [],
  milestone: "Auto buy part 2",
  assignees: ["someone"],
};

Deno.test(
  "Issue #2563: a dependency-blocked top-priority issue does not park the work-on issues in its stream",
  async () => {
    const outcome = await bothInstruments(
      [
        DEPENDENCY_BLOCKED_TOP_PRIORITY,
        OPEN_DEPENDENCY,
        { number: 948, labels: ["work-on"], milestone: "" },
      ],
      [MILESTONE_ROLLUP_PR],
    );

    assertEquals(outcome.censusClaimable, [948]);
    assertEquals(
      outcome.scanClaimed,
      948,
      "the scan refused a work-on issue whose only obstacle is another " +
        "issue's dependency",
    );
    assertAgree(outcome);
  },
);

Deno.test(
  "Issue #2563: the two agree when the work-on issue is itself dependency-blocked",
  async () => {
    const outcome = await bothInstruments(
      [
        DEPENDENCY_BLOCKED_TOP_PRIORITY,
        OPEN_DEPENDENCY,
        {
          number: 948,
          labels: ["work-on"],
          milestone: "",
          body: "Depends on #844",
        },
      ],
      [MILESTONE_ROLLUP_PR],
    );

    assertEquals(outcome.scanClaimed, null);
    assertAgree(outcome);
  },
);

Deno.test(
  "Issue #2563: the two agree when an open PR on the stream holds both tiers",
  async () => {
    // A PR on the non-milestone stream blocks every issue in it, whichever
    // tier: the scan refuses both, and the census counts both as PR-blocked.
    const outcome = await bothInstruments(
      [
        { number: 846, labels: ["top-priority"], milestone: "" },
        { number: 948, labels: ["work-on"], milestone: "" },
      ],
      [{
        number: 968,
        title: "Fix something (Issue #934)",
        baseRefName: "main",
        headRefName: "issue-934-fix-something",
      }],
    );

    assertEquals(outcome.scanClaimed, null);
    assertAgree(outcome);
  },
);

Deno.test(
  "Issue #2563: a claimable top-priority issue still outranks work-on",
  async () => {
    const outcome = await bothInstruments(
      [
        { number: 846, labels: ["top-priority"], milestone: "" },
        { number: 948, labels: ["work-on"], milestone: "" },
      ],
      [MILESTONE_ROLLUP_PR],
    );

    assertEquals(outcome.scanClaimed, 846);
    assertAgree(outcome);
  },
);
