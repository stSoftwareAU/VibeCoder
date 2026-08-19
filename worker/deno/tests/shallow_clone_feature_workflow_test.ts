/**
 * Integration tests for the shallow-clone feature-branch workflow (Issue #1503).
 *
 * `setupRepo()` now clones the primary repository with
 * `--depth=1 --no-single-branch`. These tests verify that the full
 * feature-branch workflow still works against a clone produced with
 * exactly those flags:
 *
 *   1. Shallow clone a local fixture repo with `--depth=1 --no-single-branch`
 *      and confirm the resulting clone is shallow.
 *   2. Check out a feature branch from an origin remote-tracking ref (which
 *      `--no-single-branch` preserves for every upstream branch).
 *   3. Create a commit on the feature branch.
 *   4. Run commit-range operations (`git log BASE..HEAD`, `rev-list --count`)
 *      — `ensureHistoryDepth()` deepens on demand so these succeed.
 *   5. Merge the default branch back into the feature branch. The merge
 *      must succeed and the working tree must end up with both commits
 *      (the merged upstream change and the feature-branch change).
 *
 * Also covers a unit-level check of `buildShallowCloneArgs()` — the pure
 * helper that produces the argument list for the `gh repo clone` call —
 * so the presence of the `--depth=1 --no-single-branch` flags is enforced
 * by a real function call, not by grepping source.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildShallowCloneArgs } from "../commands/git_operations.ts";
import { ensureHistoryDepth, isShallowRepo } from "../lib/git_history.ts";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";

// ---------------------------------------------------------------------------
// buildShallowCloneArgs — pure helper
// ---------------------------------------------------------------------------

Deno.test("buildShallowCloneArgs - passes --depth=1 --no-single-branch to git clone", () => {
  const args = buildShallowCloneArgs("owner/repo", "/work/repo");
  assertEquals(args[0], "repo");
  assertEquals(args[1], "clone");
  assertEquals(args[2], "owner/repo");
  assertEquals(args[3], "/work/repo");
  // The literal `--` separator is required so gh forwards the flags to
  // the underlying git clone invocation.
  assertEquals(args[4], "--");
  // Order after `--` is not semantically important, but both flags must
  // be present.
  assert(args.includes("--depth=1"), "missing --depth=1");
  assert(args.includes("--no-single-branch"), "missing --no-single-branch");
});

Deno.test("buildShallowCloneArgs - preserves caller-supplied repo path", () => {
  const args = buildShallowCloneArgs("acme/widgets", "/tmp/cloned/widgets");
  assertEquals(args[3], "/tmp/cloned/widgets");
});

// ---------------------------------------------------------------------------
// Helpers for the end-to-end fixture test
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

// ---------------------------------------------------------------------------
// End-to-end fixture workflow
// ---------------------------------------------------------------------------

Deno.test(
  "shallow clone - feature-branch workflow succeeds end-to-end against a fixture repo",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "shallow_clone_test_" });
    const upstream = `${tmp}/upstream`;
    const downstream = `${tmp}/downstream`;
    await Deno.mkdir(upstream, { recursive: true });

    try {
      // ---------------------------------------------------------------
      // Step 1 — Build an upstream fixture with >1 commit on the default
      // branch (so a shallow depth=1 clone really is shallow).
      // ---------------------------------------------------------------
      assertEquals((await runGit(["init", "-b", "main"], upstream)).code, 0);
      await runGit(["config", "user.email", "t@t"], upstream);
      await runGit(["config", "user.name", "t"], upstream);
      for (let i = 1; i <= 5; i += 1) {
        await Deno.writeTextFile(`${upstream}/file.txt`, `content ${i}\n`);
        await runGit(["add", "file.txt"], upstream);
        await runGit(["commit", "-m", `commit ${i}`], upstream);
      }

      // ---------------------------------------------------------------
      // Step 2 — Shallow clone the fixture with exactly the flags the
      // worker now passes through to git clone: --depth=1 and
      // --no-single-branch. Use file:// so git honours --depth (a
      // plain-path clone sidesteps the protocol and hardlinks .git).
      // ---------------------------------------------------------------
      const cloneResult = await runGit(
        [
          "clone",
          "--depth=1",
          "--no-single-branch",
          `file://${upstream}`,
          downstream,
        ],
        tmp,
      );
      assertEquals(
        cloneResult.code,
        0,
        `shallow clone failed: ${cloneResult.stderr}`,
      );

      // The clone must actually be shallow.
      const shallow = await isShallowRepo({ cwd: downstream });
      assert(shallow.ok);
      if (shallow.ok) assertEquals(shallow.value, true);

      // --no-single-branch keeps remote-tracking refs for every branch.
      const remoteRefs = await runGit(
        ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"],
        downstream,
      );
      assertEquals(remoteRefs.code, 0);
      assertStringIncludes(remoteRefs.stdout, "refs/remotes/origin/main");

      // Configure identity on the downstream clone for commits below.
      await runGit(["config", "user.email", "t@t"], downstream);
      await runGit(["config", "user.name", "t"], downstream);

      // Check out main locally so subsequent operations work on a branch.
      assertEquals(
        (await runGit(["checkout", "main"], downstream)).code,
        0,
      );

      // ---------------------------------------------------------------
      // Step 3 — Create a feature branch from the base (main). This is
      // the same code path `git_operations.ts setup-repo` + callers
      // exercise in production via `createFeatureBranchFromBase()`.
      // It first runs `git fetch origin <base>` (no-op here against a
      // local file:// remote) and then `checkout -b`.
      // ---------------------------------------------------------------
      const branchResult = await createFeatureBranchFromBase(
        "issue-1503-feature",
        "main",
        { cwd: downstream },
      );
      assert(
        branchResult.ok,
        branchResult.ok ? "" : branchResult.error.message,
      );

      // Make a commit on the feature branch.
      await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
      assertEquals((await runGit(["add", "feature.txt"], downstream)).code, 0);
      assertEquals(
        (await runGit(["commit", "-m", "feature commit"], downstream)).code,
        0,
      );

      // ---------------------------------------------------------------
      // Step 4 — Add another commit to upstream main so the branches
      // diverge. Feature branch now has history the default branch
      // does not, and vice versa — the textbook "needs common ancestor"
      // scenario that ensureHistoryDepth() exists to resolve.
      // ---------------------------------------------------------------
      await Deno.writeTextFile(`${upstream}/file.txt`, "content 6\n");
      await runGit(["add", "file.txt"], upstream);
      await runGit(["commit", "-m", "commit 6 upstream"], upstream);

      // Fetch the new upstream commit into the shallow clone. This
      // mirrors what ensureDefaultBranchCurrent / feature-sync does.
      assertEquals(
        (await runGit(["fetch", "origin", "main"], downstream)).code,
        0,
      );

      // ---------------------------------------------------------------
      // Step 5 — Commit-range operations must succeed. Call the real
      // ensureHistoryDepth() helper to deepen on demand, then run the
      // range queries.
      // ---------------------------------------------------------------
      const deepenResult = await ensureHistoryDepth(
        ["origin/main", "HEAD"],
        { cwd: downstream },
      );
      assert(
        deepenResult.ok,
        deepenResult.ok ? "" : deepenResult.error.message,
      );

      const logRange = await runGit(
        ["log", "origin/main..HEAD", "--oneline"],
        downstream,
      );
      assertEquals(logRange.code, 0);
      assertStringIncludes(logRange.stdout, "feature commit");

      const revCount = await runGit(
        ["rev-list", "--count", "origin/main..HEAD"],
        downstream,
      );
      assertEquals(revCount.code, 0);
      assertEquals(revCount.stdout.trim(), "1");

      // ---------------------------------------------------------------
      // Step 6 — Merge the default branch back into the feature branch.
      // This is the operation most dependent on having the common
      // ancestor available — ensureHistoryDepth above made it so.
      // ---------------------------------------------------------------
      const mergeResult = await runGit(
        [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "merge",
          "--no-ff",
          "-m",
          "merge main",
          "origin/main",
        ],
        downstream,
      );
      assertEquals(
        mergeResult.code,
        0,
        `merge failed: ${mergeResult.stderr}`,
      );

      // ---------------------------------------------------------------
      // Step 7 — Working-tree assertion. After the merge the feature
      // branch must contain both the upstream change and the feature
      // change.
      // ---------------------------------------------------------------
      const fileTxt = await Deno.readTextFile(`${downstream}/file.txt`);
      assertEquals(fileTxt.trim(), "content 6");

      const featureTxt = await Deno.readTextFile(`${downstream}/feature.txt`);
      assertEquals(featureTxt.trim(), "feature work");

      // Log should now contain both the feature commit and the merged
      // upstream commit.
      const finalLog = await runGit(
        ["log", "--oneline", "-n", "10"],
        downstream,
      );
      assertEquals(finalLog.code, 0);
      assertStringIncludes(finalLog.stdout, "feature commit");
      assertStringIncludes(finalLog.stdout, "commit 6 upstream");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
