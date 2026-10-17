/**
 * Issue #3571: the idle-decision census counted a `top-priority` issue as
 * claimable although the claim scan refused it with `label-author-not-allowed`
 * — its priority label had been added by an untrusted actor such as
 * `github-actions[bot]`. The false claimable count raised a false
 * `inversion_signal=true`.
 *
 * The census is synchronous, so the caller precomputes the refused issue
 * numbers as `untrustedLabelIssues`. Those issues must be counted as
 * `claim_refused`, never as claimable, and they must not suppress the lower
 * tiers either, because the claim scan drops them before any tier-suppression
 * rule runs.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  type RepoCensusInput,
} from "../lib/idle_decision_census.ts";

function issue(number: number, labels: string[], milestone = ""): CensusIssue {
  return { number, labels, assignees: [], milestone };
}

function openPR(
  number: number,
  baseRefName: string,
  headRefName: string,
) {
  return { number, title: `PR ${number}`, baseRefName, headRefName };
}

function repoInput(
  partial: Partial<RepoCensusInput> & { repo: string },
): RepoCensusInput {
  return {
    monitored: true,
    scannedThisCycle: true,
    nice: 0,
    issues: [],
    // Issue #2663: cap 1 matches the other census tests; the PR-blocking
    // test below widens it, exactly as `#2922` does.
    fleetPrSlots: 1,
    ...partial,
  };
}

Deno.test("census - a top-priority issue the label-author gate refuses is claim_refused, not claimable (Issue #3571)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["top-priority"])],
        untrustedLabelIssues: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.topPriority, 0);
  assertEquals(entry.claimRefused, 1);
  assertEquals(entry.claimableIssues, []);
  assert(!entry.inversionSignal, "a refused label is not an inversion");
  assertEquals(census.escalationRepos, []);
});

Deno.test("census - the same top-priority issue without the untrusted set is claimable (Issue #3571 positive control)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["top-priority"])],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.topPriority, 1);
  assertEquals(entry.claimRefused, 0);
  assertEquals(entry.claimableIssues, [1]);
  assert(entry.inversionSignal);
});

Deno.test("census - an untrusted top-priority issue does not suppress a work-on issue in its stream (Issue #3571)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ-AutoTrader",
        issues: [
          issue(1, ["top-priority"]),
          issue(2, ["work-on"]),
          issue(3, ["work-on"]),
        ],
        // Issue #1's own PR would otherwise PR-block it and suppress the
        // `work-on` candidates sharing its stream (Issue #2922).
        openPRs: [openPR(100, "Develop", "issue-1-fix")],
        fleetPrSlots: 5,
        untrustedLabelIssues: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.topPriority, 0);
  assertEquals(entry.claimRefused, 1);
  assertEquals(entry.prBlocked, 0);
  assertEquals(entry.workOnSuppressed, 0);
  assertEquals(entry.unblocked.workOn, 2);
  assertEquals(entry.claimableIssues, [2, 3]);
});

Deno.test("census - control: the PR-blocked top-priority issue suppresses its work-on stream when it is trusted (Issue #3571)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ-AutoTrader",
        issues: [
          issue(1, ["top-priority"]),
          issue(2, ["work-on"]),
          issue(3, ["work-on"]),
        ],
        openPRs: [openPR(100, "Develop", "issue-1-fix")],
        fleetPrSlots: 5,
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.prBlocked, 1);
  assertEquals(entry.workOnSuppressed, 2);
  assertEquals(entry.unblocked.workOn, 0);
});

Deno.test("census - an untrusted work-on issue does not suppress the low-priority backlog (Issue #3571)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["low-priority"])],
        untrustedLabelIssues: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.claimRefused, 1);
  assertEquals(entry.lowPrioritySuppressed, 0);
  assertEquals(entry.unblocked.lowPriority, 1);
  assertEquals(entry.claimableIssues, [2]);
  assert(entry.inversionSignal);
});

Deno.test("census - control: the same trusted work-on issue suppresses the low-priority backlog (Issue #3571)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["low-priority"])],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.lowPrioritySuppressed, 1);
  assertEquals(entry.unblocked.lowPriority, 0);
});
