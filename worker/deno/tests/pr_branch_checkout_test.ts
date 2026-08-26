/**
 * Tests for checkoutPrBranchAtRemoteHead (Issue #211).
 *
 * The branch-update pass must judge a PR by its remote head. Checking out a
 * shared clone's local branch instead made it merge-test a stale tree and
 * label a mergeable PR `merge-conflict` (NEAT-AI-core #557).
 *
 * Real repositories, real git.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkoutPrBranchAtRemoteHead } from "../lib/pr_branch_checkout.ts";

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
 * Upstream with a `Develop` default branch and a PR branch, plus a
 * single-branch worker clone (the shape that produced the false conflict).
 */
async function makeFixture(
  prefix: string,
  branch: string,
): Promise<{ tmp: string; sibling: string; worker: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const sibling = `${tmp}/sibling`;
  const worker = `${tmp}/worker`;

  await runGit(["init", "--bare", "-b", "Develop", upstream], tmp);
  await runGit(["clone", upstream, sibling], tmp);
  await Deno.writeTextFile(`${sibling}/README.md`, "seed\n");
  await runGit(["add", "."], sibling);
  await runGit(["commit", "-m", "seed"], sibling);
  await runGit(["push", "-u", "origin", "Develop"], sibling);
  await runGit(["checkout", "-b", branch], sibling);
  await Deno.writeTextFile(`${sibling}/feature.txt`, "one\n");
  await runGit(["add", "."], sibling);
  await runGit(["commit", "-m", "feature one"], sibling);
  await runGit(["push", "-u", "origin", branch], sibling);

  await runGit(
    ["clone", "--single-branch", "--branch", "Develop", upstream, worker],
    tmp,
  );
  return { tmp, sibling, worker };
}

Deno.test("checkoutPrBranchAtRemoteHead - creates the branch from the remote head on a single-branch clone", async () => {
  const branch = "issue-211-create";
  const { tmp, sibling, worker } = await makeFixture("prco_create_", branch);
  try {
    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value, "created-from-remote");

    const remote = await runGit(["rev-parse", `refs/heads/${branch}`], sibling);
    const local = await runGit(["rev-parse", "HEAD"], worker);
    assertEquals(local.stdout.trim(), remote.stdout.trim());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - resets a stale local branch onto the sibling's push", async () => {
  const branch = "issue-211-stale";
  const { tmp, sibling, worker } = await makeFixture("prco_stale_", branch);
  try {
    // The worker clone picked the branch up at the old head …
    const first = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(first.ok);
    await runGit(["checkout", "Develop"], worker);

    // … then a sibling fleet host pushed to it.
    await Deno.writeTextFile(`${sibling}/feature.txt`, "one\ntwo\n");
    await runGit(["add", "."], sibling);
    await runGit(["commit", "-m", "sibling fix"], sibling);
    await runGit(["push", "origin", branch], sibling);

    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value, "reset-to-remote");

    const remote = await runGit(["rev-parse", `refs/heads/${branch}`], sibling);
    const local = await runGit(["rev-parse", "HEAD"], worker);
    assertEquals(local.stdout.trim(), remote.stdout.trim());
    assertEquals(
      await Deno.readTextFile(`${worker}/feature.txt`),
      "one\ntwo\n",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - refuses when the local branch holds unpushed commits", async () => {
  const branch = "issue-211-unpushed";
  const { tmp, worker } = await makeFixture("prco_unpushed_", branch);
  try {
    const first = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(first.ok);
    await Deno.writeTextFile(`${worker}/local.txt`, "local only\n");
    await runGit(["add", "."], worker);
    await runGit(["commit", "-m", "local only"], worker);
    const beforeSha = (await runGit(["rev-parse", "HEAD"], worker)).stdout
      .trim();

    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(!result.ok, "a stale local branch must not be evaluated");
    if (!result.ok) {
      assertStringIncludes(result.error.message, "1 commit(s)");
      assertStringIncludes(result.error.message, branch);
    }

    // The refusal must not have destroyed the local work.
    const afterSha = (await runGit(["rev-parse", "HEAD"], worker)).stdout
      .trim();
    assertEquals(afterSha, beforeSha);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - reports an unchanged branch as already at the remote head", async () => {
  const branch = "issue-211-insync";
  const { tmp, worker } = await makeFixture("prco_insync_", branch);
  try {
    assert((await checkoutPrBranchAtRemoteHead(branch, { cwd: worker })).ok);
    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) assertEquals(result.value, "already-at-remote");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - refuses a branch that exists only locally", async () => {
  const branch = "issue-211-local-only";
  const { tmp, worker } = await makeFixture("prco_localonly_", branch);
  try {
    const result = await checkoutPrBranchAtRemoteHead("never-pushed", {
      cwd: worker,
    });
    assert(!result.ok);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "does not exist on origin");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - refuses a refspec-breaking branch name", async () => {
  const result = await checkoutPrBranchAtRemoteHead("a:refs/heads/main", {
    cwd: Deno.cwd(),
  });
  assert(!result.ok);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "not a valid ref component");
  }
});

// ---------------------------------------------------------------------------
// Unusable local refs (Issue #411)
//
// The branch-update pass read `refs/heads/<branch>` with `rev-parse --verify`,
// then ran `git checkout <branch>` as a separate command. Anything that makes
// the local ref unusable between — or simply unusable full stop — failed the
// PR every cycle, for ever, while the branch sat healthy on origin:
//
//   Failed to checkout branch 'issue-387-side-data-…': error: pathspec
//   'issue-387-side-data-…' did not match any file(s) known to git
//
// Corrupt refs are real on these hosts — the same clone logged
// `fatal: bad object refs/heads/milestone/357-…` the night before. A PR is
// defined by its remote head, so the local ref is never the truth; positioning
// the branch with a single `checkout -B` from the tracking ref repairs it
// instead of reading it.
// ---------------------------------------------------------------------------

Deno.test("checkoutPrBranchAtRemoteHead - repairs a corrupt local ref instead of failing every cycle (Issue #411)", async () => {
  const branch = "issue-411-corrupt";
  const { tmp, sibling, worker } = await makeFixture("prco_corrupt_", branch);
  try {
    // Adopt the branch, step off it, then corrupt the ref — a ref that
    // resolves for `rev-parse --verify` but names an object that is not there.
    const first = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(first.ok, first.ok ? "" : first.error.message);
    await runGit(["checkout", "Develop"], worker);
    await Deno.writeTextFile(
      `${worker}/.git/refs/heads/${branch}`,
      `${"0".repeat(40)}\n`,
    );

    // Precondition: the plain checkout the old code used cannot recover.
    const plain = await runGit(["checkout", branch], worker);
    assert(
      plain.code !== 0,
      "precondition: a plain checkout must fail on the corrupt ref",
    );

    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(result.ok, result.ok ? "" : result.error.message);

    const remote = await runGit(["rev-parse", `refs/heads/${branch}`], sibling);
    const local = await runGit(["rev-parse", "HEAD"], worker);
    assertEquals(local.stdout.trim(), remote.stdout.trim());
    assertEquals(
      (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worker)).stdout
        .trim(),
      branch,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - a vanished local ref is created from the remote, not reported missing (Issue #411)", async () => {
  const branch = "issue-411-vanished";
  const { tmp, sibling, worker } = await makeFixture("prco_vanished_", branch);
  try {
    const first = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(first.ok);
    await runGit(["checkout", "Develop"], worker);
    // A sibling lane in the shared clone deleted the local branch.
    await runGit(["branch", "-D", branch], worker);

    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(result.ok, result.ok ? "" : result.error.message);

    const remote = await runGit(["rev-parse", `refs/heads/${branch}`], sibling);
    const local = await runGit(["rev-parse", "HEAD"], worker);
    assertEquals(local.stdout.trim(), remote.stdout.trim());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("checkoutPrBranchAtRemoteHead - unpushed commits are still refused, never repaired away (Issue #411)", async () => {
  const branch = "issue-411-unpushed";
  const { tmp, worker } = await makeFixture("prco_unpushed_", branch);
  try {
    const first = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assert(first.ok);
    await Deno.writeTextFile(`${worker}/local-only.txt`, "unpushed\n");
    await runGit(["add", "."], worker);
    await runGit(["commit", "-m", "unpushed work"], worker);
    const before = (await runGit(["rev-parse", "HEAD"], worker)).stdout.trim();

    // The repair must not become a licence to discard somebody's work: the
    // Issue #211 refusal is the whole point of the ahead-check.
    const result = await checkoutPrBranchAtRemoteHead(branch, { cwd: worker });
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error.message, "Issue #211");

    assertEquals(
      (await runGit(["rev-parse", `refs/heads/${branch}`], worker)).stdout
        .trim(),
      before,
      "the unpushed commit must still be on the branch",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
