/**
 * Tests for countUnpushedCommits — honest "is my work on origin?" count
 * (Issue #211).
 *
 * The regression these cover: on a **single-branch clone** (the shape every
 * fleet workdir has) `refs/remotes/origin/<feature-branch>` never exists,
 * because the clone's fetch refspec maps only the default branch. The old
 * probe fell back to `rev-list --count HEAD --not --remotes=origin`, which
 * counts every commit ahead of *Develop* — so a fully pushed branch reported
 * N unpushed commits, a good push was declared failed, and the PR was handed
 * to bogus recovery, a "please check the branch" comment and a spurious
 * `merge-conflict` label.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { countUnpushedCommits } from "../lib/git_unpushed_count.ts";

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

async function commitFile(
  dir: string,
  name: string,
  body: string,
): Promise<void> {
  await Deno.writeTextFile(`${dir}/${name}`, body);
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", `add ${name}`], dir);
}

/**
 * Build an upstream with `main` plus a feature branch, then clone it the way
 * the fleet does — `--single-branch --branch main` — and check the feature
 * branch out from `FETCH_HEAD`. The result has NO
 * `refs/remotes/origin/<feature>` ref, exactly like a live fleet workdir.
 */
async function makeSingleBranchClone(
  prefix: string,
  branchName: string,
  featureCommits: number,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await commitFile(seed, "README.md", "seed\n");
  await runGit(["push", "origin", "main"], seed);

  await runGit(["checkout", "-b", branchName], seed);
  for (let i = 0; i < featureCommits; i++) {
    await commitFile(seed, `feature-${i}.txt`, `feature ${i}\n`);
  }
  if (featureCommits > 0) {
    await runGit(["push", "-u", "origin", branchName], seed);
  }

  await runGit(
    ["clone", "--single-branch", "--branch", "main", upstream, downstream],
    tmp,
  );
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  if (featureCommits > 0) {
    await runGit(["fetch", "origin", branchName], downstream);
    await runGit(["checkout", "-b", branchName, "FETCH_HEAD"], downstream);
  } else {
    await runGit(["checkout", "-b", branchName], downstream);
  }

  return { tmp, downstream };
}

Deno.test("countUnpushedCommits - single-branch clone in sync reports 0, not commits-ahead-of-default (Issue #211)", async () => {
  const branch = "issue-556-single-branch";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_single_sync_",
    branch,
    4,
  );
  try {
    // Guard: the clone genuinely lacks the remote-tracking ref, so this test
    // exercises the real fleet shape rather than a full clone.
    const trackingRef = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      downstream,
    );
    assertEquals(
      trackingRef.code !== 0,
      true,
      "fixture must have no origin/<branch> tracking ref",
    );

    // The old probe counts the 4 feature commits as "unpushed".
    const legacy = await runGit(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      downstream,
    );
    assertEquals(legacy.stdout.trim(), "4");

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.count, 0);
      assertEquals(result.value.source, "fetched-head");
      assert(result.value.remoteSha !== null);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - single-branch clone counts genuinely unpushed commits (Issue #211)", async () => {
  const branch = "issue-556-ahead";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_single_ahead_",
    branch,
    2,
  );
  try {
    await commitFile(downstream, "local-1.txt", "local one\n");
    await commitFile(downstream, "local-2.txt", "local two\n");

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.count, 2);
      assertEquals(result.value.source, "fetched-head");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - branch missing from origin counts every commit not on origin (Issue #1463)", async () => {
  const branch = "issue-1463-brand-new";
  const { tmp, downstream } = await makeSingleBranchClone(
    "unpushed_first_push_",
    branch,
    0,
  );
  try {
    await commitFile(downstream, "new-1.txt", "new one\n");

    const result = await countUnpushedCommits(branch, { cwd: downstream });
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.count, 1);
      assertEquals(result.value.remoteSha, null);
      assertEquals(result.value.source, "no-remote-branch");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - full clone uses the local tracking ref without a fetch (Issue #211)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "unpushed_tracking_ref_" });
  const upstream = `${tmp}/upstream.git`;
  const downstream = `${tmp}/downstream`;
  const branch = "issue-211-tracking";
  try {
    await runGit(["init", "--bare", "-b", "main", upstream], tmp);
    await runGit(["clone", upstream, downstream], tmp);
    await runGit(["config", "user.email", "t@t"], downstream);
    await runGit(["config", "user.name", "t"], downstream);
    await commitFile(downstream, "README.md", "seed\n");
    await runGit(["push", "origin", "main"], downstream);
    await runGit(["checkout", "-b", branch], downstream);
    await runGit(["push", "-u", "origin", branch], downstream);

    const inSync = await countUnpushedCommits(branch, { cwd: downstream });
    assert(inSync.ok);
    if (inSync.ok) {
      assertEquals(inSync.value.count, 0);
      assertEquals(inSync.value.source, "tracking-ref");
    }

    await commitFile(downstream, "later.txt", "later\n");
    const ahead = await countUnpushedCommits(branch, { cwd: downstream });
    assert(ahead.ok);
    if (ahead.ok) {
      assertEquals(ahead.value.count, 1);
      assertEquals(ahead.value.source, "tracking-ref");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - unreachable remote fails loud rather than reporting 0 (Issue #211)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "unpushed_no_remote_" });
  const repo = `${tmp}/repo`;
  const branch = "issue-211-broken-remote";
  try {
    await Deno.mkdir(repo);
    await runGit(["init", "-b", "main", "."], repo);
    await runGit(["config", "user.email", "t@t"], repo);
    await runGit(["config", "user.name", "t"], repo);
    await commitFile(repo, "README.md", "seed\n");
    await runGit(["checkout", "-b", branch], repo);
    await runGit(
      ["remote", "add", "origin", `${tmp}/does-not-exist.git`],
      repo,
    );

    const result = await countUnpushedCommits(branch, { cwd: repo });
    assert(
      !result.ok,
      "an unreachable origin must fail loud, never be reported as in sync",
    );
    if (!result.ok) {
      assert(
        result.error.message.includes(branch),
        `error must name the branch, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("countUnpushedCommits - refuses a dash-leading branch name (Issue #3714)", async () => {
  const result = await countUnpushedCommits("--upload-pack=echo", {
    cwd: Deno.cwd(),
  });
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.message.includes("must not begin with '-'"));
  }
});
