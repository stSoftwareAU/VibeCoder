/**
 * Tests for the default-branch tip reader behind the milestone-sync cadence
 * (Issue #1776).
 *
 * The tip is read from local git, not the API, so these tests drive real
 * repositories: a bare upstream, a clone, and a commit pushed to the upstream
 * that the clone has not seen yet.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readLocalDefaultTip } from "../lib/milestone_default_tip.ts";

/** Run git in `cwd`, returning its exit code and stdout. */
async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
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
  };
}

/** A bare upstream with one commit on `main`, plus a clone of it. */
async function clonePair(
  tmp: string,
): Promise<{ upstream: string; seed: string; clone: string }> {
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const clone = `${tmp}/clone`;
  assertEquals(
    (await git(["init", "--bare", "-b", "main", upstream], tmp)).code,
    0,
  );
  assertEquals((await git(["clone", upstream, seed], tmp)).code, 0);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await git(["add", "."], seed);
  await git(["commit", "-m", "seed"], seed);
  assertEquals((await git(["push", "origin", "main"], seed)).code, 0);
  assertEquals((await git(["clone", upstream, clone], tmp)).code, 0);
  return { upstream, seed, clone };
}

Deno.test("readLocalDefaultTip - reports origin's tip (Issue #1776)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "issue-1776-tip-" });
  try {
    const { seed, clone } = await clonePair(tmp);
    const expected = (await git(["rev-parse", "HEAD"], seed)).stdout;

    const tip = await readLocalDefaultTip("main", clone);
    assert(tip.ok, "the tip must be readable in a healthy clone");
    assertEquals(tip.value, expected);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test(
  "readLocalDefaultTip - follows the tip when it moves (Issue #1776)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "issue-1776-moved-tip-" });
    try {
      const { seed, clone } = await clonePair(tmp);
      const before = await readLocalDefaultTip("main", clone);
      assert(before.ok);

      // A new commit lands on the default branch the clone has not fetched.
      await Deno.writeTextFile(`${seed}/README.md`, "seed\nmore\n");
      await git(["commit", "-am", "second"], seed);
      assertEquals((await git(["push", "origin", "main"], seed)).code, 0);
      const pushed = (await git(["rev-parse", "HEAD"], seed)).stdout;

      // The reader fetches before it reads, so the move is visible at once.
      const after = await readLocalDefaultTip("main", clone);
      assert(after.ok);
      assertEquals(after.value, pushed);
      assert(
        before.value !== after.value,
        "the tip must be seen to have moved",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "readLocalDefaultTip - an unreadable clone fails with a reason, not a guess (Issue #1776)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "issue-1776-no-clone-" });
    try {
      const tip = await readLocalDefaultTip("main", `${tmp}/never-cloned`);
      assert(!tip.ok, "a clone that is not there cannot report a tip");
      assertStringIncludes(tip.error.message, "main");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "readLocalDefaultTip - a branch name that is not a safe ref is refused (Issue #1776)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "issue-1776-unsafe-ref-" });
    try {
      const { clone } = await clonePair(tmp);
      const tip = await readLocalDefaultTip(
        "--upload-pack=touch /tmp/pwned",
        clone,
      );
      assert(!tip.ok, "an unsafe ref component must be refused");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "readLocalDefaultTip - a local ref that could not be moved is a loud failure, not the remote tip (Issue #1776)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "issue-1776-stuck-ref-" });
    try {
      const { seed, clone } = await clonePair(tmp);
      const stale = (await git(["rev-parse", "main"], clone)).stdout;

      // Another worktree holds `main`, so `ensureDefaultBranchCurrent`'s
      // `git branch -f main origin/main` is refused — while it still reports
      // success (Issue #394). The clone itself sits on a feature branch.
      assertEquals(
        (await git(["checkout", "-q", "-b", "feature"], clone)).code,
        0,
      );
      assertEquals(
        (await git(["worktree", "add", `${tmp}/held`, "main"], clone)).code,
        0,
      );

      // The default branch moves on the remote.
      await Deno.writeTextFile(`${seed}/README.md`, "seed\nmoved\n");
      await git(["commit", "-am", "moved"], seed);
      assertEquals((await git(["push", "origin", "main"], seed)).code, 0);
      const pushed = (await git(["rev-parse", "HEAD"], seed)).stdout;

      const tip = await readLocalDefaultTip("main", clone);
      assert(
        !tip.ok,
        "a tip the merge cannot reach must never be reported as the tip",
      );
      assertStringIncludes(tip.error.message, "could not be moved");
      assertStringIncludes(tip.error.message, stale.slice(0, 7));
      assertStringIncludes(tip.error.message, pushed.slice(0, 7));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
