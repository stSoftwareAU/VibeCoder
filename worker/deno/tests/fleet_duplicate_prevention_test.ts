/**
 * Fleet-wide regression tests for the one-PR-per-issue invariant (Issue #3153,
 * capstone of #3136).
 *
 * The desired end state is **exactly one PR per issue across the whole fleet**.
 * The individual guards that enforce it are tested per sub-issue
 * (`claim_issue_test.ts` #3150, `find_oldest_issue_test.ts` #3100/#3151,
 * `issue_query_test.ts`, `pr_issue_linking_test.ts` #3152). This file is the
 * cross-cutting capstone: it exercises the *interaction* of the guard stack in
 * scenarios that span **multiple monitored repos** and **more than two fleet
 * accounts**, so the invariant cannot silently regress again (as it did after
 * #3095 / #3099 / #3100).
 *
 * Guard layers under test (a duplicate is prevented if ANY layer fires):
 *   1. Fleet-author union            — resolveFleetAuthors (#3138)
 *   2. Discovery open-PR guard       — findOldestIssue + fetchOpenPRsForFleet (#3100)
 *   3. Claim-time live re-check      — claimIssue live fleet re-check (#3150)
 *   4. Permanent merged-lock         — fetchRecentlyClosedPRsForFleet (#3151)
 *   5. Branch reuse on retry         — findClosedUnmergedPrForBranch (#3152)
 *   +  Fail-loud fleet-config check  — validateFleetConfig (#3138)
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { claimIssue } from "../lib/claim_issue.ts";
import {
  fetchClosedPRsByBranch,
  fetchRecentlyClosedPRsForFleet,
} from "../lib/issue_query.ts";
import { findClosedUnmergedPrForBranch } from "../lib/pr_issue_linking.ts";
import { resolveFleetAuthors } from "../lib/fleet_authors.ts";
import { validateFleetConfig } from "../lib/fleet_config_validation.ts";
import { createBranchName } from "../lib/git_branch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// --- Fleet identities --------------------------------------------------------
// A three-account fleet. `stsvcbot` is a sibling declared in allowed_authors;
// `fleet-worker` is a sibling declared ONLY in fleet_pr_authors — the exact
// #3138 blind-spot shape. `alice` is the human who applies `work-on`.
const HOST = "vibecoderbot";
const SIBLING_ALLOWED = "stsvcbot";
const SIBLING_FLEET_ONLY = "fleet-worker";
const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "fleet-dup-prevention-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "fleet-dup-workdir-" }),
    repos: ["owner/repo-a", "owner/repo-b", "owner/repo-c"],
    issueLabels: ["top-priority", "help-wanted", "claude"],
    // Union sources: alice + stsvcbot via allowed_authors, fleet-worker via
    // fleet_pr_authors only. The guard must cover all three fleet logins.
    allowedAuthors: ["alice", SIBLING_ALLOWED],
    fleetPrAuthors: [SIBLING_FLEET_ONLY],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    shuffleRepos: false,
    ...overrides,
  };
}

const noSleep = () => Promise.resolve();

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

// --- Multi-repo fleet scenario mock -----------------------------------------

interface WorkOnIssueSpec {
  number: number;
  createdAt?: string;
}

interface RepoScenario {
  /** Open `work-on` issues in the repo (author = alice). */
  issues: WorkOnIssueSpec[];
  /** Open PRs keyed by gh `--author`. */
  openByAuthor?: Record<
    string,
    Array<{ number: number; baseRefName: string; headRefName?: string }>
  >;
  /** Closed PRs (with merge state) keyed by gh `--author`. */
  closedByAuthor?: Record<
    string,
    Array<
      {
        number: number;
        title: string;
        mergedAt: string | null;
        closedAt: string | null;
      }
    >
  >;
}

/**
 * Build a mock `gh` that serves several repos at once. Each repo answers its
 * own issue list, per-author open/closed PR lists, per-issue labels, and a
 * work-on timeline. The whole fleet duplicate-prevention stack reads through
 * this one mock so a cross-repo / cross-account scenario is a single fixture.
 */
function createFleetScenarioMockGh(
  scenarios: Record<string, RepoScenario>,
): (args: string[]) => Promise<string> {
  const buildIssue = (n: number, createdAt?: string) => ({
    number: n,
    title: `Fleet work-on issue #${n}`,
    url: `https://github.com/owner/issues/${n}`,
    assignees: [],
    labels: [{ name: "work-on" }],
    createdAt: createdAt ?? "2024-01-01T00:00:00Z",
    author: ALICE,
    milestone: null,
  });

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
    const scenario = scenarios[repo];

    if (command.includes("issue list")) {
      const issues = (scenario?.issues ?? []).map((s) =>
        buildIssue(s.number, s.createdAt)
      );
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("issue view")) {
      // fetchIssueLabels: `gh issue view <n> --repo <r> --json labels`.
      return Promise.resolve(JSON.stringify({ labels: [{ name: "work-on" }] }));
    }
    if (command.includes("pr list")) {
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] ?? "" : "";
      const stateIdx = args.indexOf("--state");
      const state = stateIdx >= 0 ? args[stateIdx + 1] ?? "" : "";
      if (state === "closed") {
        return Promise.resolve(
          JSON.stringify(scenario?.closedByAuthor?.[author] ?? []),
        );
      }
      const open = (scenario?.openByAuthor?.[author] ?? []).map((p) => ({
        number: p.number,
        title: `PR ${p.number}`,
        baseRefName: p.baseRefName,
        headRefName: p.headRefName ?? `issue-${p.number}`,
      }));
      return Promise.resolve(JSON.stringify(open));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(
        JSON.stringify([
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ]),
      );
    }
    return Promise.resolve("[]");
  };
}

// =============================================================================
// Layer 1 — the shared fleet-author union (#3138)
// =============================================================================

Deno.test(
  "fleet invariant - the guard's author union covers a sibling present only in fleet_pr_authors (#3138)",
  () => {
    // Every guard resolves its fleet set through this one helper. If a fleet
    // login is not in the union, that account's PRs are invisible and a
    // duplicate follows (the #3095/#3138 root cause).
    const union = resolveFleetAuthors(
      HOST,
      ["alice", SIBLING_ALLOWED],
      [SIBLING_FLEET_ONLY],
    );
    assertEquals(union.includes(HOST), true);
    assertEquals(union.includes(SIBLING_ALLOWED), true);
    assertEquals(union.includes(SIBLING_FLEET_ONLY), true);
    // Case-insensitive de-duplication — no login appears twice.
    const lowered = union.map((a) => a.toLowerCase());
    assertEquals(new Set(lowered).size, union.length);
  },
);

// =============================================================================
// Cross-cutting — two guard layers suppress two repos via two fleet accounts,
// and the one clean issue across the fleet is selected (Layers 2 + 4).
// =============================================================================

Deno.test(
  "fleet invariant - across three repos and three accounts, only the issue with no fleet PR is selected (#3100/#3151)",
  async () => {
    const config = makeConfig();
    const mockGh = createFleetScenarioMockGh({
      // repo-a #10 — an OPEN PR by the fleet-only sibling (fleet-worker) blocks
      // it via the discovery open-PR guard (Layer 2). Proves the union covers
      // an account that lives only in fleet_pr_authors.
      "owner/repo-a": {
        issues: [{ number: 10 }],
        openByAuthor: {
          [SIBLING_FLEET_ONLY]: [{ number: 100, baseRefName: "main" }],
        },
      },
      // repo-b #20 — a MERGED PR by the allowed sibling (stsvcbot), two hours
      // ago (past the 1h cooldown). The permanent merged-lock (Layer 4) blocks
      // re-pickup for good.
      "owner/repo-b": {
        issues: [{ number: 20 }],
        closedByAuthor: {
          [SIBLING_ALLOWED]: [{
            number: 200,
            title: "Fleet work-on issue (#20)",
            mergedAt: isoSecondsAgo(7200),
            closedAt: isoSecondsAgo(7200),
          }],
        },
      },
      // repo-c #30 — clean: no open, closed, or merged fleet PR anywhere.
      "owner/repo-c": {
        issues: [{ number: 30 }],
      },
    });

    const result = await findOldestIssue(config, {
      githubUser: HOST,
      ghCommandFn: mockGh,
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    // The blocked issues (#10 open-PR, #20 merged-lock) must be skipped even
    // though #10 is the oldest scanned; the clean #30 wins.
    assertStringIncludes(result.output, "|30|");
  },
);

// =============================================================================
// Mode B — permanent post-merge re-pickup lock (Layer 4). The single-guard
// same-account and cross-repo-non-suppression regressions live in
// find_oldest_issue_test.ts; here we exercise the fleet-wide classifier that
// mixes all three accounts and both PR classes at once.
// =============================================================================

Deno.test(
  "fleet invariant - merged blocks permanently but closed-unmerged expires with the cooldown (#3151 classification)",
  async () => {
    // Directly exercise the fleet-wide classifier over three accounts: a
    // merged PR is permanent; a closed-unmerged PR past the window is dropped
    // (retry path); a closed-unmerged PR inside the window still blocks.
    const closed = await fetchRecentlyClosedPRsForFleet(
      "owner/repo-a",
      [HOST, SIBLING_ALLOWED, SIBLING_FLEET_ONLY],
      3600,
      undefined,
      createFleetScenarioMockGh({
        "owner/repo-a": {
          issues: [],
          closedByAuthor: {
            [HOST]: [{
              number: 1,
              title: "merged host (#10)",
              mergedAt: isoSecondsAgo(7200),
              closedAt: isoSecondsAgo(7200),
            }],
            [SIBLING_ALLOWED]: [{
              number: 2,
              title: "closed-unmerged past window (#20)",
              mergedAt: null,
              closedAt: isoSecondsAgo(7200),
            }],
            [SIBLING_FLEET_ONLY]: [{
              number: 3,
              title: "closed-unmerged in window (#30)",
              mergedAt: null,
              closedAt: isoSecondsAgo(60),
            }],
          },
        },
      }),
    );

    const byNumber = new Map(closed.map((p) => [p.number, p]));
    // Merged host PR: present and flagged permanent.
    assertEquals(byNumber.get(1)?.merged, true);
    // Closed-unmerged past the window: dropped (retry path preserved).
    assertEquals(byNumber.has(2), false);
    // Closed-unmerged inside the window: present, not merged.
    assertEquals(byNumber.get(3)?.merged, false);
  },
);

// =============================================================================
// Mode A — concurrent cross-account claim (Layer 3), third fleet account.
// =============================================================================

/**
 * Claim-time re-check mock: this host wins the comment race, then the live
 * cache-bypassing re-check runs `pr list` per fleet author. `prsByAuthor`
 * seeds the sibling PR opened in the discovery→claim window.
 */
function makeClaimRecheckMockGh(
  workerId: string,
  prsByAuthor: Record<string, unknown[]>,
): { ghCommandFn: (args: string[]) => Promise<string>; calls: string[][] } {
  const ownClaim = JSON.stringify([
    {
      id: 11,
      body: `<!-- CLAIM_LOCK:${workerId} --> Claimed`,
      created_at: "2026-07-02T00:00:01Z",
    },
  ]);
  let apiCallCount = 0;
  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "pr" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1] ?? "";
      return JSON.stringify(prsByAuthor[author] ?? []);
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + stale cleanup
      if (apiCallCount === 3) return ownClaim; // verification: sole claimant
      return "11"; // removeOwnClaimComment lookup → comment id
    }
    return "";
  };
  return { ghCommandFn, calls };
}

Deno.test(
  "fleet invariant - claim aborts when the THIRD fleet account opened a PR in the claim window (#3150 + #3138)",
  async () => {
    // Neither the host nor the allowed sibling has a PR; the fleet-only
    // sibling (fleet-worker) opened one between discovery and claim. The claim
    // must abort with cleanup — no second PR is created.
    const { ghCommandFn, calls } = makeClaimRecheckMockGh("worker-c1", {
      [HOST]: [],
      [SIBLING_ALLOWED]: [],
      [SIBLING_FLEET_ONLY]: [
        {
          number: 648,
          title: "Fix bug (#647)",
          baseRefName: "main",
          headRefName: "issue-647-fix-bug",
        },
      ],
    });

    const result = await claimIssue({
      repo: "owner/repo-a",
      issueNumber: 647,
      githubUser: HOST,
      workerId: "worker-c1",
      fleetAuthors: [HOST, SIBLING_ALLOWED, SIBLING_FLEET_ONLY],
      sleepFn: noSleep,
      ghCommandFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.claimed, false);
      assertEquals(result.value.reason, "fleet_pr_exists");
    }
    // Aborting mirrors the claim_race=lost cleanup: release the assignment and
    // delete this worker's claim comment — leaving no trace and no PR.
    assertEquals(
      calls.some((c) => c.join(" ").includes("--remove-assignee vibecoderbot")),
      true,
    );
    assertEquals(
      calls.some((c) => c.join(" ").includes("-X DELETE")),
      true,
    );
  },
);

// =============================================================================
// Mode C — branch reuse on retry (Layer 5) across the fleet.
// =============================================================================

Deno.test(
  "fleet invariant - a retry reuses the closed-unmerged PR on the deterministic branch instead of opening a fresh one (#3152)",
  async () => {
    // Branch names are deterministic, so a fleet retry lands on the same head
    // branch. A closed-UNMERGED PR there is eligible for reuse (reopen).
    const branch = createBranchName(647, "Fix bug");
    const mockGh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("pr list") && command.includes(branch)) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 648,
              title: "Fix bug (#647)",
              mergedAt: null,
              closedAt: isoSecondsAgo(7200),
            },
          ]),
        );
      }
      return Promise.resolve("[]");
    };

    const reuse = await findClosedUnmergedPrForBranch(
      "owner/repo-a",
      branch,
      mockGh,
    );
    assertEquals(reuse.ok, true);
    if (reuse.ok) assertStringIncludes(reuse.value, "/pull/648");
  },
);

Deno.test(
  "fleet invariant - a MERGED prior PR on the branch is never reused (#3152 + #3151)",
  async () => {
    // A merged PR is done for the fleet: reuse must be rejected so no reopen
    // is attempted (gh rejects reopening a merged PR, and Mode B keeps the
    // issue permanently locked anyway).
    const branch = createBranchName(647, "Fix bug");
    const mockGh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("pr list") && command.includes(branch)) {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 648,
              title: "Fix bug (#647)",
              mergedAt: isoSecondsAgo(7200),
              closedAt: isoSecondsAgo(7200),
            },
          ]),
        );
      }
      return Promise.resolve("[]");
    };

    // The raw fetch sees the PR but with a non-null mergedAt.
    const closed = await fetchClosedPRsByBranch(
      "owner/repo-a",
      branch,
      undefined,
      mockGh,
    );
    assertEquals(closed.length, 1);
    assertEquals(closed[0]?.mergedAt !== null, true);

    // Reuse must reject a merged-only branch.
    const reuse = await findClosedUnmergedPrForBranch(
      "owner/repo-a",
      branch,
      mockGh,
    );
    assertEquals(reuse.ok, false);
  },
);

// =============================================================================
// Fail-loud fleet-config validation (#3138) — the config that feeds every layer.
// =============================================================================

Deno.test(
  "fleet invariant - a sibling named only in fleet_pr_authors is covered, and is no longer a smell (#3138, Issue #1066)",
  () => {
    // The #3138 incident shape — a sibling in `fleet_pr_authors` but not in
    // `allowed_authors` — is now the *correct* shape: fleet identity lives in
    // `fleet_pr_authors` / `service_accounts`, and `allowed_authors` grants
    // nothing. The union still covers the sibling, so there is no blind spot;
    // what has gone is the warning, which would now fire on every healthy
    // start-up.
    const result = validateFleetConfig({
      githubUser: HOST,
      allowedAuthors: [HOST, "alice"],
      fleetPrAuthors: [SIBLING_FLEET_ONLY],
    });

    assertEquals(result.level, "ok", JSON.stringify(result.messages));
    assertEquals(result.messages, []);
    assertEquals(result.effectiveAuthors.includes(SIBLING_FLEET_ONLY), true);
  },
);

Deno.test(
  "fleet invariant - an empty effective fleet set is a hard error, not a warning (#3138)",
  () => {
    // With no host login and no authors the open-PR guard sees nothing — the
    // worst blind spot — so validation must escalate to error.
    const result = validateFleetConfig({
      githubUser: "",
      allowedAuthors: [],
      fleetPrAuthors: [],
    });
    assertEquals(result.level, "error");
    assertEquals(result.effectiveAuthors.length, 0);
  },
);
