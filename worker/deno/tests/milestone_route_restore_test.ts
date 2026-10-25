/**
 * An open milestone whose rollup has merged gets a working route again
 * (Issue #4175).
 *
 * A fresh rollup from the milestone branch re-opens the route, and the held
 * child is armed onto that branch. A sync pull request is not opened into a
 * route that is still closed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";
import {
  _resetMilestoneBehindMemo,
  decideMilestoneBaseMerge,
} from "../lib/milestone_children_gate.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { hasExistingMilestoneSummaryPr } from "../lib/milestone_completion.ts";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge,
} from "../lib/pr_auto_merge.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/clean-up";
const DEFAULT = "Develop";

Deno.test("decideMilestoneBaseMerge - an open rollup restores the route even when an older rollup merged (Issue #4175)", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: 4109,
    baseRefName: BRANCH,
    ghCommandFn: (args) => {
      const key = args.join(" ");
      if (key.includes("pr list") && key.includes("--head")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 3125,
            state: "MERGED",
            baseRefName: DEFAULT,
            mergedAt: "2026-06-30T02:27:52Z",
          },
          { number: 4200, state: "OPEN", baseRefName: DEFAULT },
        ]));
      }
      if (key.includes("/milestones?state=all")) {
        return Promise.resolve(JSON.stringify([
          { number: 7, title: "Clean up", state: "open" },
        ]));
      }
      return Promise.resolve("[]");
    },
  });
  assertEquals(decision.decision, "allow");
  if (decision.decision === "allow") {
    assertEquals(decision.reason, "route-open");
  }
});

Deno.test("decideMilestoneBaseMerge - an open child is not merged while no rollup is open (Issue #4175)", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: 4109,
    baseRefName: BRANCH,
    ghCommandFn: (args) => {
      const key = args.join(" ");
      if (key.includes("pr list") && key.includes("--head")) {
        return Promise.resolve(JSON.stringify([
          {
            number: 3125,
            state: "MERGED",
            baseRefName: DEFAULT,
            mergedAt: "2026-10-13T13:58:25Z",
          },
        ]));
      }
      if (key.includes("pr list") && key.includes("--base")) {
        return Promise.resolve(JSON.stringify([
          { number: 4109, title: "Ship the widget" },
        ]));
      }
      if (key.includes("/milestones?state=all")) {
        return Promise.resolve(JSON.stringify([
          { number: 7, title: "Clean up", state: "open" },
        ]));
      }
      if (key.includes("/issues?milestone=")) {
        return Promise.resolve(JSON.stringify([
          { number: 3905, title: "Ship the widget" },
        ]));
      }
      return Promise.resolve("[]");
    },
  });
  assertEquals(decision.decision, "defer");
  if (decision.decision === "defer") {
    assertEquals(decision.reason, "route-waiting");
  }
});

Deno.test("a closed-route milestone with an open child gets a restored route and its held PR is armed (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  let rollupCreated = false;
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: REPO,
    prNumber: 4109,
    headRefName: "issue-3905-widget",
    baseRefName: BRANCH,
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
    isBaseProtectedFn: () => Promise.resolve(true),
    ghCommandFn: (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key.includes("pr list") && key.includes("--head")) {
        const rollups = [
          {
            number: 3125,
            state: "MERGED",
            baseRefName: DEFAULT,
            mergedAt: "2026-10-13T13:58:25Z",
          },
        ];
        if (rollupCreated) {
          rollups.push({
            number: 4200,
            state: "OPEN",
            baseRefName: DEFAULT,
            mergedAt: "",
          });
        }
        return Promise.resolve(JSON.stringify(rollups));
      }
      if (key.includes("pr list") && key.includes("--base")) {
        return Promise.resolve(JSON.stringify([
          { number: 4109, title: "Ship the widget" },
        ]));
      }
      if (key.includes("/milestones?state=all")) {
        return Promise.resolve(JSON.stringify([
          { number: 7, title: "Clean up", state: "open" },
        ]));
      }
      if (key.includes("/issues?milestone=")) {
        return Promise.resolve(JSON.stringify([
          { number: 3905, title: "Ship the widget" },
        ]));
      }
      if (key.includes("/compare/") && key.includes("ahead_by")) {
        return Promise.resolve(JSON.stringify({
          ahead_by: 2,
          files: [{ filename: "widget.txt" }],
        }));
      }
      if (key.includes("/compare/") && key.includes(".behind_by")) {
        return Promise.resolve("0\n");
      }
      if (args[0] === "pr" && args[1] === "create") {
        rollupCreated = true;
        return Promise.resolve(
          "https://github.com/owner/repo/pull/4200\n",
        );
      }
      if (args[0] === "pr" && args[1] === "merge") {
        return Promise.resolve("Enabled auto-merge\n");
      }
      return Promise.resolve("");
    },
  });

  assertEquals(result.result, AutoMergeResult.Enabled);
  const created = calls.find((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  assert(created, "a fresh rollup PR is opened from the milestone branch");
  assertEquals(created[created.indexOf("--head") + 1], BRANCH);
  assertEquals(created[created.indexOf("--base") + 1], DEFAULT);
  const body = created[created.indexOf("--body") + 1] ?? "";
  assertEquals(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*(?::\s*)?#\d+/i.test(body),
    false,
    "the rollup body must not carry a closing keyword",
  );
  assert(
    calls.some((args) =>
      args[0] === "pr" && args[1] === "merge" && args.includes("--auto") &&
      args.includes("4109")
    ),
    "the held child PR is armed",
  );
  assert(
    !calls.some((args) => args.includes("--disable-auto")),
    "the restored route is not disarmed",
  );
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "edit"),
    "the child is not retargeted onto the default branch",
  );
});

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function notAheadRouteGh(
  calls: string[][],
  ci: "pending" | "green",
  childMerged: { value: boolean },
  onCreate: (args: string[]) => Promise<string>,
): (args: string[]) => Promise<string> {
  return (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("pr list") && key.includes("--head")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 4077,
          state: "MERGED",
          baseRefName: DEFAULT,
          mergedAt: "2026-10-13T13:58:25Z",
        },
      ]));
    }
    if (key.includes("pr list") && key.includes("--base")) {
      return Promise.resolve(JSON.stringify([
        { number: 4109, title: "Ship the widget" },
      ]));
    }
    if (key.includes("/milestones?state=all")) {
      return Promise.resolve(JSON.stringify([
        { number: 7, title: "Clean up", state: "open" },
      ]));
    }
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve(JSON.stringify([
        { number: 3905, title: "Ship the widget" },
      ]));
    }
    if (key.includes("/compare/") && key.includes("ahead_by")) {
      return Promise.resolve(JSON.stringify(
        childMerged.value
          ? { ahead_by: 1, files: [{ filename: "widget.txt" }] }
          : { ahead_by: 0, files: [] },
      ));
    }
    if (args[0] === "pr" && args[1] === "view" && key.includes("headRefOid")) {
      return Promise.resolve(JSON.stringify({
        headSha: HEAD_SHA,
        committedDate: "2020-01-01T00:00:00Z",
      }));
    }
    if (
      args[0] === "pr" && args[1] === "view" &&
      key.includes("isCrossRepository")
    ) {
      return Promise.resolve(JSON.stringify({
        baseRefName: BRANCH,
        headRefName: "issue-3905-widget",
        isCrossRepository: false,
      }));
    }
    if (args[0] === "pr" && args[1] === "view" && key.includes("baseRefName")) {
      return Promise.resolve(BRANCH);
    }
    if (key.includes("default_branch")) {
      return Promise.resolve(DEFAULT);
    }
    if (
      args[0] === "api" && args[1] === "graphql" &&
      key.includes("statusCheckRollup")
    ) {
      const green = ci === "green";
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            n0: {
              commits: {
                nodes: [{
                  commit: {
                    oid: HEAD_SHA,
                    statusCheckRollup: {
                      state: green ? "SUCCESS" : "PENDING",
                      contexts: {
                        nodes: [{
                          __typename: "CheckRun",
                          databaseId: 11,
                          name: "validate",
                          status: green ? "COMPLETED" : "IN_PROGRESS",
                          conclusion: green ? "SUCCESS" : null,
                        }],
                      },
                    },
                  },
                }],
              },
            },
          },
        },
      }));
    }
    if (
      args[0] === "api" && args[1] === "graphql" && key.includes("behindBy")
    ) {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            p0: {
              mergeable: "MERGEABLE",
              reviewDecision: "",
              baseRef: { compare: { aheadBy: 1, behindBy: 0 } },
            },
          },
        },
      }));
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (args.includes("--merge")) {
        return Promise.reject(
          new Error("Merge commits are not allowed for this repository"),
        );
      }
      childMerged.value = true;
      return Promise.resolve("Merged\n");
    }
    if (args[0] === "pr" && args[1] === "create") {
      return onCreate(args);
    }
    if (args[0] === "issue" && args[1] === "reopen") {
      return Promise.resolve("reopened\n");
    }
    return Promise.resolve("");
  };
}

Deno.test("a not-ahead child on an unprotected base stays unmerged while CI is still running (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: REPO,
    prNumber: 4109,
    headRefName: "issue-3905-widget",
    baseRefName: BRANCH,
    fleetAuthors: ["vibe-bot"],
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
    isBaseProtectedFn: () => Promise.resolve(false),
    ghCommandFn: notAheadRouteGh(
      calls,
      "pending",
      { value: false },
      () => Promise.resolve("https://github.com/owner/repo/pull/4200\n"),
    ),
  });
  assertEquals(result.result, AutoMergeResult.Deferred);
  assertStringIncludes(result.message, "checks_pending");
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "merge"),
    "CI that is still running does not merge the child",
  );
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "create"),
    "no rollup is opened before the child lands",
  );
  assert(
    !calls.some((args) => args[0] === "issue" && args[1] === "reopen"),
    "a deferred gate leaves the issue untouched",
  );
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "edit"),
    "the child is not retargeted onto the default branch",
  );
});

Deno.test("a not-ahead child on an unprotected base is squash-merged once CI is green and a rollup is opened (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const childMerged = { value: false };
  const result = await enableAutoMerge({
    repo: REPO,
    prNumber: 4109,
    headRefName: "issue-3905-widget",
    baseRefName: BRANCH,
    fleetAuthors: ["vibe-bot"],
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
    isBaseProtectedFn: () => Promise.resolve(false),
    ghCommandFn: notAheadRouteGh(
      calls,
      "green",
      childMerged,
      () => Promise.resolve("https://github.com/owner/repo/pull/4200\n"),
    ),
  });
  assertEquals(result.result, AutoMergeResult.MergedDirectly);
  const merges = calls.filter((args) =>
    args[0] === "pr" && args[1] === "merge"
  );
  assertEquals(merges.length, 1, "a refused merge commit is not retried");
  const merge = merges[0]!;
  assert(merge.includes("--squash"));
  assert(merge.includes("--match-head-commit"));
  assertEquals(merge[merge.indexOf("--match-head-commit") + 1], HEAD_SHA);
  assert(!merge.includes("--merge"));
  assert(!merge.includes("--auto"));
  assert(!merge.includes("--base"));
  const mergeAt = calls.indexOf(merge);
  const createAt = calls.findIndex((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  assert(createAt > mergeAt, "the rollup is opened after the child merges");
  const created = calls[createAt]!;
  assertEquals(created[created.indexOf("--head") + 1], BRANCH);
  assertEquals(created[created.indexOf("--base") + 1], DEFAULT);
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "edit"),
    "the child is not retargeted onto the default branch",
  );
});

Deno.test("a not-ahead child on a protected base is armed with a squash when merge commits are refused (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const arm = async () => {
    const calls: string[][] = [];
    const result = await enableAutoMerge({
      repo: REPO,
      prNumber: 4109,
      headRefName: "issue-3905-widget",
      baseRefName: BRANCH,
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
      isBaseProtectedFn: () => Promise.resolve(true),
      ghCommandFn: (args) => {
        calls.push(args);
        const key = args.join(" ");
        if (key.includes("pr list") && key.includes("--head")) {
          return Promise.resolve(JSON.stringify([
            {
              number: 4077,
              state: "MERGED",
              baseRefName: DEFAULT,
              mergedAt: "2026-10-13T13:58:25Z",
            },
          ]));
        }
        if (key.includes("pr list") && key.includes("--base")) {
          return Promise.resolve(JSON.stringify([
            { number: 4109, title: "Ship the widget" },
          ]));
        }
        if (key.includes("/milestones?state=all")) {
          return Promise.resolve(JSON.stringify([
            { number: 7, title: "Clean up", state: "open" },
          ]));
        }
        if (key.includes("/issues?milestone=")) {
          return Promise.resolve(JSON.stringify([
            { number: 3905, title: "Ship the widget" },
          ]));
        }
        if (key.includes("/compare/") && key.includes("ahead_by")) {
          return Promise.resolve(JSON.stringify({ ahead_by: 0, files: [] }));
        }
        if (args[0] === "pr" && args[1] === "merge") {
          if (args.includes("--merge")) {
            return Promise.reject(
              new Error("Merge commits are not allowed for this repository"),
            );
          }
          return Promise.resolve("Enabled auto-merge\n");
        }
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve("OPEN");
        }
        return Promise.resolve("");
      },
    });
    return { calls, result };
  };

  const first = await arm();
  const second = await arm();
  for (const pass of [first, second]) {
    assertEquals(pass.result.result, AutoMergeResult.Enabled);
    const merges = pass.calls.filter((args) =>
      args[0] === "pr" && args[1] === "merge"
    );
    assertEquals(merges.length, 1, "a refused merge commit is not retried");
    assert(merges[0]!.includes("--auto"));
    assert(merges[0]!.includes("--squash"));
    assert(!merges[0]!.includes("--merge"));
    assert(
      !pass.calls.some((args) => args[0] === "pr" && args[1] === "create"),
      "the rollup waits until the armed merge has landed",
    );
    assert(
      !pass.calls.some((args) => args[0] === "issue" && args[1] === "reopen"),
      "arming leaves the issue untouched",
    );
    assert(
      !pass.calls.some((args) => args[0] === "pr" && args[1] === "edit"),
      "the child is not retargeted onto the default branch",
    );
  }
});

Deno.test("a protected not-ahead child opens a rollup on the scan after auto-merge lands (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  let landed = false;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (
      args[0] === "pr" && args[1] === "list" &&
      args[args.indexOf("--state") + 1] === "merged"
    ) {
      return Promise.resolve(
        landed
          ? JSON.stringify([{
            number: 4109,
            title: "Ship the widget (Issue #3905)",
            headRefName: "issue-3905-widget",
            mergedAt: "2026-10-20T00:00:00Z",
            body: "",
          }])
          : "[]",
      );
    }
    if (key.includes("pr list") && key.includes("--head")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 4077,
          state: "MERGED",
          baseRefName: DEFAULT,
          mergedAt: "2026-10-13T13:58:25Z",
        },
      ]));
    }
    if (key.includes("pr list") && key.includes("--base")) {
      return Promise.resolve(
        landed
          ? "[]"
          : JSON.stringify([{ number: 4109, title: "Ship the widget" }]),
      );
    }
    if (key.includes("/milestones?state=all")) {
      return Promise.resolve(JSON.stringify([
        { number: 7, title: "Clean up", state: "open" },
      ]));
    }
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve(
        landed
          ? "[]"
          : JSON.stringify([{ number: 3905, title: "Ship the widget" }]),
      );
    }
    if (key.includes("/compare/") && key.includes("ahead_by")) {
      return Promise.resolve(JSON.stringify(
        landed
          ? { ahead_by: 1, files: [{ filename: "widget.txt" }] }
          : { ahead_by: 0, files: [] },
      ));
    }
    if (key.includes("default_branch")) {
      return Promise.resolve(DEFAULT);
    }
    if (args[0] === "pr" && args[1] === "view" && key.includes("--jq")) {
      return Promise.resolve(landed ? "MERGED" : "OPEN");
    }
    if (args[0] === "pr" && args[1] === "view" && key.includes("baseRefName")) {
      return Promise.resolve(JSON.stringify({
        state: landed ? "MERGED" : "OPEN",
        baseRefName: BRANCH,
      }));
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: "CLOSED",
        labels: [],
        createdAt: "2026-10-01T00:00:00Z",
      }));
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (args.includes("--merge")) {
        return Promise.reject(
          new Error("Merge commits are not allowed for this repository"),
        );
      }
      return Promise.resolve("Enabled auto-merge\n");
    }
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.resolve("https://github.com/owner/repo/pull/4200\n");
    }
    return Promise.resolve("");
  };

  const armed = await enableAutoMerge({
    repo: REPO,
    prNumber: 4109,
    headRefName: "issue-3905-widget",
    baseRefName: BRANCH,
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
    isBaseProtectedFn: () => Promise.resolve(true),
    ghCommandFn: gh,
  });
  assertEquals(armed.result, AutoMergeResult.Enabled, armed.message);
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "create"),
    "arming does not open a rollup before the merge lands",
  );
  const armedMerge = calls.find((args) =>
    args[0] === "pr" && args[1] === "merge"
  );
  assert(armedMerge?.includes("--auto"));
  assert(armedMerge?.includes("--squash"));

  landed = true;
  const beforeScan = calls.length;
  await closeIssuesForMergedPrs([REPO], "bot", gh);
  const scanCalls = calls.slice(beforeScan);
  const created = scanCalls.find((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  assert(created, "the next scan opens a rollup after the child has merged");
  assertEquals(created[created.indexOf("--head") + 1], BRANCH);
  assertEquals(created[created.indexOf("--base") + 1], DEFAULT);
  assert(
    !scanCalls.some((args) => args[0] === "pr" && args[1] === "merge"),
    "the rollup does not need another open child pull request",
  );
  assert(
    !scanCalls.some((args) => args[0] === "issue" && args[1] === "reopen"),
    "a rollup that opens leaves the closed issue closed",
  );
});

Deno.test("a landed protected child whose rollup cannot be opened is not left closed (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const notes: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (
      args[0] === "pr" && args[1] === "list" &&
      args[args.indexOf("--state") + 1] === "merged"
    ) {
      return Promise.resolve(JSON.stringify([{
        number: 4109,
        title: "Ship the widget (Issue #3905)",
        headRefName: "issue-3905-widget",
        mergedAt: "2026-10-20T00:00:00Z",
        body: "",
      }]));
    }
    if (key.includes("pr list") && key.includes("--head")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 4077,
          state: "MERGED",
          baseRefName: DEFAULT,
          mergedAt: "2026-10-13T13:58:25Z",
        },
      ]));
    }
    if (key.includes("pr list") && key.includes("--base")) {
      return Promise.resolve("[]");
    }
    if (key.includes("/milestones?state=all")) {
      return Promise.resolve(JSON.stringify([
        { number: 7, title: "Clean up", state: "open" },
      ]));
    }
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve("[]");
    }
    if (key.includes("/compare/") && key.includes("ahead_by")) {
      return Promise.resolve(JSON.stringify({
        ahead_by: 1,
        files: [{ filename: "widget.txt" }],
      }));
    }
    if (key.includes("default_branch")) {
      return Promise.resolve(DEFAULT);
    }
    if (args[0] === "pr" && args[1] === "view" && key.includes("baseRefName")) {
      return Promise.resolve(JSON.stringify({
        state: "MERGED",
        baseRefName: BRANCH,
      }));
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: "CLOSED",
        labels: [],
        createdAt: "2026-10-01T00:00:00Z",
      }));
    }
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.reject(new Error("rollup refused"));
    }
    if (args[0] === "issue" && args[1] === "reopen") {
      return Promise.resolve("reopened\n");
    }
    return Promise.resolve("");
  };

  await closeIssuesForMergedPrs([REPO], "bot", gh, "planning", undefined, {
    logFn: (message) => notes.push(message),
  });
  const reopened = calls.find((args) =>
    args[0] === "issue" && args[1] === "reopen"
  );
  assert(reopened, "the closed issue is reopened");
  assert(reopened.includes("3905"));
  assert(
    !calls.some((args) => args[0] === "issue" && args[1] === "close"),
    "the issue is not closed again while the rollup is missing",
  );
  assert(notes.some((message) => message.includes("rollup refused")));
  assert(notes.every((message) => !message.includes("WARNING:")));
  assert(notes.every((message) => !message.includes("ERROR:")));
});

Deno.test("a not-ahead child whose rollup cannot be opened does not leave its issue closed (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: REPO,
    prNumber: 4109,
    headRefName: "issue-3905-widget",
    baseRefName: BRANCH,
    fleetAuthors: ["vibe-bot"],
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: DEFAULT }),
    isBaseProtectedFn: () => Promise.resolve(false),
    ghCommandFn: notAheadRouteGh(
      calls,
      "green",
      { value: false },
      () => Promise.reject(new Error("rollup refused")),
    ),
  });
  assertEquals(result.result, AutoMergeResult.Failed);
  assertStringIncludes(result.message, "rollup refused");
  const reopened = calls.find((args) =>
    args[0] === "issue" && args[1] === "reopen"
  );
  assert(reopened, "the milestone issue is reopened");
  assert(reopened.includes("3905"));
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "edit"),
    "the child is not retargeted onto the default branch",
  );
});

Deno.test("a merged rollup does not count when the branch still has a file diff (Issue #4175)", async () => {
  const existing = await hasExistingMilestoneSummaryPr(
    REPO,
    "Clean up",
    BRANCH,
    (args) => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return Promise.resolve(JSON.stringify([{
          number: 4077,
          title: "Milestone rollup",
          headRefName: BRANCH,
          state: "MERGED",
          isCrossRepository: false,
        }]));
      }
      if (key.includes("/compare/") && key.includes("ahead_by")) {
        return Promise.resolve(JSON.stringify({
          ahead_by: 1,
          files: [{ filename: "widget.txt" }],
        }));
      }
      return Promise.resolve("[]");
    },
    undefined,
    [],
    "main",
  );
  assertEquals(existing, { ok: true, value: null });
});

// ---------------------------------------------------------------------------
// Sync must not open a pull request into a route that stays closed
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed", detail: "checked", output: "" });

async function withGatedMilestoneClone(
  body: (clone: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "issue-4175-sync-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  try {
    await gitOk(["init", "--bare", "-b", "main", remote], root);
    await gitOk(["clone", remote, clone], root);
    await gitOk(["config", "user.email", "t@example.com"], clone);
    await gitOk(["config", "user.name", "Test"], clone);
    await gitOk(["config", "commit.gpgsign", "false"], clone);
    await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
    await gitOk(["add", "README.md"], clone);
    await gitOk(["commit", "-m", "seed"], clone);
    await gitOk(["push", "-u", "origin", "main"], clone);
    await gitOk(["checkout", "-b", "milestone/1048"], clone);
    await Deno.writeTextFile(`${clone}/milestone.txt`, "milestone work\n");
    await gitOk(["add", "milestone.txt"], clone);
    await gitOk(["commit", "-m", "milestone work"], clone);
    await gitOk(["push", "-u", "origin", "milestone/1048"], clone);
    await gitOk(["checkout", "main"], clone);
    await Deno.writeTextFile(`${clone}/README.md`, "seed\nmain moved\n");
    await gitOk(["add", "README.md"], clone);
    await gitOk(["commit", "-m", "main moves on"], clone);
    await gitOk(["push", "origin", "main"], clone);
    await gitOk(["checkout", "milestone/1048"], clone);

    const hook = `${remote}/hooks/pre-receive`;
    await Deno.writeTextFile(
      hook,
      [
        "#!/bin/sh",
        "while read -r old new ref; do",
        '  case "$ref" in',
        "    refs/heads/milestone/*)",
        '      echo "! [remote rejected] $ref (push declined due to repository rule violations)" >&2',
        "      exit 1;;",
        "  esac",
        "done",
        "exit 0",
      ].join("\n") + "\n",
    );
    await Deno.chmod(hook, 0o755);
    await body(clone);
  } finally {
    _resetGhSpawnRunner();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("no sync PR is opened into a closed route (Issue #4175)", async () => {
  await withGatedMilestoneClone(async (clone) => {
    const ghCalls: string[][] = [];
    _setGhSpawnRunner((args) => {
      ghCalls.push([...args]);
      const state = args[args.indexOf("--state") + 1];
      if (args[1] === "list" && state === "all") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify([
            {
              number: 3287,
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-10-13T13:58:25Z",
            },
          ]),
          stderr: "",
        });
      }
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "[]",
          stderr: "",
        });
      }
      if (args[0] === "api" && args.join(" ").includes("/milestones")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify([
            { number: 3, title: "1048", state: "closed" },
          ]),
          stderr: "",
        });
      }
      if (args[1] === "create") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "https://github.com/owner/repo/pull/4100\n",
          stderr: "",
        });
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: "",
        stderr: "",
      });
    });

    const result = await syncMilestoneBranchWithDefault(
      "milestone/1048",
      "main",
      { cwd: clone },
      "owner/repo",
      passingGate,
    );
    assert(
      result.ok,
      `sync should report the refusal, not throw: ${
        !result.ok && result.error.message
      }`,
    );
    assert(
      !ghCalls.some((args) => args[1] === "create"),
      `a sync PR was opened into a closed route: ${
        ghCalls.map((args) => args.join(" ")).join("\n")
      }`,
    );
    assertStringIncludes(result.value.message, "sync PR not opened");
  });
});

Deno.test("no sync PR is opened into a not-ahead route with an open child (Issue #4175)", async () => {
  await withGatedMilestoneClone(async (clone) => {
    const openCalls: string[][] = [];
    _setGhSpawnRunner((args) => {
      openCalls.push([...args]);
      const state = args[args.indexOf("--state") + 1];
      const key = args.join(" ");
      if (args[1] === "list" && state === "all") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify([
            {
              number: 4077,
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-10-13T13:58:25Z",
            },
          ]),
          stderr: "",
        });
      }
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "[]",
          stderr: "",
        });
      }
      if (key.includes("/milestones")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify([
            { number: 3, title: "1048", state: "open" },
          ]),
          stderr: "",
        });
      }
      if (key.includes("/issues?milestone=")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify([
            { number: 3905, title: "Ship the widget" },
          ]),
          stderr: "",
        });
      }
      if (key.includes("/compare/") && key.includes("ahead_by")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: JSON.stringify({ ahead_by: 0, files: [] }),
          stderr: "",
        });
      }
      if (args[1] === "create") {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "https://github.com/owner/repo/pull/4100\n",
          stderr: "",
        });
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: "",
        stderr: "",
      });
    });
    const openRoute = await syncMilestoneBranchWithDefault(
      "milestone/1048",
      "main",
      { cwd: clone },
      "owner/repo",
      passingGate,
    );
    assert(
      openRoute.ok,
      `sync should report the refusal, not throw: ${
        !openRoute.ok && openRoute.error.message
      }`,
    );
    assert(
      !openCalls.some((args) => args[1] === "create"),
      `a sync PR was opened into a route with no rollup: ${
        openCalls.map((args) => args.join(" ")).join("\n")
      }`,
    );
    assertStringIncludes(openRoute.value.message, "sync PR not opened");
  });
});
