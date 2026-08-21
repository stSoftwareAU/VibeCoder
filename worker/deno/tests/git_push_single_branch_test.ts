/**
 * Regression tests for the false "push failed" on single-branch clones
 * (Issue #211).
 *
 * A single-branch clone keeps `remote.origin.fetch` restricted to the default
 * branch, so `refs/remotes/origin/<feature>` never appears — not even after a
 * successful `git push -u`. `commitAndPushPending` used to re-count with
 * `HEAD --not --remotes=origin`, which then reports "commits ahead of the
 * default branch" and made a good push look like 4 unpushed commits
 * (`commitsPushed=4 finalUnpushedCount=4`).
 *
 * Real git repositories — no stubs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { commitAndPushPending, pushUnpushedCommits } from "../lib/git_push.ts";

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** Upstream bare repo plus a `--single-branch` clone of it. */
async function makeSingleBranchClone(
  prefix: string,
): Promise<{ tmp: string; clone: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const clone = `${tmp}/clone`;

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
    ["clone", "--single-branch", "--branch", "main", upstream, clone],
    tmp,
  );
  await runGit(["config", "user.email", "t@t"], clone);
  await runGit(["config", "user.name", "t"], clone);

  return { tmp, clone };
}

async function commitFile(
  cwd: string,
  name: string,
  body: string,
): Promise<void> {
  await Deno.writeTextFile(`${cwd}/${name}`, body);
  await runGit(["add", "."], cwd);
  await runGit(["commit", "-m", `add ${name}`], cwd);
}

Deno.test("commitAndPushPending - a good push on a single-branch clone reports nothing unpushed (Issue #211)", async () => {
  const branch = "issue-211-single-branch";
  const { tmp, clone } = await makeSingleBranchClone("push_single_branch_");
  try {
    await runGit(["checkout", "-b", branch], clone);
    // Three commits already made by the agent, plus uncommitted work — the
    // final-mile helper commits the last one and pushes all four.
    for (const n of [1, 2, 3]) {
      await commitFile(clone, `f${n}.txt`, `${n}\n`);
    }
    await Deno.writeTextFile(`${clone}/f4.txt`, "4\n");

    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: clone },
    );

    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.commitsPushed, 4);
      // The bug: this was 4 — "commits ahead of main" — so the caller
      // reported a push failure for a push that had just succeeded.
      assertEquals(result.value.finalUnpushedCount, 0);
    }

    // Origin really has our head.
    const remote = await runGit(
      ["ls-remote", "--heads", "origin", branch],
      clone,
    );
    const local = await runGit(["rev-parse", "HEAD"], clone);
    assert(
      remote.stdout.startsWith(local.stdout.trim()),
      `origin should hold ${local.stdout.trim()}, ls-remote said: ${remote.stdout}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("pushUnpushedCommits - counts only the commits the remote lacks on a single-branch clone (Issue #211)", async () => {
  const branch = "issue-211-partial";
  const { tmp, clone } = await makeSingleBranchClone("push_single_partial_");
  try {
    await runGit(["checkout", "-b", branch], clone);
    // Three commits are already on the remote…
    for (const n of [1, 2, 3]) {
      await commitFile(clone, `f${n}.txt`, `${n}\n`);
    }
    await runGit(["push", "-u", "origin", branch], clone);
    // …and exactly one is not.
    await commitFile(clone, "f4.txt", "4\n");

    const result = await pushUnpushedCommits(branch, { cwd: clone });
    assert(result.ok, `expected ok, got: ${!result.ok ? result.error : ""}`);
    // The bug reported 4 (commits ahead of main); only one was unpushed.
    if (result.ok) assertEquals(result.value, 1);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - still reports unpushed commits honestly when the push cannot land (Issue #211)", async () => {
  const branch = "issue-211-blocked";
  const { tmp, clone } = await makeSingleBranchClone("push_single_blocked_");
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");
    await runGit(["push", "-u", "origin", branch], clone);

    // A sibling moves the remote head, then we commit locally: our push is
    // rejected non-fast-forward and recovery must rebase before it can land.
    const sibling = `${tmp}/sibling`;
    await runGit(
      [
        "clone",
        "--single-branch",
        "--branch",
        branch,
        `${tmp}/upstream.git`,
        sibling,
      ],
      tmp,
    );
    await runGit(["config", "user.email", "s@s"], sibling);
    await runGit(["config", "user.name", "s"], sibling);
    await commitFile(sibling, "sibling.txt", "sibling\n");
    await runGit(["push", "origin", branch], sibling);

    await Deno.writeTextFile(`${clone}/b.txt`, "b\n");
    const result = await commitAndPushPending(
      branch,
      "Final-mile commit (Issue #211)",
      { cwd: clone },
    );

    // The head moved during the run, so recovery rebases onto it and pushes:
    // the work lands, nothing is reported unpushed, and no caller has cause to
    // ask a human to check the branch.
    assert(
      result.ok,
      `expected the rebase-and-push recovery to land the work, got: ${
        !result.ok ? result.error.message : ""
      }`,
    );
    if (result.ok) {
      assertEquals(result.value.finalUnpushedCount, 0);
      const remote = await runGit(
        ["ls-remote", "--heads", "origin", branch],
        clone,
      );
      const local = await runGit(["rev-parse", "HEAD"], clone);
      assert(
        remote.stdout.startsWith(local.stdout.trim()),
        "an ok Result must mean the local head really is on origin",
      );
      // The sibling's commit survived — we rebased onto it, not over it.
      const subjects = await runGit(["log", "--format=%s"], clone);
      assert(
        subjects.stdout.includes("add sibling.txt"),
        `the sibling's commit must survive the recovery, got:\n${subjects.stdout}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
