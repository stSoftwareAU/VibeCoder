/**
 * A failing Dependabot upkeep action (e.g. `gh pr merge` refused by GitHub)
 * used to throw out of `pass()`, so no fleet PR was ever reviewed and every
 * later pass failed again on the same PR (Issue #2891). A failure is now
 * reported in `upkeep` and not retried at the same head commit.
 */
import { assertEquals } from "@std/assert";
import { pass } from "../../../.claude/skills/review-fleet-prs/gate.ts";

const REVIEWER = "nleck";

const commits = {
  nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
};

function dependabotPr(headRefOid = "dep-head") {
  return {
    number: 30,
    title: "chore: bump x",
    url: "https://github.com/acme/app/pull/30",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    headRefOid,
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
    },
    author: { login: "dependabot" },
    commits,
    reviews: {
      nodes: [{
        author: { login: REVIEWER },
        state: "APPROVED",
        body: "",
        commit: { oid: headRefOid },
      }],
    },
  };
}

function fleetPr() {
  return {
    number: 41,
    title: "feat: add widget",
    url: "https://github.com/acme/app/pull/41",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    headRefOid: "fleet-head",
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
    },
    author: { login: "VibeCoderST" },
    commits,
    reviews: { nodes: [] },
  };
}

function searchResult(depPr: ReturnType<typeof dependabotPr>) {
  return JSON.stringify({
    data: {
      search: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [depPr, fleetPr()],
      },
    },
  });
}

const FLEET = new Set(["VibeCoderST"]);
const REPOS = new Set(["acme/app"]);

// Records every call; `pr merge` throws the GitHub error the issue reports.
function makeGh(depPr: ReturnType<typeof dependabotPr>) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(searchResult(depPr));
    }
    if (args[0] === "pr" && args[1] === "merge") {
      throw new Error(
        "gh pr merge: GraphQL: Resource not accessible by integration " +
          "(mergePullRequest)\nsecond line",
      );
    }
    if (args[0] === "api" && args[1]?.includes("/files")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

Deno.test("a failing Dependabot auto-merge is reported and does not stop the pass", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const depPr = dependabotPr();
    const { gh } = makeGh(depPr);
    const result = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
    assertEquals(result.ready.length, 1);
    assertEquals(result.ready[0]!.number, 41);
    assertEquals(result.upkeep, [
      "acme/app#30 auto-merge failed: gh pr merge: GraphQL: " +
      "Resource not accessible by integration (mergePullRequest)",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed auto-merge is not retried at the same head, but is retried once the head changes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const depPr = dependabotPr();
    const { gh } = makeGh(depPr);
    await pass(REPOS, FLEET, REVIEWER, { gh, dir });

    const { gh: gh2, calls: calls2 } = makeGh(depPr);
    const second = await pass(REPOS, FLEET, REVIEWER, { gh: gh2, dir });
    assertEquals(
      calls2.some((c) => c[0] === "pr" && c[1] === "merge"),
      false,
    );
    assertEquals(second.upkeep, []);
    assertEquals(second.ready.length, 1);

    const newHeadPr = dependabotPr("dep-head-2");
    const { gh: gh3, calls: calls3 } = makeGh(newHeadPr);
    await pass(REPOS, FLEET, REVIEWER, { gh: gh3, dir });
    assertEquals(
      calls3.some((c) => c[0] === "pr" && c[1] === "merge"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
