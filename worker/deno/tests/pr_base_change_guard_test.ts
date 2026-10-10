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
