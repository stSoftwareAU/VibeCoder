/**
 * Branch-update conflict detection must judge the **remote** head
 * (Issue #211).
 *
 * The incident: this host's workdir still held a stale local copy of the PR
 * branch. The branch-update pass checked that stale branch out, merged the
 * base into it, hit a conflict that exists only in the old tree, and labelled
 * a perfectly mergeable PR `merge-conflict` (NEAT-AI-core #557). GitHub was
 * judging origin's head; the worker was judging a local leftover.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { isPrBranchConflictError, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BASE = "main";
const BRANCH = "issue-211-remote-head";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.value.stderr}`);
  }
  return result.value.stdout.trim();
}

async function write(
  dir: string,
  name: string,
  body: string,
): Promise<void> {
  await Deno.writeTextFile(`${dir}/${name}`, body);
}

interface Fixture {
  tmpDir: string;
  /** This host's clone — the one the branch-update pass runs in. */
  workerPath: string;
  /** A sibling fleet host's clone of the same remote. */
  siblingPath: string;
}

/**
 * Remote with `main` and a feature branch whose first version conflicts with
 * a later `main` change. Both clones start at that first version.
 */
async function setupFixture(): Promise<Fixture> {
  const tmpDir = await Deno.makeTempDir({ prefix: "pr_branch_remote_head_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const siblingPath = `${tmpDir}/sibling`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", `refs/heads/${BASE}`], remotePath);

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);
  await write(workerPath, "shared.txt", "base line\n");
  await git(["add", "shared.txt"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "origin", BASE], workerPath);

  await git(["checkout", "-b", BRANCH], workerPath);
  await write(workerPath, "shared.txt", "feature line v1\n");
  await git(["add", "shared.txt"], workerPath);
  await git(["commit", "-m", "Feature v1"], workerPath);
  await git(["push", "-u", "origin", BRANCH], workerPath);

  // The base moves in a way that collides with the feature's v1 tree.
  await git(["checkout", BASE], workerPath);
  await write(workerPath, "shared.txt", "base line changed\n");
  await git(["add", "shared.txt"], workerPath);
  await git(["commit", "-m", "Base moves"], workerPath);
  await git(["push", "origin", BASE], workerPath);
  await git(["checkout", BRANCH], workerPath);

  await git(["clone", remotePath, siblingPath], tmpDir);
  await git(["config", "user.email", "sibling@example.com"], siblingPath);
  await git(["config", "user.name", "Sibling"], siblingPath);
  await git(["checkout", BRANCH], siblingPath);

  return { tmpDir, workerPath, siblingPath };
}

Deno.test("updatePrBranch - a sibling's merge on origin clears the conflict the stale local branch still shows (Issue #211)", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupFixture();
  try {
    // The sibling host resolves the conflict for real and pushes. origin's
    // head is now mergeable; this host's local branch is not.
    await git(["fetch", "origin", BASE], siblingPath);
    const merge = await runGitCommand(
      ["merge", `origin/${BASE}`, "--no-edit"],
      { cwd: siblingPath },
    );
    if (!merge.ok || merge.value.code !== 0) {
      await write(siblingPath, "shared.txt", "base line changed + feature\n");
      await git(["add", "shared.txt"], siblingPath);
      await git(["commit", "--no-edit"], siblingPath);
    }
    await git(["push", "origin", BRANCH], siblingPath);

    // Sanity: this host's local branch is stale and still conflicts.
    const staleHead = await git(["rev-parse", "HEAD"], workerPath);
    const remoteHead = await git(
      ["ls-remote", "origin", `refs/heads/${BRANCH}`],
      workerPath,
    );
    assert(
      !remoteHead.startsWith(staleHead),
      "fixture must leave the worker clone behind origin",
    );

    const result = await updatePrBranch(
      BRANCH,
      BASE,
      { cwd: workerPath },
      "conflicting",
    );

    assertEquals(
      isPrBranchConflictError(result.ok ? null : result.error),
      false,
      `a mergeable remote head must not be reported as conflicted: ${
        result.ok ? "" : result.error.message
      }`,
    );
    assert(
      result.ok,
      `expected the update to succeed, got: ${
        result.ok ? "" : result.error.message
      }`,
    );

    // The local branch was brought to origin's head before evaluation.
    const afterHead = await git(["rev-parse", "HEAD"], workerPath);
    assert(
      afterHead !== staleHead,
      "the stale local head must not survive the update",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - refuses to judge a branch holding unpushed commits, rather than calling it conflicted (Issue #211)", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupFixture();
  try {
    // A sibling pushes, and this host also has a local-only commit: the two
    // have diverged, so origin's head is not what this tree holds.
    await write(siblingPath, "sibling.txt", "sibling work\n");
    await git(["add", "sibling.txt"], siblingPath);
    await git(["commit", "-m", "Sibling commit"], siblingPath);
    await git(["push", "origin", BRANCH], siblingPath);

    await write(workerPath, "local.txt", "local only\n");
    await git(["add", "local.txt"], workerPath);
    await git(["commit", "-m", "Local-only commit"], workerPath);

    const result = await updatePrBranch(
      BRANCH,
      BASE,
      { cwd: workerPath },
      "conflicting",
    );

    assert(!result.ok, "the update must not claim success");
    assertEquals(
      isPrBranchConflictError(result.error),
      false,
      "unpushed local work is not a base-branch conflict and must not be labelled one",
    );
    assert(
      result.error.message.includes("unpushed"),
      `the failure must name the real cause, got: ${result.error.message}`,
    );

    // The local-only commit must survive — never reset away.
    const log = await git(["log", "--format=%s"], workerPath);
    assert(
      log.includes("Local-only commit"),
      "local-only work must not be discarded",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
