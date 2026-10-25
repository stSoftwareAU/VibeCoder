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
 * The run id is supplied as a parameter (Issue #963). It used to be set on
 * the process as `VIBE_RUN_ID`, which races every other test running at that
 * moment and pinned this file into the gate's serial pass (Issue #880).
 * {@link TEST_RUN_ID} exists in no real environment, so a fall back to
 * `Deno.env.get` would stamp a different id rather than pass unnoticed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { cloneGitFixture, seedGitRemote } from "./support/git_fixture.ts";

import { assertEquals } from "@std/assert";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const DEFAULT_BRANCH = "Develop";
const FEATURE_BRANCH = "issue-556-moved-head";

/** Run id stamped on the commits this test makes (Issue #963). */
const TEST_RUN_ID = "vibe-963-moved-head-sentinel";

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
  const remotePath = await seedGitRemote(tmpDir, DEFAULT_BRANCH, [
    {
      branch: DEFAULT_BRANCH,
      subject: "Initial commit",
      files: { "README.md": "# Test\n" },
    },
    {
      branch: FEATURE_BRANCH,
      parent: 1,
      subject: "Feature work",
      files: { "feature.txt": "feature\n" },
    },
  ]);
  const workerPath = `${tmpDir}/worker`;
  const siblingPath = `${tmpDir}/sibling`;
  await cloneGitFixture(remotePath, workerPath, {
    singleBranch: FEATURE_BRANCH,
    name: "Worker",
    email: "worker@example.com",
  });
  await cloneGitFixture(remotePath, siblingPath, {
    checkout: FEATURE_BRANCH,
    name: "Sibling",
    email: "sibling@example.com",
  });

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
      false,
      undefined,
      TEST_RUN_ID,
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
    await cleanup(tmpDir);
  }
});
