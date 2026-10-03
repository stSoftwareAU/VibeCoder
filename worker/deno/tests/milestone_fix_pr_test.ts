/**
 * Tests for milestone_fix_pr.ts — landing a fix into a gated milestone PR
 * through a side-branch PR (Issue #2907).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  findOpenMilestoneFixPr,
  isMilestoneFixBranch,
  MILESTONE_FIX_BRANCH_PREFIX,
  milestoneFixBranchFor,
  milestoneFixPrefixFor,
  raiseMilestoneFixPr,
} from "../lib/milestone_fix_pr.ts";

const REPO = "org/repo";
const MILESTONE = "milestone/523-idle-task-scans";

/** Records every gh call; answers are driven by `handlers`. */
function fakeGh(handlers: {
  list?: (args: string[]) => string;
  create?: (args: string[]) => string;
  merge?: (args: string[]) => string | Error;
  comment?: (args: string[]) => string | Error;
  reviewers?: (args: string[]) => string;
}) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") {
      return Promise.resolve(handlers.list?.(args) ?? "[]");
    }
    if (args[1] === "create") {
      return Promise.resolve(
        handlers.create?.(args) ?? "https://github.com/org/repo/pull/900\n",
      );
    }
    if (args[1] === "merge") {
      const result = handlers.merge?.(args) ?? "";
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    }
    if (args[1] === "comment") {
      const result = handlers.comment?.(args) ?? "";
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    }
    if (args.includes("GET")) {
      return Promise.resolve(
        handlers.reviewers?.(args) ?? '{"users":[],"teams":[]}',
      );
    }
    return Promise.resolve("");
  };
  return { calls, gh };
}

Deno.test("milestoneFixBranchFor - builds the deterministic branch name and sanitises", () => {
  assertEquals(
    milestoneFixBranchFor(MILESTONE, 42, "review feedback"),
    `${MILESTONE_FIX_BRANCH_PREFIX}/523-idle-task-scans/pr-42-review-feedback`,
  );
});

Deno.test("milestoneFixBranchFor - truncates a long discriminator to 40 characters", () => {
  const long = "a".repeat(60);
  const branch = milestoneFixBranchFor(MILESTONE, 1, long);
  const disc = branch.split("-").pop()!;
  // The whole tail after the last '-' is all 'a's once truncated; check length.
  const afterPrefix = branch.slice(
    milestoneFixPrefixFor(MILESTONE, 1).length,
  );
  assertEquals(afterPrefix.length, 40);
  assert(disc.length <= 40);
});

Deno.test("milestoneFixBranchFor - throws on non-positive or non-integer prNumber", () => {
  assertThrows(() => milestoneFixBranchFor(MILESTONE, 0, "x"));
  assertThrows(() => milestoneFixBranchFor(MILESTONE, -1, "x"));
  assertThrows(() => milestoneFixBranchFor(MILESTONE, 1.5, "x"));
});

Deno.test("milestoneFixBranchFor - throws when the sanitised leaf or discriminator is empty", () => {
  assertThrows(() => milestoneFixBranchFor("milestone/", 1, "x"));
  assertThrows(() => milestoneFixBranchFor(MILESTONE, 1, ""));
});

Deno.test("isMilestoneFixBranch - recognises the prefix and nothing else", () => {
  assert(isMilestoneFixBranch(`${MILESTONE_FIX_BRANCH_PREFIX}/foo/pr-1-x`));
  assert(!isMilestoneFixBranch("sync/milestone-foo"));
  assert(!isMilestoneFixBranch("feature/foo"));
});

Deno.test("milestoneFixPrefixFor - shared by every fix branch for a milestone PR", () => {
  const prefix = milestoneFixPrefixFor(MILESTONE, 42);
  assertEquals(
    prefix,
    `${MILESTONE_FIX_BRANCH_PREFIX}/523-idle-task-scans/pr-42-`,
  );
  assert(milestoneFixBranchFor(MILESTONE, 42, "ci fix").startsWith(prefix));
  assertThrows(() => milestoneFixPrefixFor(MILESTONE, 0));
});

Deno.test("findOpenMilestoneFixPr - finds a matching open fix PR", async () => {
  const prefix = milestoneFixPrefixFor(MILESTONE, 42);
  const { gh, calls } = fakeGh({
    list: () =>
      JSON.stringify([
        { number: 5, url: "https://x/pr/5", headRefName: "unrelated" },
        {
          number: 901,
          url: "https://x/pr/901",
          headRefName: `${prefix}review-feedback`,
        },
      ]),
  });
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, { gh });
  assert(result.ok);
  assertEquals(result.value?.number, 901);
  assertEquals(result.value?.opened, false);
  assert(calls.some((a) => a[1] === "list"));
});

Deno.test("findOpenMilestoneFixPr - a takeover discriminator ignores a CI fix PR (Issue #2965)", async () => {
  const prefix = milestoneFixPrefixFor(MILESTONE, 42);
  const { gh } = fakeGh({
    list: () =>
      JSON.stringify([
        {
          number: 901,
          url: "https://x/pr/901",
          headRefName: `${prefix}ci-abc`,
        },
        {
          number: 902,
          url: "https://x/pr/902",
          headRefName: `${prefix}takeover-abc`,
        },
      ]),
  });
  const anyFix = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, { gh });
  const takeover = await findOpenMilestoneFixPr(
    REPO,
    MILESTONE,
    42,
    { gh },
    "takeover-",
  );
  assert(anyFix.ok && takeover.ok);
  assertEquals(anyFix.value?.number, 901);
  assertEquals(takeover.value?.number, 902);
});

Deno.test("findOpenMilestoneFixPr - returns null when nothing matches", async () => {
  const { gh } = fakeGh({ list: () => "[]" });
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, { gh });
  assert(result.ok);
  assertEquals(result.value, null);
});

Deno.test("findOpenMilestoneFixPr - fails loud on a gh failure, never returns null", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("gh exploded"));
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, { gh });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "gh exploded");
});

Deno.test("raiseMilestoneFixPr - creates the PR and arms auto-merge", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({
    list: () => "[]",
    create: () => "https://github.com/org/repo/pull/901\n",
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.number, 901);
  assertEquals(result.value.opened, true);

  const create = calls.find((a) => a[1] === "create");
  assert(create);
  assertEquals(create[create.indexOf("--base") + 1], MILESTONE);
  assertEquals(create[create.indexOf("--head") + 1], fixBranch);
  assertStringIncludes(create[create.indexOf("--title") + 1]!, "#42");
  assertStringIncludes(create[create.indexOf("--title") + 1]!, "CI fix");
  assertStringIncludes(create[create.indexOf("--body") + 1]!, "Refs #42");

  assert(calls.some((a) => a[1] === "merge" && a.includes("--auto")));
});

Deno.test("raiseMilestoneFixPr - reuses an open fix PR rather than creating one", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({
    list: () => JSON.stringify([{ number: 901, url: "https://x/pr/901" }]),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(result.ok);
  assertEquals(result.value.opened, false);
  assertEquals(result.value.number, 901);
  assert(!calls.some((a) => a[1] === "create"));
});

Deno.test("raiseMilestoneFixPr - an arming failure warns and comments, but is still ok", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({
    list: () => "[]",
    create: () => "https://github.com/org/repo/pull/901\n",
    merge: () => new Error("HTTP 500 Internal Server Error"),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  assert(warnings.some((m) => m.includes("not armed for auto-merge")));
  const comment = calls.find((a) => a[1] === "comment");
  assert(comment, JSON.stringify(calls));
  assertStringIncludes(comment.join(" "), "HTTP 500");
});

Deno.test("raiseMilestoneFixPr - a create failure is an error", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "list") return Promise.resolve("[]");
    if (args[1] === "create") {
      return Promise.reject(new Error("gh create failed"));
    }
    return Promise.resolve("");
  };
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "gh create failed");
});

Deno.test("raiseMilestoneFixPr - invalid repo is rejected with no gh call", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({});
  const result = await raiseMilestoneFixPr({
    repo: "not a repo",
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(!result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("raiseMilestoneFixPr - a non-milestone base is rejected with no gh call", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({});
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: "main",
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(!result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("raiseMilestoneFixPr - a non-fix-branch head is rejected with no gh call", async () => {
  const { gh, calls } = fakeGh({});
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch: "feature/not-a-fix-branch",
    pass: "CI fix",
  }, { gh });

  assert(!result.ok);
  assertEquals(calls.length, 0);
});
