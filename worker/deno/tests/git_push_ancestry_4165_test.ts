/**
 * A PR pass must not push history that does not extend the head it started
 * from (Issue #4165).
 *
 * Real git, in a temporary clone, as git_push_preflight_test.ts does.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { commitAndPushPending } from "../lib/git_push.ts";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Keeps the host's injected git config (hooks included) out of the fixture. */
const NO_HOST_GIT_CONFIG = { GIT_CONFIG_COUNT: "0" };

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...NO_HOST_GIT_CONFIG,
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

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

interface Repo {
  tmp: string;
  upstream: string;
  downstream: string;
  branch: string;
}

async function makeRepo(prefix: string, branch: string): Promise<Repo> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;
  await gitOk(["init", "--bare", "-b", "main", upstream], tmp);
  await gitOk(["clone", upstream, seed], tmp);
  await gitOk(["config", "user.email", "t@t"], seed);
  await gitOk(["config", "user.name", "t"], seed);
  await gitOk(["config", "commit.gpgsign", "false"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await gitOk(["add", "."], seed);
  await gitOk(["commit", "-m", "seed"], seed);
  await gitOk(["push", "origin", "main"], seed);
  await gitOk(["clone", upstream, downstream], tmp);
  await gitOk(["config", "user.email", "t@t"], downstream);
  await gitOk(["config", "user.name", "t"], downstream);
  await gitOk(["config", "commit.gpgsign", "false"], downstream);
  await gitOk(["checkout", "-b", branch], downstream);
  await gitOk(["push", "-u", "origin", branch], downstream);
  return { tmp, upstream, downstream, branch };
}

function originTip(repo: Repo): Promise<string> {
  return gitOk(["rev-parse", `refs/heads/${repo.branch}`], repo.upstream);
}

/** Point the PR branch at a commit with no ancestor in common with X. */
async function resetBranchToUnrelated(repo: Repo): Promise<string> {
  await gitOk(["checkout", "--orphan", "unrelated"], repo.downstream);
  await Deno.writeTextFile(`${repo.downstream}/y.txt`, "unrelated\n");
  await gitOk(["add", "y.txt"], repo.downstream);
  await gitOk(["commit", "-m", "unrelated Y"], repo.downstream);
  const y = await gitOk(["rev-parse", "HEAD"], repo.downstream);
  await gitOk(["checkout", "-B", repo.branch], repo.downstream);
  return y;
}

async function moveOrigin(repo: Repo): Promise<string> {
  const sibling = `${repo.tmp}/sibling`;
  await gitOk(["clone", repo.upstream, sibling], repo.tmp);
  await gitOk(["config", "user.email", "t@t"], sibling);
  await gitOk(["config", "user.name", "t"], sibling);
  await gitOk(["config", "commit.gpgsign", "false"], sibling);
  await gitOk(["checkout", repo.branch], sibling);
  await Deno.writeTextFile(`${sibling}/moved.txt`, "moved\n");
  await gitOk(["add", "moved.txt"], sibling);
  await gitOk(["commit", "-m", "origin moved"], sibling);
  await gitOk(["push", "origin", repo.branch], sibling);
  return await originTip(repo);
}

const pushOptions = (repo: Repo, ancestor: string) => ({
  cwd: repo.downstream,
  env: NO_HOST_GIT_CONFIG,
  expectedAncestor: ancestor,
});

Deno.test("commitAndPushPending refuses unrelated history and leaves origin at X", async () => {
  const repo = await makeRepo("ancestry_refuse_", "issue-4165-foreign");
  try {
    const x = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    const y = await resetBranchToUnrelated(repo);
    const result = await commitAndPushPending(
      repo.branch,
      "must not push unrelated history",
      pushOptions(repo, x),
    );
    assert(!result.ok, "unrelated history must be refused");
    if (!result.ok) {
      assertStringIncludes(result.error.message, "nothing pushed");
      assertStringIncludes(result.error.message, x);
      assertStringIncludes(result.error.message, y);
    }
    assertEquals(await originTip(repo), x, "origin must stay at X");
    assertEquals(
      await gitOk(["rev-parse", "HEAD"], repo.downstream),
      y,
      "the refusal must not rewrite HEAD",
    );
  } finally {
    await Deno.remove(repo.tmp, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection refuses before merging unrelated history", async () => {
  const repo = await makeRepo("ancestry_recover_", "issue-4165-recover");
  try {
    const x = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    const y = await resetBranchToUnrelated(repo);
    const originMoved = await moveOrigin(repo);
    assert(originMoved !== x, "the fixture must move origin");
    const result = await recoverFromPushRejection(
      repo.branch,
      pushOptions(repo, x),
    );
    assert(!result.ok, "recovery must refuse unrelated history");
    if (!result.ok) {
      assertStringIncludes(result.error.message, "nothing pushed");
      assertStringIncludes(result.error.message, x);
      assertStringIncludes(result.error.message, y);
    }
    assertEquals(
      await originTip(repo),
      originMoved,
      "recovery must not push a merge",
    );
    assertEquals(await gitOk(["rev-parse", "HEAD"], repo.downstream), y);
    const merging = await runGit(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      repo.downstream,
    );
    assert(merging.code !== 0, "recovery must not start a merge");
  } finally {
    await Deno.remove(repo.tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending still pushes a commit that extends the starting head", async () => {
  const repo = await makeRepo("ancestry_extend_", "issue-4165-extend");
  try {
    const x = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    await Deno.writeTextFile(`${repo.downstream}/work.txt`, "work\n");
    const result = await commitAndPushPending(
      repo.branch,
      "legit fix",
      pushOptions(repo, x),
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value.finalUnpushedCount, 0);
    const origin = await originTip(repo);
    assert(origin !== x);
    assertEquals(
      (await runGit(
        ["merge-base", "--is-ancestor", x, origin],
        repo.downstream,
      )).code,
      0,
    );
  } finally {
    await Deno.remove(repo.tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending still pushes a merge of the base", async () => {
  const repo = await makeRepo("ancestry_merge_", "issue-4165-merge");
  try {
    const x = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    await Deno.writeTextFile(`${repo.downstream}/feature.txt`, "feature\n");
    await gitOk(["add", "feature.txt"], repo.downstream);
    await gitOk(["commit", "-m", "feature commit"], repo.downstream);
    await gitOk(["checkout", "main"], repo.downstream);
    await Deno.writeTextFile(`${repo.downstream}/base.txt`, "base\n");
    await gitOk(["add", "base.txt"], repo.downstream);
    await gitOk(["commit", "-m", "base moved"], repo.downstream);
    await gitOk(["push", "origin", "main"], repo.downstream);
    await gitOk(["checkout", repo.branch], repo.downstream);
    await gitOk(
      ["merge", "--no-ff", "-m", "merge base", "origin/main"],
      repo.downstream,
    );
    const result = await commitAndPushPending(
      repo.branch,
      "merge of the base",
      pushOptions(repo, x),
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value.finalUnpushedCount, 0);
    assertEquals(
      (await runGit(
        ["merge-base", "--is-ancestor", x, "HEAD"],
        repo.downstream,
      )).code,
      0,
    );
    assertEquals(
      await originTip(repo),
      await gitOk(
        ["rev-parse", "HEAD"],
        repo.downstream,
      ),
    );
  } finally {
    await Deno.remove(repo.tmp, { recursive: true });
  }
});

Deno.test("a rejected push still recovers when HEAD extends the starting head", async () => {
  const repo = await makeRepo("ancestry_ff_", "issue-4165-ff");
  try {
    const x = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    await Deno.writeTextFile(`${repo.downstream}/ours.txt`, "ours\n");
    await gitOk(["add", "ours.txt"], repo.downstream);
    await gitOk(["commit", "-m", "our commit"], repo.downstream);
    const ours = await gitOk(["rev-parse", "HEAD"], repo.downstream);
    const moved = await moveOrigin(repo);
    const result = await commitAndPushPending(
      repo.branch,
      "recover a real rejection",
      pushOptions(repo, x),
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value.finalUnpushedCount, 0);
    const origin = await originTip(repo);
    assertEquals(
      (await runGit(
        ["merge-base", "--is-ancestor", ours, origin],
        repo.downstream,
      )).code,
      0,
      "our commit must be on origin",
    );
    assertEquals(
      (await runGit(
        ["merge-base", "--is-ancestor", moved, origin],
        repo.downstream,
      )).code,
      0,
      "the remote move must be on origin",
    );
  } finally {
    await Deno.remove(repo.tmp, { recursive: true });
  }
});
