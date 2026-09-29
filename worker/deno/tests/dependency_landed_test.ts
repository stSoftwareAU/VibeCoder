/**
 * Tests for the dependency-landed lookup behind the cross-milestone hold
 * release (Issue #2834).
 *
 * A fake `gh` models just enough of GitHub — the default-branch lookup, the
 * issue's closing-PR GraphQL query, the compare endpoint, and `pr list` for
 * merged partial rollups — to drive `createDependencyLandedLookup` through
 * every landing path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { createDependencyLandedLookup } from "../lib/dependency_landed.ts";
import { partialRollupMarker } from "../lib/milestone_partial_rollup.ts";

const REPO = "owner/repo";
const SHA1 = "1111111111111111111111111111111111111a";
const SHA2 = "2222222222222222222222222222222222222b";

interface FakeIssue {
  milestone?: string;
  nodes: Array<
    { merged?: boolean; mergeCommit?: { oid?: string | null } | null }
  >;
}

interface FakeRollupPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  body: string;
  author: { login: string };
}

/** A fake `gh` covering the default-branch, GraphQL, compare and pr-list calls. */
class FakeGh {
  calls: string[][] = [];
  defaultBranch = "main";
  branchFetches = 0;
  throwOnGraphQL = false;
  issues = new Map<number, FakeIssue>();
  /** sha → compare status ("behind" | "identical" | "ahead" | "diverged"). */
  compareStatus = new Map<string, string>();
  rollupPrs: FakeRollupPr[] = [];

  gh = (args: string[]): Promise<string> => {
    this.calls.push(args);
    if (
      args[0] === "api" && args[1] === `repos/${REPO}` &&
      args.includes("--jq")
    ) {
      this.branchFetches++;
      return Promise.resolve(`${this.defaultBranch}\n`);
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (this.throwOnGraphQL) return Promise.reject(new Error("boom"));
      const numberArg = args.find((a) => a.startsWith("number="));
      const number = Number(numberArg?.slice("number=".length));
      const issue = this.issues.get(number);
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              milestone: issue?.milestone ? { title: issue.milestone } : null,
              closedByPullRequestsReferences: { nodes: issue?.nodes ?? [] },
            },
          },
        },
      }));
    }
    if (args[0] === "api" && (args[1] ?? "").includes("/compare/")) {
      const sha = (args[1] ?? "").split("...")[1] ?? "";
      const status = this.compareStatus.get(sha) ?? "diverged";
      return Promise.resolve(`${status}\n`);
    }
    if (args[0] === "pr" && args[1] === "list") {
      const state = args[args.indexOf("--state") + 1];
      const hits = state === "merged" ? this.rollupPrs : [];
      return Promise.resolve(JSON.stringify(hits));
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}

Deno.test("landed via a closing PR merge commit already behind the default branch", async () => {
  const gh = new FakeGh();
  gh.issues.set(10, { nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }] });
  gh.compareStatus.set(SHA1, "behind");
  const logs: string[] = [];
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh, {
    log: (m) => logs.push(m),
  });
  assertEquals(await lookup(10), true);
  assertEquals(logs, []);
});

Deno.test("landed via a closing PR merge commit identical to the default branch", async () => {
  const gh = new FakeGh();
  gh.issues.set(20, { nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }] });
  gh.compareStatus.set(SHA1, "identical");
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh);
  assertEquals(await lookup(20), true);
});

Deno.test("landed via a merged partial-rollup head when the closing PR itself has not reached default", async () => {
  const gh = new FakeGh();
  gh.issues.set(30, {
    milestone: "Foundation",
    nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }],
  });
  // The closing PR's own merge commit has diverged — not itself landed.
  gh.compareStatus.set(SHA1, "diverged");
  gh.rollupPrs.push({
    number: 900,
    headRefName: "partial-rollup/foundation-abc1234",
    headRefOid: SHA2,
    body: partialRollupMarker("Foundation"),
    author: { login: "bot" },
  });
  gh.compareStatus.set(SHA2, "behind");
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh, {
    rollupLookup: { authorOptions: { fleetAuthors: ["bot"] }, log: () => {} },
  });
  assertEquals(await lookup(30), true);
});

Deno.test("not landed — every signal diverged or ahead of default", async () => {
  const gh = new FakeGh();
  gh.issues.set(40, { nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }] });
  gh.compareStatus.set(SHA1, "ahead");
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh);
  assertEquals(await lookup(40), false);
});

Deno.test("a gh failure fails safe — not landed, and the failure is logged", async () => {
  const gh = new FakeGh();
  gh.throwOnGraphQL = true;
  const logs: string[] = [];
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh, {
    log: (m) => logs.push(m),
  });
  assertEquals(await lookup(50), false);
  assertEquals(logs.length, 1);
});

Deno.test("an unmerged closing PR or a missing merge commit is not treated as landed", async () => {
  const gh = new FakeGh();
  gh.issues.set(60, {
    nodes: [
      { merged: false, mergeCommit: { oid: SHA1 } },
      { merged: true, mergeCommit: null },
    ],
  });
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh);
  assertEquals(await lookup(60), false);
  // Neither node yields a usable SHA, so no ancestry check is ever issued.
  assertEquals(gh.calls.some((a) => (a[1] ?? "").includes("/compare/")), false);
});

Deno.test("results are memoised — the second lookup issues no further gh calls", async () => {
  const gh = new FakeGh();
  gh.issues.set(70, { nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }] });
  gh.compareStatus.set(SHA1, "behind");
  const lookup = createDependencyLandedLookup(REPO, gh.defaultBranch, gh.gh);
  assertEquals(await lookup(70), true);
  const callsAfterFirst = gh.calls.length;
  assertEquals(await lookup(70), true);
  assertEquals(gh.calls.length, callsAfterFirst);
});

Deno.test("a lazily resolved default branch is fetched once across two issues", async () => {
  const gh = new FakeGh();
  gh.issues.set(80, { nodes: [{ merged: true, mergeCommit: { oid: SHA1 } }] });
  gh.compareStatus.set(SHA1, "behind");
  gh.issues.set(81, { nodes: [{ merged: true, mergeCommit: { oid: SHA2 } }] });
  gh.compareStatus.set(SHA2, "identical");
  const lookup = createDependencyLandedLookup(REPO, undefined, gh.gh);
  assertEquals(await lookup(80), true);
  assertEquals(await lookup(81), true);
  assertEquals(gh.branchFetches, 1);
});
