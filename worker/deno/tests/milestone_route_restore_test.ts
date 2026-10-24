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
import { restoreClosedMilestoneRoute } from "../lib/milestone_route_restore.ts";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge as enableAutoMergeReal,
} from "../lib/pr_auto_merge.ts";
import { armWithNoReviewRecord } from "./support/arm_with_no_review_record.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/clean-up";
const DEFAULT = "Develop";

function enableAutoMerge(
  options: Parameters<typeof enableAutoMergeReal>[0],
): ReturnType<typeof enableAutoMergeReal> {
  return armWithNoReviewRecord(enableAutoMergeReal, options);
}

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
  const created = calls.find((args) => args[0] === "pr" && args[1] === "create");
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

Deno.test("a not-ahead child stays unarmed, and landed work still reaches a rollup (Issue #4175)", async () => {
  _resetMilestoneBehindMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const waiting = await enableAutoMerge({
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
      if (args[0] === "pr" && args[1] === "create") {
        return Promise.resolve("https://github.com/owner/repo/pull/4200\n");
      }
      if (args[0] === "pr" && args[1] === "merge") {
        return Promise.resolve("Enabled auto-merge\n");
      }
      return Promise.resolve("");
    },
  });
  assertEquals(waiting.result, AutoMergeResult.Deferred);
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "merge"),
    "the child is not armed while the branch is not ahead",
  );
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "create"),
    "no rollup is opened when the branch is not ahead",
  );
  assert(
    !calls.some((args) => args.includes("--disable-auto")),
    "a waiting route is not held",
  );
  assert(
    !calls.some((args) => args[0] === "pr" && args[1] === "edit"),
    "the child is not retargeted onto the default branch",
  );

  // The child's commit has landed on the milestone branch. No open child
  // remains. The rollup must still carry widget.txt to the default branch.
  const root = await Deno.makeTempDir({ prefix: "issue-4175-landed-" });
  const clone = `${root}/clone`;
  try {
    await gitOk(["init", "-b", "main", clone], root);
    await gitOk(["config", "user.email", "t@example.com"], clone);
    await gitOk(["config", "user.name", "Test"], clone);
    await gitOk(["config", "commit.gpgsign", "false"], clone);
    await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
    await gitOk(["add", "README.md"], clone);
    await gitOk(["commit", "-m", "seed"], clone);
    await gitOk(["checkout", "-b", "milestone/clean-up"], clone);
    await Deno.writeTextFile(`${clone}/widget.txt`, "the widget\n");
    await gitOk(["add", "widget.txt"], clone);
    await gitOk(["commit", "-m", "Ship the widget"], clone);

    const diffNames = (await gitOk(
      ["diff", "--name-only", "main...milestone/clean-up"],
      clone,
    )).trim().split("\n");
    assert(diffNames.includes("widget.txt"));

    const created: string[][] = [];
    const restored = await restoreClosedMilestoneRoute({
      repo: REPO,
      milestoneBranch: BRANCH,
      defaultBranch: "main",
      ghCommandFn: (args) => {
        const key = args.join(" ");
        if (key.includes("pr list") && key.includes("--head")) {
          return Promise.resolve(JSON.stringify([
            {
              number: 4077,
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-10-13T13:58:25Z",
            },
          ]));
        }
        if (key.includes("/milestones?state=all")) {
          return Promise.resolve(JSON.stringify([
            { number: 7, title: "Clean up", state: "open" },
          ]));
        }
        if (key.includes("/compare/") && key.includes("ahead_by")) {
          return Promise.resolve(JSON.stringify({
            ahead_by: 1,
            files: diffNames.map((filename) => ({ filename })),
          }));
        }
        if (args[0] === "pr" && args[1] === "create") {
          created.push(args);
          return Promise.resolve("https://github.com/owner/repo/pull/4200\n");
        }
        return Promise.resolve("[]");
      },
    });
    assertEquals(restored.action, "created");
    assertEquals(created.length, 1);
    assertEquals(created[0]![created[0]!.indexOf("--head") + 1], BRANCH);
    assertEquals(created[0]![created[0]!.indexOf("--base") + 1], "main");

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
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
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
