/**
 * The milestone sync must leave the default branch in the branch's ancestry,
 * and must never revive a file the default branch deleted (Issue #1048).
 *
 * Real git repositories throughout: a bare remote, a clone, a milestone branch
 * and a default branch that has moved on — the state every sync cycle starts
 * from. The two properties pinned here are the ones the squash sync broke:
 *
 *   1. `git merge-base --is-ancestor <default> <milestone>` holds afterwards.
 *   2. A modify/delete conflict resolves as a **delete**, not as "keep it".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import {
  isMilestoneSyncBranch,
  mergeMethodFlagForHead,
  raiseMilestoneSyncPr,
  syncBranchFor,
} from "../lib/milestone_sync_pr.ts";

// ---------------------------------------------------------------------------
// Fixture
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
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

interface Fixture {
  root: string;
  clone: string;
  cleanup: () => Promise<void>;
}

/**
 * `main` carries `lib/fleet_health.ts`; `milestone/1048` forks from it, then
 * `main` deletes the file — the exact starting state of the live fault.
 */
async function setupDeletedOnMain(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1048-sync-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;

  await gitOk(["init", "--bare", "-b", "main", remote], root);
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["config", "commit.gpgsign", "false"], clone);

  await Deno.mkdir(`${clone}/lib`, { recursive: true });
  await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
  await Deno.writeTextFile(
    `${clone}/lib/fleet_health.ts`,
    "export const a=1;\n",
  );
  await gitOk(["add", "."], clone);
  await gitOk(["commit", "-m", "seed with the fleet-health subsystem"], clone);
  await gitOk(["push", "-u", "origin", "main"], clone);

  await gitOk(["checkout", "-b", "milestone/1048"], clone);
  await Deno.writeTextFile(`${clone}/milestone.txt`, "milestone work\n");
  await gitOk(["add", "milestone.txt"], clone);
  await gitOk(["commit", "-m", "milestone work"], clone);
  await gitOk(["push", "-u", "origin", "milestone/1048"], clone);

  // main deletes the subsystem and moves on.
  await gitOk(["checkout", "main"], clone);
  await gitOk(["rm", "lib/fleet_health.ts"], clone);
  await gitOk(["commit", "-m", "Remove the fleet-health subsystem"], clone);
  await gitOk(["push", "origin", "main"], clone);
  await gitOk(["checkout", "milestone/1048"], clone);

  return {
    root,
    clone,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

// ---------------------------------------------------------------------------
// The ancestry assertion
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - leaves the default branch an ancestor of the milestone branch",
  async () => {
    const fx = await setupDeletedOnMain();
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1048",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );
      assert(
        result.ok,
        `expected a successful sync: ${!result.ok && result.error.message}`,
      );

      const ancestry = await git(
        ["merge-base", "--is-ancestor", "main", "milestone/1048"],
        fx.clone,
      );
      assertEquals(
        ancestry.code,
        0,
        "a squash sync would leave main outside the branch's ancestry",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Modify/delete must resolve as a delete
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a file the default branch deleted stays deleted",
  async () => {
    const fx = await setupDeletedOnMain();
    try {
      // The milestone branch edits the file main deleted — modify/delete.
      await Deno.mkdir(`${fx.clone}/lib`, { recursive: true });
      await Deno.writeTextFile(
        `${fx.clone}/lib/fleet_health.ts`,
        "export const a=2;\n",
      );
      await gitOk(["add", "lib/fleet_health.ts"], fx.clone);
      await gitOk(["commit", "-m", "Issue #869: tweak fleet health"], fx.clone);
      await gitOk(["push", "origin", "milestone/1048"], fx.clone);

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1048",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );
      assert(
        result.ok,
        `expected a successful sync: ${!result.ok && result.error.message}`,
      );
      assertStringIncludes(result.value, "lib/fleet_health.ts");

      const tree = await gitOk(
        ["ls-tree", "-r", "--name-only", "milestone/1048"],
        fx.clone,
      );
      assert(
        !tree.split("\n").includes("lib/fleet_health.ts"),
        `the deleted file must not come back; tree was:\n${tree}`,
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a genuine content conflict still takes the default branch's side",
  async () => {
    const fx = await setupDeletedOnMain();
    try {
      // Both sides edit the same file: the ordinary conflict, unchanged.
      await gitOk(["checkout", "main"], fx.clone);
      await Deno.writeTextFile(`${fx.clone}/shared.txt`, "main side\n");
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "main edits shared"], fx.clone);
      await gitOk(["push", "origin", "main"], fx.clone);
      await gitOk(["checkout", "milestone/1048"], fx.clone);
      await Deno.writeTextFile(`${fx.clone}/shared.txt`, "milestone side\n");
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "milestone edits shared"], fx.clone);
      await gitOk(["push", "origin", "milestone/1048"], fx.clone);

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1048",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );
      assert(
        result.ok,
        `expected a successful sync: ${!result.ok && result.error.message}`,
      );
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/shared.txt`),
        "main side\n",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// The sync PR lands as a merge commit
// ---------------------------------------------------------------------------

Deno.test("mergeMethodFlagForHead - only a milestone sync branch merges", () => {
  assertEquals(
    mergeMethodFlagForHead(syncBranchFor("milestone/863")),
    "--merge",
  );
  assertEquals(mergeMethodFlagForHead("issue-1048-fix"), "--squash");
  assertEquals(mergeMethodFlagForHead("milestone/863"), "--squash");
  assertEquals(mergeMethodFlagForHead(undefined), "--squash");
  assertEquals(mergeMethodFlagForHead(""), "--squash");
  assert(isMilestoneSyncBranch("sync/milestone-863"));
  assert(!isMilestoneSyncBranch("sync/other"));
});

Deno.test("raiseMilestoneSyncPr - arms auto-merge as a merge commit, not a squash", async () => {
  const ghCalls: string[][] = [];
  const result = await raiseMilestoneSyncPr(
    "owner/repo",
    "milestone/863",
    "main",
    {
      git: () => Promise.resolve({ code: 0, stderr: "" }),
      gh: (args) => {
        ghCalls.push(args);
        if (args[1] === "list") return Promise.resolve("[]");
        if (args[1] === "create") {
          return Promise.resolve("https://github.com/owner/repo/pull/77\n");
        }
        return Promise.resolve("");
      },
    },
  );

  assert(result.ok);
  const merge = ghCalls.find((args) => args[1] === "merge");
  assert(merge, "auto-merge must be armed");
  assert(
    merge.includes("--merge"),
    `expected a merge commit, got: ${merge.join(" ")}`,
  );
  assert(
    !merge.includes("--squash"),
    "a squashed sync is what put main outside the branch's ancestry",
  );
});

Deno.test("raiseMilestoneSyncPr - a repo that forbids merge commits gets a loud squash", async () => {
  const attempted: string[] = [];
  const logged: string[] = [];
  const result = await raiseMilestoneSyncPr(
    "owner/repo",
    "milestone/863",
    "main",
    {
      git: () => Promise.resolve({ code: 0, stderr: "" }),
      gh: (args) => {
        if (args[1] === "list") return Promise.resolve("[]");
        if (args[1] === "create") {
          return Promise.resolve("https://github.com/owner/repo/pull/78\n");
        }
        if (args[1] === "merge") {
          const method = args.includes("--merge") ? "--merge" : "--squash";
          attempted.push(method);
          if (method === "--merge") {
            return Promise.reject(
              new Error("Merge commits are not allowed on this repository"),
            );
          }
        }
        return Promise.resolve("");
      },
      log: (message) => logged.push(message),
    },
  );

  assert(result.ok);
  assertEquals(attempted, ["--merge", "--squash"]);
  assert(
    logged.some((line) => line.includes("armed as a SQUASH")),
    `the downgrade must be loud; logged: ${JSON.stringify(logged)}`,
  );
});
