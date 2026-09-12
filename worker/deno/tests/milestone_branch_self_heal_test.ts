/**
 * Tests for the milestone branch self-heal pass (Issue #3912).
 *
 * A milestone can gain open children after its branch has been merged and
 * deleted. The self-heal pass recreates the branch and rescues open child
 * PRs still based on the default branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { resetRepoLevelRejectionsForTest } from "../lib/milestone_branch_rejection.ts";
import { formatMilestoneBranchRefusedMarker } from "../lib/milestone_branch_self_heal.ts";
import type { SelfDiagnosticFiling } from "../lib/self_diagnostic_attestation.ts";
import { assert, assertEquals } from "@std/assert";
import type { Result } from "../types.ts";
import { WORKER_PR_MARKER_PREFIX } from "../lib/pr_body.ts";
import {
  isFleetRaisedPr,
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
  /**
   * Existing comments (used for the retarget marker guard). A bare string is
   * the fleet's own comment; `{ body, author }` states a different author.
   */
  comments?: (string | { body: string; author: string })[];
  /** Head branch; defaults to an issue branch. */
  headRefName?: string;
  /** PR author; defaults to the fleet login (Issue #2022). */
  author?: string;
  /** PR body; defaults to one carrying the worker marker (Issue #2022). */
  body?: string;
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
/** The fleet login the harness writes its own marker comments as. */
const FLEET_LOGIN = "vibe-coder-bot";

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
          author: { login: pr.author ?? FLEET_LOGIN },
          body: pr.body ??
            `Fixes it.\n\n${WORKER_PR_MARKER_PREFIX}${pr.number} -->`,
        })),
      ));
    }

    // PR comment bodies (marker guard)
    const commentsMatch = key.match(
      new RegExp(`repos/${REPO}/issues/(\\d+)/comments`),
    );
    if (commentsMatch) {
      const pr = world.prs.find((p) => p.number === Number(commentsMatch[1]));
      // The REST comments endpoint's own shape: the marker guard reads the
      // commenter (Issue #1216), so the stub must render `user.login`.
      return Promise.resolve(JSON.stringify(
        (pr?.comments ?? []).map((c, i) =>
          typeof c === "string"
            ? { id: i, body: c, user: { login: FLEET_LOGIN } }
            : { id: i, body: c.body, user: { login: c.author } }
        ),
      ));
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
    dedupAuthors: { fleetAuthors: [FLEET_LOGIN] },
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

Deno.test("selfHealMilestoneBranches - a retarget marker planted by an outsider does not exempt the PR (Issue #1216)", async () => {
  // The marker is a published constant and a PR comment is text any GitHub
  // account may write. Trusting the body alone let one planted comment exempt
  // a PR from ever being retargeted, so its work merged to the default branch
  // outside the milestone.
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4300,
      baseRefName: "main",
      closingIssues: [3868],
      comments: [{
        body: `${MILESTONE_RETARGET_MARKER}\nnot the worker`,
        author: "drive-by-attacker",
      }],
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);

  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 1);
  assertEquals(world.prs[0]!.baseRefName, MILESTONE_53_BRANCH);
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

// ---------------------------------------------------------------------------
// Issue #2007: a repository that refuses milestone branches is reported once
// and not retried for the rest of the run.
// ---------------------------------------------------------------------------

const GH013 =
  "Failed to push milestone branch milestone/scan-20260909 to origin from Develop: " +
  "git push --end-of-options origin origin/Develop:refs/heads/milestone/scan-20260909 exited 1: " +
  "remote: error: GH013: Repository rule violations found for refs/heads/milestone/scan-20260909.";

/** Wrap the harness so `issue list` / `issue create` answer like GitHub. */
function withIssueApi(
  harness: StubHarness,
  existing: { number: number; body: string; author: string }[] = [],
): { creates: string[][]; filings: SelfDiagnosticFiling[] } {
  const creates: string[][] = [];
  const filings: SelfDiagnosticFiling[] = [];
  const inner = harness.deps.ghCommandFn;
  harness.deps.ghCommandFn = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(
        existing.map((e) => ({
          number: e.number,
          body: e.body,
          author: { login: e.author },
        })),
      ));
    }
    if (args[0] === "issue" && args[1] === "create") {
      creates.push([...args]);
      return Promise.resolve(`https://github.com/${REPO}/issues/77\n`);
    }
    return inner(args);
  };
  harness.deps.recordFiling = (filing) => {
    filings.push(filing);
    return Promise.resolve(true);
  };
  return { creates, filings };
}

Deno.test("selfHealMilestoneBranches - a repository-level refusal files one diagnostic and is not retried within the run (Issue #2007)", async () => {
  resetRepoLevelRejectionsForTest();
  try {
    const world: StubWorld = {
      milestones: [milestone53()],
      branches: new Set<string>(),
      prs: [],
    };
    const harness = makeHarness(world, () => ({
      ok: false,
      error: new Error(GH013),
    }));
    const api = withIssueApi(harness);

    const first = await selfHealMilestoneBranches(harness.deps);
    const second = await selfHealMilestoneBranches(harness.deps);

    assert(first.ok && second.ok);
    assertEquals(first.value.failures, 1);
    assertEquals(second.value.failures, 1, "still counted as a failure");
    assertEquals(
      harness.ensureCalls.length,
      1,
      "the refused push is made once per run, not once per cycle",
    );
    assertEquals(api.creates.length, 1, "exactly one diagnostic is filed");
    const body = api.creates[0]![api.creates[0]!.indexOf("--body") + 1]!;
    assert(body.includes(formatMilestoneBranchRefusedMarker(REPO)), body);
    assert(body.includes("do_not_enforce_on_create: true"), "names the flag");
    assert(body.includes("GH013"), "quotes the repository's answer");
    assertEquals(api.creates[0]![api.creates[0]!.indexOf("--repo") + 1], REPO);
    assertEquals(api.filings.length, 1);
    assertEquals(api.filings[0]?.issueNumber, 77);
    assertEquals(api.filings[0]?.familyId, "milestone-branch-refused");
    assertEquals(
      harness.logs.filter((l) => l.includes("Filing one diagnostic")).length,
      1,
      "the remedy is said once",
    );
    assertEquals(
      harness.logs.filter((l) => l.includes("Not retrying milestone branch"))
        .length,
      1,
      "the second cycle says why it did not push",
    );
  } finally {
    resetRepoLevelRejectionsForTest();
  }
});

Deno.test("selfHealMilestoneBranches - an existing fleet-authored diagnostic is reused, not duplicated (Issue #2007)", async () => {
  resetRepoLevelRejectionsForTest();
  try {
    const world: StubWorld = {
      milestones: [milestone53()],
      branches: new Set<string>(),
      prs: [],
    };
    const harness = makeHarness(world, () => ({
      ok: false,
      error: new Error(GH013),
    }));
    const api = withIssueApi(harness, [{
      number: 12,
      body: `${formatMilestoneBranchRefusedMarker(REPO)}\nfiled earlier`,
      author: FLEET_LOGIN,
    }]);

    const result = await selfHealMilestoneBranches(harness.deps);

    assert(result.ok);
    assertEquals(api.creates.length, 0, "no second diagnostic");
    assertEquals(api.filings.length, 0);
    assert(
      harness.logs.some((l) => l.includes("filing: exists:#12")),
      harness.logs.join(" | "),
    );
  } finally {
    resetRepoLevelRejectionsForTest();
  }
});

Deno.test("selfHealMilestoneBranches - a forged diagnostic from outside the fleet does not dedup (Issue #2007)", async () => {
  resetRepoLevelRejectionsForTest();
  try {
    const world: StubWorld = {
      milestones: [milestone53()],
      branches: new Set<string>(),
      prs: [],
    };
    const harness = makeHarness(world, () => ({
      ok: false,
      error: new Error(GH013),
    }));
    const api = withIssueApi(harness, [{
      number: 12,
      body: `${formatMilestoneBranchRefusedMarker(REPO)}\nplanted`,
      author: "stranger",
    }]);

    await selfHealMilestoneBranches(harness.deps);

    assertEquals(api.creates.length, 1, "a genuine diagnostic is still filed");
  } finally {
    resetRepoLevelRejectionsForTest();
  }
});

Deno.test("selfHealMilestoneBranches - a failure that is not repository-level is retried on the next pass as before (Issue #2007)", async () => {
  resetRepoLevelRejectionsForTest();
  try {
    const world: StubWorld = {
      milestones: [milestone53()],
      branches: new Set<string>(),
      prs: [],
    };
    const harness = makeHarness(world, () => ({
      ok: false,
      error: new Error(
        "fatal: unable to access origin: network is unreachable",
      ),
    }));
    const api = withIssueApi(harness);

    await selfHealMilestoneBranches(harness.deps);
    await selfHealMilestoneBranches(harness.deps);

    assertEquals(harness.ensureCalls.length, 2, "a transient fault is retried");
    assertEquals(api.creates.length, 0, "and files nothing");
  } finally {
    resetRepoLevelRejectionsForTest();
  }
});

// ---------------------------------------------------------------------------
// Only fleet-raised PRs are retargeted (Issue #2022)
// ---------------------------------------------------------------------------

Deno.test("selfHealMilestoneBranches - never retargets a PR a human raised, even on an issue-N branch (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4000,
      baseRefName: "main",
      closingIssues: [3868],
      headRefName: "issue-3868-replayed-onto-main",
      author: "maintainer",
      body: "Replayed commit by commit onto main on purpose. Closes #3868",
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(result.value.failures, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assertEquals(harness.comments.length, 0);
  assert(
    harness.calls.every((c) => !(c[0] === "pr" && c[1] === "edit")),
    "no base change was attempted",
  );
  assert(
    harness.logs.some((l) =>
      l.includes("#4000") && l.includes("not raised by the fleet") &&
      l.includes("maintainer")
    ),
    "the decision is logged once",
  );
});

Deno.test("selfHealMilestoneBranches - a fleet author without the worker marker is not enough (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4001,
      baseRefName: "main",
      closingIssues: [3868],
      body: "A PR the service account raised by hand, with no worker marker.",
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assertEquals(harness.comments.length, 0);
});

Deno.test("selfHealMilestoneBranches - a worker marker from a non-fleet author is not enough (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{
      number: 4002,
      baseRefName: "main",
      closingIssues: [3868],
      author: "drive-by-attacker",
    }],
  };
  const harness = makeHarness(world);

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
});

Deno.test("selfHealMilestoneBranches - an unresolved fleet identity retargets nothing (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{ number: 4003, baseRefName: "main", closingIssues: [3868] }],
  };
  const harness = makeHarness(world);
  harness.deps.dedupAuthors = { fleetAuthors: [] };

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assert(
    harness.logs.some((l) => l.includes("Fleet identity unresolved")),
    "the refusal names its cause",
  );
});

Deno.test("selfHealMilestoneBranches - a merge dry run that would conflict refuses the retarget (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{ number: 4004, baseRefName: "main", closingIssues: [3868] }],
  };
  const harness = makeHarness(world);
  const asked: string[] = [];
  harness.deps.mergeWouldConflictFn = (_repo, base, head) => {
    asked.push(`${base}<-${head}`);
    return Promise.resolve(true);
  };

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 0);
  assertEquals(result.value.failures, 0);
  assertEquals(world.prs[0]!.baseRefName, "main");
  assertEquals(harness.comments.length, 0);
  assertEquals(asked, [`${MILESTONE_53_BRANCH}<-issue-4004-x`]);
  assert(harness.logs.some((l) => l.includes("would conflict")));
});

Deno.test("selfHealMilestoneBranches - a merge dry run that cannot answer allows the retarget, and says so (Issue #2022)", async () => {
  const world: StubWorld = {
    milestones: [milestone53()],
    branches: new Set([MILESTONE_53_BRANCH]),
    prs: [{ number: 4005, baseRefName: "main", closingIssues: [3868] }],
  };
  const harness = makeHarness(world);
  harness.deps.mergeWouldConflictFn = () => Promise.resolve(null);

  const result = await selfHealMilestoneBranches(harness.deps);
  assert(result.ok);
  assertEquals(result.value.prsRetargeted, 1);
  assertEquals(world.prs[0]!.baseRefName, MILESTONE_53_BRANCH);
  assert(harness.logs.some((l) => l.includes("could not be read")));
});

Deno.test("isFleetRaisedPr - both signals required, head must be a safe positional (Issue #2022)", () => {
  const fleet = ["VibeCoderST", "stservice"];
  const body = `${WORKER_PR_MARKER_PREFIX}7 -->`;
  assertEquals(
    isFleetRaisedPr(
      { author: "vibecoderst", body, headRefName: "issue-7-x" },
      fleet,
    ),
    true,
  );
  assertEquals(
    isFleetRaisedPr(
      { author: "maintainer", body, headRefName: "issue-7-x" },
      fleet,
    ),
    false,
  );
  assertEquals(
    isFleetRaisedPr({
      author: "stservice",
      body: "no marker",
      headRefName: "issue-7-x",
    }, fleet),
    false,
  );
  assertEquals(
    isFleetRaisedPr({ author: "stservice", body, headRefName: "-rf" }, fleet),
    false,
  );
  assertEquals(
    isFleetRaisedPr({ author: null, body, headRefName: "issue-7-x" }, fleet),
    false,
  );
  assertEquals(
    isFleetRaisedPr(
      { author: "stservice", body, headRefName: "issue-7-x" },
      [],
    ),
    false,
  );
});
