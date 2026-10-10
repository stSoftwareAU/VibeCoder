/**
 * Tests for the PR base-change guard (Issue #3433).
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  classifyPrBaseChange,
  decidePrBaseChange,
  enforcePrBaseChangeGuard,
  parseMilestoneFixHead,
  PrBaseChangeRefusedError,
} from "../lib/pr_base_change_guard.ts";
import { milestoneFixBranchFor } from "../lib/milestone_fix_pr.ts";

Deno.test("parseMilestoneFixHead - round-trips milestoneFixBranchFor", () => {
  const head = milestoneFixBranchFor("milestone/x.y", 42, "ci-1");
  assertEquals(parseMilestoneFixHead(head), {
    leaf: "x.y",
    milestonePrNumber: 42,
  });
  assertEquals(parseMilestoneFixHead("issue-9-foo"), undefined);
  assertEquals(parseMilestoneFixHead("milestone-fix/x/pr-0-ci"), undefined);
  assertEquals(parseMilestoneFixHead("milestone-fix/x/y/pr-1-ci"), undefined);
});

Deno.test("classifyPrBaseChange - pr edit spellings", () => {
  for (
    const args of [
      ["pr", "edit", "7", "--base", "main"],
      ["pr", "edit", "7", "--base=main"],
      ["pr", "edit", "7", "-B", "main"],
      ["pr", "edit", "7", "-Bmain"],
      ["pr", "edit", "7", "-B=main"],
    ]
  ) {
    assertEquals(classifyPrBaseChange(args)?.newBase, "main", `${args}`);
    assertEquals(classifyPrBaseChange(args)?.prSelector, "7");
  }
  const url = classifyPrBaseChange([
    "pr",
    "edit",
    "https://github.com/o/r/pull/12",
    "--base",
    "main",
  ]);
  assertEquals(url?.repo, "o/r");
  assertEquals(
    classifyPrBaseChange(["pr", "edit", "7", "-R", "a/b", "--base", "m"])?.repo,
    "a/b",
  );
  assertEquals(
    classifyPrBaseChange(["pr", "edit", "7", "--title", "x"]),
    undefined,
  );
  assertEquals(
    classifyPrBaseChange(["pr", "create", "--base", "main"]),
    undefined,
  );
});

Deno.test("classifyPrBaseChange - REST spellings", () => {
  const field = classifyPrBaseChange([
    "api",
    "-X",
    "PATCH",
    "/repos/o/r/pulls/12",
    "--field=base=main",
  ]);
  assertEquals(field, { newBase: "main", repo: "o/r", prSelector: "12" });
  assertEquals(
    classifyPrBaseChange([
      "api",
      "-X",
      "PATCH",
      "repos/{owner}/{repo}/pulls/3",
      "--raw-field",
      "base=main",
    ]),
    { newBase: "main", prSelector: "3" },
  );
  assertEquals(
    classifyPrBaseChange([
      "api",
      "-X",
      "PATCH",
      "repos/o/r/pulls/12",
      "-f",
      "title=x",
    ]),
    undefined,
  );
  assertEquals(
    classifyPrBaseChange([
      "api",
      "-X",
      "PATCH",
      "repos/o/r/pulls/12/comments",
      "-f",
      "base=x",
    ]),
    undefined,
  );
});

Deno.test("classifyPrBaseChange - POST spellings (implicit and explicit) are base changes", () => {
  const expected = { newBase: "main", repo: "o/r", prSelector: "12" };
  // No -X: `gh api` sends POST because a field is given.
  assertEquals(
    classifyPrBaseChange(["api", "repos/o/r/pulls/12", "-f", "base=main"]),
    expected,
  );
  assertEquals(
    classifyPrBaseChange([
      "api",
      "-X",
      "POST",
      "repos/o/r/pulls/12",
      "--field=base=main",
    ]),
    expected,
  );
  assertEquals(
    classifyPrBaseChange(
      ["api", "--method=POST", "repos/o/r/pulls/12", "--input", "b.json"],
      () => '{"base":"main"}',
    )?.newBase,
    "main",
  );
  assertEquals(
    classifyPrBaseChange(["api", "repos/o/r/pulls/12", "--input", "b.json"])
      ?.newBase,
    null,
  );
  // Non-base POSTs and other endpoints stay unclassified.
  assertEquals(
    classifyPrBaseChange(["api", "repos/o/r/pulls/12", "-f", "title=x"]),
    undefined,
  );
  assertEquals(
    classifyPrBaseChange([
      "api",
      "repos/o/r/pulls/12/comments",
      "-f",
      "base=x",
    ]),
    undefined,
  );
  assertEquals(
    classifyPrBaseChange(["api", "repos/o/r/pulls", "-f", "base=main"]),
    undefined,
  );
});

Deno.test("classifyPrBaseChange - query, fragment and absolute-URL spellings", () => {
  for (
    const endpoint of [
      "repos/o/r/pulls/12?x=1",
      "/repos/o/r/pulls/12?x=1#frag",
      "repos/o/r/pulls/12/?x=1",
      "repos/o/r/pulls/12#frag",
      "https://api.github.com/repos/o/r/pulls/12?x=1",
      "https://api.github.com/repos/o/r/pulls/12",
    ]
  ) {
    assertEquals(
      classifyPrBaseChange(["api", "-X", "PATCH", endpoint, "-f", "base=main"]),
      { newBase: "main", repo: "o/r", prSelector: "12" },
      endpoint,
    );
  }
  // A query on a different endpoint stays unclassified.
  assertEquals(
    classifyPrBaseChange([
      "api",
      "-X",
      "PATCH",
      "repos/o/r/pulls/12/comments?x=1",
      "-f",
      "base=x",
    ]),
    undefined,
  );
});

Deno.test("classifyPrBaseChange - --input bodies", () => {
  const args = [
    "api",
    "-X",
    "PATCH",
    "repos/o/r/pulls/12",
    "--input",
    "b.json",
  ];
  assertEquals(
    classifyPrBaseChange(args, () => '{"base":"main"}')?.newBase,
    "main",
  );
  assertEquals(classifyPrBaseChange(args, () => '{"title":"x"}'), undefined);
  assertEquals(classifyPrBaseChange(args, () => "not json")?.newBase, null);
  assertEquals(classifyPrBaseChange(args)?.newBase, null);
  assertEquals(
    classifyPrBaseChange(
      ["api", "-X", "PATCH", "repos/o/r/pulls/12", "--input", "-"],
      () => "{}",
    )?.newBase,
    null,
  );
});

Deno.test("decidePrBaseChange - rules", () => {
  const fix = "milestone-fix/x/pr-5-ci";
  assertEquals(
    decidePrBaseChange({
      headRefName: fix,
      currentBase: "milestone/x",
      newBase: "milestone/x",
    }),
    { allowed: true },
  );
  assertEquals(
    decidePrBaseChange({
      headRefName: fix,
      currentBase: "milestone/x",
      newBase: "main",
    }).allowed,
    false,
  );
  assertEquals(
    decidePrBaseChange({
      headRefName: fix,
      currentBase: "milestone/x",
      newBase: "milestone/y",
    }).allowed,
    false,
  );
  assertEquals(
    decidePrBaseChange({
      headRefName: "issue-9",
      currentBase: "milestone/x",
      newBase: "main",
    }).allowed,
    false,
  );
  assertEquals(
    decidePrBaseChange({
      headRefName: "issue-9",
      currentBase: "main",
      newBase: "milestone/x",
    }).allowed,
    true,
  );
  assertEquals(
    decidePrBaseChange({
      headRefName: "issue-9",
      currentBase: "main",
      newBase: null,
    }).allowed,
    false,
  );
});

Deno.test("enforcePrBaseChangeGuard - logs and throws on refusal, no-op otherwise", async () => {
  const logs: string[] = [];
  const deps = {
    lookup: () =>
      Promise.resolve({ headRefName: "issue-9", baseRefName: "milestone/x" }),
    log: (l: string) => logs.push(l),
  };
  await assertRejects(
    () => enforcePrBaseChangeGuard(["pr", "edit", "7", "--base", "main"], deps),
    PrBaseChangeRefusedError,
  );
  assertEquals(logs.length, 1);
  assertEquals(
    logs[0]!.startsWith("[SECURITY] [PR_BASE_CHANGE_REFUSED]"),
    true,
  );

  await enforcePrBaseChangeGuard(["pr", "edit", "7", "--title", "x"], {
    ...deps,
    lookup: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(logs.length, 1);

  await assertRejects(
    () =>
      enforcePrBaseChangeGuard(["pr", "edit", "7", "--base", "main"], {
        ...deps,
        lookup: () => Promise.reject(new Error("down")),
      }),
    PrBaseChangeRefusedError,
  );
});

Deno.test("enforcePrBaseChangeGuard - implicit-POST REST spelling looks up the PR and refuses", async () => {
  const logs: string[] = [];
  const looked: string[] = [];
  const deps = {
    lookup: (change: { prSelector?: string }) => {
      looked.push(change.prSelector ?? "");
      return Promise.resolve({
        headRefName: "milestone-fix/x/pr-5-ci",
        baseRefName: "milestone/x",
      });
    },
    log: (l: string) => logs.push(l),
  };
  await assertRejects(
    () =>
      enforcePrBaseChangeGuard(
        ["api", "repos/o/r/pulls/12", "-f", "base=main"],
        deps,
      ),
    PrBaseChangeRefusedError,
  );
  assertEquals(looked, ["12"]);
  assertEquals(logs.length, 1);
  // Moving to its own milestone branch is still allowed on the same spelling.
  await enforcePrBaseChangeGuard(
    ["api", "repos/o/r/pulls/12", "-f", "base=milestone/x"],
    deps,
  );
  assertEquals(looked, ["12", "12"]);
});
