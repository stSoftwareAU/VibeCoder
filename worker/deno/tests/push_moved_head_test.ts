/**
 * A branch head that moved during the run (Issue #211).
 *
 * When a fleet sibling pushes to the PR branch while the agent works, the
 * worker's own push is rejected non-fast-forward. The right move is to rebase
 * onto the new head and push — not to give up and ask a human to "check the
 * branch status". These tests prove the final-mile push does exactly that, and
 * that the post-condition it reports afterwards is honest.
 *
 * They drive real git repositories end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const DEFAULT_BRANCH = "Develop";
const FEATURE_BRANCH = "issue-556-moved-head";

/** Run a git command in a repo, failing loudly on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (${result.value.code}): ${result.value.stderr}`,
    );
  }
  return result.value.stdout.trim();
}

interface TestRepos {
  tmpDir: string;
  remotePath: string;
  /** The worker's `--single-branch` clone, as the fleet hosts run. */
  workerPath: string;
  /** A fleet sibling's clone of the same remote. */
  siblingPath: string;
}

async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "moved_head_" });
  const remotePath = `${tmpDir}/remote.git`;
  const seedPath = `${tmpDir}/seed`;
  const workerPath = `${tmpDir}/worker`;
  const siblingPath = `${tmpDir}/sibling`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(
    ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`],
    remotePath,
  );

  await git(["clone", remotePath, seedPath], tmpDir);
  await git(["config", "user.email", "seed@example.com"], seedPath);
  await git(["config", "user.name", "Seed"], seedPath);
  await git(["checkout", "-b", DEFAULT_BRANCH], seedPath);
  await Deno.writeTextFile(`${seedPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], seedPath);
  await git(["commit", "-m", "Initial commit"], seedPath);
  await git(["push", "-u", "origin", DEFAULT_BRANCH], seedPath);
  await git(["checkout", "-b", FEATURE_BRANCH], seedPath);
  await Deno.writeTextFile(`${seedPath}/feature.txt`, "feature\n");
  await git(["add", "feature.txt"], seedPath);
  await git(["commit", "-m", "Feature work"], seedPath);
  await git(["push", "-u", "origin", FEATURE_BRANCH], seedPath);

  await git([
    "clone",
    "--single-branch",
    "--branch",
    FEATURE_BRANCH,
    remotePath,
    workerPath,
  ], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);

  await git(["clone", remotePath, siblingPath], tmpDir);
  await git(["config", "user.email", "sibling@example.com"], siblingPath);
  await git(["config", "user.name", "Sibling"], siblingPath);
  await git(["checkout", FEATURE_BRANCH], siblingPath);

  return { tmpDir, remotePath, workerPath, siblingPath };
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

Deno.test("commitAndPushPending - rebases onto a sibling's newer head and pushes", async () => {
  const { tmpDir, remotePath, workerPath, siblingPath } = await setupRepos();
  const runIdBefore = Deno.env.get("VIBE_RUN_ID");
  Deno.env.set("VIBE_RUN_ID", "test-run-211");
  try {
    // The agent's own work, committed but not yet pushed.
    await Deno.writeTextFile(`${workerPath}/agent.txt`, "agent fix\n");
    await git(["add", "agent.txt"], workerPath);
    await git(["commit", "-m", "Agent fix"], workerPath);

    // A fleet sibling pushes to the same branch while the agent ran.
    await Deno.writeTextFile(`${siblingPath}/sibling.txt`, "sibling fix\n");
    await git(["add", "sibling.txt"], siblingPath);
    await git(["commit", "-m", "Sibling fix"], siblingPath);
    await git(["push", "origin", FEATURE_BRANCH], siblingPath);

    const result = await commitAndPushPending(
      FEATURE_BRANCH,
      "Fix CI failure: Quality Checks\n\nAutomated final-mile commit.",
      { cwd: workerPath },
    );

    if (!result.ok) throw result.error;
    assertEquals(result.value.finalUnpushedCount, 0);

    // Both authors' work is on the remote — the rebase kept the sibling's
    // commit and replayed ours on top.
    const remoteLog = await git(
      ["log", "--format=%s", `refs/heads/${FEATURE_BRANCH}`],
      remotePath,
    );
    const subjects = remoteLog.split("\n");
    assertEquals(subjects.includes("Agent fix"), true);
    assertEquals(subjects.includes("Sibling fix"), true);
  } finally {
    if (runIdBefore === undefined) {
      Deno.env.delete("VIBE_RUN_ID");
    } else {
      Deno.env.set("VIBE_RUN_ID", runIdBefore);
    }
    await cleanup(tmpDir);
  }
});
