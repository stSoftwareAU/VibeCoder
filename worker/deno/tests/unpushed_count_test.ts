/**
 * Tests for the branch-scoped unpushed-commit count (Issue #211).
 *
 * `commitAndPushPending` used to answer "is anything still unpushed?" with
 * `git rev-list --count HEAD --not --remotes=origin` — commits reachable from
 * HEAD but from no `refs/remotes/origin/*` ref. On a clone whose fetch refspec
 * covers only the default branch (any clone made with a bare `--depth=1`,
 * which implies `--single-branch`), a *successful* push of a feature branch
 * never creates `refs/remotes/origin/<branch>`, so that count keeps reporting
 * every commit ahead of the default branch. The worker then declared a good
 * push a failure, ran a bogus recovery, and posted "please check the branch
 * status" to a human.
 *
 * These tests build a real single-branch clone and assert the count is
 * measured against the branch's own remote head.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { commitAndPushPending, countUnpushedCommits } from "../lib/git_push.ts";

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
 * Build an upstream plus a clone whose fetch refspec covers only `main` —
 * the shape every legacy `--depth=1` clone on the fleet still has.
 */
async function makeSingleBranchClone(
  prefix: string,
  branchName: string,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);

  const seed = `${tmp}/seed`;
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);

  await runGit(
    ["clone", "--single-branch", "--branch", "main", upstream, downstream],
    tmp,
  );
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  await runGit(["checkout", "-b", branchName], downstream);

  return { tmp, downstream };
}

Deno.test("countUnpushedCommits - reports 0 when the remote head already has HEAD on a single-branch clone (Issue #211)", async () => {
  const branch = "issue-211-already-pushed";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_count_pushed_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);
    const push = await runGit(["push", "-u", "origin", branch], downstream);
    assertEquals(push.code, 0, push.stderr);

    // The tracking ref does not exist on a single-branch clone, so the old
    // `HEAD --not --remotes=origin` probe reports 1 here.
    const legacy = await runGit(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      downstream,
    );
    assertEquals(legacy.stdout.trim(), "1");

    assertEquals(await countUnpushedCommits(branch, { cwd: downstream }), 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - counts commits the remote head does not have (Issue #211)", async () => {
  const branch = "issue-211-genuinely-unpushed";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_count_unpushed_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);

    // Two commits made after the push are genuinely unpushed.
    await Deno.writeTextFile(`${downstream}/b.txt`, "b\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "b"], downstream);
    await Deno.writeTextFile(`${downstream}/c.txt`, "c\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "c"], downstream);

    assertEquals(await countUnpushedCommits(branch, { cwd: downstream }), 2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - counts every commit when the branch is absent from the remote (Issue #211)", async () => {
  const branch = "issue-211-never-pushed";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_count_absent_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);

    // Nothing pushed yet — the remote has no such branch, so the one local
    // commit is genuinely unpushed.
    assertEquals(await countUnpushedCommits(branch, { cwd: downstream }), 1);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - reports finalUnpushedCount=0 on a single-branch clone (Issue #211)", async () => {
  const branch = "issue-211-final-mile";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_count_final_mile_",
    branch,
  );
  try {
    // Simulate the incident: commits already on the PR branch (pushed by an
    // earlier run) plus fresh uncommitted work from this run.
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);
    await Deno.writeTextFile(`${downstream}/b.txt`, "b\n");

    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: downstream },
    );

    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      // Exactly one commit was pushed — not "every commit ahead of main".
      assertEquals(result.value.commitsPushed, 1);
      assertEquals(result.value.finalUnpushedCount, 0);
    }

    // The push really landed: the remote head matches local HEAD.
    const remote = await runGit(
      ["ls-remote", "origin", `refs/heads/${branch}`],
      downstream,
    );
    const localHead = await runGit(["rev-parse", "HEAD"], downstream);
    assertEquals(
      remote.stdout.trim().split(/\s+/)[0],
      localHead.stdout.trim(),
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - still reports unpushed commits when the push cannot reach origin (Issue #211)", async () => {
  const branch = "issue-211-push-fails";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_count_push_fails_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/a.txt`, "a\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "a"], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);

    // Break the remote so neither the push nor the ls-remote verification can
    // succeed: the honest answer is "still unpushed", never a silent zero.
    await runGit(
      ["remote", "set-url", "origin", `${tmp}/does-not-exist.git`],
      downstream,
    );
    await Deno.writeTextFile(`${downstream}/b.txt`, "b\n");

    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: downstream },
    );

    // The push fails loudly; the commit was still made locally.
    assert(!result.ok, "expected the unreachable remote to fail the push");
    // With no reachable remote the count cannot be verified, so it falls back
    // to the local estimate — never to a silent zero.
    const count = await countUnpushedCommits(branch, { cwd: downstream });
    assert(
      count > 0,
      `a commit that never reached origin must still count as unpushed, got ${count}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
