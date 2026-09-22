/**
 * Tests for the discovery-side chain promotion wiring (Issue #2495).
 *
 * `applyChainPromotions` is the seam between the pure resolver
 * (Issue #2493) and `findOldestIssue`: it builds the resolver's snapshot
 * from the open-issue lists discovery already fetched, then moves each
 * promoted candidate into the blocked issue's tier. It performs no I/O,
 * so every branch is exercised here with in-memory fixtures.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  applyChainPromotions,
  type ChainPromotionRequest,
  type ChainPromotionTiers,
} from "../lib/apply_chain_promotions.ts";
import type { IssueCandidate } from "../lib/issue_priority.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const REPO_A = "owner/repo-a";
const REPO_B = "owner/repo-b";

function candidate(
  repo: string,
  number: number,
  source: IssueCandidate["source"],
): IssueCandidate {
  return {
    repo,
    number,
    url: `https://github.com/${repo}/issues/${number}`,
    title: `Issue ${number}`,
    milestone: "",
    createdAt: "2024-01-01T00:00:00Z",
    labelIndex: source === "configured-label" ? 0 : 200,
    source,
  };
}

function issue(
  number: number,
  overrides: Partial<FilterableIssue> = {},
): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: "",
    author: "alice",
    assignees: [],
    labels: ["low-priority"],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: "",
    ...overrides,
  };
}

function tiers(
  overrides: Partial<ChainPromotionTiers> = {},
): ChainPromotionTiers {
  return {
    labelCandidates: [],
    workOnCandidates: [],
    lowPriorityCandidates: [],
    idleTaskCandidates: [],
    ...overrides,
  };
}

function request(
  overrides: Partial<ChainPromotionRequest> = {},
): ChainPromotionRequest {
  return {
    blocked: [],
    issuesByRepo: new Map(),
    monitoredRepos: [REPO_A, REPO_B],
    discoveryLabels: ["top-priority", "work-on", "low-priority", "idle-task"],
    needsHumanLabel: "needs-human",
    fleetAuthors: ["vibe-bot"],
    ...overrides,
  };
}

Deno.test("applyChainPromotions - lifts a low-priority root into the blocked issue's tier", () => {
  const root = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([[REPO_A, [
        issue(100, {
          labels: ["top-priority"],
          body: "Depends on #200",
        }),
        issue(200),
      ]]]),
    }),
  );

  assertEquals(outcome.lowPriorityCandidates, []);
  assertEquals(outcome.labelCandidates.length, 1);
  const promoted = outcome.labelCandidates[0]!;
  assertEquals(promoted.number, 200);
  // The candidate keeps its own source and labels — only its rank changes.
  assertEquals(promoted.source, "low-priority");
  assertEquals(promoted.promotedBy, { repo: REPO_A, number: 100 });
  assertEquals(outcome.promotions.length, 1);
  assertEquals(outcome.promotions[0]!.promotedBy, {
    repo: REPO_A,
    number: 100,
  });
  assertEquals(outcome.unworkableRoots, []);
});

Deno.test("applyChainPromotions - a work-on blocked candidate lifts its root to the work-on tier", () => {
  const root = candidate(REPO_A, 200, "idle-task");
  const outcome = applyChainPromotions(
    tiers({ idleTaskCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "work-on",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["work-on"], body: "Depends on #200" }),
        issue(200, { labels: ["idle-task"] }),
      ]]]),
    }),
  );

  assertEquals(outcome.idleTaskCandidates, []);
  assertEquals(outcome.labelCandidates, []);
  assertEquals(outcome.workOnCandidates.map((c) => c.number), [200]);
});

Deno.test("applyChainPromotions - promotes a dependency in another monitored repo", () => {
  const root = candidate(REPO_B, 500, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_B, number: 500, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([
        [REPO_A, [issue(100, {
          labels: ["top-priority"],
          body: `Depends on ${REPO_B}#500`,
        })]],
        [REPO_B, [issue(500)]],
      ]),
    }),
  );

  assertEquals(outcome.labelCandidates.map((c) => c.repo), [REPO_B]);
  assertEquals(outcome.labelCandidates[0]!.number, 500);
});

Deno.test("applyChainPromotions - a dependency that is itself still blocked is not promoted", () => {
  const middle = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [middle] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["top-priority"], body: "Depends on #200" }),
        issue(200, { body: "Depends on #300" }),
        // #300 carries no discovery label, so the chain ends unworkable.
        issue(300, { labels: [] }),
      ]]]),
    }),
  );

  assertEquals(outcome.promotions, []);
  assertEquals(outcome.lowPriorityCandidates.map((c) => c.number), [200]);
  assertEquals(outcome.labelCandidates, []);
  assertEquals(outcome.unworkableRoots.length, 1);
  assertEquals(outcome.unworkableRoots[0]!.reason, "no-discovery-label");
  assertEquals(outcome.unworkableRoots[0]!.root, { repo: REPO_A, number: 300 });
});

Deno.test("applyChainPromotions - a closed dependency reference does not make a root look blocked", () => {
  const root = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      // #999 is absent from the open-issue list, so it is already closed.
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["top-priority"], body: "Depends on #200" }),
        issue(200, { body: "Depends on #999" }),
      ]]]),
    }),
  );

  assertEquals(outcome.labelCandidates.map((c) => c.number), [200]);
});

Deno.test("applyChainPromotions - a promoted root that is not a candidate anywhere is left alone", () => {
  const outcome = applyChainPromotions(
    tiers(),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["top-priority"], body: "Depends on #200" }),
        issue(200),
      ]]]),
    }),
  );

  assertEquals(outcome.promotions, []);
  assertEquals(outcome.labelCandidates, []);
});

Deno.test("applyChainPromotions - a fleet-assigned root is reported, never promoted", () => {
  const root = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["top-priority"], body: "Depends on #200" }),
        issue(200, { assignees: ["vibe-bot"] }),
      ]]]),
    }),
  );

  assertEquals(outcome.promotions, []);
  assertEquals(outcome.lowPriorityCandidates.map((c) => c.number), [200]);
  assertEquals(outcome.fleetWorking.length, 1);
  assertEquals(outcome.fleetWorking[0]!.assignee, "vibe-bot");
});

Deno.test("applyChainPromotions - nothing blocked leaves every tier untouched", () => {
  const low = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [low] }),
    request({
      issuesByRepo: new Map([[REPO_A, [issue(200)]]]),
    }),
  );

  assertEquals(outcome.lowPriorityCandidates, [low]);
  assertEquals(outcome.labelCandidates, []);
  assertEquals(outcome.promotions, []);
  assertEquals(outcome.unworkableRoots, []);
});

Deno.test("applyChainPromotions - a dependency in a repo the scan could not read is kept as a blocker", () => {
  const root = candidate(REPO_A, 200, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        blockers: [{ repo: REPO_A, number: 200, kind: "depends-on" }],
      }],
      // No open-issue list was fetched for owner/repo-b, so #7 cannot be
      // read — and an unreadable dependency is never assumed closed.
      issuesByRepo: new Map([[REPO_A, [
        issue(100, { labels: ["top-priority"], body: "Depends on #200" }),
        issue(200, { body: `Depends on ${REPO_B}#7` }),
      ]]]),
    }),
  );

  assertEquals(outcome.promotions, []);
  assertEquals(outcome.lowPriorityCandidates.map((c) => c.number), [200]);
});

Deno.test("applyChainPromotions - a differently-cased repo reference still finds its snapshot", () => {
  const root = candidate(REPO_B, 500, "low-priority");
  const outcome = applyChainPromotions(
    tiers({ lowPriorityCandidates: [root] }),
    request({
      blocked: [{
        repo: REPO_A,
        number: 100,
        tier: "configured-label",
        // GitHub renders the same repo either way; the snapshot is keyed
        // on the monitored spelling, so the reference must be matched to it.
        blockers: [{ repo: "Owner/Repo-B", number: 500, kind: "depends-on" }],
      }],
      issuesByRepo: new Map([
        [REPO_A, [issue(100, {
          labels: ["top-priority"],
          body: "Depends on Owner/Repo-B#500",
        })]],
        [REPO_B, [issue(500)]],
      ]),
    }),
  );

  assertEquals(outcome.labelCandidates.map((c) => c.number), [500]);
  assertEquals(outcome.lowPriorityCandidates, []);
});
