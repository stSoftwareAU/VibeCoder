/**
 * Tests for the milestone sync's stale local default ref refusal, the
 * deepen-failure refusal, and the unshallow-merge retry (Issue #2896).
 *
 * `syncMilestoneBranchWithDefault` used to ignore the result of
 * `ensureDefaultBranchCurrent` and of `ensureHistoryDepth`, so a stale local
 * default ref (one `branch -f` could not move, e.g. because another
 * worktree holds the branch — Issue #394) was merged in silently, and a
 * shallow clone whose deepen failed to reach the merge base hit
 * `git merge`'s "refusing to merge unrelated histories" refusal and reported
 * that as a permanent, non-conflict failure even though a merge base exists
 * on the remote.
 *
 * Uses real git throughout — no mocks — with tempdirs cleaned in `finally`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { mergeWithUnshallowRetry } from "../lib/git_merge_unshallow_retry.ts";

/** Run git in `cwd`, returning its exit code, stdout and stderr. */
async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command("git", {
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
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/** A gate that passes without running any real quality script. */
async function fakePassingGate(
  _repoDir: string,
): Promise<{ status: "skipped"; detail: string; output: string }> {
  return { status: "skipped", detail: "skipped (test gate)", output: "" };
}

/**
 * A bare origin with ten linear commits on `main`, and a milestone branch
 * forked from an early commit (commit 3) carrying one commit of its own,
 * both pushed.
 */
async function buildOriginWithForkedMilestone(tmp: string): Promise<{
  originPath: string;
  seedPath: string;
}> {
  const originPath = `${tmp}/origin.git`;
  const seedPath = `${tmp}/seed`;

  await Deno.mkdir(originPath, { recursive: true });
  assertEquals((await git(["init", "--bare"], originPath)).code, 0);
  assertEquals(
    (await git(["symbolic-ref", "HEAD", "refs/heads/main"], originPath)).code,
    0,
  );

  assertEquals((await git(["clone", originPath, seedPath], tmp)).code, 0);
  await git(["config", "user.email", "test@example.com"], seedPath);
  await git(["config", "user.name", "Test User"], seedPath);

  let forkSha = "";
  for (let i = 1; i <= 10; i++) {
    await Deno.writeTextFile(`${seedPath}/file${i}.txt`, `content ${i}\n`);
    await git(["add", `file${i}.txt`], seedPath);
    await git(["commit", "-m", `Commit ${i}`], seedPath);
    if (i === 3) {
      forkSha = (await git(["rev-parse", "HEAD"], seedPath)).stdout;
    }
  }
  assertEquals((await git(["push", "origin", "main"], seedPath)).code, 0);

  // Fork the milestone branch from commit 3.
  assertEquals(
    (await git(["checkout", "-b", "milestone/v1-0", forkSha], seedPath)).code,
    0,
  );
  await Deno.writeTextFile(`${seedPath}/milestone-only.txt`, "milestone\n");
  await git(["add", "milestone-only.txt"], seedPath);
  await git(["commit", "-m", "Milestone-only commit"], seedPath);
  assertEquals(
    (await git(["push", "origin", "milestone/v1-0"], seedPath)).code,
    0,
  );

  // Return seed to main so later pushes from it land on main.
  assertEquals((await git(["checkout", "main"], seedPath)).code, 0);

  return { originPath, seedPath };
}

Deno.test(
  "syncMilestoneBranchWithDefault - refuses to merge a stale local default ref that could not be moved (Issue #2896, regression)",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "milestone_sync_stale_default_",
    });
    let heldWorktreeAdded = false;
    try {
      const { originPath, seedPath } = await buildOriginWithForkedMilestone(
        tmp,
      );

      // Shallow clone — `--depth=1 --no-single-branch`, matching production.
      const clonePath = `${tmp}/shallow`;
      assertEquals(
        (await git(
          [
            "clone",
            "--depth=1",
            "--no-single-branch",
            `file://${originPath}`,
            clonePath,
          ],
          tmp,
        )).code,
        0,
      );
      await git(["config", "user.email", "test@example.com"], clonePath);
      await git(["config", "user.name", "Test User"], clonePath);

      // Check out the milestone branch in the clone (not the default
      // branch, so the clone itself does not block holding `main` below).
      assertEquals(
        (await git(["fetch", "origin", "milestone/v1-0"], clonePath)).code,
        0,
      );
      assertEquals(
        (await git(["checkout", "milestone/v1-0"], clonePath)).code,
        0,
      );

      // Push a further commit to `main` on origin from the seed clone.
      await Deno.writeTextFile(`${seedPath}/file11.txt`, "content 11\n");
      await git(["add", "file11.txt"], seedPath);
      await git(["commit", "-m", "Commit 11"], seedPath);
      assertEquals((await git(["push", "origin", "main"], seedPath)).code, 0);

      const originMainBefore = (await git(
        ["rev-parse", "main"],
        originPath,
      )).stdout;

      // Hold `main` in another worktree off the clone, so the clone's own
      // `git branch -f main origin/main` is refused (Issue #394) — the
      // clone itself is on `milestone/v1-0`, not `main`, so this does not
      // block the test's own checkout.
      const heldPath = `${tmp}/held`;
      const addWorktree = await git(
        ["worktree", "add", heldPath, "main"],
        clonePath,
      );
      assertEquals(addWorktree.code, 0, addWorktree.stderr);
      heldWorktreeAdded = true;

      // Precondition: the clone's local `main` cannot be moved to match
      // origin while the worktree holds it.
      const forceAttempt = await git(
        ["branch", "-f", "main", "origin/main"],
        clonePath,
      );
      assertEquals(
        forceAttempt.code === 0,
        false,
        "precondition: branch -f must be refused while another worktree holds 'main'",
      );

      const originMilestoneBefore = (await git(
        ["rev-parse", "milestone/v1-0"],
        originPath,
      )).stdout;

      const result = await syncMilestoneBranchWithDefault(
        "milestone/v1-0",
        "main",
        { cwd: clonePath },
        undefined,
        fakePassingGate,
        fakePassingGate,
      );

      assertEquals(
        result.ok,
        false,
        "a stale local default ref must not be merged in silently",
      );
      if (!result.ok) {
        const msg = result.error.message.toLowerCase();
        assert(
          msg.includes("stale") || msg.includes("could not be moved"),
          `expected the refusal to name the stale/unmoved ref, got: ${result.error.message}`,
        );
      }

      // Origin's milestone branch must be unchanged — nothing was merged
      // and pushed from the stale ref.
      const originMilestoneAfter = (await git(
        ["rev-parse", "milestone/v1-0"],
        originPath,
      )).stdout;
      assertEquals(originMilestoneAfter, originMilestoneBefore);
      // Sanity: origin's main really did move (the staleness is real).
      assertEquals(
        (await git(["rev-parse", "main"], originPath)).stdout,
        originMainBefore,
      );
    } finally {
      if (heldWorktreeAdded) {
        await git(["worktree", "remove", "--force", `${tmp}/held`], tmp)
          .catch(() => undefined);
      }
      await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - succeeds on a shallow clone when the local default ref is not blocked (Issue #2896)",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "milestone_sync_shallow_ok_",
    });
    try {
      const { originPath, seedPath } = await buildOriginWithForkedMilestone(
        tmp,
      );

      const clonePath = `${tmp}/shallow`;
      assertEquals(
        (await git(
          [
            "clone",
            "--depth=1",
            "--no-single-branch",
            `file://${originPath}`,
            clonePath,
          ],
          tmp,
        )).code,
        0,
      );
      await git(["config", "user.email", "test@example.com"], clonePath);
      await git(["config", "user.name", "Test User"], clonePath);

      assertEquals(
        (await git(["fetch", "origin", "milestone/v1-0"], clonePath)).code,
        0,
      );
      assertEquals(
        (await git(["checkout", "milestone/v1-0"], clonePath)).code,
        0,
      );

      // Push a further commit to `main` on origin.
      await Deno.writeTextFile(`${seedPath}/file11.txt`, "content 11\n");
      await git(["add", "file11.txt"], seedPath);
      await git(["commit", "-m", "Commit 11"], seedPath);
      assertEquals((await git(["push", "origin", "main"], seedPath)).code, 0);

      const result = await syncMilestoneBranchWithDefault(
        "milestone/v1-0",
        "main",
        { cwd: clonePath },
        undefined,
        fakePassingGate,
        fakePassingGate,
      );

      assertEquals(
        result.ok,
        true,
        `expected sync to succeed, got: ${
          result.ok ? "ok" : result.error.message
        }`,
      );

      const isAncestor = await git(
        ["merge-base", "--is-ancestor", "origin/main", "milestone/v1-0"],
        clonePath,
      );
      assertEquals(
        isAncestor.code,
        0,
        "milestone branch should now contain the latest default-branch commit",
      );

      const pushedTip = (await git(
        ["rev-parse", "milestone/v1-0"],
        originPath,
      )).stdout;
      const localTip = (await git(["rev-parse", "HEAD"], clonePath)).stdout;
      assertEquals(pushedTip, localTip);
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "mergeWithUnshallowRetry - unshallows and retries a merge refused as unrelated histories (Issue #2896)",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "merge_unshallow_retry_ok_",
    });
    try {
      const { originPath } = await buildOriginWithForkedMilestone(tmp);

      const clonePath = `${tmp}/shallow`;
      assertEquals(
        (await git(
          [
            "clone",
            "--depth=1",
            "--no-single-branch",
            `file://${originPath}`,
            clonePath,
          ],
          tmp,
        )).code,
        0,
      );
      await git(["config", "user.email", "test@example.com"], clonePath);
      await git(["config", "user.name", "Test User"], clonePath);
      assertEquals(
        (await git(["fetch", "origin", "milestone/v1-0"], clonePath)).code,
        0,
      );
      assertEquals(
        (await git(["checkout", "milestone/v1-0"], clonePath)).code,
        0,
      );

      // Precondition: the merge base is beyond depth 1, so a plain merge
      // refuses as unrelated histories, with no deepening done.
      const isShallowBefore = await git(
        ["rev-parse", "--is-shallow-repository"],
        clonePath,
      );
      assertEquals(isShallowBefore.stdout, "true");
      const plainMerge = await git(["merge", "main", "--no-edit"], clonePath);
      assertEquals(plainMerge.code === 0, false);
      assertStringIncludes(
        plainMerge.stderr.toLowerCase() + plainMerge.stdout.toLowerCase(),
        "refusing to merge unrelated histories",
      );
      // Clean up the refused merge attempt before the real test.
      await git(["merge", "--abort"], clonePath).catch(() => undefined);
      await git(["reset", "--hard", "HEAD"], clonePath);

      const result = await mergeWithUnshallowRetry("main", {
        cwd: clonePath,
      });

      assertEquals(
        result.ok && result.value.code === 0,
        true,
        `expected the retried merge to succeed, got: ${
          result.ok ? JSON.stringify(result.value) : result.error.message
        }`,
      );

      const isShallowAfter = await git(
        ["rev-parse", "--is-shallow-repository"],
        clonePath,
      );
      assertEquals(isShallowAfter.stdout, "false");
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "mergeWithUnshallowRetry - a genuinely unrelated history on a non-shallow repo is returned as-is (Issue #2896)",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "merge_unshallow_retry_unrelated_",
    });
    try {
      const originPath = `${tmp}/origin.git`;
      const seedPath = `${tmp}/seed`;
      await Deno.mkdir(originPath, { recursive: true });
      await git(["init", "--bare"], originPath);
      await git(
        ["symbolic-ref", "HEAD", "refs/heads/main"],
        originPath,
      );
      await git(["clone", originPath, seedPath], tmp);
      await git(["config", "user.email", "test@example.com"], seedPath);
      await git(["config", "user.name", "Test User"], seedPath);
      await Deno.writeTextFile(`${seedPath}/main.txt`, "main\n");
      await git(["add", "main.txt"], seedPath);
      await git(["commit", "-m", "Main commit"], seedPath);
      await git(["push", "origin", "main"], seedPath);

      // A non-shallow full clone.
      const localPath = `${tmp}/local`;
      assertEquals((await git(["clone", originPath, localPath], tmp)).code, 0);
      await git(["config", "user.email", "test@example.com"], localPath);
      await git(["config", "user.name", "Test User"], localPath);

      // An orphan branch with a genuinely unrelated history.
      assertEquals(
        (await git(["checkout", "--orphan", "orphan-branch"], localPath))
          .code,
        0,
      );
      await git(["rm", "-rf", "--cached", "."], localPath);
      await Deno.writeTextFile(`${localPath}/orphan.txt`, "orphan\n");
      await git(["add", "orphan.txt"], localPath);
      await git(["commit", "-m", "Orphan commit"], localPath);

      const isShallowBefore = await git(
        ["rev-parse", "--is-shallow-repository"],
        localPath,
      );
      assertEquals(isShallowBefore.stdout, "false");

      const result = await mergeWithUnshallowRetry("main", {
        cwd: localPath,
      });

      assertEquals(
        result.ok && result.value.code === 0,
        false,
        "a genuinely unrelated history must not be reported as a successful merge",
      );
      if (result.ok) {
        assertStringIncludes(
          (result.value.stderr + result.value.stdout).toLowerCase(),
          "unrelated histories",
        );
      }

      // No unshallow attempted on an already-non-shallow repo.
      const isShallowAfter = await git(
        ["rev-parse", "--is-shallow-repository"],
        localPath,
      );
      assertEquals(isShallowAfter.stdout, "false");
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
    }
  },
);
