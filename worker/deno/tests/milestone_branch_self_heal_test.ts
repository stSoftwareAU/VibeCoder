/**
 * Tests for the milestone branch self-heal pass (Issue #3912).
 *
 * A milestone can gain open children after its branch has been merged and
 * deleted. The self-heal pass recreates the branch and rescues open child
 * PRs still based on the default branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { Result } from "../types.ts";
import {
  MILESTONE_RETARGET_MARKER,
  type MilestoneSelfHealDeps,
  renderRetargetComment,
  selfHealMilestoneBranches,
} from "../lib/milestone_branch_self_heal.ts";

// ---------------------------------------------------------------------------
// Stub harness
// ---------------------------------------------------------------------------

interface StubMilestone {
  number: number;
  title: string;
  state?: string;
  openIssues: number;
  /** Open children returned by the issues endpoint. */
  children: { number: number; title: string; isPullRequest?: boolean }[];
}

interface StubPr {
  number: number;
  baseRefName: string;
  milestoneTitle?: string;
  closingIssues?: number[];
  /** Existing comment bodies (used for the retarget marker guard). */
  comments?: string[];
  /** Head branch; defaults to an issue branch. */
  headRefName?: string;
}

interface StubWorld {
  milestones: StubMilestone[];
  /** Branch names that exist on the remote. */
  branches: Set<string>;
  prs: StubPr[];
  /** Endpoints that should throw when called. */
  failing?: (args: string[]) => boolean;
}

interface StubHarness {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
  ensureCalls: { repo: string; branch: string; defaultBranch: string }[];
  comments: { pr: number; body: string }[];
  logs: string[];
  deps: MilestoneSelfHealDeps;
}

const REPO = "owner/repo";

function makeHarness(
  world: StubWorld,
  ensureResult: (branch: string) => Result<string> = (branch) => ({
    ok: true,
    value: `created ${branch}`,
  }),
): StubHarness {
  const calls: string[][] = [];
  const ensureCalls: { repo: string; branch: string; defaultBranch: string }[] =
    [];
  const comments: { pr: number; body: string }[] = [];
  const logs: string[] = [];

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const key = args.join(" ");

    if (world.failing?.(args)) {
      return Promise.reject(new Error(`stub failure for: ${key}`));
    }

    // Open milestone listing
    if (key.includes(`repos/${REPO}/milestones?`)) {
      return Promise.resolve(JSON.stringify(
        world.milestones.map((m) => ({
          number: m.number,
          title: m.title,
          state: m.state ?? "open",
        })),
      ));
    }

    // Single milestone (authoritative open_issues)
    const milestoneMatch = key.match(
      new RegExp(`repos/${REPO}/milestones/(\\d+)$`),
    );
    if (milestoneMatch) {
      const milestone = world.milestones.find(
        (m) => m.number === Number(milestoneMatch[1]),
      );
      return Promise.resolve(
        JSON.stringify({ open_issues: milestone?.openIssues ?? 0 }),
      );
    }

    // Open children of a milestone
    const childMatch = key.match(
      new RegExp(`repos/${REPO}/issues\\?milestone=(\\d+)`),
    );
    if (childMatch) {
      const milestone = world.milestones.find(
        (m) => m.number === Number(childMatch[1]),
      );
      return Promise.resolve(JSON.stringify(
        (milestone?.children ?? []).map((c) => ({
          number: c.number,
          title: c.title,
          ...(c.isPullRequest ? { pull_request: { url: "x" } } : {}),
        })),
      ));
    }

    // Branch existence
    const branchMatch = key.match(new RegExp(`repos/${REPO}/branches/(\\S+)`));
    if (branchMatch) {
      const branch = branchMatch[1]!;
      if (!world.branches.has(branch)) {
        return Promise.reject(new Error("HTTP 404: Branch not found"));
      }
      return Promise.resolve(branch);
    }

    // Open PR listing
    if (key.startsWith("pr list")) {
      return Promise.resolve(JSON.stringify(
        world.prs.map((pr) => ({
          number: pr.number,
          baseRefName: pr.baseRefName,
          headRefName: pr.headRefName ?? `issue-${pr.number}-x`,
          milestone: pr.milestoneTitle ? { title: pr.milestoneTitle } : null,
          closingIssuesReferences: (pr.closingIssues ?? []).map((n) => ({
            number: n,
          })),
        })),
      ));
    }

    // PR comment bodies (marker guard)
    const commentsMatch = key.match(
      new RegExp(`repos/${REPO}/issues/(\\d+)/comments`),
    );
    if (commentsMatch) {
      const pr = world.prs.find((p) => p.number === Number(commentsMatch[1]));
      return Promise.resolve((pr?.comments ?? []).join("\n"));
    }

    // retargetPrToMilestone: current base lookup
    if (key.startsWith("pr view")) {
      const pr = world.prs.find((p) => p.number === Number(args[2]));
      return Promise.resolve(pr?.baseRefName ?? "");
    }

    // retargetPrToMilestone: the edit itself
    if (key.startsWith("pr edit")) {
      const pr = world.prs.find((p) => p.number === Number(args[2]));
      if (pr) pr.baseRefName = args[args.indexOf("--base") + 1]!;
      return Promise.resolve("");
    }

    // Explanatory comment
    if (key.startsWith("pr comment")) {
      const number = Number(args[2]);
      const body = args[args.indexOf("--body") + 1]!;
      comments.push({ pr: number, body });
      const pr = world.prs.find((p) => p.number === number);
      if (pr) pr.comments = [...(pr.comments ?? []), body];
      return Promise.resolve("");
    }

    return Promise.resolve("");
  };

  const deps: MilestoneSelfHealDeps = {
    repos: [REPO],
    ghCommandFn,
    defaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
    ensureBranchFn: (repo, branch, defaultBranch) => {
      ensureCalls.push({ repo, branch, defaultBranch });
      const result = ensureResult(branch);
      if (result.ok) world.branches.add(branch);
      return Promise.resolve(result);
    },
    log: (message: string) => logs.push(message),
  };

  return { ghCommandFn, calls, ensureCalls, comments, logs, deps };
}

/** A milestone whose branch was deleted while nine children stayed open. */
function milestone53(): StubMilestone {
  return {
    number: 53,
    title: "Milestone 3872 overflow",
    openIssues: 9,
    children: [
      { number: 3868, title: "Child one" },
      { number: 3869, title: "Child two" },
    ],
  };
}

const MILESTONE_53_BRANCH = "milestone/milestone-3872-overflow";

// ---------------------------------------------------------------------------
// Branch recreation
// ---------------------------------------------------------------------------

Deno.test("selfHealMilestoneBranches - recreates a missing branch for an open milestone with open children", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 1);
  assertEquals(harness.ensureCalls.length, 1);
  assertEquals(harness.ensureCalls[0]!.repo, REPO);
  assertEquals(harness.ensureCalls[0]!.branch, MILESTONE_53_BRANCH);
  assertEquals(harness.ensureCalls[0]!.defaultBranch, "main");
});

Deno.test("selfHealMilestoneBranches - second pass is a no-op once the branch is back", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);

  await selfHealMilestoneBranches(harness.deps);
  const second = await selfHealMilestoneBranches(harness.deps);

  assert(second.ok);
  assertEquals(second.value.branchesRecreated, 0);
  // Exactly one creation across both passes.
  assertEquals(harness.ensureCalls.length, 1);
});

Deno.test("selfHealMilestoneBranches - takes no action when the branch is present", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 0);
  assertEquals(harness.ensureCalls.length, 0);
});

Deno.test("selfHealMilestoneBranches - never recreates the branch of a closed milestone", async () => {
  const closed = { ...milestone53(), state: "closed" };
  const world: StubWorld = {
    milestones: [closed],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 0);
  assertEquals(harness.ensureCalls.length, 0);
  // Only open milestones are requested from the API.
  const listing = harness.calls.find((c) =>
    c.join(" ").includes("/milestones?")
  );
  assert(listing, "expected a milestone listing call");
  assert(listing.join(" ").includes("state=open"));
});

Deno.test("selfHealMilestoneBranches - never recreates when the milestone has zero open children", async () => {
  const world: StubWorld = {
    milestones: [{
      number: 60,
      title: "Finished milestone",
      openIssues: 0,
      children: [],
    }],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 0);
  assertEquals(harness.ensureCalls.length, 0);
});

Deno.test("selfHealMilestoneBranches - skips idle-task milestones", async () => {
  const world: StubWorld = {
    milestones: [{
      number: 70,
      title: "idle-task: security-scan",
      openIssues: 5,
      children: [{ number: 1, title: "finding" }],
    }],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(harness.ensureCalls.length, 0);
});

Deno.test("selfHealMilestoneBranches - counts a failed branch recreation and does not retarget", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [{ number: 4000, baseRefName: "main", closingIssues: [3868] }],
  };
  const harness = makeHarness(world, () => ({
    ok: false,
    error: new Error("branch protection rejected the push"),
  }));

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 0);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(result.value.failures, 1);
  assert(
    harness.logs.some((l) =>
      l.includes("WARNING") && l.includes("branch protection")
    ),
    `expected a loud warning, got: ${harness.logs.join(" | ")}`,
  );
});

Deno.test("selfHealMilestoneBranches - fails loud when the open-children count cannot be read", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [],
    failing: (args) => /milestones\/53$/.test(args.join(" ")),
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 0);
  assertEquals(result.value.failures, 1);
  assert(harness.logs.some((l) => l.includes("WARNING")));
});

Deno.test("selfHealMilestoneBranches - skips a repo with no local clone", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);
  harness.deps.localCloneExistsFn = () => Promise.resolve(false);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(harness.ensureCalls.length, 0);
  assert(harness.logs.some((l) => l.includes("no local clone")));
});

// ---------------------------------------------------------------------------
// PR retargeting
// ---------------------------------------------------------------------------

Deno.test("selfHealMilestoneBranches - retargets a default-branch child PR once, with an explanatory comment", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{ number: 4000, baseRefName: "main", closingIssues: [3868] }],
  };
  const harness = makeHarness(world);

  const first = await selfHealMilestoneBranches(harness.deps);
  assert(first.ok);
  assertEquals(first.value.prsRetargeted, 1);
  assertEquals(world.prs[0]!.baseRefName, MILESTONE_53_BRANCH);
  assertEquals(harness.comments.length, 1);
  assert(harness.comments[0]!.body.includes(MILESTONE_RETARGET_MARKER));
  assert(harness.comments[0]!.body.includes(MILESTONE_53_BRANCH));

  // Second pass: the marker makes it idempotent — no second comment.
  const second = await selfHealMilestoneBranches(harness.deps);
  assert(second.ok);
  assertEquals(second.value.prsRetargeted, 0);
  assertEquals(harness.comments.length, 1);
});

Deno.test("selfHealMilestoneBranches - retargets a PR that carries the milestone directly", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4100,
      baseRefName: "main",
      milestoneTitle: "Milestone 3872 overflow",
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 1);
  assertEquals(world.prs[0]!.baseRefName, MILESTONE_53_BRANCH);
});

Deno.test("selfHealMilestoneBranches - leaves unrelated PRs and milestone-based PRs alone", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [
      // Unrelated to the milestone.
      { number: 4200, baseRefName: "main", closingIssues: [9999] },
      // Already based on the milestone branch.
      {
        number: 4201,
        baseRefName: MILESTONE_53_BRANCH,
        closingIssues: [3869],
      },
    ],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(harness.comments.length, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
});

Deno.test("selfHealMilestoneBranches - never flips back a PR a human retargeted at the default branch", async () => {
  // The marker records the worker's own earlier retarget: a human has since
  // pointed the PR back at the default branch, and the pass must not fight it.
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4300,
      baseRefName: "main",
      closingIssues: [3868],
      comments: [`${MILESTONE_RETARGET_MARKER}\nretargeted earlier`],
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assertEquals(harness.comments.length, 0);
});

Deno.test("selfHealMilestoneBranches - does not retarget when existing comments cannot be read", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{ number: 4400, baseRefName: "main", closingIssues: [3868] }],
    failing: (args) => args.join(" ").includes("/issues/4400/comments"),
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assert(harness.logs.some((l) => l.includes("WARNING")));
});

Deno.test("selfHealMilestoneBranches - retargets a PR onto a branch it has just recreated", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set<string>(),
    prs: [{ number: 4500, baseRefName: "main", closingIssues: [3869] }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.branchesRecreated, 1);
  assertEquals(result.value.prsRetargeted, 1);
  assertEquals(world.prs[0]!.baseRefName, MILESTONE_53_BRANCH);
});

Deno.test("selfHealMilestoneBranches - no repositories configured is a clean no-op", async () => {
  const world: StubWorld = {
    milestones: [],
    branches: new Set<string>(),
    prs: [],
  };
  const harness = makeHarness(world);
  harness.deps.repos = [];

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value, {
    branchesRecreated: 0,
    prsRetargeted: 0,
    failures: 0,
  });
  assertEquals(harness.calls.length, 0);
});

// ---------------------------------------------------------------------------
// renderRetargetComment
// ---------------------------------------------------------------------------

Deno.test("renderRetargetComment - names the branch, the milestone and the reason", () => {
  const body = renderRetargetComment(
    "Milestone 3872 overflow",
    MILESTONE_53_BRANCH,
    "main",
  );
  assert(body.startsWith(MILESTONE_RETARGET_MARKER));
  assert(body.includes("Milestone 3872 overflow"));
  assert(body.includes(MILESTONE_53_BRANCH));
  assert(body.includes("main"));
  assert(body.includes("3912"));
});

Deno.test("selfHealMilestoneBranches - never retargets the milestone's own delivery PR (head = milestone branch) onto itself (Issue #4360)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [
      // The delivery PR: milestone branch → default, closing the children.
      {
        number: 4354,
        baseRefName: "main",
        headRefName: MILESTONE_53_BRANCH,
        closingIssues: [3868],
      },
      // A genuine child PR still on the default branch.
      { number: 4001, baseRefName: "main", closingIssues: [3868] },
    ],
  };
  const harness = makeHarness(world);
  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 1, "only the child PR");
  assertEquals(world.prs[0]!.baseRefName, "main", "delivery PR untouched");
  assertEquals(world.prs[1]!.baseRefName, MILESTONE_53_BRANCH);
  assertEquals(harness.comments.filter((c) => c.pr === 4354).length, 0);
  assert(
    !harness.logs.some((l) => l.includes("Failed to retarget PR #4354")),
    harness.logs.join("\n"),
  );
});
