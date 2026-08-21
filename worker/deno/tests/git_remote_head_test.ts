/**
 * Tests for remote-head resolution and honest unpushed counting (Issue #211).
 *
 * The old count — `git rev-list --count HEAD --not --remotes=origin` — is only
 * correct when a remote-tracking ref exists for the branch. On a single-branch
 * clone (`remote.origin.fetch` restricted to the default branch) a successful
 * push never creates `refs/remotes/origin/<branch>`, so the count silently
 * degrades to "commits ahead of the default branch" and a good push is
 * reported as 4 commits unpushed.
 *
 * These tests use real git repositories — no stubs — so the counts are the
 * counts git itself produces.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  countUnpushedCommits,
  resolveRemoteBranchHead,
} from "../lib/git_remote_head.ts";

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
 * Build an upstream bare repo plus a clone of it.
 *
 * @param prefix - Temp directory prefix
 * @param singleBranch - Clone with `--single-branch` so the fetch refspec only
 *   covers the default branch (the shape that produced the false "push failed")
 */
async function makeClone(
  prefix: string,
  singleBranch: boolean,
): Promise<{ tmp: string; upstream: string; clone: string }> {
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

  const cloneArgs = singleBranch
    ? ["clone", "--single-branch", "--branch", "main", upstream, clone]
    : ["clone", upstream, clone];
  await runGit(cloneArgs, tmp);
  await runGit(["config", "user.email", "t@t"], clone);
  await runGit(["config", "user.name", "t"], clone);

  return { tmp, upstream, clone };
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

Deno.test("countUnpushedCommits - reports 0 after a good push on a single-branch clone (Issue #211)", async () => {
  const branch = "issue-556-fix";
  const { tmp, clone } = await makeClone("remote_head_single_", true);
  try {
    await runGit(["checkout", "-b", branch], clone);
    // Four commits, exactly as the incident: all of them pushed successfully.
    for (const n of [1, 2, 3, 4]) {
      await commitFile(clone, `f${n}.txt`, `${n}\n`);
    }
    const push = await runGit(["push", "-u", "origin", branch], clone);
    assertEquals(push.code, 0, `push failed: ${push.stderr}`);

    // The old count would say 4 here — commits ahead of main — because
    // refs/remotes/origin/<branch> does not exist on a single-branch clone.
    const legacy = await runGit(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      clone,
    );
    assertEquals(
      legacy.stdout.trim(),
      "4",
      "precondition: the legacy count must be the wrong one this fixes",
    );

    const result = await countUnpushedCommits(branch, { cwd: clone });
    assert(result.ok, `expected ok, got: ${!result.ok ? result.error : ""}`);
    if (result.ok) assertEquals(result.value, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - counts genuinely unpushed commits on a single-branch clone", async () => {
  const branch = "issue-211-behind";
  const { tmp, clone } = await makeClone("remote_head_behind_", true);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "pushed.txt", "pushed\n");
    await runGit(["push", "-u", "origin", branch], clone);

    // Two commits made after the push — these really are unpushed.
    await commitFile(clone, "local1.txt", "local\n");
    await commitFile(clone, "local2.txt", "local\n");

    const result = await countUnpushedCommits(branch, { cwd: clone });
    assert(result.ok);
    if (result.ok) assertEquals(result.value, 2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - counts every commit when the branch is not on the remote yet", async () => {
  const branch = "issue-211-first-push";
  const { tmp, clone } = await makeClone("remote_head_first_", false);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");
    await commitFile(clone, "b.txt", "b\n");

    const result = await countUnpushedCommits(branch, { cwd: clone });
    assert(result.ok);
    if (result.ok) assertEquals(result.value, 2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - uses the tracking ref when one exists", async () => {
  const branch = "issue-211-tracking";
  const { tmp, clone } = await makeClone("remote_head_tracking_", false);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");
    await runGit(["push", "-u", "origin", branch], clone);

    const head = await resolveRemoteBranchHead(branch, { cwd: clone });
    assert(head.ok);
    if (head.ok) {
      assertEquals(head.value.source, "tracking-ref");
      const localHead = await runGit(["rev-parse", "HEAD"], clone);
      assertEquals(head.value.sha, localHead.stdout.trim());
    }

    const result = await countUnpushedCommits(branch, { cwd: clone });
    assert(result.ok);
    if (result.ok) assertEquals(result.value, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveRemoteBranchHead - falls back to ls-remote when the tracking ref is missing", async () => {
  const branch = "issue-211-ls-remote";
  const { tmp, clone } = await makeClone("remote_head_lsremote_", true);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");
    await runGit(["push", "-u", "origin", branch], clone);

    const head = await resolveRemoteBranchHead(branch, { cwd: clone });
    assert(head.ok, `expected ok, got: ${!head.ok ? head.error : ""}`);
    if (head.ok) {
      assertEquals(head.value.source, "ls-remote");
      const localHead = await runGit(["rev-parse", "HEAD"], clone);
      assertEquals(head.value.sha, localHead.stdout.trim());
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveRemoteBranchHead - reports the branch as absent from the remote", async () => {
  const branch = "issue-211-absent";
  const { tmp, clone } = await makeClone("remote_head_absent_", false);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");

    const head = await resolveRemoteBranchHead(branch, { cwd: clone });
    assert(head.ok);
    if (head.ok) {
      assertEquals(head.value.sha, null);
      assertEquals(head.value.source, "absent");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - fails loud when the remote cannot be reached and no tracking ref exists (Issue #211)", async () => {
  const branch = "issue-211-unreachable";
  const { tmp, upstream, clone } = await makeClone("remote_head_broken_", true);
  try {
    await runGit(["checkout", "-b", branch], clone);
    await commitFile(clone, "a.txt", "a\n");
    // Destroy the remote so ls-remote cannot answer. With no tracking ref
    // either, the unpushed count is unknowable — it must not silently
    // return 0 ("all pushed") or a fabricated number.
    await Deno.remove(upstream, { recursive: true });

    const result = await countUnpushedCommits(branch, { cwd: clone });
    assert(
      !result.ok,
      "expected an error Result when the remote is unreachable",
    );
    if (!result.ok) {
      assert(
        /ls-remote|remote/i.test(result.error.message),
        `expected git's own failure in the message, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - refuses a dash-leading branch name", async () => {
  const result = await countUnpushedCommits("--upload-pack=evil", {});
  assert(!result.ok);
  if (!result.ok) {
    assert(
      result.error.message.includes("must not begin with '-'"),
      `expected ref guard error, got: ${result.error.message}`,
    );
  }
});
