/**
 * Tests for countUnpushedCommits — honest unpushed counting (Issue #211).
 *
 * The old measure, `git rev-list --count HEAD --not --remotes=origin`, counts
 * commits that are on no *locally tracked* origin ref. In a single-branch
 * clone the fetch refspec only covers the default branch, so `git push` never
 * creates `refs/remotes/origin/<feature>` — a perfectly good push still
 * reported every commit as unpushed, which drove a bogus recovery, a "please
 * check the branch status" comment and a spurious `merge-conflict` label.
 *
 * These tests build real repositories and run real git.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { countUnpushedCommits } from "../lib/git_unpushed.ts";
import { commitAndPushPending } from "../lib/git_push.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
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
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/**
 * Build an upstream with a `Develop` default branch and clone it with
 * `--single-branch` — exactly the clone shape that produced the false
 * "push failed" in NEAT-AI-core PR #557.
 */
async function makeSingleBranchClone(
  prefix: string,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "Develop", upstream], tmp);
  await runGit(["clone", upstream, seed], tmp);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "-u", "origin", "Develop"], seed);

  await runGit(
    ["clone", "--single-branch", "--branch", "Develop", upstream, downstream],
    tmp,
  );
  return { tmp, downstream };
}

Deno.test("countUnpushedCommits - single-branch clone reports 0 after a good push", async () => {
  const branch = "issue-211-single-branch";
  const { tmp, downstream } = await makeSingleBranchClone("unpushed_single_");
  try {
    await runGit(["checkout", "-b", branch], downstream);
    for (const n of [1, 2, 3, 4]) {
      await Deno.writeTextFile(`${downstream}/f${n}.txt`, `${n}\n`);
      await runGit(["add", "."], downstream);
      await runGit(["commit", "-m", `commit ${n}`], downstream);
    }
    const pushed = await runGit(["push", "-u", "origin", branch], downstream);
    assertEquals(pushed.code, 0, pushed.stderr);

    // The old measure still says 4 here; the honest one says 0.
    const stale = await runGit(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      downstream,
    );
    assertEquals(stale.stdout.trim(), "4");

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.count, 0);
      assertEquals(result.value.measuredAgainst, "fetched-remote-branch");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - counts only the commits ahead of the remote branch", async () => {
  const branch = "issue-211-ahead";
  const { tmp, downstream } = await makeSingleBranchClone("unpushed_ahead_");
  try {
    await runGit(["checkout", "-b", branch], downstream);
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "pushed work"], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);

    // Two genuinely unpushed commits on top of the pushed head.
    for (const name of ["b", "c"]) {
      await Deno.writeTextFile(`${downstream}/${name}.txt`, `${name}\n`);
      await runGit(["add", "."], downstream);
      await runGit(["commit", "-m", `local ${name}`], downstream);
    }

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.count, 2);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - branch absent from the remote counts every local commit", async () => {
  const branch = "issue-211-never-pushed";
  const { tmp, downstream } = await makeSingleBranchClone("unpushed_new_");
  try {
    await runGit(["checkout", "-b", branch], downstream);
    for (const name of ["a", "b"]) {
      await Deno.writeTextFile(`${downstream}/${name}.txt`, `${name}\n`);
      await runGit(["add", "."], downstream);
      await runGit(["commit", "-m", `local ${name}`], downstream);
    }

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.count, 2);
      assertEquals(result.value.measuredAgainst, "no-remote-branch");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - uses the local tracking ref when the clone has one", async () => {
  const branch = "issue-211-tracked";
  const tmp = await Deno.makeTempDir({ prefix: "unpushed_tracked_" });
  try {
    const upstream = `${tmp}/upstream.git`;
    const seed = `${tmp}/seed`;
    const downstream = `${tmp}/downstream`;
    await runGit(["init", "--bare", "-b", "Develop", upstream], tmp);
    await runGit(["clone", upstream, seed], tmp);
    await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
    await runGit(["add", "."], seed);
    await runGit(["commit", "-m", "seed"], seed);
    await runGit(["push", "-u", "origin", "Develop"], seed);
    await runGit(["clone", upstream, downstream], tmp);

    await runGit(["checkout", "-b", branch], downstream);
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "work"], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.count, 0);
      assertEquals(result.value.measuredAgainst, "remote-tracking-ref");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - refuses a dash-leading branch name", async () => {
  const result = await countUnpushedCommits("--upload-pack=echo", {
    cwd: Deno.cwd(),
  });
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.message.includes("must not begin with '-'"));
  }
});

Deno.test("commitAndPushPending - single-branch clone: a good push reports finalUnpushedCount 0", async () => {
  const branch = "issue-211-final-mile";
  const { tmp, downstream } = await makeSingleBranchClone("unpushed_final_");
  try {
    await runGit(["checkout", "-b", branch], downstream);
    await runGit(["config", "user.email", "t@t"], downstream);
    await runGit(["config", "user.name", "t"], downstream);
    // Four commits, as in the reported run — none pushed yet.
    for (const n of [1, 2, 3, 4]) {
      await Deno.writeTextFile(`${downstream}/f${n}.txt`, `${n}\n`);
      await runGit(["add", "."], downstream);
      await runGit(["commit", "-m", `commit ${n}`], downstream);
    }

    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: downstream },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.commitsPushed, 4);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - a push that cannot reach origin still reports the commits as unpushed", async () => {
  const branch = "issue-211-push-unreachable";
  const { tmp, downstream } = await makeSingleBranchClone("unpushed_broken_");
  try {
    await runGit(["checkout", "-b", branch], downstream);
    await runGit(["config", "user.email", "t@t"], downstream);
    await runGit(["config", "user.name", "t"], downstream);
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);

    // Break the remote: neither the push nor the tracking-ref fetch can
    // succeed, so the honest answer is "still unpushed", never a quiet 0.
    await runGit(
      ["remote", "set-url", "origin", `${tmp}/does-not-exist.git`],
      downstream,
    );

    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: downstream },
    );
    assert(!result.ok, "an unreachable remote must fail the push loudly");

    const count = await countUnpushedCommits(branch, { cwd: downstream });
    assert(count.ok, count.ok ? "" : count.error.message);
    if (count.ok) {
      assertEquals(count.value.measuredAgainst, "no-remote-branch");
      assert(
        count.value.count > 0,
        `a commit that never reached origin must still count as unpushed, got ${count.value.count}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
