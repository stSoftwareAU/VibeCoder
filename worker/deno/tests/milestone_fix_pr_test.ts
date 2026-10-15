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
  milestoneFixMergeMethod,
  milestoneFixPrefixFor,
  raiseMilestoneFixPr,
} from "../lib/milestone_fix_pr.ts";

const REPO = "org/repo";
const MILESTONE = "milestone/523-idle-task-scans";

/** The `--jq` expression of a `gh api` call. */
const jqOf = (args: string[]): string | undefined =>
  args[args.indexOf("--jq") + 1];

/** Records every gh call; answers are driven by `handlers`. */
function fakeGh(handlers: {
  list?: (args: string[]) => string;
  create?: (args: string[]) => string;
  view?: (args: string[]) => string | Error;
  merge?: (args: string[]) => string | Error;
  comment?: (args: string[]) => string | Error;
  compare?: (args: string[]) => string | Error;
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
    if (args[1] === "view") {
      const result = handlers.view?.(args) ??
        JSON.stringify({ baseRefName: MILESTONE, headRefName: "x" });
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
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
    if (args[0] === "api" && args[1] === `repos/${REPO}`) {
      return Promise.resolve("main\n");
    }
    if (args[0] === "api" && (args[1] ?? "").includes("/compare/")) {
      // Content-only by default, so existing tests keep their --squash.
      const fallback = jqOf(args) === ".merge_base_commit.sha"
        ? "a".repeat(40)
        : "behind";
      const result = handlers.compare?.(args) ?? fallback;
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

Deno.test("raiseMilestoneFixPr - arms only after the base reads back as the milestone branch (Issue #3433)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({
    view: () =>
      JSON.stringify({ baseRefName: MILESTONE, headRefName: fixBranch }),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(result.ok);
  const viewAt = calls.findIndex((a) => a[1] === "view");
  const mergeAt = calls.findIndex((a) => a[1] === "merge");
  assert(viewAt >= 0 && mergeAt > viewAt, JSON.stringify(calls));
  assert(calls[mergeAt]!.includes("--auto"));
  assert(calls[mergeAt]!.includes("--squash"));
});

Deno.test("raiseMilestoneFixPr - a base that reads back as main is not armed (Issue #3433)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({
    view: () => JSON.stringify({ baseRefName: "main", headRefName: fixBranch }),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  assert(!calls.some((a) => a[1] === "merge"), JSON.stringify(calls));
  assert(
    warnings.some((m) =>
      m.includes("its base is 'main'") && m.includes("Issue #3433")
    ),
    warnings.join("\n"),
  );
  const comment = calls.find((a) => a[1] === "comment");
  assert(comment, JSON.stringify(calls));
  assertStringIncludes(comment.join(" "), "Issue #3433");
});

Deno.test("raiseMilestoneFixPr - an unreadable base fails closed and warns (Issue #3433)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({
    view: () => new Error("HTTP 502 Bad Gateway"),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  assert(!calls.some((a) => a[1] === "merge"), JSON.stringify(calls));
  assert(warnings.some((m) => m.includes("HTTP 502")), warnings.join("\n"));
});

Deno.test("raiseMilestoneFixPr - a base the view does not return as a string is 'unknown' and not armed (Issue #3433)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({ view: () => "{}" });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  assert(!calls.some((a) => a[1] === "merge"), JSON.stringify(calls));
  assert(
    warnings.some((m) => m.includes("its base is 'unknown'")),
    warnings.join("\n"),
  );
  const comment = calls.find((a) => a[1] === "comment");
  assert(comment, JSON.stringify(calls));
  assertStringIncludes(comment.join(" "), "its base is 'unknown'");
});

Deno.test("raiseMilestoneFixPr - a head that merges the default branch is armed with --merge, never --squash (Issue #3596)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const mergeBase = "b".repeat(40);
  const { gh, calls } = fakeGh({
    compare: (args) => jqOf(args) === ".status" ? "ahead" : mergeBase,
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh });

  assert(result.ok, result.ok ? "" : result.error.message);
  const merge = calls.find((a) => a[1] === "merge");
  assert(merge, JSON.stringify(calls));
  assert(merge.includes("--auto"), merge.join(" "));
  assert(merge.includes("--merge"), merge.join(" "));
  assert(!merge.includes("--squash"), merge.join(" "));
  const paths = calls.filter((a) => a[0] === "api").map((a) => a[1]);
  assert(
    paths.includes(`repos/${REPO}/compare/main...${fixBranch}`),
    paths.join("\n"),
  );
  assert(
    paths.includes(`repos/${REPO}/compare/${MILESTONE}...${mergeBase}`),
    paths.join("\n"),
  );
});

Deno.test("raiseMilestoneFixPr - a merge refused by a repository that bans merge commits is not squashed (Issue #3596)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({
    compare: (args) => jqOf(args) === ".status" ? "ahead" : "b".repeat(40),
    merge: () => new Error("Merge commits are not allowed on this repository"),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  const merges = calls.filter((a) => a[1] === "merge");
  assertEquals(merges.length, 1, JSON.stringify(merges));
  assert(!merges[0]!.includes("--squash"), merges[0]!.join(" "));
  assert(
    warnings.some((m) =>
      m.includes("Allow merge commits") && m.includes("Issue #3596")
    ),
    warnings.join("\n"),
  );
  const comment = calls.find((a) => a[1] === "comment");
  assert(comment, JSON.stringify(calls));
  assertStringIncludes(comment.join(" "), "NOT squashed");
});

Deno.test("raiseMilestoneFixPr - an unreadable merge-method check is not armed and warns (Issue #3596)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const warnings: string[] = [];
  const { gh, calls } = fakeGh({
    compare: () => new Error("HTTP 502"),
  });
  const result = await raiseMilestoneFixPr({
    repo: REPO,
    milestoneBranch: MILESTONE,
    milestonePrNumber: 42,
    fixBranch,
    pass: "CI fix",
  }, { gh, warn: (m) => warnings.push(m) });

  assert(result.ok);
  assert(!calls.some((a) => a[1] === "merge"), JSON.stringify(calls));
  assert(
    warnings.some((m) => m.includes("HTTP 502") && m.includes("Issue #3596")),
    warnings.join("\n"),
  );
});

Deno.test("milestoneFixMergeMethod - diverged history is --merge (Issue #3596)", async () => {
  const { gh } = fakeGh({
    compare: (args) => jqOf(args) === ".status" ? "diverged" : "b".repeat(40),
  });
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value, "--merge");
});

Deno.test("milestoneFixMergeMethod - an identical merge base is --squash (Issue #3596)", async () => {
  const { gh } = fakeGh({
    compare: (args) => jqOf(args) === ".status" ? "identical" : "b".repeat(40),
  });
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value, "--squash");
});

Deno.test("milestoneFixMergeMethod - an unexpected comparison status is an error (Issue #3596)", async () => {
  const { gh } = fakeGh({
    compare: (args) => jqOf(args) === ".status" ? "weird" : "b".repeat(40),
  });
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "weird");
});

Deno.test("milestoneFixMergeMethod - a merge base that is not a sha is an error (Issue #3596)", async () => {
  const { gh } = fakeGh({
    compare: (args) =>
      jqOf(args) === ".merge_base_commit.sha" ? "not-a-sha" : "ahead",
  });
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
});

Deno.test("milestoneFixMergeMethod - an empty default branch is an error (Issue #3596)", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(args[1] === `repos/${REPO}` ? "\n" : "");
  };
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
  assertEquals(calls.length, 1, JSON.stringify(calls));
});

Deno.test("milestoneFixMergeMethod - a head containing '..' is rejected with no gh call (Issue #3596)", async () => {
  const { gh, calls } = fakeGh({});
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "x/../y",
    gh,
  );
  assert(!result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("milestoneFixMergeMethod - a non-milestone branch is rejected with no gh call (Issue #3596)", async () => {
  const fixBranch = milestoneFixBranchFor(MILESTONE, 42, "ci fix");
  const { gh, calls } = fakeGh({});
  const result = await milestoneFixMergeMethod(
    REPO,
    "main",
    fixBranch,
    gh,
  );
  assert(!result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("milestoneFixMergeMethod - an invalid repo is rejected with no gh call (Issue #3596)", async () => {
  const { gh, calls } = fakeGh({});
  const result = await milestoneFixMergeMethod(
    "not a repo",
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "invalid repo");
  assertEquals(calls.length, 0);
});

Deno.test("milestoneFixMergeMethod - a head outside the allowed character set is rejected with no gh call (Issue #3596)", async () => {
  for (const head of ["milestone-fix/x/pr-1-a b", "fix?x=1"]) {
    const { gh, calls } = fakeGh({});
    const result = await milestoneFixMergeMethod(REPO, MILESTONE, head, gh);
    assert(!result.ok, head);
    assertStringIncludes(
      result.error.message,
      "is not a safe branch name or sha",
    );
    assertEquals(calls.length, 0, head);
  }
});

Deno.test("milestoneFixMergeMethod - a failed default-branch read is an error after one gh call (Issue #3596)", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.reject(new Error("HTTP 503 default"));
  };
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "could not tell whether");
  assertStringIncludes(result.error.message, "HTTP 503 default");
  assertEquals(calls.length, 1, JSON.stringify(calls));
});

Deno.test("milestoneFixMergeMethod - a failed comparison-status read is an error after three gh calls (Issue #3596)", async () => {
  const { gh, calls } = fakeGh({
    compare: (args) =>
      jqOf(args) === ".status" ? new Error("HTTP 504 status") : "b".repeat(40),
  });
  const result = await milestoneFixMergeMethod(
    REPO,
    MILESTONE,
    "fix-branch",
    gh,
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "HTTP 504 status");
  assertEquals(calls.length, 3, JSON.stringify(calls));
});
