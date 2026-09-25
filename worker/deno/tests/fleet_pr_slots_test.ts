/**
 * One fleet PR per slot (Issue #2663).
 *
 * The owner's rule (2026-09-26): "There should be one PR per slot by the
 * fleet (not other humans). Multiple milestones means multiple PRs."
 *
 * Before this, `getBlockingPRForIssue` held every non-milestone issue while
 * **any** fleet PR was open on the repo's default-branch stream — one fleet PR
 * at a time per repo, fleet-wide. GRQ-AutoTrader's 13 `work-on` issues waited
 * three hours behind PR #1309. These tests pin the per-slot rule in both
 * directions, and the census/scan agreement the #460 / #2563 invariant needs.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_FLEET_PR_SLOTS,
  getBlockingPRForIssue,
  type OpenPR,
  resolveFleetPrSlots,
} from "../lib/issue_query.ts";
import {
  resolveEffectiveFleetPrAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "../lib/fleet_authors.ts";
import {
  buildIdleDecisionCensus,
  type RepoCensusInput,
} from "../lib/idle_decision_census.ts";
import {
  buildHeldIssueGateComment,
  heldIssueGateFor,
} from "../lib/held_issue_gate_comment.ts";

const HOST = "stservice";
const SIBLING = "VibeCoderST";

/**
 * The gate's fleet set on a host whose config names `stservice` under
 * `service_accounts` only and `VibeCoderST` under `fleet_pr_authors` only —
 * `loadConfig` unions the two keys, so both count.
 */
const FLEET = resolveFleetMaintenanceAuthorSet({
  githubUser: HOST,
  fleetPrAuthors: resolveEffectiveFleetPrAuthors([SIBLING], [HOST]),
});

/** An open PR on the default branch by `author`. */
function defaultPr(number: number, author: string): OpenPR {
  return {
    number,
    title: `PR ${number}`,
    baseRefName: "main",
    headRefName: `issue-${number}`,
    author,
  };
}

/** `n` fleet PRs on the default branch, alternating the two fleet accounts. */
function fleetPrs(n: number): OpenPR[] {
  return Array.from(
    { length: n },
    (_, i) => defaultPr(100 + i, i % 2 === 0 ? HOST : SIBLING),
  );
}

Deno.test("fleet PR slots - below the cap a non-milestone issue is claimable", () => {
  assertEquals(getBlockingPRForIssue(fleetPrs(2), "", FLEET, 3), null);
  assertEquals(getBlockingPRForIssue(fleetPrs(1), "", FLEET, 6), null);
});

Deno.test("fleet PR slots - at the cap a non-milestone issue is held, naming the count", () => {
  const held = getBlockingPRForIssue(fleetPrs(3), "", FLEET, 3);
  assert(held !== null);
  assertEquals(held.fleetPrCap, { open: 3, cap: 3 });
  // Above the cap (a slot shrank, or a human override) still holds.
  assertEquals(
    getBlockingPRForIssue(fleetPrs(5), "", FLEET, 3)?.fleetPrCap,
    { open: 5, cap: 3 },
  );
});

Deno.test("fleet PR slots - a human PR never counts towards the cap", () => {
  const prs = [...fleetPrs(2), defaultPr(900, "nleck"), defaultPr(901, "bob")];
  // Two fleet PRs, two human PRs, cap 3: claimable.
  assertEquals(getBlockingPRForIssue(prs, "", FLEET, 3), null);
  // Human PRs alone never hold, even at cap 1.
  assertEquals(
    getBlockingPRForIssue([defaultPr(902, "nleck")], "", FLEET, 1),
    null,
  );
});

Deno.test("fleet PR slots - a PR by either fleet account counts", () => {
  // Only the sibling's PRs are open: they are the fleet's, so they hold.
  const siblingOnly = [defaultPr(1, SIBLING), defaultPr(2, SIBLING)];
  assertEquals(
    getBlockingPRForIssue(siblingOnly, "", FLEET, 2)?.fleetPrCap,
    { open: 2, cap: 2 },
  );
  // And the host account's PRs, the account listed only in service_accounts.
  const hostOnly = [defaultPr(3, HOST), defaultPr(4, "STSERVICE")];
  assertEquals(
    getBlockingPRForIssue(hostOnly, "", FLEET, 2)?.fleetPrCap,
    { open: 2, cap: 2 },
  );
});

Deno.test("fleet PR slots - milestone PRs do not count towards the default-branch cap", () => {
  const prs: OpenPR[] = [
    defaultPr(1, HOST),
    { ...defaultPr(2, HOST), baseRefName: "milestone/oidc" },
    { ...defaultPr(3, SIBLING), headRefName: "milestone/oidc" },
    { ...defaultPr(4, SIBLING), headRefName: "merge-milestone-oidc" },
  ];
  assertEquals(getBlockingPRForIssue(prs, "", FLEET, 2), null);
});

Deno.test("fleet PR slots - milestone issues keep one PR per milestone branch", () => {
  const onMilestone: OpenPR = {
    ...defaultPr(7, SIBLING),
    baseRefName: "milestone/oidc",
  };
  // One PR on the milestone branch holds the milestone issue whatever the cap.
  const held = getBlockingPRForIssue([onMilestone], "OIDC", FLEET, 8);
  assertEquals(held?.number, 7);
  assertEquals(held?.fleetPrCap, undefined);
  // A full default-branch stream never holds a milestone issue.
  assertEquals(getBlockingPRForIssue(fleetPrs(8), "OIDC", FLEET, 1), null);
});

Deno.test("fleet PR slots - the listing author counts when no fetch login was stamped", () => {
  // `fetchAllOpenPRs` rows carry `authorLogin`, not `author`: the census and
  // the idle audit read that listing, so it must classify the same way.
  const listed = [
    { ...defaultPr(1, ""), author: undefined, authorLogin: SIBLING },
    { ...defaultPr(2, ""), author: undefined, authorLogin: "nleck" },
  ];
  assertEquals(getBlockingPRForIssue(listed, "", FLEET, 2), null);
  assertEquals(
    getBlockingPRForIssue(listed, "", FLEET, 1)?.fleetPrCap,
    { open: 1, cap: 1 },
  );
});

Deno.test("fleet PR slots - an unusable cap falls back to the default", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assertEquals(
      getBlockingPRForIssue(
        fleetPrs(DEFAULT_FLEET_PR_SLOTS - 1),
        "",
        FLEET,
        bad,
      ),
      null,
    );
    assertEquals(
      getBlockingPRForIssue(fleetPrs(DEFAULT_FLEET_PR_SLOTS), "", FLEET, bad)
        ?.fleetPrCap?.cap,
      DEFAULT_FLEET_PR_SLOTS,
    );
  }
});

Deno.test("fleet PR slots - resolveFleetPrSlots: default, global, per-repo override", () => {
  assertEquals(resolveFleetPrSlots({}, "o/r"), DEFAULT_FLEET_PR_SLOTS);
  assertEquals(resolveFleetPrSlots({ fleetPrSlots: 4 }, "o/r"), 4);
  assertEquals(
    resolveFleetPrSlots(
      { fleetPrSlots: 4, repoConfig: { "o/r": { fleetPrSlots: 2 } } },
      "o/r",
    ),
    2,
  );
  // Another repo keeps the global value.
  assertEquals(
    resolveFleetPrSlots(
      { fleetPrSlots: 4, repoConfig: { "o/r": { fleetPrSlots: 2 } } },
      "o/other",
    ),
    4,
  );
  // Invalid values fall back rather than disabling the gate.
  assertEquals(resolveFleetPrSlots({ fleetPrSlots: 0 }, "o/r"), 8);
  assertEquals(
    resolveFleetPrSlots(
      { fleetPrSlots: 4, repoConfig: { "o/r": { fleetPrSlots: -3 } } },
      "o/r",
    ),
    4,
  );
});

// ---------------------------------------------------------------------------
// The census counts the gate the scan applies (#460 / #2563 invariant)
// ---------------------------------------------------------------------------

function censusPrBlocked(
  openPRs: OpenPR[],
  fleetPrSlots: number,
): number {
  const input: RepoCensusInput = {
    repo: "stSoftwareAU/GRQ-AutoTrader",
    monitored: true,
    scannedThisCycle: true,
    nice: 0,
    issues: [{ number: 1, labels: ["work-on"], assignees: [], milestone: "" }],
    openPRs,
    fleetPrSlots,
  };
  return buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: HOST,
    repos: [input],
    pushCapableAuthors: FLEET,
  }).perRepo[0]!.prBlocked;
}

Deno.test("fleet PR slots - census and scan agree in both directions", () => {
  // The census reads `fetchAllOpenPRs`, whose rows carry `authorLogin`.
  const listing = (prs: OpenPR[]) =>
    prs.map((pr) => ({ ...pr, author: undefined, authorLogin: pr.author }));
  const cases: { prs: OpenPR[]; cap: number }[] = [
    { prs: fleetPrs(2), cap: 3 },
    { prs: fleetPrs(3), cap: 3 },
    { prs: [...fleetPrs(2), defaultPr(900, "nleck")], cap: 3 },
    { prs: [defaultPr(900, "nleck")], cap: 1 },
    { prs: [defaultPr(1, SIBLING)], cap: 1 },
  ];
  for (const { prs, cap } of cases) {
    const scanHolds = getBlockingPRForIssue(prs, "", FLEET, cap) !== null;
    assertEquals(
      censusPrBlocked(listing(prs), cap) === 1,
      scanHolds,
      `census disagreed with the scan for ${prs.length} PRs at cap ${cap}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The held-issue gate comment states the count against the cap
// ---------------------------------------------------------------------------

Deno.test("fleet PR slots - the gate comment names the count against the cap", () => {
  const gate = heldIssueGateFor(
    {
      repo: "o/r",
      issueNumber: 5,
      milestone: "",
      reason: "pr-blocked",
      blockingPr: 100,
      fleetPrCap: { open: 6, cap: 6 },
    },
    undefined,
    false,
  );
  assert(gate !== null);
  const { body, key } = buildHeldIssueGateComment(gate);
  assertStringIncludes(
    body,
    "6 fleet PRs are open on this repo's default branch (cap 6)",
  );
  assert(!body.includes("PR #100"), "must not name one PR as the blocker");
  // A different count is a different gate, so the comment is edited.
  const other = heldIssueGateFor(
    {
      repo: "o/r",
      issueNumber: 5,
      milestone: "",
      reason: "pr-blocked",
      blockingPr: 100,
      fleetPrCap: { open: 7, cap: 6 },
    },
    undefined,
    false,
  );
  assert(other !== null);
  assert(buildHeldIssueGateComment(other).key !== key);
});

Deno.test("fleet PR slots - a milestone PR hold still names the PR", () => {
  const gate = heldIssueGateFor(
    {
      repo: "o/r",
      issueNumber: 5,
      milestone: "OIDC",
      reason: "pr-blocked",
      blockingPr: 7,
    },
    undefined,
    false,
  );
  assert(gate !== null);
  assertStringIncludes(buildHeldIssueGateComment(gate).body, "PR #7");
});
