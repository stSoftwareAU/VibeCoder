/**
 * Dependabot upkeep of the review-fleet-prs skill: rebase a PR that is
 * behind or conflicting (once per head), arm auto-merge once approved.
 */
import { assertEquals } from "@std/assert";
import { dependabotAction } from "../../../.claude/skills/review-fleet-prs/scripts/dependabot.ts";
import type { SearchPr } from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const pr = (over: Partial<SearchPr> = {}): SearchPr => ({
  number: 30,
  title: "chore: bump x",
  url: "https://github.com/o/r/pull/30",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  headRefOid: "head",
  baseRefName: "Develop",
  repository: {
    nameWithOwner: "o/r",
    defaultBranchRef: { name: "Develop" },
    autoMergeAllowed: true,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  },
  author: { login: "app/dependabot" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] },
  ...over,
});

const approved = {
  nodes: [{
    author: { login: "nleck" },
    state: "APPROVED",
    body: "",
    commit: { oid: "head" },
  }],
};

Deno.test("a Dependabot PR behind or conflicting gets one rebase request per head", () => {
  assertEquals(
    dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", undefined)
      .kind,
    "rebase",
  );
  assertEquals(
    dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck", "older").kind,
    "rebase",
  );
  assertEquals(
    dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", "head").kind,
    "none",
  );
});

Deno.test("an approved, up-to-date Dependabot PR gets auto-merge armed with the repo's allowed method", () => {
  assertEquals(
    dependabotAction(pr({ reviews: approved }), "nleck", undefined),
    { kind: "auto-merge", method: "squash" },
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, squashMergeAllowed: false },
      }),
      "nleck",
      undefined,
    ),
    { kind: "auto-merge", method: "merge" },
  );
});

Deno.test("no auto-merge without the reviewer's approval at the head, when already armed, or when the repo forbids it", () => {
  assertEquals(dependabotAction(pr(), "nleck", undefined).kind, "none");
  const stale = {
    nodes: [{ ...approved.nodes[0]!, commit: { oid: "older" } }],
  };
  assertEquals(
    dependabotAction(pr({ reviews: stale }), "nleck", undefined).kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }),
      "nleck",
      undefined,
    ).kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, autoMergeAllowed: false },
      }),
      "nleck",
      undefined,
    ).kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({ isDraft: true, mergeStateStatus: "BEHIND" }),
      "nleck",
      undefined,
    ).kind,
    "none",
  );
});
